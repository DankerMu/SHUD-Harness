import * as fs from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  GOVERNANCE_INVARIANTS,
  REPORT_LIMITATION_TEMPLATES,
  instantiateSensitivityCoverage,
} from "../../packages/dsh-shud-core/src/governance/wording.ts";
import {
  RunJobSchema,
  RunRecordSchema,
  type AnalysisPlan,
  type EvidenceReport,
  type RunJob,
  type RunRecord,
  type TaskCard,
} from "../../packages/dsh-shud-core/src/schemas/index.ts";
import {
  checkCalibProducts,
  readReportMarkdown,
  readWorkspaceRecord,
  renderReport,
} from "../../packages/dsh-shud-records/lib/index.js";
import { requireFact } from "./shud-restart-evidence.ts";
import type { SensitivityEvaluationInput } from "./shud-sensitivity-evaluate.ts";
import { ccwSha256 } from "./shud-sensitivity-prepare.ts";
import { regular } from "./shud-session-log.ts";
import { BUFFER_LIMIT, directoryNames, load } from "./shud-web-driver.ts";

/** Criterion 1's structured outcome; only `non_equivalent` can make the exit INCONCLUSIVE. */
export type PlanOutcome =
  | { kind: "equivalent" }
  | { kind: "non_equivalent"; deviations: string[] }
  | { kind: "unavailable"; reason: string };

interface BatchRun {
  job: RunJob;
  record: RunRecord | null;
}
export interface SensitivityBatch {
  /** The single sensitivity card, when exactly one exists. */
  card: TaskCard | null;
  /** The card's single linked plan, when readable and bound to the card. */
  plan: AnalysisPlan | null;
  outcome: PlanOutcome;
  /** Every `runs/<run_id>/` keyed by job id; throws naming the unreadable run. */
  runs(): Map<string, BatchRun>;
  /** The card's single accepted linked report; throws naming what was found instead. */
  report(): EvidenceReport;
}
export type CriterionCheck = [criterion: number, check: () => string[] | Promise<string[]>];

/** The fixed acceptance plan (oat-sensitivity criterion 1): one constant. */
const FIXED_PLAN = {
  project: "ccw",
  end_days: 90,
  threads: 1,
  parameter_sets: ["baseline", "GEOL_KSATH×0.5", "GEOL_KSATH×2", "LC_ROUGH×2"],
} as const;

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function schemaParse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new Error(`schema invalid at ${issue.path.join(".") || "<root>"}: ${issue.message}`);
}

/** Every key whose value differs between two file-hash maps, both values named. */
export function hashDrift(
  label: string,
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((name) => before[name] !== after[name])
    .map((name) => `${label}${name}: ${before[name] ?? "absent"} -> ${after[name] ?? "absent"}`);
}

/** (key, multiplier, baseline) of one parameter set; label and order do not count. */
function signature(set: AnalysisPlan["parameter_sets"][number]): string {
  if (set.baseline) return "baseline";
  return Object.entries(set.changes)
    .map(([key, multiplier]) => `${key}×${multiplier}`)
    .join("+");
}

function planDeviations(plan: AnalysisPlan, workspace: string): string[] {
  const fixed = new Set<string>(FIXED_PLAN.parameter_sets);
  const own = new Set(plan.parameter_sets.map(signature));
  const deviations = plan.parameter_sets
    .filter((set) => !fixed.has(signature(set)))
    .map((set) => `${set.parameter_set_id} ${signature(set)} is not in the fixed plan`);
  for (const expected of fixed)
    if (!own.has(expected)) deviations.push(`fixed ${expected} is missing`);
  const inputDir = fs.realpathSync(join(workspace, "input/ccw"));
  const fields = { ...FIXED_PLAN, input_dir: inputDir };
  for (const field of ["end_days", "threads", "input_dir", "project"] as const)
    if (plan[field] !== fields[field])
      deviations.push(`${field} ${plan[field]} (fixed ${fields[field]})`);
  return deviations;
}

function memo<T>(read: () => T): () => T {
  let value: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  return () => {
    if (!value) {
      try {
        value = { ok: true, value: read() };
      } catch (error) {
        value = { ok: false, error };
      }
    }
    if (!value.ok) throw value.error;
    return value.value;
  };
}

function readRuns(workspace: string): Map<string, BatchRun> {
  const runs = new Map<string, BatchRun>();
  const root = join(workspace, "runs");
  if (!fs.existsSync(root)) return runs;
  const budget = { remaining: BUFFER_LIMIT };
  for (const name of directoryNames(root)) {
    const read = <T>(file: string, schema: z.ZodType<T>): T => {
      const path = join(root, name, file);
      regular(path, `runs/${name}/${file}`);
      return schemaParse(schema, load(path, budget));
    };
    try {
      const job = read("run-job.json", RunJobSchema);
      const record = fs.existsSync(join(root, name, "run-record.json"))
        ? read("run-record.json", RunRecordSchema)
        : null;
      requireFact(
        job.run_id === name &&
          (!record || (record.run_id === name && record.job_id === job.job_id)),
        "identity differs from its directory",
      );
      runs.set(job.job_id, { job, record });
    } catch (error) {
      throw new Error(`runs/${name}: ${message(error)}`, { cause: error });
    }
  }
  return runs;
}

/** Criterion 1 inputs plus lazily read runs and report, each criterion seeing the same reads. */
export function loadSensitivityBatch(workspace: string): SensitivityBatch {
  let card: TaskCard | null = null;
  let plan: AnalysisPlan | null = null;
  let outcome: PlanOutcome;
  try {
    const tasks = join(workspace, "tasks");
    const cards = (fs.existsSync(tasks) ? [...directoryNames(tasks)] : [])
      .map((id) => readWorkspaceRecord(workspace, "task", id, { readonly: true }))
      .filter((value) => value.type === "sensitivity");
    requireFact(cards.length === 1, `${cards.length} sensitivity TaskCards in tasks/`);
    card = cards[0];
    const links = card.linked_analyses;
    requireFact(links.length === 1, `linked_analyses has ${links.length} entries`);
    let linked: AnalysisPlan;
    try {
      linked = readWorkspaceRecord(workspace, "analysis", links[0], {
        readonly: true,
      });
    } catch (error) {
      throw new Error(`analyses/${links[0]}.json: ${message(error)}`, { cause: error });
    }
    requireFact(linked.task_id === card.task_id, `plan ${links[0]} belongs to ${linked.task_id}`);
    const deviations = planDeviations(linked, workspace);
    plan = linked;
    outcome = deviations.length ? { kind: "non_equivalent", deviations } : { kind: "equivalent" };
  } catch (error) {
    outcome = { kind: "unavailable", reason: message(error) };
  }
  const owner = card;
  return {
    card,
    plan,
    outcome,
    runs: memo(() => readRuns(workspace)),
    report: memo(() => {
      requireFact(owner, "no sensitivity TaskCard to link a report");
      const reports = owner.linked_reports.map((id) =>
        readWorkspaceRecord(workspace, "report", id, { readonly: true }),
      );
      const accepted = reports.filter((value) => value.status === "accepted");
      const found = reports.map((value) => `${value.report_id} ${value.status}`).join(", ");
      requireFact(accepted.length === 1, `${accepted.length} accepted linked reports (${found})`);
      return accepted[0];
    }),
  };
}

function bound(batch: SensitivityBatch): { card: TaskCard; plan: AnalysisPlan } {
  const { card, plan, outcome } = batch;
  requireFact(
    card && plan,
    `no readable linked plan: ${outcome.kind === "unavailable" ? outcome.reason : "unbound"}`,
  );
  return { card, plan };
}

/** Criterion 2: one collected succeeded RunJob per parameter set, all and only them linked. */
function onePerSet(batch: SensitivityBatch): string[] {
  const { card, plan } = bound(batch);
  const runs = batch.runs();
  const linked = new Set<string>(card.linked_jobs);
  const selected = new Set<string>();
  const evidence: string[] = [];
  for (const set of plan.parameter_sets) {
    const id = set.parameter_set_id;
    const candidates = [...runs.values()].filter(
      ({ job }) => job.analysis_plan_id === plan.analysis_plan_id && job.parameter_set_id === id,
    );
    const good = candidates.filter(
      ({ job, record }) =>
        job.status === "collected" &&
        record?.status === "succeeded" &&
        record.analysis_plan_id === plan.analysis_plan_id &&
        record.parameter_set_id === id,
    );
    const seen = candidates.map(
      ({ job, record }) => `${job.run_id} job ${job.status} record ${record?.status ?? "missing"}`,
    );
    if (good.length !== 1)
      evidence.push(
        `${id}: ${good.length} collected succeeded RunJobs; ${seen.join(", ") || "no RunJob"}`,
      );
    else if (!linked.has(good[0].job.job_id))
      evidence.push(`${id}: ${good[0].job.run_id} (${good[0].job.job_id}) is not in linked_jobs`);
    else selected.add(good[0].job.job_id);
  }
  for (const id of card.linked_jobs)
    if (!selected.has(id)) {
      const runId = runs.get(id)?.job.run_id;
      evidence.push(`linked_jobs has ${id} outside the batch${runId ? ` (${runId})` : ""}`);
    }
  return evidence;
}

/** Criterion 3: one non-null StackLock across the linked runs, every data_id non-null. */
function oneStack(batch: SensitivityBatch): string[] {
  requireFact(batch.card, "no sensitivity TaskCard");
  const runs = batch.runs();
  const evidence: string[] = [];
  const records: RunRecord[] = [];
  for (const id of batch.card.linked_jobs) {
    const record = runs.get(id)?.record;
    if (record) records.push(record);
    else evidence.push(`${id} has no RunRecord`);
  }
  if (records.length === 0) return [...evidence, "no in-batch RunRecord"];
  const stacks = new Set(records.map((record) => record.stack_id));
  if (stacks.size !== 1 || stacks.has(null))
    evidence.push(
      `stack_id differs or is null: ${records.map((r) => `${r.run_id}=${r.stack_id ?? "null"}`).join(", ")}`,
    );
  for (const record of records)
    if (record.data_id === null) evidence.push(`${record.run_id} data_id is null`);
  return evidence;
}

/** Criterion 8: accepted report, done card, exact plan, canonical Markdown with verbatim wording. */
function acceptedReport(workspace: string, batch: SensitivityBatch): string[] {
  requireFact(batch.card, "no sensitivity TaskCard");
  const evidence: string[] = [];
  if (batch.card.status !== "done")
    evidence.push(`TaskCard status ${batch.card.status} (expected done)`);
  let report: EvidenceReport;
  try {
    report = batch.report();
  } catch (error) {
    return [...evidence, message(error)];
  }
  const id = report.report_id;
  const plan = batch.plan;
  if (!plan) evidence.push("analysis_ids unchecked: no readable linked plan");
  else if (report.analysis_ids.length !== 1 || report.analysis_ids[0] !== plan.analysis_plan_id)
    evidence.push(
      `analysis_ids [${report.analysis_ids.join(", ")}] (expected [${plan.analysis_plan_id}])`,
    );
  const markdown = readReportMarkdown(workspace, id);
  if (markdown === undefined) return [...evidence, `reports/${id}.md is missing`];
  try {
    if (renderReport(workspace, id) !== markdown)
      evidence.push(`reports/${id}.md differs from renderReport`);
  } catch (error) {
    evidence.push(`renderReport ${id} failed: ${message(error)}`);
  }
  const wording = [
    ...(plan ? [instantiateSensitivityCoverage(plan)] : []),
    REPORT_LIMITATION_TEMPLATES.parameter_range,
    ...GOVERNANCE_INVARIANTS,
  ];
  for (const sentence of wording)
    if (!markdown.includes(sentence)) evidence.push(`reports/${id}.md lacks "${sentence}"`);
  return evidence;
}

/** Criterion 12: plan digests are the prepared copy's, and the copy is unchanged at the end. */
function preparedDigests(input: SensitivityEvaluationInput, batch: SensitivityBatch): string[] {
  const { plan } = bound(batch);
  const copy = input.preparation.copy_sha256;
  const directory = join(input.workspace, "input/ccw");
  const evidence: string[] = [];
  try {
    const required = new Set(
      Object.keys(checkCalibProducts(directory, plan.project, plan.parameter_sets)),
    );
    const actual = new Set(Object.keys(plan.input_digests));
    for (const name of required)
      if (!actual.has(name)) evidence.push(`input_digests lacks ${name}`);
    for (const name of actual)
      if (!required.has(name)) evidence.push(`input_digests has extra ${name}`);
  } catch (error) {
    evidence.push(`checkCalibProducts: ${message(error)}`);
  }
  for (const [name, sha256] of Object.entries(plan.input_digests))
    if (copy[name] !== sha256)
      evidence.push(`${name}: plan ${sha256} prepared ${copy[name] ?? "absent"}`);
  return [...evidence, ...hashDrift("input/ccw/", copy, ccwSha256(directory))];
}

export function workspaceCriteria(
  input: SensitivityEvaluationInput,
  batch: SensitivityBatch,
): CriterionCheck[] {
  const { outcome } = batch;
  return [
    [
      1,
      () =>
        outcome.kind === "equivalent"
          ? []
          : outcome.kind === "non_equivalent"
            ? outcome.deviations
            : [outcome.reason],
    ],
    [2, () => onePerSet(batch)],
    [3, () => oneStack(batch)],
    [8, () => acceptedReport(input.workspace, batch)],
    [12, () => preparedDigests(input, batch)],
  ];
}
