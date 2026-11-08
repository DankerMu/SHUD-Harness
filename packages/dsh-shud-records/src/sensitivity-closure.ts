import {
  AnalysisPlanIdSchema,
  AnalysisPlanSchema,
  JobRecordIdSchema,
  MAX_COLLECT_ATTEMPTS,
  RunJobSchema,
  RunRecordSchema,
  TaskIdSchema,
  type AnalysisPlan,
  type RunJob,
  type RunRecord,
  type TaskCard,
} from "@shud-harness/dsh-shud-core";
import type { ClosureDraft, ClosureRunJob } from "./task-closure-shared.ts";
import type {
  SensitivityClosureFailure,
  SensitivityClosureResult,
  SensitivityObjectLoaders,
  SensitivityRunIdentity,
  SensitivitySelection,
} from "./sensitivity-closure-types.ts";

interface Candidate extends SensitivityRunIdentity {
  job: RunJob;
  record: RunRecord | undefined;
  attempts: number;
}

function denied(failure: SensitivityClosureFailure): SensitivityClosureResult {
  return { ok: false, failures: [failure] };
}

/** Require one exclusive family, including inherited capabilities; undefined exclusions are inert. */
export function hasSensitivityLoaders(value: unknown): value is SensitivityObjectLoaders {
  return (
    value !== null &&
    typeof value === "object" &&
    "readAnalysisPlan" in value &&
    typeof value.readAnalysisPlan === "function" &&
    "readRunMetrics" in value &&
    typeof value.readRunMetrics === "function" &&
    (!("readChange" in value) || value.readChange === undefined) &&
    (!("readPatch" in value) || value.readPatch === undefined) &&
    (!("readVerification" in value) || value.readVerification === undefined)
  );
}

/**
 * Sole effective-run selection rule for closure and downstream summaries. Inputs are snapshots;
 * IO is exclusively through explicit readonly readers. Phases stop on the first controlled
 * failure in card/plan order. No collection, discovery, mutation or authored-text classification.
 */
export function deriveSensitivityClosure(
  card: TaskCard,
  runJobs: readonly ClosureRunJob[],
  runRecords: readonly RunRecord[],
  draft: ClosureDraft,
  loaders?: SensitivityObjectLoaders,
): SensitivityClosureResult {
  if (card.type !== "sensitivity" || !TaskIdSchema.safeParse(card.task_id).success) {
    return denied({ clause: 0, reason: "invalid_sensitivity_card" });
  }
  if (!hasSensitivityLoaders(loaders)) {
    return denied({ clause: 0, reason: "missing_sensitivity_loaders" });
  }
  if (card.linked_analyses.length !== 1) {
    return denied({ clause: 0, reason: "invalid_plan_link" });
  }
  const linkedPlan = AnalysisPlanIdSchema.safeParse(card.linked_analyses[0]);
  if (!linkedPlan.success) return denied({ clause: 0, reason: "invalid_plan_link" });
  const analysis_plan_id = linkedPlan.data;
  const fail = (
    clause: SensitivityClosureFailure["clause"],
    reason: SensitivityClosureFailure["reason"],
    ids: Pick<SensitivityClosureFailure, "parameter_set_id" | "job_id" | "job_ids"> = {},
  ) => denied({ clause, reason, analysis_plan_id, ...ids });
  let plan: AnalysisPlan;
  try {
    const parsed = AnalysisPlanSchema.safeParse(loaders.readAnalysisPlan(analysis_plan_id));
    if (!parsed.success) return fail(0, "plan_read_error");
    plan = parsed.data;
  } catch {
    return fail(0, "plan_read_error");
  }
  if (plan.analysis_plan_id !== analysis_plan_id) return fail(0, "plan_identity_mismatch");
  if (plan.task_id !== card.task_id) return fail(0, "foreign_plan");
  if (card.linked_jobs.length === 0) return fail(0, "no_linked_jobs");
  if (draft.observations.length === 0) return fail(0, "missing_observations");
  if (draft.limitations.length === 0) return fail(0, "missing_limitations");
  if (draft.pi_questions.length === 0) return fail(0, "missing_pi_questions");

  const groups = new Map<string, Candidate[]>(
    plan.parameter_sets.map((set) => [set.parameter_set_id, []]),
  );
  const candidates: Candidate[] = [];
  const seenJobs = new Set<string>();
  const seenRuns = new Set<string>();
  for (const rawId of card.linked_jobs) {
    const checkedId = JobRecordIdSchema.safeParse(rawId);
    if (!checkedId.success) return fail(1, "invalid_job_link");
    const job_id = checkedId.data;
    if (seenJobs.has(job_id)) return fail(1, "ambiguous_job", { job_id });
    seenJobs.add(job_id);
    const entries = runJobs.filter((entry) => entry.job.job_id === job_id);
    if (entries.length === 0) return fail(1, "missing_job", { job_id });
    if (entries.length !== 1) return fail(1, "ambiguous_job", { job_id });
    const parsedJob = RunJobSchema.safeParse(entries[0].job);
    if (!parsedJob.success) return fail(1, "invalid_job", { job_id });
    const job = parsedJob.data;
    if (job.task_id !== card.task_id) return fail(1, "foreign_job", { job_id });
    const parameter_set_id = job.parameter_set_id;
    if (
      job.analysis_plan_id !== analysis_plan_id ||
      parameter_set_id === null ||
      !groups.has(parameter_set_id)
    ) {
      return fail(1, "invalid_job_binding", { job_id });
    }
    const ids = { job_id, parameter_set_id };
    if (seenRuns.has(job.run_id)) return fail(1, "ambiguous_job", ids);
    seenRuns.add(job.run_id);
    const attempts = entries[0].collect_error_attempts;
    if (!Number.isSafeInteger(attempts) || attempts < 0) {
      return fail(1, "invalid_collect_attempts", ids);
    }
    if (
      job.status !== "collected" &&
      job.status !== "failed" &&
      job.status !== "cancelled" &&
      attempts < MAX_COLLECT_ATTEMPTS
    ) {
      return fail(1, "job_not_terminal", ids);
    }
    // Only linked jobs supply evidence. A neighboring/unlinked record cannot repair a
    // missing record or veto a valid one merely by repeating its run id.
    const records = runRecords.filter((record) => record.job_id === job_id);
    if (records.length > 1) return fail(1, "ambiguous_record", ids);
    let record: RunRecord | undefined;
    if (records.length === 1) {
      const parsedRecord = RunRecordSchema.safeParse(records[0]);
      if (!parsedRecord.success) return fail(1, "invalid_record", ids);
      record = parsedRecord.data;
      if (
        record.job_id !== job_id ||
        record.run_id !== job.run_id ||
        record.task_id !== card.task_id ||
        record.analysis_plan_id !== analysis_plan_id ||
        record.parameter_set_id !== parameter_set_id
      ) {
        return fail(1, "record_identity_mismatch", ids);
      }
    } else if (job.status === "collected") {
      return fail(1, "missing_record", ids);
    }
    const candidate = { ...ids, run_id: job.run_id, job, record, attempts };
    groups.get(parameter_set_id)!.push(candidate);
    candidates.push(candidate);
  }

  const effective: Candidate[] = [];
  for (const set of plan.parameter_sets) {
    const group = groups.get(set.parameter_set_id)!;
    const ids = { parameter_set_id: set.parameter_set_id };
    if (group.length === 0) return fail(2, "missing_parameter_set", ids);
    const successes = group.filter((candidate) => candidate.record?.status === "succeeded");
    if (successes.length > 1) {
      return fail(2, "multiple_successes", {
        ...ids,
        job_ids: successes.map((candidate) => candidate.job_id),
      });
    }
    // Branded job ids are ASCII: relational comparison is the required code-point ordering.
    effective.push(
      successes[0] ??
        group.reduce((latest, candidate) =>
          candidate.job_id > latest.job_id ? candidate : latest,
        ),
    );
  }

  for (const [index, candidate] of effective.entries()) {
    const { job, record, attempts, job_id, parameter_set_id } = candidate;
    if (
      job.status !== "collected" ||
      record === undefined ||
      attempts >= MAX_COLLECT_ATTEMPTS ||
      record.exit_class === "cancelled" ||
      record.exit_class === "lost" ||
      (plan.parameter_sets[index].baseline && record.status !== "succeeded")
    ) {
      return fail(3, "inadmissible_effective_run", { job_id, parameter_set_id });
    }
  }
  let stack: string | undefined;
  for (const candidate of effective) {
    const { record, job_id, parameter_set_id } = candidate;
    if (record!.status !== "succeeded") continue;
    const ids = { job_id, parameter_set_id };
    if (record!.stack_id === null) return fail(4, "missing_stack_reference", ids);
    if (record!.data_id === null) return fail(4, "missing_data_reference", ids);
    if (stack !== undefined && stack !== record!.stack_id) return fail(4, "mixed_stack", ids);
    stack = record!.stack_id;
  }
  const selected: SensitivitySelection[] = [];
  for (const candidate of effective) {
    const { job_id, run_id, parameter_set_id } = candidate;
    const record = candidate.record!;
    const selection: SensitivitySelection = {
      job_id,
      run_id,
      parameter_set_id,
      record,
      metrics: null,
    };
    if (record.status === "succeeded") {
      const ids = { job_id, parameter_set_id };
      const artifact = record.artifacts.metrics_summary;
      if (artifact === null) return fail(5, "missing_metrics", ids);
      try {
        const metrics = loaders.readRunMetrics(run_id, artifact.sha256);
        if (metrics.status !== "ok") return fail(5, "metrics_unavailable", ids);
        selection.metrics = metrics;
      } catch {
        return fail(5, "metrics_read_error", ids);
      }
    }
    selected.push(selection);
  }
  const selectedJobs = new Set(effective.map((candidate) => candidate.job_id));
  const superseded = candidates
    .filter((candidate) => !selectedJobs.has(candidate.job_id))
    .map(({ job_id, run_id, parameter_set_id }) => ({ job_id, run_id, parameter_set_id }));
  return { ok: true, failures: [], analysis_plan_id, plan, selected, superseded };
}
