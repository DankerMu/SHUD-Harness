import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  DataProvenanceSchema,
  EvidenceReportSchema,
  RunJobSchema,
  RunRecordSchema,
  StackLockSchema,
  TaskCardSchema,
  type DataProvenance,
  type EvidenceReport,
  type RunJob,
  type RunRecord,
  type StackLock,
  type TaskCard,
} from "../../packages/dsh-shud-core/src/schemas/index.ts";
import { GOVERNANCE_INVARIANTS } from "../../packages/dsh-shud-core/src/governance/wording.ts";
// Runtime scripts require the normal workspace build, as do shud:tiny/restart.
// The source renderer's transitive dependencies are not Node strip-only compatible.
import { renderReportDocument } from "../../packages/dsh-shud-records/lib/report-render.js";
import { object, text, type CanonicalEvent } from "./shud-restart-evidence.ts";

export interface FirstTaskLog {
  header: Record<string, unknown>;
  events: CanonicalEvent[];
  asOfSeq: number;
  canonicalLog: string;
  flushedThroughSeq: number;
}
export interface FirstTaskEvidence {
  workspace: string;
  home: string;
  root: FirstTaskLog;
  delegationBinding?: {
    parentSessionId: string;
    configPath: string;
    provider: string;
    agentPreset: string;
    toolName: string;
  };
  children: FirstTaskLog[];
  files: Record<string, unknown>;
  actualStack: {
    commits: Record<"SHUD" | "rSHUD" | "AutoSHUD", string>;
    llm: { base_url: string; request_alias: string; response_model: string };
  };
  inputs: {
    before: Record<string, string>;
    sourceAfter: Record<string, string>;
    copyAfter: Record<string, string>;
  };
}
type Predicate =
  | "CANONICAL_LOG"
  | "CHILD_IDENTITY"
  | "IDENTITY_JOIN"
  | "TOOL_RESULT"
  | "WORKER_COLLECTION"
  | "ORDER"
  | "REPORT_VALIDATION"
  | "MISSING_APPROVAL"
  | "APPROVAL_JOIN"
  | "SCHEMA"
  | "TASK_DONE"
  | "MARKDOWN"
  | "STACK"
  | "INVARIANTS"
  | "INPUTS";
type EventLog = Pick<FirstTaskLog, "events">;
function fact(value: unknown, code: Predicate): asserts value {
  if (!value)
    throw Object.assign(new Error(`First-task predicate failed: ${code}`), {
      code: `FIRST_TASK_${code}`,
    });
}
function data(event: CanonicalEvent): Record<string, unknown> {
  return object(event.data);
}
function calls(log: EventLog, name: string): CanonicalEvent[] {
  return log.events.filter((event) => event.type === "tool/call" && data(event).name === name);
}
function onlyCall(log: EventLog, name: string, code: Predicate): CanonicalEvent {
  const values = calls(log, name);
  fact(values.length === 1, code);
  return values[0];
}
function argumentsOf(call: CanonicalEvent): Record<string, unknown> {
  return object(JSON.parse(text(data(call).arguments)) as unknown);
}
function resultFor(log: EventLog, call: CanonicalEvent, code: Predicate): CanonicalEvent {
  const id = text(data(call).callId);
  const results = log.events.filter(
    (event) => event.type === "tool/result" && object(data(event).message).toolCallId === id,
  );
  fact(results.length === 1, "TOOL_RESULT");
  const event = results[0];
  const value = data(event);
  const message = object(value.message);
  fact(
    message.role === "tool" &&
      object(message.source).kind === "tool" &&
      object(message.source).callId === id,
    "TOOL_RESULT",
  );
  fact(event.seq > call.seq, "ORDER");
  fact(!value.error && message.isError === false, code);
  return event;
}
function resultText(event: CanonicalEvent): string {
  const content = object(data(event).message).content;
  fact(Array.isArray(content), "TOOL_RESULT");
  return content
    .map((part: unknown) => {
      const item = object(part);
      return item.type === "text" ? text(item.text) : "";
    })
    .join("");
}
function resultObject(event: CanonicalEvent): Record<string, unknown> {
  return object(JSON.parse(resultText(event)) as unknown);
}
function validateLog(log: FirstTaskLog, home: string): void {
  fact(
    log.header.type === "session" &&
      log.header.version === 4 &&
      typeof log.header.id === "string" &&
      /^[A-Za-z0-9-]+$/u.test(log.header.id) &&
      Number.isSafeInteger(log.asOfSeq) &&
      log.asOfSeq >= -1 &&
      log.events.length === log.asOfSeq + 1 &&
      log.flushedThroughSeq >= log.asOfSeq &&
      Number.isSafeInteger(log.flushedThroughSeq) &&
      log.events.every((event, i) => event.seq === i && Number.isFinite(event.time)),
    "CANONICAL_LOG",
  );
  const path = relative(join(home, "sessions"), log.canonicalLog);
  fact(
    isAbsolute(log.canonicalLog) &&
      !isAbsolute(path) &&
      !path.split(sep).includes("..") &&
      path.split(sep).length === 3 &&
      path.split(sep)[1] === log.header.id &&
      /^session\.v4\.jsonl(?:\.zstd)?$/u.test(path.split(sep)[2]),
    "CANONICAL_LOG",
  );
  const ids = log.events
    .filter((event) => event.type === "tool/call")
    .map((event) => text(data(event).callId));
  fact(new Set(ids).size === ids.length, "TOOL_RESULT");
}
function parseFiles(files: Record<string, unknown>) {
  const tasks = new Map<string, TaskCard>();
  const jobs = new Map<string, RunJob>();
  const records = new Map<string, RunRecord>();
  const reports = new Map<string, EvidenceReport>();
  const stacks = new Map<string, StackLock>();
  const provenance = new Map<string, DataProvenance>();
  for (const [path, value] of Object.entries(files)) {
    if (/^tasks\/[^/]+\/task\.json$/u.test(path)) tasks.set(path, TaskCardSchema.parse(value));
    else if (/^runs\/[^/]+\/run-job\.json$/u.test(path)) jobs.set(path, RunJobSchema.parse(value));
    else if (/^runs\/[^/]+\/run-record\.json$/u.test(path))
      records.set(path, RunRecordSchema.parse(value));
    else if (/^reports\/[^/]+\.json$/u.test(path))
      reports.set(path, EvidenceReportSchema.parse(value));
    else if (/^stacks\/[^/]+\.json$/u.test(path)) stacks.set(path, StackLockSchema.parse(value));
    else if (/^provenance\/[^/]+\.json$/u.test(path))
      provenance.set(path, DataProvenanceSchema.parse(value));
  }
  return { tasks, jobs, records, reports, stacks, provenance };
}
function successfulValidation(log: EventLog, reportId: string) {
  const validations = calls(log, "report_validate").filter(
    (call) => argumentsOf(call).report_id === reportId,
  );
  fact(validations.length > 0, "REPORT_VALIDATION");
  const validated = validations.map((call) => ({
    call,
    result: resultFor(log, call, "REPORT_VALIDATION"),
  }));
  const validation = validated.find(({ result }) => {
    const output = resultObject(result);
    return output.report_id === reportId && output.ok === true && output.status === "reviewed";
  });
  fact(validation, "REPORT_VALIDATION");
  return validation;
}

/** Authorization is limited to this live canonical call's successfully validated report. */
export function approvalReport(log: EventLog, callId: string): string | undefined {
  try {
    const submit = onlyCall(log, "report_submit", "REPORT_VALIDATION");
    if (data(submit).callId !== callId) return undefined;
    const id = text(argumentsOf(submit).report_id);
    const validation = successfulValidation(log, id);
    return validation.result.seq < submit.seq ? id : undefined;
  } catch {
    return undefined;
  }
}

function assertSnapshot(e: FirstTaskEvidence) {
  const files = parseFiles(e.files);
  validateLog(e.root, e.home);
  for (const child of e.children) validateLog(child, e.home);
  fact(
    e.root.header.cwd === e.workspace && e.root.header.agentPreset === "coordinator",
    "CHILD_IDENTITY",
  );
  const root = e.root;
  const taskCall = onlyCall(root, "task_create", "IDENTITY_JOIN");
  const taskResult = resultFor(root, taskCall, "TOOL_RESULT");
  const taskOutput = resultObject(taskResult);
  const taskId = text(taskOutput.task_id);
  fact(
    taskOutput.status === "planned" && argumentsOf(taskCall).type === "science_assist",
    "IDENTITY_JOIN",
  );
  const delegation = onlyCall(root, "subagent", "CHILD_IDENTITY");
  const delegated = argumentsOf(delegation);
  if (delegated.agent_preset !== "worker") {
    const binding = e.delegationBinding;
    fact(delegated.agent_preset === undefined && binding !== undefined, "CHILD_IDENTITY");
    fact(
      binding.parentSessionId === root.header.id &&
        binding.provider === "spawn" &&
        binding.agentPreset === "worker" &&
        binding.toolName === "subagent" &&
        binding.configPath === join(e.home, "first-task-evidence/effective-config.json"),
      "CHILD_IDENTITY",
    );
  }
  fact(
    typeof delegated.prompt === "string" &&
      delegated.prompt.includes(taskId) &&
      delegated.prompt.includes(join(e.workspace, "input/ccw")),
    "IDENTITY_JOIN",
  );
  const delegatedResult = resultFor(root, delegation, "TOOL_RESULT");
  const catalogs = root.events.filter((event) => event.type === "subagent/catalog");
  fact(catalogs.length === 1, "CHILD_IDENTITY");
  const catalog = catalogs[0];
  const childId = text(data(catalog).childId);
  const children = e.children.filter((child) => child.header.id === childId);
  fact(
    children.length === 1 && resultText(delegatedResult) === `started subagent ${childId}`,
    "CHILD_IDENTITY",
  );
  const worker = children[0];
  fact(
    worker.header.parentSession === root.header.id &&
      worker.header.origin === "subagent" &&
      worker.header.agentPreset === "worker" &&
      worker.header.delegationDepth === 1 &&
      worker.header.cwd === e.workspace &&
      worker.header.createdAt === data(catalog).childCreatedAt,
    "CHILD_IDENTITY",
  );
  fact(
    taskResult.seq < delegation.seq &&
      delegation.seq < catalog.seq &&
      catalog.seq < delegatedResult.seq,
    "ORDER",
  );
  fact(calls(root, "shud_run").length === 0, "CHILD_IDENTITY");
  const runCall = onlyCall(worker, "shud_run", "WORKER_COLLECTION");
  const runArgs = argumentsOf(runCall);
  fact(
    runArgs.task_id === taskId &&
      runArgs.input_dir === join(e.workspace, "input/ccw") &&
      runArgs.end_days === 30 &&
      (runArgs.project === undefined || runArgs.project === "ccw"),
    "IDENTITY_JOIN",
  );
  const runResult = resultFor(worker, runCall, "TOOL_RESULT");
  const submission =
    /^SHUD running: job_id=([^,\n]+), run_id=([^,\n]+), dsh_job_id=([^,\n]+), run_dir=([^\n]+)\.\n/u.exec(
      resultText(runResult),
    );
  fact(submission, "IDENTITY_JOIN");
  const [, jobId, runId, dshId, runDir] = submission;
  fact(runDir === join(e.workspace, "runs", runId), "IDENTITY_JOIN");
  const waits = calls(worker, "job_output").filter((call) => {
    const args = argumentsOf(call);
    return args.job_id === dshId && args.wait === true;
  });
  fact(waits.length > 0, "WORKER_COLLECTION");
  const waited = waits.map((call) => ({
    call,
    result: resultFor(worker, call, "WORKER_COLLECTION"),
  }));
  const terminalWait = waited.find(({ result }) =>
    resultText(result).includes("[status: completed, SHUD exited with code 0]"),
  );
  fact(terminalWait, "WORKER_COLLECTION");
  const collectCall = onlyCall(worker, "shud_collect", "WORKER_COLLECTION");
  const collectArgs = argumentsOf(collectCall);
  fact(
    !(typeof collectArgs.job_id === "string" && collectArgs.job_id.startsWith("shud-")),
    "WORKER_COLLECTION",
  );
  fact(
    (collectArgs.run_id === runId && collectArgs.job_id === undefined) ||
      (collectArgs.job_id === jobId && collectArgs.run_id === undefined),
    "IDENTITY_JOIN",
  );
  const collectResult = resultFor(worker, collectCall, "WORKER_COLLECTION");
  const collected = RunRecordSchema.parse(resultObject(collectResult));
  fact(
    collected.status === "succeeded" && collected.exit_code === 0 && collected.exit_class === "ok",
    "WORKER_COLLECTION",
  );
  fact(
    collected.run_id === runId && collected.job_id === jobId && collected.task_id === taskId,
    "IDENTITY_JOIN",
  );
  const ends = worker.events.filter((event) => event.type === "turn/end");
  fact(ends.length > 0, "WORKER_COLLECTION");
  const end = ends[ends.length - 1];
  fact(object(data(end).reason).kind === "completed", "WORKER_COLLECTION");
  fact(
    runResult.seq < terminalWait.call.seq &&
      terminalWait.result.seq < collectCall.seq &&
      collectResult.seq < end.seq,
    "ORDER",
  );
  const settled = root.events.filter(
    (event) =>
      event.type === "user/message" &&
      object(data(event).source).kind === "subagent-settled" &&
      object(data(event).source).senderSessionId === childId,
  );
  fact(settled.length > 0, "CHILD_IDENTITY");
  const submit = onlyCall(root, "report_submit", "REPORT_VALIDATION");
  const reportId = text(argumentsOf(submit).report_id);
  const generations = calls(root, "report_generate");
  for (const generation of generations) {
    fact(
      taskResult.seq < generation.seq &&
        settled.some((notice) => delegatedResult.seq < notice.seq && notice.seq < generation.seq),
      "ORDER",
    );
  }
  const generation = generations.find(
    (call) => resultObject(resultFor(root, call, "TOOL_RESULT")).report_id === reportId,
  );
  fact(generation && argumentsOf(generation).task_id === taskId, "REPORT_VALIDATION");
  const generated = resultFor(root, generation, "TOOL_RESULT");
  fact(resultObject(generated).status === "draft", "REPORT_VALIDATION");
  const validation = successfulValidation(root, reportId);
  fact(generated.seq < validation.call.seq && validation.result.seq < submit.seq, "ORDER");
  const submitResult = resultFor(root, submit, "TOOL_RESULT");
  const submitOutput = resultObject(submitResult);
  fact(submitOutput.report_id === reportId && submitOutput.status === "accepted", "IDENTITY_JOIN");
  const asks = root.events.filter((event) => event.type === "approval/asked");
  const decisions = root.events.filter((event) => event.type === "approval/decided");
  fact(asks.length > 0 && decisions.length > 0, "MISSING_APPROVAL");
  const matching = asks.filter((event) => data(event).callId === data(submit).callId);
  fact(matching.length === 1, "APPROVAL_JOIN");
  const asked = matching[0];
  fact(
    data(asked).toolName === "report_submit" &&
      data(asked).reason === `PI approval required for report ${reportId}`,
    "APPROVAL_JOIN",
  );
  const answers = decisions.filter((event) => data(event).id === data(asked).id);
  fact(answers.length === 1 && data(answers[0]).outcome === "allowed-once", "APPROVAL_JOIN");
  fact(
    submit.seq < asked.seq && asked.seq < answers[0].seq && answers[0].seq < submitResult.seq,
    "ORDER",
  );
  const task = files.tasks.get(`tasks/${taskId}/task.json`);
  const job = files.jobs.get(`runs/${runId}/run-job.json`);
  const record = files.records.get(`runs/${runId}/run-record.json`);
  const report = files.reports.get(`reports/${reportId}.json`);
  fact(task && job && record && report, "IDENTITY_JOIN");
  fact(task.status === "done", "TASK_DONE");
  fact(job.status === "collected", "WORKER_COLLECTION");
  fact(
    task.task_id === taskId &&
      task.linked_jobs.includes(job.job_id) &&
      task.linked_reports.includes(report.report_id) &&
      job.job_id === jobId &&
      job.run_id === runId &&
      job.task_id === taskId &&
      job.owner_session === childId &&
      job.run_dir === runDir &&
      job.input_dir === runArgs.input_dir &&
      job.end_days === 30 &&
      job.project === "ccw" &&
      job.dsh_job_id === dshId &&
      job.dsh_job_ids.includes(dshId) &&
      job.exit_code === 0 &&
      record.run_id === runId &&
      record.job_id === jobId &&
      record.task_id === taskId &&
      record.status === "succeeded" &&
      record.exit_code === 0 &&
      isDeepStrictEqual(record, collected) &&
      isDeepStrictEqual(record.command, job.command) &&
      isDeepStrictEqual(record.llm, job.llm) &&
      report.task_id === taskId &&
      report.report_id === reportId &&
      report.status === "accepted" &&
      report.linked_runs.length === 1 &&
      report.linked_runs[0] === runId,
    "IDENTITY_JOIN",
  );
  fact(
    task.stack_id &&
      task.data_id &&
      job.stack_id === task.stack_id &&
      record.stack_id === task.stack_id &&
      job.data_id === task.data_id &&
      record.data_id === task.data_id &&
      report.stack_ids.length === 1 &&
      report.stack_ids[0] === task.stack_id &&
      report.data_ids.length === 1 &&
      report.data_ids[0] === task.data_id &&
      report.llm_response_models.length === 1 &&
      report.llm_response_models[0] === record.llm.response_model,
    "IDENTITY_JOIN",
  );
  const stack = files.stacks.get(`stacks/${task.stack_id}.json`);
  const provenance = files.provenance.get(`provenance/${task.data_id}.json`);
  fact(
    stack && provenance && stack.stack_id === task.stack_id && provenance.data_id === task.data_id,
    "IDENTITY_JOIN",
  );
  fact(report.decision_history.length === 1, "IDENTITY_JOIN");
  const decision = report.decision_history[0];
  fact(
    decision.report_id === reportId &&
      decision.decision_id === submitOutput.decision_id &&
      decision.outcome === "accepted" &&
      decision.comment === null,
    "IDENTITY_JOIN",
  );
  fact(decision.approval_ref === data(submit).callId, "APPROVAL_JOIN");
  fact(
    isDeepStrictEqual(stack.llm, e.actualStack.llm) &&
      stack.llm.response_model === record.llm.response_model &&
      (["SHUD", "rSHUD", "AutoSHUD"] as const).every(
        (name) =>
          /^[0-9a-f]{40}$/u.test(e.actualStack.commits[name]) &&
          stack.repos[name].commit === e.actualStack.commits[name],
      ),
    "STACK",
  );
  const markdown = e.files[`reports/${reportId}.md`];
  fact(typeof markdown === "string", "MARKDOWN");
  fact(
    GOVERNANCE_INVARIANTS.every((sentence) => markdown.includes(sentence)),
    "INVARIANTS",
  );
  fact(
    markdown === renderReportDocument(report, [stack], [provenance], [record]).markdown,
    "MARKDOWN",
  );
  fact(
    Object.keys(e.inputs.before).length > 0 &&
      Object.values(e.inputs.before).every((hash) => /^[0-9a-f]{64}$/u.test(hash)) &&
      isDeepStrictEqual(e.inputs.before, e.inputs.sourceAfter) &&
      isDeepStrictEqual(e.inputs.before, e.inputs.copyAfter),
    "INPUTS",
  );
  return {
    criteria: {
      canonicalSessions: true,
      workerCollected: true,
      reportValidated: true,
      approvalJoined: true,
      taskDone: true,
      recordsJoined: true,
      canonicalMarkdown: true,
      stackRecorded: true,
      governanceInvariants: true,
      inputsUnchanged: true,
    },
    ids: {
      rootSessionId: text(root.header.id),
      workerSessionId: childId,
      taskId,
      jobId,
      runId,
      reportId,
      decisionId: decision.decision_id,
      submitCallId: text(data(submit).callId),
    },
  };
}

/** Read-only replay verdict shared by the live gate and independent fault snapshots. */
export function assertFirstTaskEvidence(evidence: FirstTaskEvidence) {
  try {
    return assertSnapshot(evidence);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("FIRST_TASK_")
    )
      throw error;
    fact(false, "SCHEMA");
  }
}
