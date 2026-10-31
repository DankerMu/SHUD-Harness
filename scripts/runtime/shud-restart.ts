import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { RunJob } from "../../packages/dsh-shud-core/src/schemas/run-job.ts";
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
  type CanonicalPrefix,
  type ProcessSample,
  type RestartEvidence,
  type RestartSignal,
  type WrapperFile,
} from "./shud-restart-evidence.ts";
import {
  WebHost,
  canonicalLog,
  cleanupOwnedRuns,
  command,
  cwdOf,
  hashes,
  load,
  native,
  readPrivateJob,
  save,
  screen,
  STOP_MS,
  within,
} from "./shud-web-driver.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SUBMIT_MS = 180_000;
const COMPLETE_MS = 15 * 60_000;
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
  function recordSample(phase: ProcessSample["phase"]): void {
    requireFact(original, "Cannot sample before submission");
    const job = readPrivateJob(workspace, original.run_dir);
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
    sessionId = text(
      object(
        await first.rpc("session/create", {
          cwd: workspace,
          agentPreset: "worker",
        }),
      ).sessionId,
    );
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
        original = readPrivateJob(workspace, tool.run_dir);
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
        cleanupErrors.push(`Unsafe Web host cleanup: PID ${host.identity.pid} may remain live`);
      }
    }
    cleanupErrors.push(
      ...(await cleanupOwnedRuns(
        workspace,
        config.shudBin,
        new Set(sessionId ? [sessionId] : []),
        groups,
        hosts.every((host) => host.exited),
        (job) =>
          requireFact(
            !sampleProcesses(job, config.shudBin, "completion").solvers.length,
            "Solver outlived unowned wrapper",
          ),
      )),
    );
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
