import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import {
  TaskCardSchema,
  ChangeRequestSchema,
  BuildRecordSchema,
  RunJobSchema,
  RunRecordSchema,
  StackLockSchema,
  DataProvenanceSchema,
  VerificationCaseSchema,
  EvidenceReportSchema,
  type TaskCard,
  type ChangeRequest,
  type BuildRecord,
  type RunJob,
  type RunRecord,
  type StackLock,
  type DataProvenance,
  type VerificationCase,
  type EvidenceReport,
} from "../../packages/dsh-shud-core/src/schemas/index.ts";
import {
  GOVERNANCE_INVARIANTS,
  CODE_CHANGE_SECTION5_WORDING,
  REPORT_LIMITATION_TEMPLATES,
} from "../../packages/dsh-shud-core/src/governance/wording.ts";
import { renderReportDocument } from "../../packages/dsh-shud-records/lib/report-render.js";
import { object, requireFact } from "./shud-restart-evidence.ts";
import { snapshotReportMetricFacts } from "./shud-report-metrics.ts";

import { REPLAY_COMMIT, REPLAY_FILES } from "./shud-replay-contract.ts";
export interface ReplayRecords {
  task: TaskCard;
  change: ChangeRequest;
  base: BuildRecord;
  candidate: BuildRecord;
  jobs: RunJob[];
  runs: RunRecord[];
  stacks: StackLock[];
  provenance: DataProvenance[];
  verification: VerificationCase;
  report: EvidenceReport;
}

/** A collector receipt represents bytes too large/binary to retain inline. */
export function artifactDigest(value: unknown): { sha256: string; size_bytes: number } {
  if (typeof value === "string")
    return {
      sha256: createHash("sha256").update(value).digest("hex"),
      size_bytes: Buffer.byteLength(value),
    };
  const receipt = object(value);
  requireFact(
    typeof receipt.sha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(receipt.sha256) &&
      Number.isSafeInteger(receipt.size_bytes) &&
      Number(receipt.size_bytes) >= 0,
    "Invalid artifact digest receipt",
  );
  return { sha256: receipt.sha256, size_bytes: Number(receipt.size_bytes) };
}

function parseReplayRecord<T>(
  files: Record<string, unknown>,
  path: string,
  schema: { parse(value: unknown): T },
): T {
  requireFact(Object.hasOwn(files, path), `Missing evidence ${path}`);
  try {
    return schema.parse(files[path]);
  } catch (error) {
    // Schema issues contain field paths but may include authored payloads: never echo them.
    const issues =
      error instanceof Error && "issues" in error && Array.isArray(error.issues)
        ? error.issues
        : [];
    const fields = issues.map((issue: unknown) => {
      const value = object(issue);
      return Array.isArray(value.path) ? value.path.map(String).join(".") : "schema";
    });
    throw new Error(`Invalid evidence ${path}: ${fields.join(", ") || "schema"}`, { cause: error });
  }
}

/** keliya writes no storage outputs: residual null for a missing variable, digest-bound file. */
function assertReplayRunMetrics(files: Record<string, unknown>, run: RunRecord): void {
  const path = `runs/${run.run_id}/metrics.json`;
  const summary = run.artifacts.metrics_summary;
  requireFact(summary !== null, `RunRecord ${run.run_id}: metrics_summary must be non-null`);
  requireFact(
    Object.hasOwn(files, path) && artifactDigest(files[path]).sha256 === summary.sha256,
    `Metrics digest ${path}`,
  );
  requireFact(
    run.numerical_health.water_balance_residual === null,
    `RunRecord ${run.run_id}: water_balance_residual must be null`,
  );
  requireFact(
    run.numerical_health.max_solver_dt === null,
    `RunRecord ${run.run_id}: max_solver_dt must be null`,
  );
  const [{ metrics }] = snapshotReportMetricFacts(files, [run]);
  const reason = metrics?.numerical_health.reasons.water_balance_residual;
  requireFact(
    typeof reason === "string" && reason.startsWith("missing_variable:"),
    `Metrics residual reason ${path}: must start with missing_variable:`,
  );
}

export function replayRecords(files: Record<string, unknown>, workspace: string): ReplayRecords {
  function records<T>(
    pattern: RegExp,
    schema: { parse(value: unknown): T },
    count: number | null,
    label: string,
  ): T[] {
    const paths = Object.keys(files)
      .filter((path) => pattern.test(path))
      .sort();
    requireFact(
      count === null || paths.length === count,
      `${label}: expected ${count} records, found ${paths.length}`,
    );
    return paths.map((path) => parseReplayRecord(files, path, schema));
  }
  const [task] = records(/^tasks\/[^/]+\/task\.json$/u, TaskCardSchema, 1, "TaskCard");
  const [change] = records(/^changes\/[^/]+\.json$/u, ChangeRequestSchema, 1, "ChangeRequest");
  const builds = records(
    /^builds\/[^/]+\/build-record\.json$/u,
    BuildRecordSchema,
    2,
    "BuildRecord",
  );
  const jobs = records(/^runs\/[^/]+\/run-job\.json$/u, RunJobSchema, 2, "RunJob");
  requireFact(
    new Set(jobs.map((job) => job.job_id)).size === 2 &&
      new Set(jobs.map((job) => job.run_id)).size === 2 &&
      new Set(jobs.map((job) => job.dsh_job_id)).size === 2,
    "Duplicate RunJob identity",
  );
  const runs = records(/^runs\/[^/]+\/run-record\.json$/u, RunRecordSchema, 2, "RunRecord");
  const stacks = records(/^stacks\/[^/]+\.json$/u, StackLockSchema, 2, "StackLock");
  const provenance = records(
    /^provenance\/[^/]+\.json$/u,
    DataProvenanceSchema,
    2,
    "DataProvenance",
  );
  const [verification] = records(
    /^verifications\/[^/]+\.json$/u,
    VerificationCaseSchema,
    1,
    "VerificationCase VC",
  );
  const reports = records(/^reports\/[^/]+\.json$/u, EvidenceReportSchema, null, "EvidenceReport");
  const accepted = reports.filter((entry) => entry.status === "accepted");
  requireFact(accepted.length === 1, "Expected one accepted EvidenceReport");
  const report = accepted[0];
  requireFact(
    new Set(reports.map((entry) => entry.report_id)).size === reports.length &&
      reports.every(
        (entry) => entry.task_id === task.task_id && files[`reports/${entry.report_id}.json`],
      ),
    "Report file/task identity",
  );
  requireFact(
    verification.status === "passed",
    `VerificationCase ${verification.vc_id}: ${verification.status}`,
  );
  const taskPath = `tasks/${task.task_id}/task.json`;
  requireFact(
    files[taskPath] && task.type === "code_change" && task.status === "done",
    `TaskCard ${taskPath} must be code_change done`,
  );
  requireFact(
    task.source_base_commit === REPLAY_COMMIT,
    `${taskPath}: source_base_commit must equal ${REPLAY_COMMIT}`,
  );
  requireFact(
    files[`changes/${change.change_id}.json`] &&
      change.task_id === task.task_id &&
      change.status === "approved" &&
      change.base_commit === REPLAY_COMMIT &&
      change.created_by === "coder" &&
      change.semantic_level === "numerical_implementation" &&
      change.risk === "high" &&
      change.files_changed.every((path) => REPLAY_FILES.some((allowed) => allowed === path)) &&
      ["Makefile", "src/Model/MD_rhs_core.cpp"].every((path) =>
        change.files_changed.includes(path),
      ),
    `Invalid approved ChangeRequest ${change.change_id}`,
  );
  requireFact(
    artifactDigest(files[change.patch_path]).sha256 === change.patch_sha256,
    `Patch digest ${change.change_id}`,
  );
  const base = builds.find((build) => build.change_id === null);
  const candidate = builds.find((build) => build.change_id === change.change_id);
  requireFact(
    base && candidate && base.build_id !== candidate.build_id,
    "Missing distinct base/candidate BuildRecord",
  );
  for (const build of builds) {
    const path = `builds/${build.build_id}/build-record.json`;
    requireFact(files[path] && build.task_id === task.task_id, `Build identity ${path}`);
    requireFact(
      build.source_commit === REPLAY_COMMIT,
      `${path}: source_commit must equal ${REPLAY_COMMIT}`,
    );
    requireFact(
      build.exit_code === 0 &&
        artifactDigest(files[build.binary_path]).sha256 === build.binary_sha256,
      `Build binary ${build.build_id}`,
    );
  }
  requireFact(
    base.patch_sha256 === null && !base.rhs_openmp,
    `Invalid base build ${base.build_id}`,
  );
  requireFact(
    candidate.patch_sha256 === change.patch_sha256 && candidate.rhs_openmp,
    `Invalid candidate build ${candidate.build_id}`,
  );
  const makeLog = files[candidate.stdout_path];
  requireFact(
    typeof makeLog === "string" && makeLog.includes("-fopenmp"),
    `Candidate ${candidate.build_id} missing -fopenmp evidence`,
  );
  requireFact(
    files[`verifications/${verification.vc_id}.json`] &&
      verification.task_id === task.task_id &&
      verification.change_id === change.change_id &&
      verification.reviewed_by === "reviewer" &&
      verification.base_build_id === base.build_id &&
      verification.candidate_build_id === candidate.build_id,
    `VerificationCase identity ${verification.vc_id}`,
  );
  const orderedJobs: RunJob[] = [];
  const orderedRuns: RunRecord[] = [];
  const orderedStacks: StackLock[] = [];
  const orderedData: DataProvenance[] = [];
  for (const [index, build] of [base, candidate].entries()) {
    const selected = jobs.filter((job) => job.build_id === build.build_id);
    requireFact(selected.length === 1, `RunJob build join ${build.build_id}`);
    const job = selected[0];
    const run = runs.find((entry) => entry.run_id === job.run_id);
    const stack = stacks.find((entry) => entry.stack_id === job.stack_id);
    const data = provenance.find((entry) => entry.data_id === job.data_id);
    const prefix = `runs/${job.run_id}`;
    requireFact(
      run &&
        stack &&
        data &&
        files[`${prefix}/run-job.json`] &&
        files[`${prefix}/run-record.json`] &&
        files[`stacks/${stack.stack_id}.json`] &&
        files[`provenance/${data.data_id}.json`],
      `Run file identity ${job.run_id}`,
    );
    requireFact(
      job.status === "collected" &&
        job.exit_code === 0 &&
        job.threads === 1 &&
        job.project === "keliya" &&
        job.task_id === task.task_id &&
        job.end_days === null &&
        job.run_dir === join(workspace, prefix) &&
        job.input_dir === join(workspace, "input/keliya") &&
        job.binary_sha256 === build.binary_sha256 &&
        job.dsh_job_id !== null &&
        job.dsh_job_ids.includes(job.dsh_job_id) &&
        isDeepStrictEqual(job.command, [
          join(job.run_dir, "bin/shud"),
          "-o",
          "output/keliya.out",
          "keliya",
        ]),
      `RunJob keliya/build contract ${job.run_id}`,
    );
    requireFact(
      run.status === "succeeded" &&
        run.exit_code === 0 &&
        run.exit_class === "ok" &&
        run.threads === 1 &&
        run.job_id === job.job_id &&
        run.task_id === task.task_id &&
        run.build_id === build.build_id &&
        run.binary_sha256 === build.binary_sha256 &&
        run.stack_id === stack.stack_id &&
        run.data_id === data.data_id &&
        isDeepStrictEqual(run.command, job.command) &&
        isDeepStrictEqual(run.llm, job.llm),
      `RunRecord join ${job.run_id}`,
    );
    requireFact(
      stack.build_id === build.build_id &&
        stack.repos.SHUD.commit === REPLAY_COMMIT &&
        data.basin === "keliya" &&
        data.sources.input_root === job.input_dir &&
        data.sources.external_files.length === 32 &&
        new Set(data.sources.external_files.map((file) => file.path)).size === 32,
      `Stack/provenance join ${job.run_id}`,
    );
    requireFact(
      artifactDigest(files[`${prefix}/bin/shud`]).sha256 === build.binary_sha256,
      `Run binary ${job.run_id}`,
    );
    for (const file of data.sources.files)
      requireFact(
        isDeepStrictEqual(artifactDigest(files[`${prefix}/input/${job.project}/${file.path}`]), {
          sha256: file.sha256,
          size_bytes: file.size_bytes,
        }),
        `Input digest ${job.run_id}/${file.path}`,
      );
    const outputRoot = `${prefix}/output/${job.project}.out`;
    requireFact(
      run.artifacts.shud_output === join(job.run_dir, "output", `${job.project}.out`),
      `Run output root ${job.run_id}`,
    );
    for (const file of run.artifacts.files)
      requireFact(
        artifactDigest(files[`${outputRoot}/${file.path}`]).size_bytes === file.size_bytes,
        `Artifact size ${job.run_id}/${file.path}`,
      );
    assertReplayRunMetrics(files, run);
    const compared = `output/keliya.out/keliya.rivqdown.dat`;
    requireFact(
      verification.observed.compared_path === compared &&
        verification.artifact_refs[index] === `${prefix}/${compared}` &&
        (index === 0 ? verification.base_run_id : verification.candidate_run_id) === job.run_id &&
        artifactDigest(files[`${prefix}/${compared}`]).sha256 ===
          (index === 0
            ? verification.observed.base_sha256
            : verification.observed.candidate_sha256),
      `VC artifact join ${job.run_id}`,
    );
    orderedJobs.push(job);
    orderedRuns.push(run);
    orderedStacks.push(stack);
    orderedData.push(data);
  }
  requireFact(
    files[`reports/${report.report_id}.json`] &&
      report.status === "accepted" &&
      report.task_id === task.task_id &&
      isDeepStrictEqual(task.linked_changes, [change.change_id]) &&
      isDeepStrictEqual(task.linked_verifications, [verification.vc_id]) &&
      isDeepStrictEqual(
        [...task.linked_reports].sort(),
        reports.map((entry) => entry.report_id).sort(),
      ) &&
      isDeepStrictEqual([...task.linked_jobs].sort(), jobs.map((job) => job.job_id).sort()) &&
      isDeepStrictEqual(report.change_ids, [change.change_id]) &&
      isDeepStrictEqual(report.verification_ids, [verification.vc_id]),
    "Task/report identity links",
  );
  for (const [actual, expected] of [
    [report.linked_runs, orderedRuns.map((run) => run.run_id)],
    [report.stack_ids, orderedStacks.map((stack) => stack.stack_id)],
    [report.data_ids, orderedData.map((data) => data.data_id)],
    [report.llm_response_models, [...new Set(orderedRuns.map((run) => run.llm.response_model))]],
  ])
    requireFact(
      isDeepStrictEqual([...actual].sort(), [...expected].sort()),
      `Report linked evidence ${report.report_id}`,
    );
  const markdown = files[`reports/${report.report_id}.md`];
  requireFact(
    typeof markdown === "string" &&
      GOVERNANCE_INVARIANTS.every((sentence) => markdown.includes(sentence)) &&
      markdown.split("## 5. 指标与图表\n\n")[1]?.split("\n\n")[0] ===
        CODE_CHANGE_SECTION5_WORDING &&
      !markdown.includes("本里程碑无指标 artifact") &&
      report.limitations.filter((entry) => entry === REPORT_LIMITATION_TEMPLATES.max_solver_dt)
        .length === 1,
    `Report Markdown invariants ${report.report_id}`,
  );
  const reportRuns = report.linked_runs.map((id) => runs.find((run) => run.run_id === id)!);
  const metricFacts = snapshotReportMetricFacts(files, reportRuns);
  const section5 = markdown.split("## 5. 指标与图表\n")[1]?.split("\n## 6.")[0] ?? "";
  requireFact(
    reportRuns.every((run) => section5.includes(`| ${run.run_id} |`)),
    `Report Markdown facts ${report.report_id}`,
  );
  requireFact(
    markdown ===
      renderReportDocument(
        report,
        report.stack_ids.map((id) => stacks.find((stack) => stack.stack_id === id)!),
        report.data_ids.map((id) => provenance.find((data) => data.data_id === id)!),
        reportRuns,
        {
          changes: [change],
          verifications: [{ record: verification, baseBuild: base, candidateBuild: candidate }],
        },
        metricFacts,
      ).markdown,
    `Report Markdown facts ${report.report_id}`,
  );
  return {
    task,
    change,
    base,
    candidate,
    jobs: orderedJobs,
    runs: orderedRuns,
    stacks: orderedStacks,
    provenance: orderedData,
    verification,
    report,
  };
}
