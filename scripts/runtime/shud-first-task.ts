import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";
import { parseDocument } from "yaml";
import { processStart } from "../../packages/dsh-shud-jobs/src/process-identity.ts";
import type { ShudProcessGroup } from "../../packages/dsh-shud-jobs/src/process-group.ts";
import type { FirstTaskEvidence, FirstTaskLog } from "./shud-first-task-evidence.ts";
import {
  extendPrefix,
  object,
  requireFact,
  text,
  type CanonicalEvent,
} from "./shud-restart-evidence.ts";
import {
  WebHost,
  BUFFER_LIMIT,
  canonicalLog,
  cleanupOwnedRuns,
  command,
  cwdOf,
  directoryNames,
  hashes,
  native,
  ownRunGroup,
  readFileBounded,
  readPrivateJob,
  save,
  screen,
} from "./shud-web-driver.ts";

const ROOT = fs.realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const COMPLETE_MS = 15 * 60_000;
let sessionAttempted = false;
interface Config {
  workspace: string;
  shudBin: string;
  dshBin: string;
  patch?: string;
  source: string;
  hashes: Record<string, string>;
}
interface StoredLog extends FirstTaskLog {
  byteLength: number;
}
function regular(path: string, label: string): void {
  requireFact(
    fs.lstatSync(path).isFile() && fs.realpathSync(path) === path,
    `Unsafe ${label}: regular physical file required`,
  );
}
/** External ancestor aliases are allowed; the supplied final component must be ordinary. */
function physicalInputFile(path: string, label: string): string {
  requireFact(fs.lstatSync(path).isFile(), `Unsafe ${label}: regular file required`);
  const physical = fs.realpathSync(path);
  regular(physical, label);
  return physical;
}
/** No writes, build, installation or host before all required input checks succeed. */
function preflight(argv: string[]): Config {
  requireFact(
    argv.length === 1 || (argv.length === 3 && argv[1] === "--patch"),
    "usage: shud-first-task.sh <workspace> [--patch <file>]",
  );
  requireFact(argv[0]?.trim(), "Missing workspace argument");
  requireFact(process.env.DMXAPI_KEY?.trim(), "Missing DMXAPI_KEY");
  let shudBin = process.env.SHUD_BIN;
  requireFact(shudBin && isAbsolute(shudBin), "Missing explicit absolute SHUD_BIN");
  try {
    shudBin = physicalInputFile(shudBin, "SHUD_BIN");
    fs.accessSync(shudBin, fs.constants.X_OK);
  } catch {
    throw new Error("Missing executable regular SHUD_BIN");
  }
  const dshBin = process.env.DSH_BIN;
  requireFact(
    dshBin && isAbsolute(dshBin) && fs.statSync(dshBin).isFile(),
    "Missing resolved pinned dsh; use shud-first-task.sh",
  );
  const requested = resolve(argv[0]);
  requireFact(requested !== sep, "Unsafe root workspace");
  let ancestor = requested;
  while (!fs.existsSync(ancestor)) {
    // lstat catches dangling symlinks, which existsSync alone treats as absent.
    try {
      requireFact(!fs.lstatSync(ancestor).isSymbolicLink(), "Unsafe workspace symlink");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    ancestor = dirname(ancestor);
  }
  requireFact(fs.statSync(ancestor).isDirectory(), "Workspace requires a directory");
  if (fs.existsSync(requested))
    requireFact(!fs.lstatSync(requested).isSymbolicLink(), "Unsafe workspace symlink");
  const workspace = join(fs.realpathSync(ancestor), requested.slice(ancestor.length));
  if (fs.existsSync(workspace)) {
    requireFact(fs.lstatSync(workspace).isDirectory(), "Workspace must be a directory");
    for (const name of ["tasks", "runs", "reports", "stacks", "provenance", "input/ccw"]) {
      try {
        fs.lstatSync(join(workspace, name));
        throw new Error(`Occupied workspace ${name}; never overwrite input or records`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    const input = join(workspace, "input");
    try {
      requireFact(
        fs.lstatSync(input).isDirectory() && !fs.lstatSync(input).isSymbolicLink(),
        "Unsafe input directory or symlink",
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  let patch = argv[2] === undefined ? undefined : resolve(argv[2]);
  if (patch) {
    try {
      patch = physicalInputFile(patch, "patch");
      fs.accessSync(patch, fs.constants.R_OK);
    } catch {
      throw new Error("Missing readable regular --patch overlay");
    }
    try {
      configurationRows(readFileBounded(patch).bytes.toString("utf8"), "patch overlay");
    } catch {
      throw new Error("Invalid --patch overlay: bounded YAML sequence of mapping entries required");
    }
  }
  const source = join(ROOT, "SHUD/input/ccw");
  let original: Record<string, string>;
  try {
    original = hashes(source);
    requireFact(original["ccw.cfg.para"], "Missing ccw.cfg.para");
  } catch {
    throw new Error("Missing or unsafe SHUD/input/ccw source inputs");
  }
  requireFact(
    process.platform === "darwin" || process.platform === "linux",
    "Native process inspection requires Darwin or Linux",
  );
  requireFact(
    processStart(process.pid) && cwdOf(process.pid) === fs.realpathSync(process.cwd()),
    "Native process identity inspection unavailable",
  );
  for (const path of [workspace, source, shudBin, dshBin, ...(patch ? [patch] : [])]) screen(path);
  return { workspace, shudBin, dshBin, patch, source, hashes: original };
}
function readLog(home: string, id: string, limit = BUFFER_LIMIT): StoredLog {
  const path = canonicalLog(home, id);
  regular(path, "canonical log");
  const input = readFileBounded(path, limit).bytes;
  let bytes: Buffer;
  if (path.endsWith(".zstd")) {
    const chunks: Buffer[] = [];
    let offset = 0;
    let total = 0;
    while (offset < input.length) {
      requireFact(total < limit, "Canonical log exceeds byte budget");
      const decoded: unknown = zstdDecompressSync(input.subarray(offset), {
        info: true,
        maxOutputLength: limit - total,
      });
      const value = object(decoded);
      const chunk = value.buffer;
      const consumed = object(value.engine).bytesWritten;
      requireFact(
        Buffer.isBuffer(chunk) &&
          typeof consumed === "number" &&
          consumed > 0 &&
          consumed <= input.length - offset,
        "Malformed canonical compression frame",
      );
      total += chunk.length;
      requireFact(total <= limit, "Canonical log exceeds byte budget");
      chunks.push(chunk);
      offset += consumed;
    }
    bytes = Buffer.concat(chunks, total);
  } else bytes = input;
  const source = bytes.toString("utf8");
  screen(source);
  const rows = source
    .trimEnd()
    .split("\n")
    .map((line) => object(JSON.parse(line) as unknown));
  const header = rows.shift();
  requireFact(
    header?.type === "session" && header.version === 4 && header.id === id,
    "Canonical stored header identity mismatch",
  );
  const events = rows.map((row): CanonicalEvent => {
    requireFact(
      typeof row.type === "string" &&
        typeof row.seq === "number" &&
        typeof row.time === "number" &&
        "data" in row,
      "Malformed stored canonical event",
    );
    return { type: row.type, seq: row.seq, time: row.time, data: row.data };
  });
  const prefix = { events, asOfSeq: events.length - 1 };
  extendPrefix({ asOfSeq: -1, events: [] }, prefix);
  return { ...prefix, header, canonicalLog: path, flushedThroughSeq: -1, byteLength: bytes.length };
}
async function storedLog(
  host: WebHost,
  home: string,
  id: string,
  limit = BUFFER_LIMIT,
): Promise<StoredLog> {
  // Export accepts the actual bare child UUID and flushes that live session directly.
  // HEAD of the root with descendants=true alone does NOT flush child logs.
  await host.flush(id);
  const log = readLog(home, id, limit);
  log.flushedThroughSeq = log.asOfSeq;
  return log;
}
function childIds(root: FirstTaskLog): string[] {
  let child: string | undefined;
  for (const event of root.events) {
    if (event.type !== "subagent/catalog") continue;
    const id = text(object(event.data).childId);
    requireFact(
      child === undefined || child === id,
      "First-task has unexpected additional worker children",
    );
    child = id;
  }
  return child === undefined ? [] : [child];
}
function snapshotFiles(workspace: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const budget = { remaining: BUFFER_LIMIT };
  function read(relative: string): void {
    const path = join(workspace, relative);
    regular(path, "workspace evidence");
    const file = readFileBounded(path, budget.remaining);
    budget.remaining -= file.bytes.length;
    const source = file.bytes.toString("utf8");
    screen(source);
    result[relative] = relative.endsWith(".md") ? source : (JSON.parse(source) as unknown);
  }
  for (const directory of ["tasks", "runs", "reports", "stacks", "provenance"]) {
    const path = join(workspace, directory);
    if (!fs.existsSync(path)) continue;
    requireFact(
      fs.realpathSync(path) === path && fs.lstatSync(path).isDirectory(),
      "Unsafe workspace evidence directory",
    );
    for (const name of directoryNames(path, budget)) {
      requireFact(
        /^(?:TASK|RUN|REPORT|STACK|DATA)-\d{8}T\d{6}-[0-9a-f]{4}(?:\.(?:json|md))?$/u.test(name),
        "Unexpected workspace evidence entry",
      );
      if (directory === "tasks") read(`${directory}/${name}/task.json`);
      else if (directory === "runs") {
        for (const file of ["run-job.json", "run-record.json"])
          if (fs.existsSync(join(path, name, file))) read(`${directory}/${name}/${file}`);
      } else if (name.endsWith(".json") || name.endsWith(".md")) read(`${directory}/${name}`);
    }
  }
  return result;
}
function captureCommits(): FirstTaskEvidence["actualStack"]["commits"] {
  const result = { SHUD: "", rSHUD: "", AutoSHUD: "" };
  for (const name of ["SHUD", "rSHUD", "AutoSHUD"] as const) {
    result[name] = native("git", ["-C", join(ROOT, name), "rev-parse", "HEAD"]).trim();
    requireFact(/^[0-9a-f]{40}$/u.test(result[name]), "Missing actual submodule revision");
  }
  return result;
}
function configurationRows(source: string, label: string): Record<string, unknown>[] {
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      merge: false,
      schema: "core",
      customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }],
    });
    requireFact(
      document.errors.length === 0 && document.warnings.length === 0,
      `Invalid ${label} YAML`,
    );
    const value: unknown = document.toJS({ maxAliasCount: 100 });
    requireFact(Array.isArray(value), `${label} must be a sequence`);
    return value.map(object);
  } catch {
    throw new Error(`Invalid ${label} YAML or mapping entry shape`);
  }
}
function effectiveConfig(source: string) {
  const rows = configurationRows(source, "effective profile");
  function row(id: string) {
    const found = rows.filter((entry) => entry.id === id && entry.disabled !== true);
    requireFact(found.length === 1, "Missing or ambiguous required effective profile row");
    return object(found[0].config);
  }
  const coordinator = row("preset-coordinator");
  requireFact(
    coordinator.id === "coordinator" && Array.isArray(coordinator.plugins),
    "Missing effective coordinator composition",
  );
  const delegates = coordinator.plugins
    .map(object)
    .filter(
      (entry) =>
        entry.id === "tool-subagent" &&
        entry.disabled !== true &&
        entry.name === "@deepseek-ai/dsh-tool-subagent",
    );
  requireFact(delegates.length === 1, "Missing effective coordinator delegation binding");
  const delegate = object(delegates[0].config);
  requireFact(
    delegate.provider === "spawn" &&
      delegate.agentPreset === "worker" &&
      delegate.toolName === "subagent",
    "Effective delegation must explicitly configure spawn/worker",
  );
  const jobs = row("shud-jobs");
  const llm = object(jobs.llm);
  requireFact(
    llm.base_url === row("llm-deepseek").baseURL &&
      llm.request_alias === row("agent-default-model").model,
    "Effective model capture route mismatch",
  );
  return {
    provider: "spawn",
    agentPreset: "worker",
    toolName: "subagent",
    base_url: text(llm.base_url),
    request_alias: text(llm.request_alias),
  };
}
function responseModel(worker: FirstTaskLog): string {
  const run = worker.events.find(
    (event) => event.type === "tool/call" && object(event.data).name === "shud_run",
  );
  requireFact(run, "Missing worker model provenance");
  const headers = worker.events.filter(
    (event) => event.type === "request/header" && event.seq < run.seq,
  );
  requireFact(headers.length > 0, "Missing worker request model metadata");
  return text(object(object(object(headers[headers.length - 1].data).header).config).model);
}

async function run(config: Config, abort: AbortSignal): Promise<void> {
  const workspace = config.workspace;
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  requireFact(fs.realpathSync(workspace) === workspace, "Workspace changed during admission");
  process.stdout.write(`shud:first-task retained workspace: ${workspace}\n`);
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "shud-first-task-")));
  screen(home);
  process.stdout.write(`shud:first-task retained home: ${home}\n`);
  fs.chmodSync(home, 0o700);
  const evidenceDir = join(home, "first-task-evidence");
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  const stateDir = join(home, "profiles/shud/shud-jobs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    PROFILE_NAME: "shud",
    PROFILE_TEMPLATE: "web",
    SHUD_BIN: config.shudBin,
  };
  delete env.ALL_PROXY;
  const groups = new Map<number, ShudProcessGroup>();
  const owners = new Set<string>();
  let host: WebHost | undefined;
  let approvals: { healthy(): void; close(): Promise<void> } | undefined;
  let rootId: string | undefined;
  let root: StoredLog | undefined;
  const children = new Map<string, StoredLog>();
  let outcome: unknown;
  let failure: unknown;
  let stage = "input-copy";
  const cleanupErrors: string[] = [];
  function singleRun(): string | undefined {
    const runs = join(workspace, "runs");
    if (!fs.existsSync(runs)) return undefined;
    requireFact(fs.realpathSync(runs) === runs, "Unsafe private run root");
    let selected: string | undefined;
    for (const name of directoryNames(runs)) {
      requireFact(selected === undefined, "First-task has unexpected additional runs");
      selected = name;
    }
    return selected;
  }
  function discoverRun(name: string | undefined): void {
    if (name === undefined) return;
    const run = join(workspace, "runs", name);
    if (!fs.existsSync(join(run, "run-job.json"))) return;
    const job = readPrivateJob(workspace, run);
    requireFact(job.run_dir === run, "Private run path ownership mismatch");
    if (job.pid && job.pid_started_at && job.owner_session && owners.has(job.owner_session))
      ownRunGroup(job, config.shudBin, owners, groups);
  }
  function logBudget(replacing: string): number {
    let remaining = BUFFER_LIMIT;
    if (root && root.header.id !== replacing) remaining -= root.byteLength;
    for (const [id, child] of children) if (id !== replacing) remaining -= child.byteLength;
    return remaining;
  }
  try {
    fs.mkdirSync(join(workspace, "input"), { recursive: true, mode: 0o700 });
    requireFact(
      fs.realpathSync(join(workspace, "input")) === join(workspace, "input"),
      "Unsafe input directory",
    );
    // Reserve ownership before cpSync: errorOnExist alone permits directory merges.
    fs.mkdirSync(join(workspace, "input/ccw"), { mode: 0o700 });
    fs.cpSync(config.source, join(workspace, "input/ccw"), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    requireFact(
      JSON.stringify(hashes(join(workspace, "input/ccw"))) === JSON.stringify(config.hashes),
      "ccw input copy mismatch",
    );
    save(join(evidenceDir, "input-before.json"), config.hashes);
    stage = "build";
    await command("pnpm", ["run", "build"], ROOT, env, abort);
    stage = "profile-install";
    await command("sh", [join(ROOT, "scripts/runtime/profile-install.sh")], workspace, env, abort);
    stage = "effective-config";
    const extra = config.patch ? ["--patch", config.patch] : [];
    const composed = effectiveConfig(
      await command(
        process.execPath,
        [config.dshBin, "--profile", "shud", ...extra, "--dump-config"],
        workspace,
        env,
        abort,
      ),
    );
    const configPath = join(evidenceDir, "effective-config.json");
    save(configPath, composed);
    const commits = captureCommits();
    stage = "host-start";
    host = new WebHost(config.dshBin, workspace, env, abort, {
      interactions: "answer",
      patch: config.patch,
    });
    await host.ready(stateDir);
    stage = "session-create";
    sessionAttempted = true;
    rootId = text(
      object(await host.rpc("session/create", { cwd: workspace, agentPreset: "coordinator" }))
        .sessionId,
    );
    root = await storedLog(host, home, rootId);
    // Bootstrap boundary: static imports would load built records before this
    // executable has performed its required build (and before CLI preflight).
    const { openReportApprovals } = await import("./shud-first-task-approval.ts");
    const { assertFirstTaskEvidence } = await import("./shud-first-task-evidence.ts");
    approvals = await openReportApprovals(host, rootId, workspace);
    stage = "first-task-chain";
    const accepted = object(
      await host.rpc("session/prompt", {
        requestId: randomUUID(),
        sessionId: rootId,
        mode: "queue",
        content: [
          {
            type: "text",
            text: `Create one science_assist task for ccw engineering evidence, then delegate exactly one worker using the configured subagent tool (it explicitly selects worker; do not supply unsupported agent_preset). Give it the created task_id and input_dir ${JSON.stringify(join(workspace, "input/ccw"))}. The worker must call shud_run once with that task_id, project ccw and end_days 30, wait using job_output with returned dsh_job_id and wait:true, then successfully shud_collect using the persistent run_id or JOB identifier before returning run_id and terminal status. After the worker returns, generate an evidence report, validate it, and submit the successfully validated report via report_submit. If validation fails, generate and validate a corrected report rather than submit the failed draft. Do not run SHUD directly as coordinator, create extra runs, change scientific inputs, or claim scientific validation. This script answers only the owned report submission approval; it is an engineering gate, not PI functional acceptance.`,
          },
        ],
      }),
    );
    requireFact(accepted.accepted === true, "First-task prompt was not accepted");
    const deadline = Date.now() + COMPLETE_MS;
    let terminal = false;
    while (Date.now() < deadline) {
      approvals.healthy();
      const current = await storedLog(host, home, rootId, logBudget(rootId));
      extendPrefix(root, current);
      root = current;
      const ids = childIds(root);
      const runName = singleRun();
      for (const id of ids) {
        const child = await storedLog(host, home, id, logBudget(id));
        const previous = children.get(id);
        if (previous) extendPrefix(previous, child);
        requireFact(
          child.header.parentSession === rootId &&
            child.header.origin === "subagent" &&
            child.header.agentPreset === "worker",
          "Worker canonical ownership mismatch",
        );
        children.set(id, child);
        owners.add(id);
      }
      discoverRun(runName);
      const submitCalls = root.events.filter(
        (event) => event.type === "tool/call" && object(event.data).name === "report_submit",
      );
      terminal = submitCalls.some((call) =>
        root?.events.some(
          (event) =>
            event.type === "tool/result" &&
            object(object(event.data).message).toolCallId === object(call.data).callId,
        ),
      );
      if (terminal) break;
      const ends = root.events.filter((event) => event.type === "turn/end");
      const notices = root.events.filter(
        (event) =>
          event.type === "user/message" &&
          object(object(event.data).source).kind === "subagent-settled",
      );
      if (
        ends.length &&
        (!children.size ||
          (notices.length && ends[ends.length - 1].seq > notices[notices.length - 1].seq))
      )
        throw new Error("First-task coordinator completed without report submission");
      await delay(500, undefined, { signal: abort });
    }
    requireFact(terminal, "First-task chain deadline");
    approvals.healthy();
    stage = "evidence-verdict";
    const finalRoot = await storedLog(host, home, rootId, logBudget(rootId));
    extendPrefix(root, finalRoot);
    root = finalRoot;
    const finalChildren = childIds(root);
    requireFact(finalChildren.length === 1, "First-task requires one catalog-bound worker");
    singleRun();
    for (const id of finalChildren) {
      const child = await storedLog(host, home, id, logBudget(id));
      const previous = children.get(id);
      if (previous) extendPrefix(previous, child);
      requireFact(
        child.header.parentSession === rootId &&
          child.header.origin === "subagent" &&
          child.header.agentPreset === "worker",
        "Final worker canonical ownership mismatch",
      );
      children.set(id, child);
      owners.add(id);
    }
    approvals.healthy();
    requireFact(children.size === 1, "First-task requires one owned worker");
    const worker = [...children.values()][0];
    const snapshot: FirstTaskEvidence = {
      workspace,
      home,
      root,
      children: [...children.values()],
      files: snapshotFiles(workspace),
      actualStack: {
        commits,
        llm: {
          base_url: composed.base_url,
          request_alias: composed.request_alias,
          response_model: responseModel(worker),
        },
      },
      delegationBinding: {
        parentSessionId: rootId,
        configPath,
        provider: composed.provider,
        agentPreset: composed.agentPreset,
        toolName: composed.toolName,
      },
      inputs: {
        before: config.hashes,
        sourceAfter: hashes(config.source),
        copyAfter: hashes(join(workspace, "input/ccw")),
      },
    };
    save(join(evidenceDir, "first-task-evidence.json"), snapshot);
    requireFact(
      JSON.stringify(captureCommits()) === JSON.stringify(commits),
      "Scientific stack revisions changed",
    );
    outcome = assertFirstTaskEvidence(snapshot);
  } catch (error) {
    failure = error;
  } finally {
    if (approvals) {
      try {
        await approvals.close();
      } catch {
        cleanupErrors.push("Approval stream cleanup failed");
      }
    }
    if (host) {
      try {
        await host.stop();
      } catch {
        cleanupErrors.push("Unsafe Web host cleanup; process may remain live");
      }
    }
    // Read stopped-host durable logs too: a lost tool result/catalog response cannot
    // authorize a signal, but a real child header can recover its owner association.
    if (rootId) {
      try {
        root = readLog(home, rootId, logBudget(rootId));
        const ids = new Set(childIds(root));
        const sessions = join(home, "sessions");
        const discovery = { remaining: BUFFER_LIMIT };
        for (const project of directoryNames(sessions, discovery)) {
          const directory = join(sessions, project);
          if (!fs.lstatSync(directory).isDirectory()) continue;
          for (const id of directoryNames(directory, discovery)) {
            if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id) || ids.has(id)) continue;
            requireFact(
              ids.size === 0,
              "Unsafe additional worker directories; ownership remains unproved",
            );
            ids.add(id);
          }
        }
        for (const id of ids) {
          const child = readLog(home, id, logBudget(id));
          if (
            child.header.parentSession === rootId &&
            child.header.origin === "subagent" &&
            child.header.agentPreset === "worker"
          ) {
            children.set(id, child);
            owners.add(id);
          }
        }
      } catch {
        cleanupErrors.push(
          "Unsafe canonical discovery: additional or unavailable worker evidence; unknown work remains unproved",
        );
      }
    }
    cleanupErrors.push(
      ...(await cleanupOwnedRuns(workspace, config.shudBin, owners, groups, !host || host.exited)),
    );
    if (host) {
      try {
        host.saveOutput(join(evidenceDir, "host.json"));
      } catch {
        cleanupErrors.push("Host output suppressed by secret screen");
      }
    }
    try {
      const sourceAfter = hashes(config.source),
        copyAfter = hashes(join(workspace, "input/ccw"));
      save(join(evidenceDir, "input-after.json"), { sourceAfter, copyAfter });
      requireFact(
        JSON.stringify(sourceAfter) === JSON.stringify(config.hashes) &&
          JSON.stringify(copyAfter) === JSON.stringify(config.hashes),
        "Input preservation failed",
      );
    } catch {
      cleanupErrors.push("Input preservation failed");
    }
  }
  const retained = {
    workspace,
    home,
    root: root?.canonicalLog ?? null,
    children: [...children.values()].map((child) => child.canonicalLog),
    evidenceDir,
  };
  let code =
    failure instanceof Error &&
    "code" in failure &&
    typeof failure.code === "string" &&
    /^FIRST_TASK_[A-Z_]+$/u.test(failure.code)
      ? failure.code
      : `FIRST_TASK_${stage.toUpperCase().replaceAll("-", "_")}`;
  let status = !failure && !abort.aborted && !cleanupErrors.length && outcome ? "PASS" : "FAIL";
  try {
    save(join(evidenceDir, "verdict.json"), {
      status,
      ...(status === "PASS" ? { assertions: outcome } : { code }),
      cleanupErrors,
      retained,
      hostStopped: !host || host.exited,
      ownedGroups: [...groups.keys()],
      overlay: config.patch ?? null,
    });
  } catch {
    cleanupErrors.push("Verdict persistence failed; retained paths remain available");
    status = "FAIL";
    if (!failure) code = "FIRST_TASK_EVIDENCE_WRITE";
  }
  process.stdout.write(
    `${JSON.stringify({ status, ...(status === "FAIL" ? { code } : { assertions: outcome }), retained, cleanupErrors })}\n`,
  );
  if (status === "FAIL")
    throw new Error(`shud:first-task ${code}; retained evidence: ${evidenceDir}`, {
      cause: failure,
    });
}
async function main(): Promise<void> {
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error("First-task gate interrupted"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, interrupted);
  try {
    const config = preflight(process.argv.slice(2));
    await run(config, abort.signal);
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, interrupted);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    let message = error instanceof Error ? error.message : "First-task gate failed";
    if (/^[A-Z_]+:|^Unexpected token|^Expected property name/u.test(message))
      message = "First-task input or evidence operation failed";
    try {
      screen(message);
    } catch {
      message = "Failure detail suppressed by secret screen";
    }
    process.stderr.write(`shud:first-task: ${message}\n`);
    if (!sessionAttempted) process.stderr.write("shud:first-task: no session started\n");
    process.exitCode = 1;
  }
}
