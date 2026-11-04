import { lstatSync, realpathSync } from "node:fs";
import { defineTool, ToolArgsError, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  DataIdSchema,
  FORBIDDEN_REPORT_PHRASES,
  RunIdSchema,
  TaskIdSchema,
  VerificationCaseSchema,
  isProjectComponent,
  readCallerPresetId,
  type DataProvenance,
  type RunJob,
  type RunRecord,
  type TaskCard,
  type TaskId,
} from "@shud-harness/dsh-shud-core";
import type { ShudJobRegistry } from "@shud-harness/dsh-shud-jobs";
import {
  compareRivqdown,
  createVerificationCase,
  readWorkspaceRecord,
  writeWorkspaceRecord,
  WorkspaceRecordError,
  type WorkspaceRecordKind,
  type WorkspaceRecordMap,
} from "@shud-harness/dsh-shud-records";
import { strictTool } from "./strict-tool.ts";

const parameters = {
  task_id: { type: "string", required: true },
  base_run_id: { type: "string", required: true },
  candidate_run_id: { type: "string", required: true },
  reviewer_notes: { type: "array", items: { type: "string" }, required: true },
  compatibility_verdict: {
    type: "string",
    enum: ["compatible", "incompatible", "unknown"],
    required: true,
  },
} as const;

function readRecord<K extends WorkspaceRecordKind>(cwd: string, kind: K, id: string) {
  let record: WorkspaceRecordMap[K] | undefined;
  let stage: WorkspaceRecordError["stage"] = "read";
  try {
    record = readWorkspaceRecord(cwd, kind, id, { readonly: true });
  } catch (error) {
    stage = error instanceof WorkspaceRecordError ? error.stage : "read";
  }
  if (record === undefined) {
    throw new Error(`verification_run ${kind} ${id}: ${stage} failed`);
  }
  return record;
}

function eligibleTask(cwd: string, id: TaskId) {
  const card = readRecord(cwd, "task", id);
  if (card.type !== "code_change" || card.status !== "running") {
    throw new Error(`verification_run task ${id}: requires running code_change`);
  }
  return card;
}

function physicalDirectory(path: string, subject: string) {
  try {
    return realpathSync.native(path);
  } catch {
    throw new Error(`verification_run ${subject}: cannot resolve directory ${path}`);
  }
}

function boundRunDirectory(physicalCwd: string, job: RunJob) {
  const expected = physicalDirectory(`${physicalCwd}/runs/${job.run_id}`, job.run_id);
  // Resolve the original spelling before appending anything: alias/.. is physical traversal.
  const directory = physicalDirectory(job.run_dir, job.run_id);
  if (directory !== expected) {
    throw new Error(`verification_run ${job.run_id}: run_dir is outside the session workspace`);
  }
  for (const path of [`${directory}/output`, `${directory}/output/${job.project}.out`]) {
    try {
      if (!lstatSync(path).isDirectory()) throw new Error();
    } catch {
      throw new Error(
        `verification_run ${job.run_id}: output directory is missing or unsafe: ${path}`,
      );
    }
  }
  return directory;
}

function runEvidence(cwd: string, card: TaskCard, job: RunJob, run: RunRecord) {
  if (
    job.task_id !== card.task_id ||
    run.task_id !== card.task_id ||
    run.run_id !== job.run_id ||
    run.job_id !== job.job_id
  ) {
    throw new Error(`verification_run ${job.run_id}/${job.job_id}: task or run identity mismatch`);
  }
  if (run.status !== "succeeded") {
    throw new Error(`verification_run ${job.run_id}: requires succeeded, found ${run.status}`);
  }
  if (!card.linked_jobs.includes(job.job_id)) {
    throw new Error(`verification_run ${job.run_id}/${job.job_id}: missing from linked_jobs`);
  }
  if (job.threads !== 1) {
    throw new Error(`verification_run ${job.run_id}: threads must be 1`);
  }
  if (job.build_id === null) {
    throw new Error(`verification_run ${job.run_id}: build_id is required`);
  }
  const build = readRecord(cwd, "build", job.build_id);
  if (build.task_id !== card.task_id) {
    throw new Error(`verification_run ${build.build_id}: task_id differs from ${card.task_id}`);
  }
  if (job.binary_sha256 !== build.binary_sha256) {
    throw new Error(`verification_run ${job.run_id}/${build.build_id}: binary_sha256 mismatch`);
  }
  const dataId = DataIdSchema.safeParse(run.data_id);
  if (!dataId.success) {
    throw new Error(`verification_run ${job.run_id}: data_id is required and must be valid`);
  }
  return { build, data: readRecord(cwd, "data", dataId.data) };
}

function provenancePairs(data: DataProvenance) {
  const pairs = new Set<string>();
  for (const source of [data.sources.files, data.sources.external_files]) {
    for (const { path, sha256 } of source) pairs.add(JSON.stringify([path, sha256]));
  }
  return pairs;
}

function samePairs(base: ReadonlySet<string>, candidate: ReadonlySet<string>): boolean {
  if (base.size !== candidate.size) return false;
  for (const pair of base) {
    if (!candidate.has(pair)) return false;
  }
  return true;
}

async function collectedRun(jobs: ShudJobRegistry, job: RunJob) {
  try {
    return await jobs.collectShud(job.job_id, { readonly: true });
  } catch {
    throw new Error(
      `verification_run ${job.run_id}/${job.job_id}: readonly collected RunRecord unavailable (status ${job.status})`,
    );
  }
}

export function createVerificationRunTool(jobs: ShudJobRegistry): ToolDefinition {
  const tool = defineTool({
    name: "verification_run",
    description:
      "Compare collected serial baseline and approved candidate rivqdown bytes for a running code-change task. Publish regression evidence and link it without collecting jobs, approving changes or establishing scientific validity.",
    parameters,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          vc_id: { type: "string", required: true },
          status: { type: "string", enum: ["passed", "failed"], required: true },
          observed: {
            type: "object",
            required: true,
            additionalProperties: false,
            properties: {
              compared_path: { type: "string", required: true },
              base_sha256: { type: "string", required: true },
              candidate_sha256: { type: "string", required: true },
            },
          },
          failure_reason: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    async execute(args, exec) {
      const taskId = TaskIdSchema.safeParse(args.task_id);
      const baseId = RunIdSchema.safeParse(args.base_run_id);
      const candidateId = RunIdSchema.safeParse(args.candidate_run_id);
      if (!taskId.success) throw new ToolArgsError(["Invalid task_id"]);
      if (!baseId.success) throw new ToolArgsError(["Invalid base_run_id"]);
      if (!candidateId.success) throw new ToolArgsError(["Invalid candidate_run_id"]);
      const compatibility = VerificationCaseSchema.shape.compatibility_verdict.safeParse(
        args.compatibility_verdict,
      );
      if (!compatibility.success) throw new ToolArgsError(["Invalid compatibility_verdict"]);
      if (args.reviewer_notes.length === 0) {
        throw new ToolArgsError(["reviewer_notes must contain at least one nonempty entry"]);
      }
      for (const [index, note] of args.reviewer_notes.entries()) {
        if (note.length === 0)
          throw new ToolArgsError([`reviewer_notes[${index}] must be nonempty`]);
        if (FORBIDDEN_REPORT_PHRASES.some((phrase) => note.includes(phrase))) {
          throw new ToolArgsError([`reviewer_notes[${index}] contains a forbidden phrase`]);
        }
      }
      const cwd = exec.agent?.session?.header?.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) {
        throw new Error("verification_run requires the calling session's cwd (workspace)");
      }
      eligibleTask(cwd, taskId.data);
      let taskJobs;
      try {
        taskJobs = await jobs.listRunJobsByTask(taskId.data);
      } catch {
        throw new Error(`verification_run task ${taskId.data}: readonly RunJob query failed`);
      }
      const baseJob = taskJobs.find((job) => job.run_id === baseId.data);
      const candidateJob = taskJobs.find((job) => job.run_id === candidateId.data);
      if (!baseJob)
        throw new Error(
          `verification_run ${baseId.data}: no indexed RunJob for task ${taskId.data}`,
        );
      if (!candidateJob)
        throw new Error(
          `verification_run ${candidateId.data}: no indexed RunJob for task ${taskId.data}`,
        );
      const baseRun = await collectedRun(jobs, baseJob);
      const candidateRun = await collectedRun(jobs, candidateJob);

      // No await after this reread: validate current links/pin and publish as one synchronous stretch.
      const card = eligibleTask(cwd, taskId.data);
      if (baseJob.project !== candidateJob.project || !isProjectComponent(baseJob.project)) {
        throw new Error(
          `verification_run ${baseId.data}/${candidateId.data}: project mismatch or invalid component`,
        );
      }
      const base = runEvidence(cwd, card, baseJob, baseRun);
      const candidate = runEvidence(cwd, card, candidateJob, candidateRun);
      if (base.build.source_commit !== candidate.build.source_commit) {
        throw new Error(
          `verification_run source_commit mismatch: ${base.build.build_id} ${base.build.source_commit}; ${candidate.build.build_id} ${candidate.build.source_commit}`,
        );
      }
      // Pair equality makes this pin check apply to both builds.
      if (base.build.source_commit !== card.source_base_commit) {
        throw new Error(
          `verification_run ${base.build.build_id}: source_commit ${base.build.source_commit} differs from pinned ${card.source_base_commit}`,
        );
      }
      if (base.build.change_id !== null || base.build.rhs_openmp) {
        throw new Error(
          `verification_run ${base.build.build_id}: base requires null change_id and rhs_openmp false`,
        );
      }
      if (candidate.build.change_id === null) {
        throw new Error(
          `verification_run ${candidate.build.build_id}: candidate change_id is required`,
        );
      }
      const change = readRecord(cwd, "change", candidate.build.change_id);
      if (change.status !== "approved" || change.task_id !== card.task_id) {
        throw new Error(
          `verification_run ${candidate.build.build_id}/${change.change_id}: requires approved change for task ${card.task_id}`,
        );
      }
      const basePairs = provenancePairs(base.data);
      const candidatePairs = provenancePairs(candidate.data);
      if (!samePairs(basePairs, candidatePairs)) {
        throw new Error(
          `verification_run ${baseId.data}/${candidateId.data}: input provenance pairs differ`,
        );
      }
      const physicalCwd = physicalDirectory(cwd, "workspace");
      const baseDirectory = boundRunDirectory(physicalCwd, baseJob);
      const candidateDirectory = boundRunDirectory(physicalCwd, candidateJob);
      const { equal, ...observed } = compareRivqdown(
        baseDirectory,
        candidateDirectory,
        baseJob.project,
      );
      const status: "passed" | "failed" = equal ? "passed" : "failed";
      const failureReason = equal
        ? null
        : `Rivqdown SHA256 mismatch: base ${observed.base_sha256}; candidate ${observed.candidate_sha256}`;
      const verification = createVerificationCase(cwd, {
        task_id: card.task_id,
        change_id: change.change_id,
        bundle_id: null,
        case_type: "regression",
        expected_result_source: "baseline_regression",
        target_code_targets: change.files_changed,
        description:
          "Compare serial baseline and candidate rivqdown output bytes for the same inputs.",
        expected_result: "Candidate rivqdown bytes are identical to the serial baseline.",
        pass_criteria: "The SHA256 digests of the baseline and candidate rivqdown files are equal.",
        base_run_id: baseId.data,
        candidate_run_id: candidateId.data,
        base_build_id: base.build.build_id,
        candidate_build_id: candidate.build.build_id,
        artifact_refs: [
          `runs/${baseId.data}/${observed.compared_path}`,
          `runs/${candidateId.data}/${observed.compared_path}`,
        ],
        observed,
        status,
        failure_reason: failureReason,
        reviewed_by: readCallerPresetId(exec.agent),
        reviewer_notes: args.reviewer_notes,
        compatibility_verdict: compatibility.data,
        created_at: new Date().toISOString(),
      });
      try {
        const current = eligibleTask(cwd, taskId.data);
        writeWorkspaceRecord(cwd, "task", {
          ...current,
          linked_verifications: [
            ...new Set([...current.linked_verifications, verification.vc_id]),
          ].sort(),
          updated_at: new Date().toISOString(),
        });
      } catch {
        throw new Error(
          `verification_run ${verification.vc_id}: task_card publication failed; committed verification retained`,
        );
      }
      return {
        vc_id: verification.vc_id,
        status,
        observed,
        failure_reason: failureReason,
      };
    },
  });
  return strictTool(tool, parameters);
}
