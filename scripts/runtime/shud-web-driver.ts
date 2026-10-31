import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { RunJobSchema, type RunJob } from "../../packages/dsh-shud-core/src/schemas/run-job.ts";
import {
  processExecutionState,
  processStart,
} from "../../packages/dsh-shud-jobs/src/process-identity.ts";
import {
  recoverProcessGroup,
  type ShudProcessGroup,
} from "../../packages/dsh-shud-jobs/src/process-group.ts";
import {
  object,
  ownChildOutput,
  requireFact,
  text,
  type CanonicalEvent,
  type CanonicalPrefix,
  type ChildOutput,
  type Identity,
  type RestartSignal,
} from "./shud-restart-evidence.ts";

export const BUFFER_LIMIT = 8 * 1024 * 1024;
export const HTTP_MS = 15_000;
export const STOP_MS = 15_000;
const START_MS = 60_000;
const secrets = new Set<string>();
if (process.env.DMXAPI_KEY) secrets.add(process.env.DMXAPI_KEY);
export function screen(value: string): void {
  requireFact(
    ![...secrets].some((secret) => value.includes(secret)) &&
      !/DMXAPI_KEY\s*=|\bsk-[A-Za-z0-9_-]{16,}|[?&]token=|set-cookie:|dsh-auth-/iu.test(value),
    "Secret detected; evidence suppressed",
  );
}
export function save(path: string, value: unknown): void {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  requireFact(Buffer.byteLength(bytes) <= BUFFER_LIMIT, "Retained evidence exceeds byte budget");
  screen(bytes);
  fs.writeFileSync(path, bytes, { mode: 0o600 });
}
/** One descriptor proves type, size and wrapper metadata; never block opening a FIFO. */
export function readFileBounded(path: string, limit = BUFFER_LIMIT) {
  requireFact(
    Number.isSafeInteger(limit) && limit >= 0 && limit <= BUFFER_LIMIT,
    "Invalid evidence byte budget",
  );
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    requireFact(stat.isFile(), "Evidence source is not a regular file");
    requireFact(
      Number.isSafeInteger(stat.size) && stat.size <= limit,
      "Evidence file exceeds byte budget",
    );
    // Snapshot the observed length; a concurrent log append cannot expand this read.
    const buffer = Buffer.allocUnsafe(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
      requireFact(length <= limit, "Evidence read exceeds byte budget");
    }
    requireFact(length === stat.size, "Evidence file changed during bounded read");
    return { bytes: buffer, stat };
  } finally {
    fs.closeSync(fd);
  }
}

/** Streaming discovery keeps directory fanout out of unbounded readdir arrays. */
export function* directoryNames(
  path: string,
  budget = { remaining: BUFFER_LIMIT },
): Generator<string> {
  const directory = fs.opendirSync(path, { bufferSize: 1 });
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) return;
      budget.remaining -= Buffer.byteLength(entry.name) + 1;
      requireFact(budget.remaining >= 0, "Directory discovery exceeds byte budget");
      yield entry.name;
    }
  } finally {
    directory.closeSync();
  }
}

export function load(path: string, budget?: { remaining: number }): unknown {
  const file = readFileBounded(path, budget?.remaining ?? BUFFER_LIMIT);
  if (budget) budget.remaining -= file.bytes.length;
  const bytes = file.bytes.toString("utf8");
  screen(bytes);
  return JSON.parse(bytes) as unknown;
}
export function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}
export function native(command: string, args: string[]): string {
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
export function cwdOf(pid: number): string {
  if (process.platform === "linux") return fs.realpathSync(`/proc/${pid}/cwd`);
  const rows = native("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .split("\n")
    .filter((line) => line.startsWith("n"));
  requireFact(rows.length === 1, "Cannot determine process cwd");
  return fs.realpathSync(rows[0].slice(1));
}
export function hashes(directory: string): Record<string, string> {
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
export class WebHost {
  child: ChildProcess;
  handles: ChildOutput;
  identity: Identity;
  output = "";
  outputBytes = 0;
  failure: Error | undefined;
  exited = false;
  origin = "";
  cookie = "";
  launchToken = "";
  abort: AbortSignal;
  options: { interactions?: "none" | "answer"; patch?: string };

  constructor(
    bin: string,
    workspace: string,
    env: NodeJS.ProcessEnv,
    abort: AbortSignal,
    options: { interactions?: "none" | "answer"; patch?: string } = {},
  ) {
    this.options = options;
    this.abort = abort;
    this.child = spawn(
      process.execPath,
      [
        bin,
        "--profile",
        "shud",
        ...(options.patch ? ["--patch", options.patch] : []),
        "--no-open",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ],
      {
        cwd: workspace,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.handles = ownChildOutput(this.child, "Web host", workspace, STOP_MS);
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
    connect.searchParams.set("interactions", this.options.interactions ?? "none");
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
  async rpc(method: string, request: unknown, signal?: AbortSignal): Promise<unknown> {
    this.healthy();
    const rpcId = randomUUID();
    const abort = AbortSignal.any([
      this.abort,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(HTTP_MS),
    ]);
    const response = await fetch(new URL(`/api/${method}`, this.origin), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", cookie: this.cookie },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method,
        payload: { args: method === "$events/result" ? request : { request } },
      }),
      signal: abort,
    });
    if (response.status !== 200 || !response.body) {
      let cleanupFailed = false;
      try {
        await response.body?.cancel();
      } catch {
        cleanupFailed = true;
      }
      throw new Error(
        `Public ${method} HTTP failure${cleanupFailed ? "; response cleanup failed" : ""}`,
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    let cancellation: Promise<void> | undefined;
    let failed = false;
    let failure: unknown;
    let cleanupFailed = false;
    const cancelRead = () => {
      cancellation ??= reader.cancel(abort.reason);
      // The promise is also awaited below; an abort callback must not leak a rejection.
      void cancellation.catch(() => undefined);
    };
    abort.addEventListener("abort", cancelRead, { once: true });
    if (abort.aborted) cancelRead();
    try {
      while (true) {
        abort.throwIfAborted();
        const next = await reader.read();
        abort.throwIfAborted();
        if (next.done) break;
        const chunk: unknown = next.value;
        requireFact(chunk instanceof Uint8Array, "Public RPC returned a non-byte chunk");
        size += chunk.byteLength;
        requireFact(size <= BUFFER_LIMIT, "Public RPC exceeds byte budget");
        chunks.push(chunk);
      }
    } catch (error) {
      failed = true;
      failure = abort.aborted ? abort.reason : error;
    } finally {
      abort.removeEventListener("abort", cancelRead);
      try {
        await (cancellation ?? reader.cancel());
      } catch {
        cleanupFailed = true;
      }
      try {
        reader.releaseLock();
      } catch {
        cleanupFailed = true;
      }
    }
    if (failed) throw failure;
    requireFact(!cleanupFailed, `Public ${method} response cleanup failed`);
    abort.throwIfAborted();
    const bytes = Buffer.concat(chunks).toString("utf8");
    screen(bytes);
    const envelope = object(JSON.parse(bytes) as unknown);
    requireFact(
      envelope.type === "server-response" && envelope.rpcId === rpcId,
      "Public RPC correlation mismatch",
    );
    const result = object(envelope.result);
    requireFact(
      result.ok === true && (method === "$events/result" || "value" in result),
      `Public ${method} returned an RPC error`,
    );
    return result.value;
  }
  async prefix(sessionId: string, signal?: AbortSignal): Promise<CanonicalPrefix> {
    const projection = object(await this.rpc("session/projections", { sessionId }, signal));
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
        await this.rpc(
          "session/page",
          {
            address: { kind: "session", sessionId },
            throughSeq: asOfSeq,
            beforeSeq,
            maxMessages: 64,
          },
          signal,
        ),
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
  async flush(sessionId: string, includeDescendants = false): Promise<void> {
    const url = new URL("/api/session.export", this.origin);
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("includeDescendants", String(includeDescendants));
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
    await this.handles.cleanup(async () => {
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
    });
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

export function canonicalLog(home: string, sessionId: string): string {
  requireFact(
    /^(?:session-[A-Za-z0-9-]+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u.test(sessionId),
    "Invalid canonical session identity",
  );
  const root = join(home, "sessions");
  const budget = { remaining: BUFFER_LIMIT };
  let directory: string | undefined;
  for (const project of directoryNames(root, budget)) {
    const candidate = join(root, project, sessionId);
    if (!fs.existsSync(candidate)) continue;
    requireFact(directory === undefined, "Missing or ambiguous canonical session directory");
    directory = candidate;
  }
  requireFact(directory, "Missing or ambiguous canonical session directory");
  let selected: { name: string; version: number } | undefined;
  let ambiguous = false;
  for (const name of directoryNames(directory, budget)) {
    const match = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/u.exec(name);
    if (!match) continue;
    const version = Number(match[1] ?? 0);
    if (!selected || version > selected.version) {
      selected = { name, version };
      ambiguous = false;
    } else if (version === selected.version) ambiguous = true;
  }
  requireFact(selected && !ambiguous, "Missing or ambiguous canonical log generation");
  return join(directory, selected.name);
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

export async function command(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  abort: AbortSignal,
): Promise<string> {
  abort.throwIfAborted();
  const child = spawn(binary, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handles = ownChildOutput(child, "build/installer", cwd, STOP_MS);
  let exited = false;
  let failed = false;
  let output = "";
  let stdout = "";
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
      else {
        output += chunk;
        if (stream === child.stdout) stdout += chunk;
      }
    });
  }
  let group: ShudProcessGroup | undefined;
  await handles.run(
    async () => {
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
      await handles.drain();
      screen(output);
      requireFact(
        exited && !failed && child.exitCode === 0,
        "Build or profile installation failed (captured output suppressed)",
      );
    },
    async () => {
      if (group) await stopGroup(group);
      else
        requireFact(exited, "Unsafe to clean up build/installer without original birth identity");
    },
  );
  return stdout;
}

export function readPrivateJob(
  workspace: string,
  runDir: string,
  budget?: { remaining: number },
): RunJob {
  requireFact(
    fs.realpathSync(runDir) === runDir && within(join(workspace, "runs"), runDir),
    "Run directory is not private",
  );
  const parsed = RunJobSchema.safeParse(load(join(runDir, "run-job.json"), budget));
  requireFact(parsed.success, "Malformed canonical RunJob");
  return parsed.data;
}

/** Capture only a live, cwd/command/wrapper/owner-bound leader; never signal by ledger PID. */
export function ownRunGroup(
  job: RunJob,
  shudBin: string,
  owners: ReadonlySet<string>,
  groups: Map<number, ShudProcessGroup>,
  budget?: { remaining: number },
): boolean {
  requireFact(
    job.owner_session &&
      owners.has(job.owner_session) &&
      job.pid &&
      job.pid_started_at &&
      JSON.stringify(job.command) === JSON.stringify([shudBin, "-o", "output/ccw.out", "ccw"]),
    "Cleanup run ownership mismatch",
  );
  if (groups.has(job.pid)) return true;
  const state = processExecutionState(job.pid);
  if (!state || state.state.startsWith("Z")) return false;
  requireFact(cwdOf(job.pid) === job.run_dir, "Cleanup wrapper cwd/pid mismatch");
  const wrapper = readFileBounded(
    join(job.run_dir, "wrapper.pid"),
    budget?.remaining ?? BUFFER_LIMIT,
  );
  if (budget) budget.remaining -= wrapper.bytes.length;
  requireFact(
    wrapper.bytes.toString("utf8").trim() === String(job.pid),
    "Cleanup wrapper cwd/pid mismatch",
  );
  groups.set(job.pid, recoverProcessGroup({ pid: job.pid, pid_started_at: job.pid_started_at }));
  return true;
}

/** Discover durable admissions even after a lost submission result; retain every unsafe identity. */
export async function cleanupOwnedRuns(
  workspace: string,
  shudBin: string,
  owners: ReadonlySet<string>,
  groups: Map<number, ShudProcessGroup>,
  hostsStopped: boolean,
  assertStopped?: (job: RunJob) => void,
): Promise<string[]> {
  const errors: string[] = [];
  if (!hostsStopped) return ["Solver cleanup withheld while a submission host may remain live"];
  const runs = join(workspace, "runs");
  if (owners.size && fs.existsSync(runs)) {
    try {
      requireFact(fs.realpathSync(runs) === runs, "Cleanup run root is not private");
      // Restart retains its existing per-run inspection/sampling contract. The
      // first-task caller has no historical-group sampler and admits one run.
      const entries: string[] = assertStopped ? fs.readdirSync(runs) : [];
      const budget = assertStopped ? undefined : { remaining: BUFFER_LIMIT };
      if (assertStopped) {
        if (entries.length !== 1)
          errors.push("Private workspace contains unexpected additional or missing runs");
      } else {
        for (const name of directoryNames(runs, budget)) {
          if (entries.length) {
            errors.push("Unsafe additional private runs: undiscovered ownership remains unproved");
            break;
          }
          entries.push(name);
        }
        if (!entries.length)
          errors.push("Private workspace contains unexpected additional or missing runs");
      }
      for (const name of entries) {
        try {
          const job = readPrivateJob(workspace, join(runs, name), budget);
          if (!assertStopped)
            requireFact(job.run_dir === join(runs, name), "Cleanup run path ownership mismatch");
          if (!ownRunGroup(job, shudBin, owners, groups, budget)) {
            requireFact(
              assertStopped,
              "Historical group quiescence unproved; descendants may remain live",
            );
            assertStopped(job);
          }
        } catch {
          errors.push(
            assertStopped
              ? "Unsafe to clean up private run: persisted ownership unproved"
              : "Unsafe to clean up private run: persisted ownership or historical group quiescence unproved",
          );
        }
      }
    } catch {
      errors.push("Unsafe to inspect private runs for cleanup");
    }
  } else if (!assertStopped && fs.existsSync(runs)) {
    errors.push("Unsafe to clean up private runs without canonical owner identity");
  }
  for (const group of groups.values()) {
    try {
      await stopGroup(group);
    } catch {
      errors.push("Unsafe to clean up solver: original group ownership or quiescence unproved");
    }
  }
  return errors;
}
