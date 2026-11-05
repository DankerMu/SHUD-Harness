import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { runGit } from "../../packages/dsh-shud-core/src/stack-lock/repository-revision.ts";
import { BuildRecordSchema, type RunJob } from "../../packages/dsh-shud-core/src/schemas/index.ts";
import { object, requireFact, text } from "./shud-restart-evidence.ts";
import {
  BUFFER_LIMIT,
  directoryNames,
  load,
  readFileBounded,
  screen,
  type NativeRunPolicy,
} from "./shud-web-driver.ts";
import {
  regular,
  readLog,
  storedLog,
  type StoredLog,
  type SessionLog,
} from "./shud-session-log.ts";
import type { WebHost } from "./shud-web-driver.ts";
import type { PreservationState, ReplayEvidence } from "./shud-replay-evidence.ts";
import {
  argumentsOf,
  calls,
  completedResultFor,
  data,
  resultFor,
  resultObject,
} from "./shud-evidence-events.ts";
import { REPLAY_COMMIT } from "./shud-replay-contract.ts";

export interface ReplayBuildBinding {
  taskId: string;
  changeId: string | null;
}

export interface ReplayAssemblyInput {
  workspace: string;
  home: string;
  rootId: string;
  configPath: string;
  logs: { root: SessionLog; children: SessionLog[] };
  files: Record<string, unknown>;
  before: PreservationState;
  after: PreservationState;
  configuration: {
    base_url: string;
    request_alias: string;
    delegations: { provider: string; agentPreset: string; toolName: string }[];
  };
}

/** Package complete evidence before judging; observed per-run models remain in canonical logs. */
export function assembleReplayEvidence(input: ReplayAssemblyInput): ReplayEvidence {
  const { workspace, home, rootId, configPath, logs, files, before, after, configuration } = input;
  requireFact(before.clone, "Missing private clone receipt");
  return {
    workspace,
    home,
    ...logs,
    files,
    delegationBindings: configuration.delegations.map((entry) => ({
      ...entry,
      parentSessionId: rootId,
      configPath,
    })),
    actualStack: {
      commits: {
        SHUD: before.clone.head,
        rSHUD: before.repositories.rSHUD.head,
        AutoSHUD: before.repositories.AutoSHUD.head,
      },
      llm: {
        base_url: configuration.base_url,
        request_alias: configuration.request_alias,
      },
    },
    preservation: { before, after },
  };
}

export function rememberReplayBuilds(
  root: SessionLog,
  children: SessionLog[],
  bindings: Map<string, ReplayBuildBinding>,
): void {
  const created = calls(root, "task_create");
  if (!created.length) return;
  requireFact(
    created.length === 1 && root.header.agentPreset === "coordinator",
    "Cleanup task producer identity",
  );
  const taskResult = root.events.find(
    (event) =>
      event.type === "tool/result" &&
      object(data(event).message).toolCallId === data(created[0]).callId,
  );
  if (!taskResult) return;
  const taskId = text(resultObject(resultFor(root, created[0], "TASK_CREATE")).task_id);
  for (const child of children) {
    requireFact(
      child.header.parentSession === root.header.id && child.header.origin === "subagent",
      "Cleanup build caller ownership",
    );
    for (const call of calls(child, "shud_build")) {
      if (
        !child.events.some(
          (event) =>
            event.type === "tool/result" &&
            object(data(event).message).toolCallId === data(call).callId,
        )
      )
        continue;
      const completed = completedResultFor(child, call, "SHUD_BUILD");
      if (object(data(completed).message).isError === true) continue;
      requireFact(
        child.header.agentPreset === "coder" && argumentsOf(call).task_id === taskId,
        "Cleanup build task/role binding",
      );
      const output = resultObject(resultFor(child, call, "SHUD_BUILD"));
      const changeId =
        argumentsOf(call).change_id === undefined ? null : text(argumentsOf(call).change_id);
      requireFact(
        output.change_id === changeId && output.source_commit === REPLAY_COMMIT,
        "Cleanup build source identity",
      );
      const buildId = text(output.build_id),
        previous = bindings.get(buildId);
      requireFact(
        !previous || (previous.taskId === taskId && previous.changeId === changeId),
        "Cleanup build identity changed",
      );
      requireFact(
        bindings.has(buildId) ||
          (bindings.size < 2 &&
            ![...bindings.values()].some(
              (entry) => (entry.changeId === null) === (changeId === null),
            )),
        "Cleanup requires distinct base/candidate builds",
      );
      bindings.set(buildId, { taskId, changeId });
    }
  }
}

const HASH_LIMIT = 512 * 1024 * 1024;
interface Budget {
  remaining: number;
}

function digest(path: string, algorithm: "sha256" | "md5", budget: Budget) {
  regular(path, "digest source");
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd);
    requireFact(
      before.isFile() && before.size <= budget.remaining,
      `Hash byte budget exceeded: ${path}`,
    );
    budget.remaining -= before.size;
    const hash = createHash(algorithm);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, before.size));
    let offset = 0;
    while (offset < before.size) {
      const count = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      requireFact(count > 0, "Digest source truncated");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(fd),
      current = fs.lstatSync(path);
    requireFact(
      before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        current.ino === before.ino &&
        current.dev === before.dev &&
        !current.isSymbolicLink(),
      "Digest source changed",
    );
    return { sha256: hash.digest("hex"), size_bytes: before.size };
  } finally {
    fs.closeSync(fd);
  }
}

function walk(
  directory: string,
  consume: (path: string) => void,
  budget: Budget,
  inventoryOnly = false,
): void {
  requireFact(
    fs.lstatSync(directory).isDirectory() && fs.realpathSync(directory) === directory,
    `Unsafe evidence directory: ${directory}`,
  );
  for (const name of directoryNames(directory, budget)) {
    const path = join(directory, name),
      stat = fs.lstatSync(path);
    requireFact(inventoryOnly || !stat.isSymbolicLink(), `Symbolic evidence path: ${path}`);
    if (stat.isDirectory()) walk(path, consume, budget, inventoryOnly);
    else {
      requireFact(inventoryOnly || stat.isFile(), `Special evidence path: ${path}`);
      consume(path);
    }
  }
}
function treeHashes(
  directory: string,
  algorithm: "sha256" | "md5",
  hashBudget: Budget,
  absolute = false,
) {
  const values: Record<string, string> = {};
  walk(
    directory,
    (path) => {
      values[absolute ? path : relative(directory, path)] = digest(
        path,
        algorithm,
        hashBudget,
      ).sha256;
    },
    { remaining: BUFFER_LIMIT },
  );
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function entryExists(path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export function preparedInputReceipt(workspace: string): Record<string, string> | null {
  const directory = join(workspace, "input/keliya");
  if (!fs.existsSync(directory)) return null;
  return treeHashes(directory, "sha256", { remaining: HASH_LIMIT });
}

export async function cloneReceipt(workspace: string) {
  const clone = join(workspace, "repos/SHUD");
  if (!fs.existsSync(clone)) return null;
  requireFact(
    fs.realpathSync(clone) === clone && fs.lstatSync(clone).isDirectory(),
    "Unsafe private clone",
  );
  const head = (await runGit(clone, ["rev-parse", "HEAD"], { maxBuffer: BUFFER_LIMIT })).stdout
    .toString("utf8")
    .trim();
  const gitDir = (
    await runGit(clone, ["rev-parse", "--absolute-git-dir"], { maxBuffer: BUFFER_LIMIT })
  ).stdout
    .toString("utf8")
    .trim();
  requireFact(
    fs.realpathSync(gitDir) === gitDir && fs.lstatSync(gitDir).isDirectory(),
    "Unsafe private git directory",
  );
  return { head, gitDir };
}

export async function capturePreservation(
  root: string,
  workspace: string,
  source: string,
): Promise<PreservationState> {
  const hashBudget = { remaining: HASH_LIMIT };
  const repositories = {} as PreservationState["repositories"];
  for (const name of ["SHUD", "rSHUD", "AutoSHUD"] as const) {
    const repo = join(root, name);
    const head = (await runGit(repo, ["rev-parse", "HEAD"], { maxBuffer: BUFFER_LIMIT })).stdout
      .toString("utf8")
      .trim();
    const status = (await runGit(repo, ["status"], { maxBuffer: BUFFER_LIMIT })).stdout.toString(
      "utf8",
    );
    const diff = (await runGit(repo, ["diff", "--binary", "HEAD"], { maxBuffer: BUFFER_LIMIT }))
      .stdout;
    screen(status);
    repositories[name] = {
      head,
      status,
      diffSha256: createHash("sha256").update(diff).digest("hex"),
    };
  }
  const absoluteGitDir = (
    await runGit(join(root, "SHUD"), ["rev-parse", "--absolute-git-dir"], {
      maxBuffer: BUFFER_LIMIT,
    })
  ).stdout
    .toString("utf8")
    .trim();
  const inventory: string[] = [];
  walk(
    absoluteGitDir,
    (path) => inventory.push(relative(absoluteGitDir, path)),
    { remaining: BUFFER_LIMIT },
    true,
  );
  inventory.sort();
  const dotGit = join(root, "SHUD/.git");
  const gitlink = fs.lstatSync(dotGit).isFile();
  const raw = join(root, "data/raw"),
    workspaceRaw = join(workspace, "data/raw");
  const rawRoots = { harness: entryExists(raw), workspace: entryExists(workspaceRaw) };
  const rawHashes: Record<string, string> = {};
  for (const [label, path] of [
    ["harness", raw],
    ["workspace", workspaceRaw],
  ])
    if (entryExists(path)) {
      for (const [name, hash] of Object.entries(treeHashes(path, "md5", hashBudget)))
        rawHashes[`${label}/${name}`] = hash;
    }
  return {
    clone: await cloneReceipt(workspace),
    repositories,
    preparedInputSha256: preparedInputReceipt(workspace),
    shudGit: {
      kind: gitlink ? "gitlink" : "directory",
      bytes: gitlink ? readFileBounded(dotGit).bytes.toString("utf8") : null,
      absoluteGitDir,
      inventory,
    },
    ccwMd5: treeHashes(join(root, "SHUD/input/ccw"), "md5", hashBudget),
    raw: { exists: rawRoots.harness || rawRoots.workspace, md5: rawHashes, roots: rawRoots },
    keliyaSourceSha256: treeHashes(source, "sha256", hashBudget),
    forcingSha256: treeHashes(
      join(dirname(dirname(source)), "forcing.trimmed"),
      "sha256",
      hashBudget,
      true,
    ),
  };
}

export function collectReplayFiles(workspace: string): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  const names = { remaining: BUFFER_LIMIT },
    bytes = { remaining: BUFFER_LIMIT },
    hashBudget = { remaining: HASH_LIMIT };
  for (const directory of [
    "tasks",
    "changes",
    "patches",
    "builds",
    "runs",
    "stacks",
    "provenance",
    "verifications",
    "reports",
    "input/keliya",
  ]) {
    const root = join(workspace, directory);
    if (!fs.existsSync(root)) continue;
    walk(
      root,
      (path) => {
        const name = relative(workspace, path);
        const json =
          /^(?:tasks\/[^/]+\/task|changes\/[^/]+|builds\/[^/]+\/build-record|runs\/[^/]+\/run-(?:job|record)|stacks\/[^/]+|provenance\/[^/]+|verifications\/[^/]+|reports\/[^/]+|input\/keliya\/PREPARED)\.json$/u.test(
            name,
          );
        const plain =
          json ||
          /^reports\/[^/]+\.md$/u.test(name) ||
          /^builds\/[^/]+\/make\.(?:stdout|stderr)\.log$/u.test(name);
        if (plain) {
          regular(path, "workspace record");
          const content = readFileBounded(path, bytes.remaining).bytes;
          bytes.remaining -= content.length;
          const source = content.toString("utf8");
          screen(source);
          files[name] = json ? (JSON.parse(source) as unknown) : source;
        } else files[name] = digest(path, "sha256", hashBudget);
      },
      names,
    );
  }
  return files;
}

/** Every child is individually flushed; root exports do not flush descendants. */
export async function collectReplayLogs(
  home: string,
  rootId: string,
  host?: WebHost,
): Promise<{ root: StoredLog; children: StoredLog[] }> {
  let remaining = BUFFER_LIMIT;
  const logs = new Map<string, StoredLog>();
  const pending = [rootId];
  while (pending.length) {
    const id = pending.shift()!;
    requireFact(!logs.has(id), `Duplicate/cyclic child session ${id}`);
    const log = host ? await storedLog(host, home, id, remaining) : readLog(home, id, remaining);
    remaining -= log.byteLength;
    logs.set(id, log);
    for (const event of log.events)
      if (event.type === "subagent/catalog") {
        const child = text(object(event.data).childId);
        requireFact(
          /^[A-Za-z0-9-]+$/u.test(child) && !logs.has(child) && !pending.includes(child),
          "Duplicate/cyclic catalog child",
        );
        pending.push(child);
      }
  }
  return {
    root: logs.get(rootId)!,
    children: [...logs.values()].filter((log) => log.header.id !== rootId),
  };
}

/** Called only after submission hosts stop; no unbounded filesystem discovery. */
export function discoverOwnedSessions(home: string, rootId: string): StoredLog[] {
  const found: StoredLog[] = [];
  const root = join(home, "sessions"),
    budget = { remaining: BUFFER_LIMIT };
  if (!fs.existsSync(root)) return [];
  for (const project of directoryNames(root, budget)) {
    const directory = join(root, project);
    if (fs.lstatSync(directory).isFile()) continue;
    requireFact(
      fs.lstatSync(directory).isDirectory() && fs.realpathSync(directory) === directory,
      "Unsafe session discovery directory",
    );
    for (const id of directoryNames(directory, budget)) {
      if (fs.lstatSync(join(directory, id)).isFile()) continue;
      requireFact(
        /^(?:session-[A-Za-z0-9-]+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u.test(id),
        "Unsafe session discovery id",
      );
      const log = readLog(home, id, budget.remaining);
      budget.remaining -= log.byteLength;
      found.push(log);
    }
  }
  return found.filter(
    (log) => log.header.parentSession === rootId && log.header.origin === "subagent",
  );
}

export function replayRunPolicy(
  workspace: string,
  bindings: ReadonlyMap<string, ReplayBuildBinding>,
): NativeRunPolicy {
  const runsByBuild = new Map<string, string>();
  return {
    minRuns: 0,
    maxRuns: 2,
    expectedArgv(job: RunJob) {
      requireFact(
        job.build_id &&
          job.project === "keliya" &&
          job.threads === 1 &&
          job.run_dir === join(workspace, "runs", job.run_id),
        "Replay cleanup build/run identity",
      );
      const path = join(workspace, "builds", job.build_id, "build-record.json");
      regular(path, "cleanup BuildRecord");
      const build = BuildRecordSchema.parse(load(path));
      const expected = bindings.get(job.build_id);
      requireFact(
        expected &&
          expected.taskId === job.task_id &&
          expected.changeId === build.change_id &&
          build.source_commit === REPLAY_COMMIT,
        "Replay cleanup canonical build binding",
      );
      requireFact(
        !runsByBuild.has(job.build_id) || runsByBuild.get(job.build_id) === job.run_id,
        "Replay cleanup duplicate run for build",
      );
      runsByBuild.set(job.build_id, job.run_id);
      requireFact(
        build.build_id === job.build_id &&
          build.task_id === job.task_id &&
          build.binary_sha256 === job.binary_sha256,
        "Replay cleanup build binding",
      );
      const binary = join(job.run_dir, "bin/shud");
      requireFact(
        digest(binary, "sha256", { remaining: HASH_LIMIT }).sha256 === build.binary_sha256,
        "Replay cleanup binary digest",
      );
      return [binary, "-o", "output/keliya.out", "keliya"];
    },
  };
}
