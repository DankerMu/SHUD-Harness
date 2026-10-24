import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { RunJobSchema, type RunJob } from "../../packages/dsh-shud-core/src/schemas/run-job.ts";
import { RunRecordSchema } from "../../packages/dsh-shud-core/src/schemas/run-record.ts";
import { StateLock } from "../../packages/dsh-shud-jobs/src/state-lock.ts";
import {
  processExecutionState,
  processStart,
} from "../../packages/dsh-shud-jobs/src/process-identity.ts";
import {
  recoverProcessGroup,
  type ShudProcessGroup,
} from "../../packages/dsh-shud-jobs/src/process-group.ts";
import {
  assertRestartEvidence,
  extendPrefix,
  object,
  requireFact,
  submission,
  text,
  type CanonicalEvent,
  type CanonicalPrefix,
  type Identity,
  type ProcessSample,
  type RestartEvidence,
  type RestartSignal,
  type WrapperFile,
} from "./shud-restart-evidence.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUFFER_LIMIT = 8 * 1024 * 1024;
const HTTP_MS = 15_000;
const START_MS = 60_000;
const SUBMIT_MS = 180_000;
const STOP_MS = 15_000;
const COMPLETE_MS = 15 * 60_000;
const secrets = new Set<string>();
if (process.env.DMXAPI_KEY) secrets.add(process.env.DMXAPI_KEY);

function screen(value: string): void {
  requireFact(
    ![...secrets].some((secret) => value.includes(secret)) &&
      !/DMXAPI_KEY\s*=|sk-[A-Za-z0-9_-]{16,}|[?&]token=|set-cookie:|dsh-auth-/iu.test(value),
    "Secret detected; evidence suppressed",
  );
}
function save(path: string, value: unknown): void {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  requireFact(Buffer.byteLength(bytes) <= BUFFER_LIMIT, "Retained evidence exceeds byte budget");
  screen(bytes);
  fs.writeFileSync(path, bytes, { mode: 0o600 });
}
function load(path: string): unknown {
  requireFact(fs.statSync(path).size <= BUFFER_LIMIT, "Evidence file exceeds byte budget");
  const bytes = fs.readFileSync(path, "utf8");
  screen(bytes);
  return JSON.parse(bytes) as unknown;
}
function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}
function native(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: HTTP_MS,
    maxBuffer: BUFFER_LIMIT,
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
  });
  screen((result.stdout ?? "") + (result.stderr ?? ""));
  requireFact(
    !result.error && !result.signal && result.status === 0,
    "Native process inspection failed",
  );
  return result.stdout;
}
function cwdOf(pid: number): string {
  if (process.platform === "linux") return fs.realpathSync(`/proc/${pid}/cwd`);
  const rows = native("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .split("\n")
    .filter((line) => line.startsWith("n"));
  requireFact(rows.length === 1, "Cannot determine process cwd");
  return fs.realpathSync(rows[0].slice(1));
}
function hashes(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(relative: string): void {
    for (const name of fs.readdirSync(join(directory, relative)).sort()) {
      const child = join(relative, name);
      const path = join(directory, child);
      const stat = fs.lstatSync(path);
      requireFact(!stat.isSymbolicLink(), "ccw input contains a symbolic link");
      if (stat.isDirectory()) visit(child);
      else {
        requireFact(stat.isFile(), "ccw input contains a nonregular file");
        result[child] = createHash("sha256").update(fs.readFileSync(path)).digest("hex");
      }
    }
  }
  visit("");
  return result;
}

interface RestartConfig {
  shudBin: string;
  dshBin: string;
  source: string;
  hashes: Record<string, string>;
}
/** No host invocation, including profile creation, occurs before this gate. */
function preflight(): RestartConfig {
  requireFact(process.env.DMXAPI_KEY?.trim(), "shud:restart requires nonblank DMXAPI_KEY");
  const shudBin = process.env.SHUD_BIN ?? join(ROOT, "SHUD/shud");
  requireFact(isAbsolute(shudBin), "shud:restart requires absolute SHUD_BIN");
  try {
    requireFact(fs.statSync(shudBin).isFile(), "SHUD_BIN is not a regular file");
    fs.accessSync(shudBin, fs.constants.X_OK);
  } catch {
    throw new Error("shud:restart requires executable regular SHUD_BIN");
  }
  const dshBin = process.env.DSH_BIN;
  requireFact(
    dshBin && isAbsolute(dshBin) && fs.statSync(dshBin).isFile(),
    "shud:restart requires resolved pinned dsh; use the shell entry",
  );
  requireFact(
    process.platform === "darwin" || process.platform === "linux",
    "shud:restart requires Darwin or Linux native process inspection",
  );
  requireFact(processStart(process.pid), "shud:restart requires native ps start identity");
  requireFact(
    cwdOf(process.pid) === fs.realpathSync(process.cwd()),
    "shud:restart requires native cwd inspection",
  );
  if (process.platform === "linux") {
    fs.accessSync(`/proc/${process.pid}/stat`, fs.constants.R_OK);
    requireFact(
      Number.isFinite(Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0])) &&
        Number(native("getconf", ["CLK_TCK"]).trim()) > 0,
      "shud:restart requires Linux procfs uptime and getconf CLK_TCK",
    );
  }
  const source = join(ROOT, "SHUD/input/ccw");
  const original = hashes(source);
  requireFact(
    original["ccw.cfg.para"],
    "shud:restart requires ccw.cfg.para in the source input inventory",
  );
  const home = fs.realpathSync(homedir());
  requireFact(
    !within(ROOT, home) &&
      !within(fs.realpathSync(tmpdir()), home) &&
      !within(fs.realpathSync("/tmp"), home),
    "Private HOME scratch must be outside repository and temporary roots",
  );
  const probe = fs.mkdtempSync(join(home, ".shud-restart-preflight-"));
  try {
    const lock = new StateLock(probe);
    lock.release();
  } finally {
    fs.rmSync(probe, { recursive: true });
  }
  return { shudBin, dshBin, source, hashes: original };
}

class WebHost {
  child: ChildProcess;
  identity: Identity;
  output = "";
  outputBytes = 0;
  failure: Error | undefined;
  exited = false;
  origin = "";
  cookie = "";
  launchToken = "";
  abort: AbortSignal;

  constructor(bin: string, workspace: string, env: NodeJS.ProcessEnv, abort: AbortSignal) {
    this.abort = abort;
    this.child = spawn(
      process.execPath,
      [bin, "--profile", "shud", "--no-open", "--host", "127.0.0.1", "--port", "0"],
      {
        cwd: workspace,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child.once("error", () => {
      this.failure = new Error("Web host spawn failed");
      this.exited = true;
    });
    this.child.once("exit", () => {
      this.exited = true;
    });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        this.outputBytes += Buffer.byteLength(chunk);
        if (this.outputBytes > BUFFER_LIMIT)
          this.failure = new Error("Web host output exceeds byte budget");
        else this.output += chunk;
      });
    }
    this.identity = { pid: this.child.pid ?? 0, stamp: "" };
    try {
      requireFact(this.child.pid, "Web host has no process identity");
      const stamp = processStart(this.child.pid);
      requireFact(stamp, "Web host start identity unavailable");
      this.identity = { pid: this.child.pid, stamp };
    } catch {
      this.failure = new Error("Web host start identity unavailable; cleanup must fail closed");
    }
  }
  healthy(): void {
    this.abort.throwIfAborted();
    if (this.failure) throw this.failure;
    requireFact(!this.exited, "Web host exited unexpectedly");
  }
  private assertOwner(stateDir: string, message: string): void {
    const lock = object(load(join(stateDir, "lock")));
    requireFact(
      lock.pid === this.identity.pid &&
        lock.pid_started_at === this.identity.stamp &&
        processStart(this.identity.pid) === this.identity.stamp,
      message,
    );
  }
  async ready(stateDir: string): Promise<void> {
    const deadline = Date.now() + START_MS;
    let url: URL | undefined;
    while (Date.now() < deadline) {
      this.healthy();
      const match = /dsh web: (http:\/\/[^\s]+)[\r\n]/u.exec(stripVTControlCharacters(this.output));
      if (match) {
        url = new URL(match[1]);
        break;
      }
      await delay(100, undefined, { signal: this.abort });
    }
    requireFact(
      url && url.hostname === "127.0.0.1" && url.port && url.searchParams.get("token"),
      "Web startup deadline or malformed loopback launch URL",
    );
    this.launchToken = text(url.searchParams.get("token"));
    secrets.add(this.launchToken);
    this.origin = url.origin;
    this.assertOwner(stateDir, "Web host does not own shud-jobs state lock");
    const connect = new URL("/connect", this.origin);
    connect.searchParams.set("token", this.launchToken);
    connect.searchParams.set("interactions", "none");
    const response = await fetch(connect, {
      redirect: "manual",
      signal: AbortSignal.any([this.abort, AbortSignal.timeout(HTTP_MS)]),
    });
    const cookies = response.headers.getSetCookie();
    await response.body?.cancel();
    requireFact(
      response.status === 302 && cookies.length === 1,
      "Web connect requires 302 and one auth cookie",
    );
    this.cookie = cookies[0].split(";", 1)[0];
    requireFact(/^dsh-auth-[^=]+=v2\./u.test(this.cookie), "Web connect did not issue v2 API auth");
    secrets.add(this.cookie);
    secrets.add(this.cookie.slice(this.cookie.indexOf("=") + 1));
  }
  async rpc(method: string, request: unknown): Promise<unknown> {
    this.healthy();
    const rpcId = randomUUID();
    const response = await fetch(new URL(`/api/${method}`, this.origin), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", cookie: this.cookie },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method,
        payload: { args: { request } },
      }),
      signal: AbortSignal.any([this.abort, AbortSignal.timeout(HTTP_MS)]),
    });
    requireFact(response.status === 200 && response.body, `Public ${method} HTTP failure`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk: unknown = next.value;
        requireFact(chunk instanceof Uint8Array, "Public RPC returned a non-byte chunk");
        size += chunk.byteLength;
        requireFact(size <= BUFFER_LIMIT, "Public RPC exceeds byte budget");
        chunks.push(chunk);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks).toString("utf8");
    screen(bytes);
    const envelope = object(JSON.parse(bytes) as unknown);
    requireFact(
      envelope.type === "server-response" && envelope.rpcId === rpcId,
      "Public RPC correlation mismatch",
    );
    const result = object(envelope.result);
    requireFact(result.ok === true && "value" in result, `Public ${method} returned an RPC error`);
    return result.value;
  }
  async prefix(sessionId: string): Promise<CanonicalPrefix> {
    const projection = object(await this.rpc("session/projections", { sessionId }));
    const asOfSeq = projection.asOfSeq;
    requireFact(
      projection.kind === "sequenced" &&
        typeof asOfSeq === "number" &&
        Number.isSafeInteger(asOfSeq) &&
        asOfSeq >= -1,
      "Session has no canonical sequenced projection",
    );
    let beforeSeq = asOfSeq + 1;
    const pages: CanonicalEvent[][] = [];
    let bytes = 0;
    while (true) {
      const page = object(
        await this.rpc("session/page", {
          address: { kind: "session", sessionId },
          throughSeq: asOfSeq,
          beforeSeq,
          maxMessages: 64,
        }),
      );
      requireFact(
        Array.isArray(page.records) && typeof page.hasMore === "boolean",
        "Malformed canonical page",
      );
      bytes += Buffer.byteLength(JSON.stringify(page));
      requireFact(bytes <= BUFFER_LIMIT, "Canonical prefix exceeds byte budget");
      const events = page.records.map((entry: unknown): CanonicalEvent => {
        const record = object(entry);
        const event = object(record.event);
        requireFact(
          record.type === "event" &&
            typeof event.type === "string" &&
            typeof event.seq === "number" &&
            Number.isSafeInteger(event.seq) &&
            typeof event.time === "number" &&
            Number.isFinite(event.time) &&
            "data" in event,
          "Malformed canonical event",
        );
        return { ...event, type: event.type, seq: event.seq, time: event.time, data: event.data };
      });
      requireFact(
        events.length > 0 || (beforeSeq === 0 && !page.hasMore),
        "Empty incomplete canonical prefix",
      );
      if (events.length) {
        const first = events[0].seq;
        requireFact(
          first >= 0 &&
            first < beforeSeq &&
            events.every((event, i) => event.seq === first + i) &&
            events[events.length - 1].seq === beforeSeq - 1,
          "Canonical page is not dense or within requested cut",
        );
        beforeSeq = first;
      }
      pages.push(events);
      requireFact(page.hasMore === beforeSeq > 0, "Canonical history exhaustion mismatch");
      if (!page.hasMore) break;
    }
    return { asOfSeq, events: pages.reverse().flat() };
  }
  async flush(sessionId: string): Promise<void> {
    const url = new URL("/api/session.export", this.origin);
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("includeDescendants", "false");
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "error",
      headers: { cookie: this.cookie },
      signal: AbortSignal.any([this.abort, AbortSignal.timeout(HTTP_MS)]),
    });
    requireFact(response.status === 200, "Canonical stored-log export barrier failed");
  }
  async interrupt(signal: RestartSignal, stateDir: string): Promise<void> {
    this.healthy();
    this.assertOwner(stateDir, "Restart signal requires the spawned registry owner");
    requireFact(this.child.kill(signal), "Host restart signal was not sent");
    const deadline = Date.now() + STOP_MS;
    while (!this.exited && Date.now() < deadline)
      await delay(100, undefined, { signal: this.abort });
    requireFact(this.exited, "Signalled host did not exit before deadline");
    requireFact(
      signal === "SIGTERM" ? this.child.exitCode === 0 : this.child.signalCode === "SIGKILL",
      "Host exit does not match requested restart case",
    );
  }
  async stop(): Promise<void> {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (this.exited) return;
      requireFact(
        this.identity.pid > 0 && this.identity.stamp.length > 0,
        "Unsafe to clean up Web host: birth identity was not captured",
      );
      requireFact(
        processStart(this.identity.pid) === this.identity.stamp,
        "Unsafe to clean up Web host: process identity changed",
      );
      this.child.kill(signal);
      const deadline = Date.now() + STOP_MS;
      while (!this.exited && Date.now() < deadline) await delay(100);
    }
    requireFact(this.exited, "Web host cleanup deadline");
  }
  saveOutput(path: string): void {
    // Captured whole bounded streams avoid chunk-boundary credential leakage.
    const scrubbed = this.output.replace(
      /dsh web: http:\/\/[^\r\n]+/gu,
      "dsh web: [launch URL withheld]",
    );
    screen(scrubbed);
    save(path, { output: scrubbed, bytes: this.outputBytes });
  }
}

function canonicalLog(home: string, sessionId: string): string {
  requireFact(/^session-[A-Za-z0-9-]+$/u.test(sessionId), "Invalid canonical session identity");
  const root = join(home, "sessions");
  const directories = fs
    .readdirSync(root)
    .map((project) => join(root, project, sessionId))
    .filter((path) => fs.existsSync(path));
  requireFact(directories.length === 1, "Missing or ambiguous canonical session directory");
  const files = fs
    .readdirSync(directories[0])
    .flatMap((name) => {
      const match = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/u.exec(name);
      return match ? [{ name, version: Number(match[1] ?? 0) }] : [];
    })
    .sort((a, b) => b.version - a.version);
  requireFact(
    files.length > 0 && (!files[1] || files[1].version !== files[0].version),
    "Missing or ambiguous canonical log generation",
  );
  return join(directories[0], files[0].name);
}

function sampleProcesses(
  job: RunJob,
  shudBin: string,
  phase: ProcessSample["phase"],
): ProcessSample {
  requireFact(job.pid && job.pid_started_at, "RunJob lacks original wrapper identity");
  const sample: ProcessSample = { phase, at: Date.now(), wrapper: null, solvers: [] };
  const wrapper = processExecutionState(job.pid);
  if (wrapper && !wrapper.state.startsWith("Z")) {
    requireFact(
      new Date(`${wrapper.stamp} UTC`).toISOString() === job.pid_started_at,
      "Original wrapper birth identity changed",
    );
    try {
      requireFact(cwdOf(job.pid) === job.run_dir, "Original wrapper cwd changed");
      sample.wrapper = { pid: job.pid, stamp: wrapper.stamp };
    } catch (error) {
      const now = processExecutionState(job.pid);
      if (now && !now.state.startsWith("Z")) throw error;
    }
  }
  const binary = fs.realpathSync(shudBin);
  // Minimal comm, never foreign argv; enumerate beyond the original PGID.
  for (const line of native("ps", ["-ww", "-axo", "pid=,comm="]).trim().split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    requireFact(match, "Malformed native process candidate list");
    if (basename(match[2]) !== basename(shudBin) && basename(match[2]) !== basename(binary))
      continue;
    const pid = Number(match[1]);
    const state = processExecutionState(pid);
    if (!state || state.state.startsWith("Z")) continue;
    let executable: string;
    try {
      if (cwdOf(pid) !== job.run_dir) continue;
      executable =
        process.platform === "linux"
          ? fs.realpathSync(`/proc/${pid}/exe`)
          : fs.realpathSync(match[2]);
    } catch (error) {
      // Only a separately proven exit can explain a cwd/exe read race.
      const now = processExecutionState(pid);
      if (!now || now.state.startsWith("Z")) continue;
      throw error;
    }
    requireFact(executable === binary, "Unknown executable in run cwd");
    const now = processExecutionState(pid);
    if (!now || now.state.startsWith("Z")) continue;
    requireFact(now.stamp === state.stamp, "Candidate PID was reused during observation");
    sample.solvers.push({ pid, stamp: state.stamp });
  }
  requireFact(sample.solvers.length <= 1, "Observed duplicate SHUD execution");
  if (phase !== "completion") {
    requireFact(
      sample.wrapper &&
        sample.solvers.length === 1 &&
        !fs.existsSync(join(job.run_dir, "exit_code")),
      "Original execution is not live across restart",
    );
  }
  return sample;
}

function wrapperFile(runDir: string): WrapperFile {
  const path = join(runDir, "wrapper.pid");
  const stat = fs.statSync(path);
  return { text: fs.readFileSync(path, "utf8"), ino: stat.ino, mtimeMs: stat.mtimeMs };
}

async function stopGroup(group: ShudProcessGroup): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!group.isGroupActive()) return;
    group.signalGroup(signal);
    const deadline = Date.now() + STOP_MS;
    while (group.isGroupActive() && Date.now() < deadline) await delay(100);
  }
  requireFact(!group.isGroupActive(), "Owned subprocess group cleanup deadline");
}

async function command(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  abort: AbortSignal,
): Promise<void> {
  abort.throwIfAborted();
  const child = spawn(binary, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  let failed = false;
  let output = "";
  let bytes = 0;
  child.once("error", () => {
    failed = true;
    exited = true;
  });
  child.once("exit", () => {
    exited = true;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > BUFFER_LIMIT) failed = true;
      else output += chunk;
    });
  }
  let group: ShudProcessGroup | undefined;
  try {
    requireFact(child.pid, "Build/installer process failed to start");
    const stamp = processStart(child.pid);
    requireFact(stamp, "Build/installer birth identity unavailable");
    group = recoverProcessGroup({
      pid: child.pid,
      pid_started_at: new Date(`${stamp} UTC`).toISOString(),
    });
    const deadline = Date.now() + 600_000;
    while (!exited && !failed && Date.now() < deadline)
      await delay(100, undefined, { signal: abort });
    screen(output);
    requireFact(
      exited && !failed && child.exitCode === 0,
      "Build or profile installation failed (captured output suppressed)",
    );
  } finally {
    if (group) await stopGroup(group);
    else requireFact(exited, "Unsafe to clean up build/installer without original birth identity");
  }
}

async function runCase(
  config: RestartConfig,
  signal: RestartSignal,
  abort: AbortSignal,
): Promise<string> {
  const scratch = fs.realpathSync(
    fs.mkdtempSync(join(fs.realpathSync(homedir()), `.shud-restart-${signal}-`)),
  );
  fs.chmodSync(scratch, 0o700);
  screen(scratch);
  process.stdout.write(`shud:restart ${signal} retained scratch: ${scratch}\n`);
  const home = join(scratch, "home"),
    workspace = join(scratch, "work"),
    evidenceDir = join(scratch, "evidence");
  for (const directory of [home, workspace, evidenceDir]) fs.mkdirSync(directory, { mode: 0o700 });
  const stateDir = join(home, "profiles/shud/shud-jobs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SHUD_BIN: config.shudBin,
    DSH_HOME: home,
    PROFILE_NAME: "shud",
    PROFILE_TEMPLATE: "web",
  };
  delete env.ALL_PROXY;
  const hosts: WebHost[] = [];
  const groups = new Map<number, ShudProcessGroup>();
  const jobs: RunJob[] = [],
    samples: ProcessSample[] = [],
    wrapperFiles: WrapperFile[] = [];
  let sessionId: string | undefined,
    original: RunJob | undefined,
    finalEvidence: RestartEvidence | undefined;
  let previous: CanonicalPrefix = { asOfSeq: -1, events: [] };
  let failure: unknown;
  const cleanupErrors: string[] = [];
  function readJob(runDir: string): RunJob {
    requireFact(
      fs.realpathSync(runDir) === runDir && within(join(workspace, "runs"), runDir),
      "Run directory is not private",
    );
    const parsed = RunJobSchema.safeParse(load(join(runDir, "run-job.json")));
    requireFact(parsed.success, "Malformed canonical RunJob");
    return parsed.data;
  }
  function recordSample(phase: ProcessSample["phase"]): void {
    requireFact(original, "Cannot sample before submission");
    const job = readJob(original.run_dir);
    jobs.push(job);
    const sample = sampleProcesses(job, config.shudBin, phase);
    samples.push(sample);
    if (samples.length > 1)
      requireFact(
        sample.solvers.every(
          (solver) => JSON.stringify(solver) === JSON.stringify(samples[0].solvers[0]),
        ),
        "Observed replacement solver identity",
      );
    save(join(evidenceDir, "observations.json"), { jobs, samples });
  }
  async function history(host: WebHost): Promise<CanonicalPrefix> {
    requireFact(sessionId, "Missing owner session");
    const prefix = await host.prefix(sessionId);
    extendPrefix(previous, prefix);
    previous = prefix;
    save(join(evidenceDir, "canonical-prefix.json"), prefix);
    return prefix;
  }
  try {
    fs.cpSync(config.source, join(workspace, "input/ccw"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    requireFact(
      JSON.stringify(hashes(join(workspace, "input/ccw"))) === JSON.stringify(config.hashes),
      "ccw workspace copy differs from source",
    );
    save(join(evidenceDir, "input-before.json"), config.hashes);
    await command("sh", [join(ROOT, "scripts/runtime/profile-install.sh")], workspace, env, abort);
    const first = new WebHost(config.dshBin, workspace, env, abort);
    hosts.push(first);
    await first.ready(stateDir);
    sessionId = text(object(await first.rpc("session/create", { cwd: workspace })).sessionId);
    await history(first);
    await first.flush(sessionId);
    const accepted = object(
      await first.rpc("session/prompt", {
        requestId: randomUUID(),
        sessionId,
        mode: "queue",
        content: [
          {
            type: "text",
            text: `Call shud_run exactly once with input_dir ${JSON.stringify(join(workspace, "input/ccw"))} and project "ccw". Do not pass end_days. Do not use any other tool, start a replacement run, wait for completion, or manually collect. Return immediately after the tool result. When automatically notified after completion, do not invoke tools; summarize the notification only.`,
          },
        ],
      }),
    );
    requireFact(accepted.accepted === true, "Web prompt was not accepted");
    const submissionDeadline = Date.now() + SUBMIT_MS;
    while (Date.now() < submissionDeadline) {
      const tool = submission(await history(first), workspace);
      if (tool) {
        original = readJob(tool.run_dir);
        requireFact(
          original.owner_session === sessionId &&
            original.run_id === tool.run_id &&
            original.job_id === tool.job_id &&
            original.dsh_job_id === tool.dsh_job_id &&
            original.status === "running" &&
            original.exit_code === null &&
            original.end_days === null &&
            original.input_dir === join(workspace, "input/ccw") &&
            original.pid &&
            original.pid_started_at &&
            JSON.stringify(original.command) ===
              JSON.stringify([config.shudBin, "-o", "output/ccw.out", "ccw"]),
          "Canonical tool result and running RunJob disagree",
        );
        groups.set(
          original.pid,
          recoverProcessGroup({ pid: original.pid, pid_started_at: original.pid_started_at }),
        );
        break;
      }
      await delay(500, undefined, { signal: abort });
    }
    requireFact(original, "Deadline waiting for canonical shud_run result");
    const before = previous;
    await first.flush(sessionId);
    const log = canonicalLog(home, sessionId);
    recordSample("before");
    wrapperFiles.push(wrapperFile(original.run_dir));
    save(join(evidenceDir, "before-restart.json"), {
      original,
      before,
      host: first.identity,
      canonicalLog: log,
      sample: samples[0],
      wrapper: wrapperFiles[0],
    });
    const beforeLock = load(join(stateDir, "lock"));
    await first.interrupt(signal, stateDir);
    const stoppedAt = Date.now();
    recordSample("offline");
    wrapperFiles.push(wrapperFile(original.run_dir));
    const restartedAt = Date.now();
    const second = new WebHost(config.dshBin, workspace, env, abort);
    hosts.push(second);
    await second.ready(stateDir);
    const afterLock = load(join(stateDir, "lock"));
    recordSample("restarted");
    wrapperFiles.push(wrapperFile(original.run_dir));
    await history(second);
    await second.flush(sessionId);
    requireFact(
      canonicalLog(home, sessionId) === log,
      "Restart changed the canonical session log path",
    );
    const completionDeadline = Date.now() + COMPLETE_MS;
    let missingSolverAt: number | undefined;
    while (Date.now() < completionDeadline) {
      second.healthy();
      recordSample("completion");
      const job = jobs[jobs.length - 1];
      const sample = samples[samples.length - 1];
      if (!sample.solvers.length && !fs.existsSync(join(original.run_dir, "exit_code"))) {
        missingSolverAt ??= Date.now();
        requireFact(
          Date.now() - missingSolverAt < STOP_MS,
          "Solver vanished without durable exit evidence",
        );
      }
      const after = await history(second);
      requireFact(job.notify.status !== "unreachable", "Owner notification became unreachable");
      const recordPath = join(original.run_dir, "run-record.json");
      const active = load(join(stateDir, "active.json")),
        completed = load(join(stateDir, "completed.json"));
      requireFact(Array.isArray(active) && Array.isArray(completed), "Malformed state indexes");
      if (
        job.status === "collected" &&
        job.notify.status === "delivered" &&
        active.length === 0 &&
        completed.length === 1 &&
        fs.existsSync(recordPath)
      ) {
        const parsed = RunRecordSchema.safeParse(load(recordPath));
        requireFact(parsed.success, "Malformed canonical RunRecord");
        const record = parsed.data;
        const exitText = fs.readFileSync(join(original.run_dir, "exit_code"), "utf8");
        requireFact(/^-?\d+\n?$/u.test(exitText), "Malformed durable exit_code");
        const outputRoot = join(original.run_dir, "output");
        const artifacts = record.artifacts.files.map((file) => {
          const path = join(record.artifacts.shud_output, file.path);
          requireFact(
            within(outputRoot, fs.realpathSync(path)) && fs.statSync(path).isFile(),
            "RunRecord artifact escapes output or is missing",
          );
          return { path: file.path, size_bytes: fs.statSync(path).size };
        });
        await second.flush(sessionId);
        finalEvidence = {
          signal,
          workspace,
          sessionId,
          canonicalLog: log,
          original,
          jobs,
          before,
          after,
          hosts: {
            before: first.identity,
            after: second.identity,
            locks: [beforeLock, afterLock],
            stoppedAt,
            restartedAt,
          },
          samples,
          wrapperFiles,
          record,
          exitCode: Number(exitText),
          artifacts,
          indexes: { active, completed },
          inputs: {
            before: config.hashes,
            sourceAfter: hashes(config.source),
            copyAfter: hashes(join(workspace, "input/ccw")),
          },
        };
        save(join(evidenceDir, "restart-evidence.json"), finalEvidence);
        assertRestartEvidence(finalEvidence);
        break;
      }
      if (
        fs.existsSync(join(original.run_dir, "collect-error.json")) &&
        !fs.existsSync(recordPath)
      ) {
        save(
          join(evidenceDir, "collect-error.json"),
          load(join(original.run_dir, "collect-error.json")),
        );
      }
      await delay(1000, undefined, { signal: abort });
    }
    requireFact(
      finalEvidence,
      "Completion deadline: RunRecord, delivered wake and completed-only indexes required",
    );
  } catch (error) {
    failure = error;
  } finally {
    for (const host of hosts) {
      try {
        await host.stop();
      } catch {
        cleanupErrors.push("Unsafe to clean up spawned host: birth identity or exit unproved");
      }
    }
    if (hosts.every((host) => host.exited)) {
      // A failed RPC/result must not strand an execution that was already
      // durably admitted. Validate each private run independently, never by name.
      const runs = join(workspace, "runs");
      if (sessionId && fs.existsSync(runs)) {
        try {
          requireFact(fs.realpathSync(runs) === runs, "Cleanup run root is not private");
          const entries = fs.readdirSync(runs);
          if (entries.length !== 1)
            cleanupErrors.push("Private workspace contains unexpected additional or missing runs");
          for (const name of entries) {
            try {
              const job = readJob(join(runs, name));
              requireFact(
                job.owner_session === sessionId &&
                  job.pid &&
                  job.pid_started_at &&
                  JSON.stringify(job.command) ===
                    JSON.stringify([config.shudBin, "-o", "output/ccw.out", "ccw"]),
                "Cleanup run ownership mismatch",
              );
              if (groups.has(job.pid)) continue;
              const state = processExecutionState(job.pid);
              if (!state || state.state.startsWith("Z")) {
                requireFact(
                  !sampleProcesses(job, config.shudBin, "completion").solvers.length,
                  "Solver outlived unowned wrapper",
                );
                continue;
              }
              requireFact(
                cwdOf(job.pid) === job.run_dir &&
                  wrapperFile(job.run_dir).text.trim() === String(job.pid),
                "Cleanup wrapper cwd/pid mismatch",
              );
              groups.set(
                job.pid,
                recoverProcessGroup({ pid: job.pid, pid_started_at: job.pid_started_at }),
              );
            } catch {
              cleanupErrors.push("Unsafe to clean up private run: persisted ownership unproved");
            }
          }
        } catch {
          cleanupErrors.push("Unsafe to inspect private runs for cleanup");
        }
      }
      for (const group of groups.values()) {
        try {
          await stopGroup(group);
        } catch {
          cleanupErrors.push(
            "Unsafe to clean up solver: original group ownership or quiescence unproved",
          );
        }
      }
    } else cleanupErrors.push("Solver cleanup withheld while a submission host may remain live");
    for (const [index, host] of hosts.entries()) {
      try {
        host.saveOutput(join(evidenceDir, `host-${index + 1}.json`));
      } catch {
        cleanupErrors.push("Host output suppressed by evidence secret screen");
      }
    }
    try {
      const sourceAfter = hashes(config.source),
        copyAfter = hashes(join(workspace, "input/ccw"));
      save(join(evidenceDir, "input-after.json"), { source: sourceAfter, workspace: copyAfter });
      requireFact(
        JSON.stringify(sourceAfter) === JSON.stringify(config.hashes) &&
          JSON.stringify(copyAfter) === JSON.stringify(config.hashes),
        "Original or copied input changed",
      );
    } catch {
      cleanupErrors.push("Input preservation check failed");
    }
    save(join(evidenceDir, "cleanup.json"), {
      hosts: hosts.map((host) => ({ identity: host.identity, stopped: host.exited })),
      ownedGroups: [...groups.keys()],
      cleanupErrors,
      retained: scratch,
    });
  }
  if (abort.aborted && !failure) failure = new Error("Restart acceptance interrupted");
  if (failure || cleanupErrors.length) {
    let reason = failure instanceof Error ? failure.message : "Case cleanup failed";
    try {
      screen(reason);
    } catch {
      reason = "Failure detail suppressed by secret screen";
    }
    save(join(evidenceDir, "verdict.json"), { status: "FAIL", reason, cleanupErrors });
    throw new Error(
      `${signal}: ${reason}; ${cleanupErrors.join("; ")}; retained evidence: ${evidenceDir}`,
    );
  }
  requireFact(finalEvidence, "Missing final restart evidence");
  save(join(evidenceDir, "verdict.json"), {
    status: "PASS",
    assertions: assertRestartEvidence(finalEvidence),
    samplingBound:
      "Finite cwd-bound samples do not prove exhaustive tracing. The jobs owner has one submission spawn path and no respawn in reconciliation; original PID/birth and wrapper-file generation are retained.",
  });
  process.stdout.write(`shud:restart ${signal} PASS: ${evidenceDir}\n`);
  return evidenceDir;
}

async function main(): Promise<void> {
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error("Restart acceptance interrupted"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, interrupted);
  try {
    const config = preflight();
    const env = { ...process.env };
    delete env.ALL_PROXY;
    await command("pnpm", ["run", "build"], ROOT, env, abort.signal);
    const cases: string[] = [];
    for (const signal of ["SIGTERM", "SIGKILL"] as const)
      cases.push(await runCase(config, signal, abort.signal));
    abort.signal.throwIfAborted();
    process.stdout.write(
      `shud:restart PASS: both independent Web restart cases; evidence ${cases.join(" ; ")}\n`,
    );
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, interrupted);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    let message = error instanceof Error ? error.message : "Restart acceptance failed";
    try {
      screen(message);
    } catch {
      message = "Failure detail suppressed by secret screen";
    }
    process.stderr.write(`shud:restart: ${message}\n`);
    process.exitCode = 1;
  }
}
