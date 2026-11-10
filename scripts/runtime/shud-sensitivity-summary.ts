import { requireFact } from "./shud-restart-evidence.ts";
import { bound, loadSensitivityBatch, schemaParse } from "./shud-sensitivity-criteria-workspace.ts";
import { SensitivityRepeatRecordSchema } from "./shud-sensitivity-evaluate.ts";
import { load } from "./shud-web-driver.ts";

/**
 * Exit-0 summary, read from workspace records and the repeat record only: task, plan, each
 * parameter set's collected succeeded run, the common StackLock, the repeat rivqdown digest and
 * the accepted report.
 */
export function sensitivitySummary(workspace: string, repeatPath: string): string {
  const batch = loadSensitivityBatch(workspace);
  const { card, plan } = bound(batch);
  const runs = [...batch.runs().values()].filter(
    ({ job, record }) =>
      card.linked_jobs.includes(job.job_id) &&
      job.status === "collected" &&
      record?.status === "succeeded",
  );
  const lines = [`task_id ${card.task_id}`, `analysis_plan_id ${plan.analysis_plan_id}`];
  const stacks = new Set<string | null>();
  for (const set of plan.parameter_sets) {
    const own = runs.filter(({ job }) => job.parameter_set_id === set.parameter_set_id);
    requireFact(own.length === 1, `${own.length} succeeded runs for ${set.parameter_set_id}`);
    lines.push(`${set.parameter_set_id} -> ${own[0].job.run_id}`);
    stacks.add(own[0].record?.stack_id ?? null);
  }
  const [stack] = stacks;
  requireFact(stacks.size === 1 && stack, "batch runs do not share one StackLock");
  lines.push(`stack_id ${stack}`);
  const repeat = schemaParse(SensitivityRepeatRecordSchema, load(repeatPath));
  requireFact(repeat.status === "executed", "repeat run not executed");
  lines.push(`repeat rivqdown sha256 ${repeat.rivqdown_sha256}`);
  const report = batch.report();
  lines.push(`report_id ${report.report_id}: ${report.status}`);
  return lines.map((line) => `shud:sensitivity: ${line}\n`).join("");
}
