import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { processStart } from "../../packages/dsh-shud-jobs/src/process-identity.ts";
import type { ShudProcessGroup } from "../../packages/dsh-shud-jobs/src/process-group.ts";
import type { RunJob } from "../../packages/dsh-shud-core/src/schemas/run-job.ts";
import { extendPrefix, object, requireFact, text } from "./shud-restart-evidence.ts";
import {
  WebHost,
  cleanupOwnedRuns,
  command,
  cwdOf,
  ownRunGroup,
  readPrivateJobs,
  readFileBounded,
  save,
  screen,
} from "./shud-web-driver.ts";
import { regular, type StoredLog } from "./shud-session-log.ts";
import { effectiveConfig } from "./shud-runtime-config.ts";
import {
  assembleReplayEvidence,
  capturePreservation,
  cloneReceipt,
  collectReplayFiles,
  collectReplayLogs,
  discoverOwnedSessions,
  replayRunPolicy,
  rememberReplayBuilds,
  preparedInputReceipt,
  type ReplayBuildBinding,
  type ReplayAssemblyInput,
} from "./shud-replay-snapshot.ts";
import type { PreservationState } from "./shud-replay-evidence.ts";
import { REPLAY_FILES } from "./shud-replay-contract.ts";
import { replayReady } from "./shud-replay-flow.ts";
import { openReplayApprovals } from "./shud-replay-approval.ts";

const ROOT = fs.realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const COMPLETE_MS = 30 * 60_000;
let sessionAttempted = false;
interface Config {
  workspace: string;
  source: string;
  design: string;
  shudBin: string;
  sundials: string;
  dshBin: string;
}

/** Side-effect free, including when invoked directly rather than through the shell wrapper. */
function replayPreflight(argv: string[]): Config {
  requireFact(
    argv.length === 1 && argv[0]?.trim(),
    "usage: shud-replay.sh <scratch-workspace>; explicit workspace required",
  );
  requireFact(process.env.DMXAPI_KEY?.trim(), "Missing DMXAPI_KEY");
  const shud = process.env.SHUD_BIN;
  requireFact(shud && isAbsolute(shud), "Missing explicit absolute SHUD_BIN");
  let shudBin: string;
  try {
    requireFact(fs.lstatSync(shud).isFile(), "SHUD_BIN must be regular");
    shudBin = fs.realpathSync(shud);
    regular(shudBin, "SHUD_BIN");
    fs.accessSync(shudBin, fs.constants.X_OK);
  } catch {
    throw new Error("Missing executable regular SHUD_BIN");
  }
  const sundials = process.env.SUNDIALS_ROOT;
  requireFact(
    sundials &&
      isAbsolute(sundials) &&
      fs.existsSync(sundials) &&
      fs.statSync(sundials).isDirectory(),
    "Missing absolute existing SUNDIALS_ROOT directory",
  );
  const input = process.env.SHUD_REPLAY_KELIYA;
  requireFact(
    typeof input === "string" &&
      input.trim() &&
      fs.existsSync(input) &&
      fs.statSync(input).isDirectory(),
    "Missing SHUD_REPLAY_KELIYA directory",
  );
  const sourceInput = input;
  const source = fs.realpathSync(sourceInput);
  for (const name of ["keliya.cfg.para", "keliya.tsd.forc"]) {
    try {
      regular(join(source, name), "SHUD_REPLAY_KELIYA input");
      fs.accessSync(join(source, name), fs.constants.R_OK);
    } catch {
      throw new Error(`Missing regular SHUD_REPLAY_KELIYA/${name}`);
    }
  }
  const forcing = join(dirname(dirname(source)), "forcing.trimmed");
  requireFact(
    fs.existsSync(forcing) &&
      fs.lstatSync(forcing).isDirectory() &&
      fs.realpathSync(forcing) === forcing &&
      !/[ \t\r\n\v\f]/u.test(forcing),
    "SHUD_REPLAY_KELIYA requires physical whitespace-free forcing.trimmed",
  );
  const design = fs.realpathSync(resolve(ROOT, "../openMP/docs/p1e/p1e_strict_omp_design.md"));
  regular(design, "P1e design document");
  requireFact(readFileBounded(design).bytes.length > 0, "Missing P1e design document contents");
  const dshBin = process.env.DSH_BIN;
  requireFact(
    dshBin && isAbsolute(dshBin) && fs.existsSync(dshBin),
    "Missing pinned DSH_BIN; use shud-replay.sh",
  );
  regular(dshBin, "pinned dsh");
  const requested = resolve(argv[0]);
  requireFact(requested !== sep, "Unsafe root workspace");
  let ancestor = requested;
  while (!fs.existsSync(ancestor)) {
    try {
      fs.lstatSync(ancestor);
      throw new Error("Unsafe dangling workspace path");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    ancestor = dirname(ancestor);
  }
  requireFact(fs.statSync(ancestor).isDirectory(), "Workspace requires a directory");
  if (fs.existsSync(requested))
    requireFact(fs.lstatSync(requested).isDirectory(), "Workspace must be an ordinary directory");
  const workspace = join(fs.realpathSync(ancestor), requested.slice(ancestor.length));
  for (const name of [
    "repos",
    "input",
    "tasks",
    "changes",
    "patches",
    "builds",
    "runs",
    "stacks",
    "provenance",
    "verifications",
    "reports",
  ]) {
    try {
      fs.lstatSync(join(workspace, name));
      throw new Error(`Occupied workspace ${name}; never overwrite replay evidence`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  requireFact(
    ["darwin", "linux"].includes(process.platform) &&
      processStart(process.pid) &&
      cwdOf(process.pid) === fs.realpathSync(process.cwd()),
    "Native ownership inspection unavailable",
  );
  for (const path of [workspace, source, design, shudBin, sundials, dshBin]) screen(path);
  return { workspace, source, design, shudBin, sundials: fs.realpathSync(sundials), dshBin };
}

const privateJobs = (workspace: string) => readPrivateJobs(workspace, 2);

async function run(config: Config, abort: AbortSignal): Promise<void> {
  abort = AbortSignal.any([abort, AbortSignal.timeout(COMPLETE_MS)]);
  const { workspace } = config;
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "shud-replay-")));
  screen(home);
  fs.chmodSync(home, 0o700);
  const evidenceDir = join(home, "replay-evidence");
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  process.stdout.write(
    `shud:replay retained workspace: ${workspace}\nshud:replay retained home: ${home}\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    PROFILE_NAME: "shud",
    PROFILE_TEMPLATE: "web",
    SHUD_BIN: config.shudBin,
    SUNDIALS_ROOT: config.sundials,
    SHUD_REPLAY_KELIYA: config.source,
  };
  delete env.ALL_PROXY;
  const groups = new Map<number, ShudProcessGroup>(),
    owners = new Set<string>();
  const ownershipReceipts = new Map<number, { capturedAt: number; job: RunJob }>();
  const buildBindings = new Map<string, ReplayBuildBinding>();
  const policy = replayRunPolicy(workspace, buildBindings);
  let before: PreservationState | undefined, after: PreservationState | undefined;
  let host: WebHost | undefined, rootId: string | undefined;
  let logs: { root: StoredLog; children: StoredLog[] } | undefined;
  let approvals:
    | {
        observe(root: StoredLog, children: StoredLog[]): void;
        healthy(): void;
        jobsTerminal(
          sessionIds: string[],
          currentJobIds: string[],
        ): Promise<{ terminal: boolean; rosters: unknown[] }>;
        close(): Promise<void>;
      }
    | undefined;
  let composed: ReplayAssemblyInput["configuration"] | undefined;
  let failure: unknown, outcome: unknown;
  let completed = false;
  let stage = "preservation-before";
  const cleanupErrors: string[] = [];
  try {
    before = await capturePreservation(ROOT, workspace, config.source);
    save(join(evidenceDir, "preservation-before.json"), before);
    stage = "prepare";
    await command(
      "sh",
      [join(ROOT, "scripts/runtime/shud-replay-prepare.sh"), workspace],
      ROOT,
      env,
      abort,
    );
    before.clone = await cloneReceipt(workspace);
    before.preparedInputSha256 = preparedInputReceipt(workspace);
    requireFact(before.preparedInputSha256, "Preparation did not publish input/keliya");
    save(join(evidenceDir, "preservation-before.json"), before);
    stage = "build";
    await command("pnpm", ["run", "build"], ROOT, env, abort);
    stage = "profile-install";
    await command("sh", [join(ROOT, "scripts/runtime/profile-install.sh")], workspace, env, abort);
    composed = effectiveConfig(
      await command(
        process.execPath,
        [config.dshBin, "--profile", "shud", "--dump-config"],
        workspace,
        env,
        abort,
      ),
      ["worker", "coder", "reviewer"],
    );
    save(join(evidenceDir, "effective-config.json"), composed);
    stage = "host-start";
    host = new WebHost(config.dshBin, workspace, env, abort, { interactions: "answer" });
    await host.ready(join(home, "profiles/shud/shud-jobs"));
    stage = "session-create";
    sessionAttempted = true;
    rootId = text(
      object(await host.rpc("session/create", { cwd: workspace, agentPreset: "coordinator" }))
        .sessionId,
    );
    approvals = await openReplayApprovals(host, home, rootId, workspace);
    stage = "replay-chain";
    const prompt = [
      `Complete one code_change replay in this workspace using the design document ${JSON.stringify(config.design)} (../openMP/docs/p1e/p1e_strict_omp_design.md) and only ${REPLAY_FILES.join(", ")}.`,
      "Execute the following stages strictly serially. Wait for each dispatched child to settle and return before dispatching the next stage; do not overlap child work. Read-only job inspection remains allowed.",
      "1. Create the code_change task.",
      "2. Delegate coder to build the clean base only, before any edit, and return its base build_id.",
      "3. Delegate coder to derive changes only in the five allowed files from the design, call change_create and change_submit, and return only after successful approval. Do not build the candidate yet.",
      `4. ONLY after successful approved change_submit and the change coder's return, delegate worker to run base keliya from ${JSON.stringify(join(workspace, "input/keliya"))} with the clean base build_id, threads: 1 and no end_days; wait for successful collection and the worker's return. Never dispatch the base worker alongside the change coder.`,
      "5. ONLY after the base run is successfully collected and its worker has returned, delegate coder to build the approved candidate with rhs_openmp: true and return its candidate build_id.",
      `6. Delegate worker to run candidate keliya from ${JSON.stringify(join(workspace, "input/keliya"))} with that candidate build_id, threads: 1 and no end_days; wait for successful collection and the worker's return.`,
      "7. ONLY after both runs are collected, delegate reviewer to verification_run on the two run ids and wait for the reviewer to settle and return.",
      "8. ONLY after the reviewer has returned, call report_generate, report_validate and report_submit in order. Wait for every child and actual job to finish.",
      "The two automatic engineering Allow once answers do not constitute PI scientific acceptance.",
    ].join("\n");
    const accepted = object(
      await host.rpc("session/prompt", {
        requestId: randomUUID(),
        sessionId: rootId,
        mode: "queue",
        content: [{ type: "text", text: prompt }],
      }),
    );
    requireFact(accepted.accepted === true, "Replay prompt not accepted");
    const deadline = Date.now() + COMPLETE_MS;
    while (Date.now() < deadline) {
      abort.throwIfAborted();
      approvals.healthy();
      const current = await collectReplayLogs(home, rootId, host);
      if (logs) {
        extendPrefix(logs.root, current.root);
        for (const previous of logs.children) {
          const next = current.children.find((child) => child.header.id === previous.header.id);
          requireFact(next, "Canonical child disappeared");
          extendPrefix(previous, next);
        }
      }
      logs = current;
      approvals.observe(logs.root, logs.children);
      rememberReplayBuilds(logs.root, logs.children, buildBindings);
      for (const child of logs.children)
        if (
          child.header.agentPreset === "worker" &&
          child.header.parentSession === rootId &&
          child.header.origin === "subagent"
        )
          owners.add(text(child.header.id));
      const jobs = privateJobs(workspace);
      for (const job of jobs)
        if (job.pid && job.pid_started_at && job.owner_session && owners.has(job.owner_session)) {
          if (ownRunGroup(job, policy, owners, groups) && !ownershipReceipts.has(job.pid)) {
            ownershipReceipts.set(job.pid, { capturedAt: Date.now(), job: structuredClone(job) });
            save(join(evidenceDir, "native-ownership.json"), [...ownershipReceipts.values()]);
          }
        }
      const idle = replayReady(logs);
      if (idle) {
        requireFact(jobs.length === 2, "Replay sessions ended without two RunJobs");
      }
      if (idle && jobs.every((job) => job.status === "collected")) {
        const roster = await approvals.jobsTerminal(
          [rootId, ...logs.children.map((child) => text(child.header.id))],
          jobs.map((job) => text(job.dsh_job_id)),
        );
        save(join(evidenceDir, "jobs-terminal.json"), roster);
        if (roster.terminal) {
          completed = true;
          break;
        }
      }
      await delay(500, undefined, { signal: abort });
    }
    requireFact(completed, "Replay execution deadline; regression evidence retained");
    logs = await collectReplayLogs(home, rootId, host);
    approvals.observe(logs.root, logs.children);
    approvals.healthy();
  } catch (error) {
    failure = error;
  } finally {
    if (approvals)
      try {
        await approvals.close();
      } catch {
        cleanupErrors.push("Approval close/drain failed");
      }
    if (host)
      try {
        await host.stop();
      } catch {
        cleanupErrors.push("Submission host ownership or shutdown unproved");
      }
    if (rootId && (!host || host.exited))
      try {
        const discovered = discoverOwnedSessions(home, rootId);
        for (const child of discovered)
          if (child.header.agentPreset === "worker") owners.add(text(child.header.id));
        const stopped = await collectReplayLogs(home, rootId);
        for (const child of discovered)
          if (!stopped.children.some((entry) => entry.header.id === child.header.id))
            stopped.children.push(child);
        const previous = new Map(
          [...(logs ? [logs.root, ...logs.children] : [])].map((log) => [text(log.header.id), log]),
        );
        for (const log of [stopped.root, ...stopped.children]) {
          const earlier = previous.get(text(log.header.id));
          if (earlier) {
            extendPrefix(earlier, log);
            log.flushedThroughSeq = earlier.flushedThroughSeq;
          }
        }
        logs = stopped;
        rememberReplayBuilds(stopped.root, stopped.children, buildBindings);
        save(join(evidenceDir, "stopped-sessions.json"), stopped, 0);
      } catch {
        cleanupErrors.push("Stopped-host descendant discovery failed; unknown work retained");
      }
    if (completed && (!host || host.exited)) {
      try {
        requireFact(
          privateJobs(workspace).length === 2 && buildBindings.size === 2,
          "Missing complete native bindings",
        );
      } catch {
        cleanupErrors.push("Completed replay lacks two distinct private build-bound runs");
      }
    }
    cleanupErrors.push(
      ...(await cleanupOwnedRuns(
        workspace,
        completed ? { ...policy, minRuns: 2 } : policy,
        owners,
        groups,
        !host || host.exited,
      )),
    );
    if (host)
      try {
        host.saveOutput(join(evidenceDir, "host.json"));
      } catch {
        cleanupErrors.push("Host output suppressed by secret screen");
      }
    if (before)
      try {
        requireFact(
          !host || host.exited,
          "Cannot certify preservation while a submission host may remain live",
        );
        after = await capturePreservation(ROOT, workspace, config.source);
        save(join(evidenceDir, "preservation-after.json"), after);
        // Loaded only after the normal build, or use direct receipt equality if preparation failed.
        // The judge's renderer loads records/lib, so this module must stay behind the build boundary.
        if (composed) {
          const { assertReplayPreservation } = await import("./shud-replay-evidence.ts");
          assertReplayPreservation(before, after, workspace);
        } else {
          requireFact(
            isDeepStrictEqual({ ...before, clone: null }, { ...after, clone: null }),
            "Source preservation failed before profile installation",
          );
        }
      } catch {
        cleanupErrors.push("Source/raw/forcing preservation failed");
      }
  }
  stage = failure ? stage : "evidence-verdict";
  try {
    requireFact(
      !host || host.exited,
      "Final evidence read withheld while a submission host may remain live",
    );
    const files = collectReplayFiles(workspace);
    if (logs && before && after && composed && rootId) {
      const snapshot = assembleReplayEvidence({
        workspace,
        home,
        rootId,
        configPath: join(evidenceDir, "effective-config.json"),
        logs,
        files,
        before,
        after,
        configuration: composed,
      });
      save(join(evidenceDir, "replay-evidence.json"), snapshot, 0);
      const { assertReplayEvidence } = await import("./shud-replay-evidence.ts");
      outcome = assertReplayEvidence(snapshot);
    } else save(join(evidenceDir, "partial-evidence.json"), { files, logs, before, after }, 0);
  } catch (error) {
    failure ??= error;
  }
  const retained = {
    workspace,
    home,
    evidenceDir,
    root: logs?.root.canonicalLog ?? null,
    children: logs?.children.map((child) => child.canonicalLog) ?? [],
  };
  let detail = failure instanceof Error ? failure.message : failure ? "Replay failed" : null;
  try {
    if (detail) screen(detail);
  } catch {
    detail = "Failure detail suppressed by secret screen";
  }
  const status = !failure && !abort.aborted && !cleanupErrors.length && outcome ? "PASS" : "FAIL";
  const verdict = {
    status,
    acceptance: "engineering-only",
    stage,
    detail,
    assertions: outcome ?? null,
    cleanupErrors,
    retained,
    hostStopped: !host || host.exited,
    ownedGroups: [...groups.keys()],
  };
  try {
    save(join(evidenceDir, "verdict.json"), verdict);
  } catch {
    verdict.status = "FAIL";
    cleanupErrors.push("Verdict persistence failed; workspace and canonical logs retained");
  }
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  if (verdict.status !== "PASS")
    throw new Error(
      `Replay failed: ${detail ?? cleanupErrors.join("; ")}; retained evidence: ${evidenceDir}`,
    );
}

async function main(): Promise<void> {
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error("Replay interrupted"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, interrupted);
  try {
    await run(replayPreflight(process.argv.slice(2)), abort.signal);
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, interrupted);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    let detail = error instanceof Error ? error.message : "Replay failed";
    try {
      screen(detail);
    } catch {
      detail = "Failure detail suppressed by secret screen";
    }
    process.stderr.write(
      `shud:replay: ${detail}\n${sessionAttempted ? "" : "shud:replay: no session started\n"}`,
    );
    process.exitCode = 1;
  }
}
