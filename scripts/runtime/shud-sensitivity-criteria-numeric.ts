import { join } from "node:path";
import {
  ensureOutputIntervalBytes,
  submittedParameterBytes,
} from "../../packages/dsh-shud-jobs/src/shud-cfg-rewrite.ts";
import { readCollectErrorAttempts } from "../../packages/dsh-shud-jobs/src/shud-collect.ts";
import type { TaskCard } from "../../packages/dsh-shud-core/src/schemas/index.ts";
import {
  buildSensitivitySummary,
  computeRunMetrics,
  createSensitivityClosureLoaders,
  deriveSensitivityClosure,
  readRunMetrics,
  readShudInputFile,
  readShudTextInput,
  serializeRunMetrics,
  serializeSensitivitySummary,
} from "../../packages/dsh-shud-records/lib/index.js";
import { requireFact } from "./shud-restart-evidence.ts";
import type { SensitivityEvaluationInput } from "./shud-sensitivity-evaluate.ts";
import { FIXED_PLAN } from "./shud-sensitivity-plan.ts";
import { ccwSha256 } from "./shud-sensitivity-prepare.ts";
import {
  bound,
  hashDrift,
  message,
  type BatchRun,
  type CriterionCheck,
  type SensitivityBatch,
} from "./shud-sensitivity-criteria-workspace.ts";

const PROJECT = FIXED_PLAN.project;
const COPY = `input/${PROJECT}`;
const CALIB = `${COPY}/${PROJECT}.cfg.calib`;
const PARAMETERS = `${COPY}/${PROJECT}.cfg.para`;
const BAK = `output/${PROJECT}.out/${PROJECT}.cfg.calib.bak`;
const RIVQDOWN = `output/${PROJECT}.out/${PROJECT}.rivqdown.dat`;

export interface LinkedRun extends BatchRun {
  /** `<workspace>/runs/<run_id>`, the directory the run's files were read from. */
  dir: string;
}

/** Every card-linked job with a run directory, in `linked_jobs` order; the rest named. */
function linkedRuns(workspace: string, batch: SensitivityBatch, evidence: string[]): LinkedRun[] {
  requireFact(batch.card, "no sensitivity TaskCard");
  const runs = batch.runs();
  const found: LinkedRun[] = [];
  for (const id of batch.card.linked_jobs) {
    const run = runs.get(id);
    if (run) found.push({ ...run, dir: join(workspace, "runs", run.job.run_id) });
    else evidence.push(`${id} has no run directory`);
  }
  if (found.length === 0) evidence.push("no linked run directory");
  return found;
}

/** SHUD writes the calib `.bak` with `%g`, so both sides compare at six significant digits. */
const significant = (value: number) => Number(value.toPrecision(6));

/**
 * Criterion 4: every `.bak` entry whose key the workspace source calib has equals `b × m` for
 * the run's perturbed key and `b` otherwise (the source's last effective line, as SHUD reads).
 * Duplicated `.bak` keys are each compared; source keys SHUD does not write are not required.
 */
function effectiveCalib(input: SensitivityEvaluationInput, batch: SensitivityBatch): string[] {
  const { plan } = bound(batch);
  const source = new Map(
    readShudTextInput(input.workspace, CALIB, "cfg.calib").data.map((e) => [e.key, e.value]),
  );
  const sets = new Map(plan.parameter_sets.map((set) => [set.parameter_set_id, set]));
  const evidence: string[] = [];
  for (const { job, dir } of linkedRuns(input.workspace, batch, evidence)) {
    const set = sets.get(job.parameter_set_id ?? "");
    if (!set) {
      evidence.push(`${job.run_id} parameter_set_id ${job.parameter_set_id} is not in the plan`);
      continue;
    }
    let entries: { key: string; value: number }[];
    try {
      entries = readShudTextInput(dir, BAK, "cfg.calib").data;
    } catch (error) {
      evidence.push(`${job.run_id}: ${message(error)}`);
      continue;
    }
    const changes: Record<string, number | undefined> = set.changes;
    const compared = new Set<string>();
    for (const { key, value } of entries) {
      const base = source.get(key);
      if (base === undefined) continue;
      compared.add(key);
      const expected = significant(base * (changes[key] ?? 1));
      if (significant(value) !== expected)
        evidence.push(`${job.run_id} ${key}: expected ${expected} actual ${value}`);
    }
    for (const key of Object.keys(set.changes))
      if (!compared.has(key))
        evidence.push(
          `${job.run_id} ${key}: perturbed key not compared (absent from ${BAK} or ${CALIB})`,
        );
  }
  return evidence;
}

const HEALTH = ["water_balance_residual", "cvode_failures", "negative_state_count"] as const;

/** Criterion 5: three health values observed, max_solver_dt null, metrics.json ok at its digest. */
function numericalHealth(input: SensitivityEvaluationInput, batch: SensitivityBatch): string[] {
  const evidence: string[] = [];
  for (const { job, record, dir } of linkedRuns(input.workspace, batch, evidence)) {
    if (!record) {
      evidence.push(`${job.job_id} has no RunRecord`);
      continue;
    }
    const id = record.run_id;
    const health = record.numerical_health;
    for (const field of HEALTH)
      if (health[field] === null) evidence.push(`${id} numerical_health.${field} is null`);
    if (health.max_solver_dt !== null)
      evidence.push(`${id} numerical_health.max_solver_dt ${health.max_solver_dt} (expected null)`);
    const summary = record.artifacts.metrics_summary;
    if (!summary) {
      evidence.push(`${id} artifacts.metrics_summary is null`);
      continue;
    }
    try {
      const { sha256 } = readShudInputFile(dir, summary.path);
      if (sha256 !== summary.sha256)
        evidence.push(
          `${id} metrics.json sha256 ${sha256} (RunRecord artifacts.metrics_summary.sha256 ${summary.sha256})`,
        );
      else {
        const { status } = readRunMetrics(dir, sha256);
        if (status !== "ok") evidence.push(`${id} metrics.json status ${status} (expected ok)`);
      }
    } catch (error) {
      evidence.push(`${id} metrics.json: ${message(error)}`);
    }
  }
  return evidence;
}

/** The report's companion recomputed through the records closure → summary → wire chain. */
async function summaryDrift(
  input: SensitivityEvaluationInput,
  batch: SensitivityBatch,
  card: TaskCard,
  runs: LinkedRun[],
): Promise<string[]> {
  const report = batch.report();
  const reference = report.sensitivity_summary;
  if (!reference) return [`${report.report_id} has no sensitivity_summary`];
  const runJobs = [];
  for (const { job, dir } of runs)
    runJobs.push({ job, collect_error_attempts: await readCollectErrorAttempts(dir) });
  const records = runs.flatMap(({ job, record }) =>
    job.status === "collected" && record ? [record] : [],
  );
  const { observations, limitations, pi_questions } = report;
  const loaders = createSensitivityClosureLoaders(input.workspace);
  const draft = { observations, limitations, pi_questions };
  const closure = deriveSensitivityClosure(card, runJobs, records, draft, loaders);
  if (!closure.ok) return [`sensitivity closure failed: ${JSON.stringify(closure.failures)}`];
  const planFile = `analyses/${closure.analysis_plan_id}.json`;
  const planBytes = readShudInputFile(input.workspace, planFile).bytes;
  const fresh = serializeSensitivitySummary(buildSensitivitySummary(closure, planBytes));
  const stored = readShudInputFile(input.workspace, reference.path).bytes;
  return stored.equals(Buffer.from(fresh, "utf8"))
    ? []
    : [`${reference.path} differs from the recomputed summary`];
}

/** Criterion 6: each ok run's metrics.json and the report's summary are byte-for-byte recomputable. */
async function recomputable(
  input: SensitivityEvaluationInput,
  batch: SensitivityBatch,
): Promise<string[]> {
  const { card } = bound(batch);
  const evidence: string[] = [];
  const runs = linkedRuns(input.workspace, batch, evidence);
  for (const { job, record, dir } of runs) {
    if (record?.exit_class !== "ok") continue;
    const file = `runs/${job.run_id}/metrics.json`;
    try {
      const stored = readShudInputFile(dir, "metrics.json").bytes;
      const fresh = serializeRunMetrics(computeRunMetrics(dir, PROJECT).metrics);
      if (!stored.equals(Buffer.from(fresh, "utf8")))
        evidence.push(`${file} differs from the recomputed metrics`);
    } catch (error) {
      evidence.push(`${file}: ${message(error)}`);
    }
  }
  try {
    evidence.push(...(await summaryDrift(input, batch, card, runs)));
  } catch (error) {
    evidence.push(`summary recompute: ${message(error)}`);
  }
  return evidence;
}

/**
 * The one card-linked, collected, succeeded run of the plan's baseline set, or why there is none.
 * Criterion 7 and the batch-external repeat share this rule; an unbound batch throws.
 */
export function inBatchBaseline(workspace: string, batch: SensitivityBatch): LinkedRun | string {
  const { plan } = bound(batch);
  const runs = linkedRuns(workspace, batch, []);
  const sets = new Set(
    plan.parameter_sets.filter((set) => set.baseline).map((set) => set.parameter_set_id),
  );
  const found = runs.filter(
    ({ job, record }) =>
      sets.has(job.parameter_set_id ?? "") &&
      job.status === "collected" &&
      record?.status === "succeeded",
  );
  return found.length === 1
    ? found[0]
    : `${found.length} collected succeeded in-batch baseline runs`;
}

/**
 * Criterion 7: in-batch RunJobs ran with one thread, and the batch-external repeat ran the
 * baseline copy with `"1"` thread variables, exited 0 and reproduced the baseline rivqdown bytes.
 * rivqdown is compared only once the repeat's input, environment and baseline identity hold.
 */
function repeatRun(input: SensitivityEvaluationInput, batch: SensitivityBatch): string[] {
  bound(batch);
  const evidence: string[] = [];
  const runs = linkedRuns(input.workspace, batch, evidence);
  for (const { job } of runs)
    if (job.threads !== FIXED_PLAN.threads)
      evidence.push(`${job.run_id} RunJob threads ${job.threads} (expected ${FIXED_PLAN.threads})`);
  const repeat = input.repeat;
  if (repeat.status === "not_executed")
    return [...evidence, `repeat run not executed: ${repeat.reason}`];
  const label = `repeat ${repeat.run_id}`;
  if (repeat.exit_code !== 0) evidence.push(`${label} exit_code ${repeat.exit_code} (expected 0)`);
  const threads = String(FIXED_PLAN.threads);
  const blocking: string[] = [];
  const environment = {
    OMP_NUM_THREADS: repeat.omp_num_threads,
    SHUD_RHS_THREADS: repeat.shud_rhs_threads,
  };
  for (const [name, value] of Object.entries(environment))
    if (value !== threads) blocking.push(`${label} ${name} "${value}" (expected "${threads}")`);
  const baseline = inBatchBaseline(input.workspace, batch);
  if (typeof baseline === "string") blocking.push(baseline);
  else {
    if (repeat.baseline_run_id !== baseline.job.run_id)
      blocking.push(
        `${label} baseline_run_id ${repeat.baseline_run_id} (in-batch baseline ${baseline.job.run_id})`,
      );
    const copy = ccwSha256(join(baseline.dir, COPY));
    blocking.push(...hashDrift(`${label} input `, copy, repeat.input_sha256));
  }
  evidence.push(...blocking);
  if (typeof baseline === "string" || blocking.length > 0)
    return [
      ...evidence,
      "rivqdown not compared: repeat input, thread environment or baseline differs",
    ];
  if (repeat.rivqdown_sha256 === null) return [...evidence, `${label} rivqdown_sha256 null`];
  try {
    const own = readShudInputFile(baseline.dir, RIVQDOWN).sha256;
    if (own !== repeat.rivqdown_sha256)
      evidence.push(
        `${label} rivqdown sha256 ${repeat.rivqdown_sha256} differs from in-batch baseline ${baseline.job.run_id} ${own}`,
      );
  } catch (error) {
    evidence.push(`${baseline.job.run_id} ${RIVQDOWN}: ${message(error)}`);
  }
  return evidence;
}

/**
 * The run copy the registry writes for the fixed plan (`shud-submissions.ts:265-277` order):
 * END, then the DT_YE_IC output interval, then NUM_OPENMP, each on every effective line or
 * appended. With an effective END line the first step equals `updateEnd`'s bytes.
 */
export function expectedRunParameters(source: Uint8Array): Buffer {
  const end = ensureOutputIntervalBytes(source, "END", FIXED_PLAN.end_days);
  return ensureOutputIntervalBytes(submittedParameterBytes(end), "NUM_OPENMP", FIXED_PLAN.threads);
}

/** Every physical line (terminator included) that differs, by one-based number. */
function lineDrift(file: string, actual: Buffer, expected: Buffer): string[] {
  const lines = (bytes: Buffer) => bytes.toString("latin1").split(/(?<=\n)/u);
  const [own, wanted] = [lines(actual), lines(expected)];
  const show = (value: string | undefined) =>
    value === undefined ? "absent" : JSON.stringify(value);
  const drift: string[] = [];
  for (let index = 0; index < Math.max(own.length, wanted.length); index++)
    if (own[index] !== wanted[index])
      drift.push(
        `${file} line ${index + 1}: ${show(own[index])} (expected ${show(wanted[index])})`,
      );
  return drift;
}

/** Criterion 13: each run copy's cfg.para is the source with only END/DT_YE_IC/NUM_OPENMP changed. */
function runParameters(input: SensitivityEvaluationInput, batch: SensitivityBatch): string[] {
  const expected = expectedRunParameters(readShudInputFile(input.workspace, PARAMETERS).bytes);
  const evidence: string[] = [];
  for (const { job, dir } of linkedRuns(input.workspace, batch, evidence)) {
    const file = `runs/${job.run_id}/${PARAMETERS}`;
    try {
      const actual = readShudInputFile(dir, PARAMETERS).bytes;
      if (!actual.equals(expected)) evidence.push(...lineDrift(file, actual, expected));
    } catch (error) {
      evidence.push(`${file}: ${message(error)}`);
    }
  }
  return evidence;
}

export function numericCriteria(
  input: SensitivityEvaluationInput,
  batch: SensitivityBatch,
): CriterionCheck[] {
  return [
    [4, () => effectiveCalib(input, batch)],
    [5, () => numericalHealth(input, batch)],
    [6, () => recomputable(input, batch)],
    [7, () => repeatRun(input, batch)],
    [13, () => runParameters(input, batch)],
  ];
}
