import { join } from "node:path";
import { calls, data } from "./shud-evidence-events.ts";
import { object, text } from "./shud-restart-evidence.ts";
import type { SessionLog } from "./shud-session-log.ts";
import type { SensitivityEvaluationInput } from "./shud-sensitivity-evaluate.ts";
import { submoduleHead } from "./shud-sensitivity-prepare.ts";
import {
  hashDrift,
  message,
  type CriterionCheck,
  type SensitivityBatch,
} from "./shud-sensitivity-criteria-workspace.ts";
import { HASH_LIMIT, rawTreeMd5, treeHashes } from "./shud-tree-digest.ts";

const preset = (log: SessionLog) => log.header.agentPreset;

/** Criterion 9: one report_submit approval in the whole scope, allowed once, cited by the report. */
function oneApproval(input: SensitivityEvaluationInput, batch: SensitivityBatch): string[] {
  const events = (type: string) =>
    input.logs.flatMap((log) =>
      log.events
        .filter((event) => event.type === type)
        .map((event) => ({ session: text(log.header.id), value: data(event) })),
    );
  const asks = events("approval/asked");
  if (asks.length !== 1 || asks[0].value.toolName !== "report_submit") {
    const listed = asks.map(
      ({ session, value }) => `${text(value.toolName)}/${text(value.callId)} in ${session}`,
    );
    return [
      `expected one report_submit approval/asked, found ${asks.length}: ${listed.join(", ")}`,
    ];
  }
  const ask = asks[0].value;
  const callId = text(ask.callId);
  const evidence: string[] = [];
  const outcomes = events("approval/decided")
    .filter(({ value }) => value.id === ask.id)
    .map(({ value }) => text(value.outcome));
  if (outcomes.length !== 1 || outcomes[0] !== "allowed-once")
    evidence.push(`approval ${callId} decided [${outcomes.join(", ")}] (expected allowed-once)`);
  try {
    const report = batch.report();
    const refs = report.decision_history.map((decision) => decision.approval_ref);
    if (refs.length === 0 || refs.some((ref) => ref !== callId))
      evidence.push(
        `${report.report_id} decision_history approval_ref ${refs.join(", ") || "none"} (expected ${callId})`,
      );
  } catch (error) {
    evidence.push(message(error));
  }
  return evidence;
}

function hasResult(log: SessionLog, name: string): boolean {
  const ids = new Set(calls(log, name).map((call) => data(call).callId));
  return log.events.some(
    (event) => event.type === "tool/result" && ids.has(object(data(event).message).toolCallId),
  );
}

/** Criterion 10: both role headers exist; plans come from a coordinator, runs only from workers. */
function roleSplit(input: SensitivityEvaluationInput): string[] {
  const evidence: string[] = [];
  for (const role of ["coordinator", "worker"])
    if (!input.logs.some((log) => preset(log) === role)) evidence.push(`no ${role} session header`);
  const plans = input.logs.filter((log) => hasResult(log, "analysis_create"));
  if (!plans.some((log) => preset(log) === "coordinator"))
    evidence.push("analysis_create tool/result not in a coordinator session");
  const runs = input.logs.filter((log) => hasResult(log, "shud_run"));
  if (runs.length === 0) evidence.push("no shud_run tool/result");
  for (const log of runs)
    if (preset(log) !== "worker")
      evidence.push(`shud_run tool/result in non-worker session ${text(log.header.id)}`);
  return evidence;
}

/** Criterion 11: source md5, submodule HEADs and data/raw recomputed read-only against the record. */
async function preserved(input: SensitivityEvaluationInput): Promise<string[]> {
  const record = input.preparation;
  const budget = { remaining: HASH_LIMIT };
  const source = treeHashes(join(input.root, "SHUD/input/ccw"), "md5", budget);
  const evidence = hashDrift("SHUD/input/ccw/", record.source_md5, source);
  for (const [name, before] of Object.entries(record.submodules)) {
    const after = await submoduleHead(input.root, name);
    if (after !== before) evidence.push(`${name} ${before} -> ${after}`);
  }
  const raw = rawTreeMd5(input.root, input.workspace, budget);
  evidence.push(...hashDrift("data/raw ", record.raw.md5, raw.md5));
  for (const side of ["harness", "workspace"] as const)
    if (raw.roots[side] !== record.raw.roots[side])
      evidence.push(`data/raw ${side} root exists ${record.raw.roots[side]} -> ${raw.roots[side]}`);
  return evidence;
}

export function governanceCriteria(
  input: SensitivityEvaluationInput,
  batch: SensitivityBatch,
): CriterionCheck[] {
  return [
    [9, () => oneApproval(input, batch)],
    [10, () => roleSplit(input)],
    [11, () => preserved(input)],
  ];
}
