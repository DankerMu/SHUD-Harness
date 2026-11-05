import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import type { SessionLog } from "./shud-session-log.ts";
import { object, requireFact } from "./shud-restart-evidence.ts";
import { replayAsks, assertReplayFlow } from "./shud-replay-flow.ts";
import { artifactDigest, replayRecords } from "./shud-replay-records.ts";
import { REPLAY_COMMIT } from "./shud-replay-contract.ts";

export interface PreservationState {
  clone: { head: string; gitDir: string } | null;
  preparedInputSha256: Record<string, string> | null;
  repositories: Record<
    "SHUD" | "rSHUD" | "AutoSHUD",
    { head: string; status: string; diffSha256: string }
  >;
  shudGit: { kind: string; bytes: string | null; absoluteGitDir: string; inventory: string[] };
  ccwMd5: Record<string, string>;
  keliyaSourceSha256: Record<string, string>;
  forcingSha256: Record<string, string>;
  raw: { exists: boolean; md5: Record<string, string>; roots?: Record<string, boolean> };
}
export interface ReplayEvidence {
  workspace: string;
  home: string;
  root: SessionLog;
  children: SessionLog[];
  delegationBindings: {
    parentSessionId: string;
    configPath: string;
    provider: string;
    agentPreset: string;
    toolName: string;
  }[];
  files: Record<string, unknown>;
  actualStack: {
    commits: Record<"SHUD" | "rSHUD" | "AutoSHUD", string>;
    llm: { base_url: string; request_alias: string; response_model: string };
  };
  preservation: { before: PreservationState; after: PreservationState };
}

/** Root/source comparison is also used on failures before a complete replay exists. */
export function assertReplayPreservation(
  before: PreservationState,
  after: PreservationState,
  workspace: string,
): void {
  if (before.preparedInputSha256 !== null) {
    requireFact(
      before.preparedInputSha256 && after.preparedInputSha256,
      "Missing prepared input preservation receipt",
    );
    requireFact(
      isDeepStrictEqual(before.preparedInputSha256, after.preparedInputSha256),
      "Preservation failed: prepared input/keliya",
    );
  }
  for (const [label, original, current] of [
    ["root repositories", before.repositories, after.repositories],
    ["SHUD/.git and git directory inventory", before.shudGit, after.shudGit],
    ["SHUD/input/ccw md5", before.ccwMd5, after.ccwMd5],
    ["data/raw md5", before.raw, after.raw],
    ["keliya source", before.keliyaSourceSha256, after.keliyaSourceSha256],
    ["external forcing", before.forcingSha256, after.forcingSha256],
  ] as const)
    requireFact(isDeepStrictEqual(original, current), `Preservation failed: ${label}`);
  requireFact(
    Object.keys(before.ccwMd5).length > 0 && Object.keys(before.keliyaSourceSha256).length > 0,
    "Missing source preservation receipts",
  );
  for (const state of [before, after]) {
    for (const repository of Object.values(state.repositories))
      requireFact(
        /^[0-9a-f]{40}$/u.test(repository.head) && /^[0-9a-f]{64}$/u.test(repository.diffSha256),
        "Invalid root revision receipt",
      );
    requireFact(
      ["gitlink", "directory"].includes(state.shudGit.kind) &&
        state.shudGit.absoluteGitDir.startsWith("/") &&
        state.shudGit.inventory.length > 0 &&
        (state.shudGit.kind !== "gitlink" || typeof state.shudGit.bytes === "string"),
      "Invalid root Git receipt",
    );
    requireFact(
      state.raw.exists || !Object.keys(state.raw.md5).length,
      "Absent raw root has files",
    );
    for (const values of [state.ccwMd5, state.raw.md5])
      requireFact(
        Object.values(values).every((hash) => /^[0-9a-f]{32}$/u.test(hash)),
        "Invalid md5 preservation receipt",
      );
    for (const values of [state.keliyaSourceSha256, state.forcingSha256])
      requireFact(
        Object.values(values).every((hash) => /^[0-9a-f]{64}$/u.test(hash)),
        "Invalid sha256 preservation receipt",
      );
    if (state.clone !== null)
      requireFact(
        state.clone.head === REPLAY_COMMIT &&
          state.clone.gitDir === join(workspace, "repos/SHUD/.git"),
        "Private clone HEAD/absolute-git-dir drift",
      );
  }
}

/** No IO or model-text verdicts: the live gate and independent snapshots use this seam. */
export function assertReplayEvidence(snapshot: ReplayEvidence) {
  // Excess approvals are a failure even for an otherwise unfinished canonical prefix.
  replayAsks([snapshot.root, ...snapshot.children]);
  const r = replayRecords(snapshot.files, snapshot.workspace);
  assertReplayFlow(snapshot, r);
  assertReplayPreservation(
    snapshot.preservation.before,
    snapshot.preservation.after,
    snapshot.workspace,
  );
  requireFact(
    snapshot.preservation.before.clone && snapshot.preservation.after.clone,
    "Missing private clone receipt",
  );
  const prepared = snapshot.preservation.before.preparedInputSha256;
  requireFact(
    prepared &&
      snapshot.preservation.after.preparedInputSha256 &&
      Object.keys(prepared).length > 0 &&
      Object.values(prepared).every((hash) => /^[0-9a-f]{64}$/u.test(hash)),
    "Missing prepared input preservation receipt",
  );
  const receipt = object(snapshot.files["input/keliya/PREPARED.json"]);
  const rewrites = object(receipt.files);
  for (const path of ["keliya.cfg.para", "keliya.tsd.forc"]) {
    const rewrite = object(rewrites[path]);
    requireFact(
      rewrite.before_sha256 === snapshot.preservation.before.keliyaSourceSha256[path] &&
        rewrite.after_sha256 === prepared[path],
      `Preparation rewrite receipt ${path}`,
    );
  }
  for (const [path, hash] of Object.entries(prepared)) {
    if (path !== "PREPARED.json")
      requireFact(
        artifactDigest(snapshot.files[`input/keliya/${path}`]).sha256 === hash,
        `Prepared input artifact ${path}`,
      );
    for (const provenance of r.provenance)
      requireFact(
        provenance.sources.files.some((file) => file.path === path && file.sha256 === hash),
        `Prepared input run provenance ${path}`,
      );
  }
  for (const provenance of r.provenance)
    requireFact(
      provenance.sources.files.length === Object.keys(prepared).length,
      "Prepared input provenance file set",
    );
  for (const stack of r.stacks) {
    requireFact(
      isDeepStrictEqual(stack.llm, snapshot.actualStack.llm),
      `Stack model identity ${stack.stack_id}`,
    );
    for (const name of ["SHUD", "rSHUD", "AutoSHUD"] as const)
      requireFact(
        /^[0-9a-f]{40}$/u.test(snapshot.actualStack.commits[name]) &&
          stack.repos[name].commit === snapshot.actualStack.commits[name],
        `Stack repository ${stack.stack_id}/${name}`,
      );
  }
  for (const provenance of r.provenance)
    for (const file of provenance.sources.external_files)
      requireFact(
        snapshot.preservation.before.forcingSha256[file.path] === file.sha256 &&
          snapshot.preservation.after.forcingSha256[file.path] === file.sha256,
        `External forcing provenance ${file.path}`,
      );
  return {
    status: "PASS" as const,
    task_id: r.task.task_id,
    change_id: r.change.change_id,
    build_ids: { base: r.base.build_id, candidate: r.candidate.build_id },
    run_ids: { base: r.jobs[0].run_id, candidate: r.jobs[1].run_id },
    verification: { vc_id: r.verification.vc_id, status: "passed" as const },
    report: { report_id: r.report.report_id, status: "accepted" as const },
    approval_count: 2,
  };
}
