import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { object, requireFact, text, type CanonicalEvent } from "./shud-restart-evidence.ts";
import {
  argumentsOf,
  calls,
  completedResultFor,
  data,
  resultFor,
  resultObject,
  resultText,
  validateLog,
  successfulValidation,
} from "./shud-evidence-events.ts";
import type { SessionLog } from "./shud-session-log.ts";
import type { ReplayRecords } from "./shud-replay-records.ts";
import { REPLAY_FILES } from "./shud-replay-contract.ts";
import type { ReplayEvidence } from "./shud-replay-evidence.ts";
import {
  isCanonicalHarnessRole,
  isRoleToolIdAllowed,
} from "../../packages/dsh-shud-core/src/governance/role-tool-map.ts";

interface OwnedEvent {
  log: SessionLog;
  event: CanonicalEvent;
}

/** Also evaluated while an ask is pending: no transport callback is required to detect excess. */
export function replayAsks(logs: readonly SessionLog[]): OwnedEvent[] {
  const asks = logs.flatMap((log) =>
    log.events.filter((event) => event.type === "approval/asked").map((event) => ({ log, event })),
  );
  const ordered = [...asks].sort((left, right) => left.event.time - right.event.time);
  if (ordered.length > 2) {
    const extra = data(ordered[2].event);
    throw new Error(`Extra approval ${text(extra.toolName)} ${text(extra.callId)}`);
  }
  const tools = new Set<string>();
  for (const { log, event } of ordered) {
    const ask = data(event);
    const tool = text(ask.toolName);
    requireFact(
      (tool === "change_submit" && log.header.agentPreset === "coder") ||
        (tool === "report_submit" && log.header.agentPreset === "coordinator"),
      `Unexpected approval ${tool} ${text(ask.callId)}`,
    );
    requireFact(!tools.has(tool), `Duplicate approval ${tool} ${text(ask.callId)}`);
    tools.add(tool);
    const matching = calls(log, tool).filter(
      (call) => data(call).callId === ask.callId && call.seq < event.seq,
    );
    requireFact(
      matching.length === 1 && typeof ask.id === "string",
      `Approval call identity ${tool} ${text(ask.callId)}`,
    );
  }
  return ordered;
}

export function sessionComplete(log: SessionLog): boolean {
  const starts = log.events.filter((event) => event.type === "turn/start");
  const ends = log.events.filter((event) => event.type === "turn/end");
  return (
    starts.length > 0 &&
    ends.length > 0 &&
    ends[ends.length - 1].seq > starts[starts.length - 1].seq
  );
}

export function replayReady(logs: { root: SessionLog; children: SessionLog[] }): boolean {
  if (!sessionComplete(logs.root) || !logs.children.every(sessionComplete)) return false;
  const catalogs = logs.root.events.filter((event) => event.type === "subagent/catalog");
  const children = new Map(logs.children.map((child) => [child.header.id, child]));
  if (
    catalogs.length !== children.size ||
    children.size !== logs.children.length ||
    new Set(catalogs.map((event) => data(event).childId)).size !== catalogs.length
  )
    return false;
  const notices = logs.root.events.filter(
    (event) =>
      event.type === "user/message" &&
      object(object(event.data).source).kind === "subagent-settled",
  );
  const end = logs.root.events.filter((event) => event.type === "turn/end").at(-1)!;
  return (
    notices.every((notice) => notice.seq < end.seq) &&
    catalogs.every((catalog) => {
      const child = children.get(data(catalog).childId);
      return (
        child !== undefined &&
        notices.some(
          (notice) =>
            object(data(notice).source).senderSessionId === child.header.id &&
            notice.seq > catalog.seq,
        )
      );
    })
  );
}

export function assertReplayFlow(e: ReplayEvidence, r: ReplayRecords): void {
  const logs = [e.root, ...e.children];
  const asks = replayAsks(logs);
  requireFact(asks.length === 2, "Replay requires exactly two engineering approvals");
  requireFact(e.root.header.agentPreset === "coordinator", "Root coordinator identity");
  const ids = logs.map((log) => text(log.header.id));
  requireFact(new Set(ids).size === logs.length, "Duplicate session identity");
  for (const log of logs) {
    validateLog(log, e.home);
    const sessionId = text(log.header.id);
    requireFact(
      log.header.cwd === e.workspace && sessionComplete(log),
      `Incomplete or foreign session ${sessionId}`,
    );
    requireFact(
      log.events.every((event, index) => index === 0 || event.time >= log.events[index - 1].time),
      `Session event time regression ${sessionId}`,
    );
    const end = log.events.filter((event) => event.type === "turn/end").at(-1)!;
    requireFact(
      object(data(end).reason).kind === "completed",
      `Session did not complete ${sessionId}`,
    );
    for (const call of log.events.filter((event) => event.type === "tool/call"))
      completedResultFor(log, call, "TOOL_RESULT");
    const headers = log.events.filter((event) => event.type === "request/header");
    requireFact(headers.length > 0, `Missing request/header ${sessionId}`);
    if (log === e.root)
      for (const event of headers) {
        const toolValues = object(data(event).header).tools;
        requireFact(Array.isArray(toolValues), "Missing coordinator header.tools");
        const names = toolValues.map((tool: unknown) => text(object(tool).name));
        requireFact(
          ["subagent", "subagent_coder", "subagent_reviewer"].every((name) => names.includes(name)),
          "Missing coordinator delegation tools",
        );
      }
    const role = log.header.agentPreset;
    requireFact(isCanonicalHarnessRole(role), `Unknown session role ${sessionId}`);
    requireFact(
      log.events
        .filter((event) => event.type === "tool/call")
        .every((event) => isRoleToolIdAllowed(role, text(data(event).name))),
      `Forbidden role tool ${sessionId}`,
    );
  }
  const prompts = e.root.events.filter(
    (event) => event.type === "user/message" && object(data(event).source).kind === "user",
  );
  requireFact(prompts.length === 1, "Replay requires one coordinator prompt");
  const content = data(prompts[0]).content;
  requireFact(Array.isArray(content), "Missing coordinator prompt content");
  const prompt = content
    .map((part: unknown) => {
      const value = object(part).text;
      return value === undefined || value === null || value === "" ? "" : text(value);
    })
    .join("");
  requireFact(
    prompt.includes("p1e_strict_omp_design.md") &&
      REPLAY_FILES.every((path) => prompt.includes(path)) &&
      !prompt.includes("diff --git") &&
      !/^@@ /mu.test(prompt),
    "Replay prompt must provide the design path and five files, not a diff",
  );
  const bindings = new Map<
    string,
    { call: CanonicalEvent; result: CanonicalEvent; settled: CanonicalEvent }
  >();
  const catalogs = e.root.events.filter((event) => event.type === "subagent/catalog");
  requireFact(catalogs.length === e.children.length, "Catalog/child count mismatch");
  for (const child of e.children) {
    const id = text(child.header.id);
    const role = text(child.header.agentPreset);
    requireFact(
      ["coder", "worker", "reviewer"].includes(role) &&
        child.header.parentSession === e.root.header.id &&
        child.header.origin === "subagent" &&
        child.header.delegationDepth === 1,
      `Child ownership ${id}`,
    );
    const catalog = catalogs.filter((event) => data(event).childId === id);
    requireFact(
      catalog.length === 1 && data(catalog[0]).childCreatedAt === child.header.createdAt,
      `Catalog identity ${id}`,
    );
    const tool = role === "worker" ? "subagent" : `subagent_${role}`;
    const config = e.delegationBindings.filter(
      (entry) =>
        entry.parentSessionId === e.root.header.id &&
        entry.agentPreset === role &&
        entry.toolName === tool,
    );
    requireFact(
      config.length === 1 &&
        config[0].provider === "spawn" &&
        config[0].configPath === join(e.home, "replay-evidence/effective-config.json"),
      `Delegation configuration ${id}`,
    );
    const dispatches = calls(e.root, tool)
      .map((call) => ({ call, result: resultFor(e.root, call, "DELEGATION") }))
      .filter(({ result }) => resultText(result) === `started subagent ${id}`);
    requireFact(dispatches.length === 1, `Delegation result ${id}`);
    const { call, result } = dispatches[0];
    requireFact(
      call.seq < catalog[0].seq &&
        catalog[0].seq < result.seq &&
        call.time <= Number(child.header.createdAt),
      `Delegation order ${id}`,
    );
    const settled = e.root.events.filter(
      (event) =>
        event.type === "user/message" &&
        object(data(event).source).kind === "subagent-settled" &&
        object(data(event).source).senderSessionId === id,
    );
    requireFact(settled.length > 0, `Missing child settlement ${id}`);
    const end = child.events.filter((event) => event.type === "turn/end").at(-1)!;
    const notice = settled.find((event) => event.seq > result.seq && event.time >= end.time);
    requireFact(notice, `Child settlement order ${id}`);
    bindings.set(id, { call, result, settled: notice });
  }
  for (const role of ["coder", "worker", "reviewer"])
    requireFact(
      e.children.some((child) => child.header.agentPreset === role),
      `Missing role ${role}`,
    );
  const rootEnd = e.root.events.filter((event) => event.type === "turn/end").at(-1)!;
  requireFact(
    e.root.events
      .filter((event) => event.type === "user/message")
      .every((event) => event.seq < rootEnd.seq),
    "Coordinator has pending messages after its completed turn",
  );
  function one(
    name: string,
    predicate: (args: Record<string, unknown>) => boolean = () => true,
  ): OwnedEvent {
    const values = logs.flatMap((log) =>
      calls(log, name)
        .filter((event) => predicate(argumentsOf(event)))
        .map((event) => ({ log, event })),
    );
    requireFact(values.length === 1, `Expected one ${name} invocation`);
    return values[0];
  }
  function result(value: OwnedEvent) {
    return resultFor(value.log, value.event, "TOOL_RESULT");
  }
  function before(left: OwnedEvent, right: OwnedEvent): void {
    const completed = result(left);
    const leftName = text(data(left.event).name);
    const rightName = text(data(right.event).name);
    if (left.log === right.log)
      requireFact(completed.seq < right.event.seq, `Order ${leftName} -> ${rightName}`);
    else {
      requireFact(
        completed.time <= right.event.time,
        `Cross-session order ${leftName} -> ${rightName}`,
      );
      const leftBinding = bindings.get(text(left.log.header.id));
      const rightBinding = bindings.get(text(right.log.header.id));
      // Dependent child stages use settlement and dispatch bindings from the root log.
      if (!leftBinding)
        requireFact(
          rightBinding && completed.seq < rightBinding.call.seq,
          `Causal delegation order ${leftName} -> ${rightName}`,
        );
      else if (!rightBinding)
        requireFact(
          leftBinding.settled.seq < right.event.seq,
          `Causal settlement order ${leftName} -> ${rightName}`,
        );
      else
        requireFact(
          leftBinding.settled.seq < rightBinding.call.seq,
          `Causal dependent settlement order ${leftName} -> ${rightName}`,
        );
    }
  }
  const task = one("task_create");
  requireFact(
    task.log === e.root &&
      argumentsOf(task.event).type === "code_change" &&
      resultObject(result(task)).task_id === r.task.task_id,
    "Task creation identity",
  );
  const base = one("shud_build", (args) => args.change_id === undefined);
  const create = one("change_create");
  const change = one("change_submit");
  const candidate = one("shud_build", (args) => args.change_id === r.change.change_id);
  requireFact(
    logs.reduce((count, log) => count + calls(log, "shud_build").length, 0) === 2,
    "Expected exactly two build calls",
  );
  for (const [call, build] of [
    [base, r.base],
    [candidate, r.candidate],
  ] as const) {
    const args = argumentsOf(call.event),
      output = resultObject(result(call));
    requireFact(
      call.log.header.agentPreset === "coder" &&
        args.task_id === r.task.task_id &&
        output.build_id === build.build_id &&
        output.change_id === build.change_id &&
        output.patch_sha256 === build.patch_sha256 &&
        output.source_commit === build.source_commit &&
        output.rhs_openmp === build.rhs_openmp &&
        output.binary_sha256 === build.binary_sha256,
      `Build call join ${build.build_id}`,
    );
  }
  requireFact(
    argumentsOf(candidate.event).rhs_openmp === true &&
      argumentsOf(create.event).task_id === r.task.task_id &&
      create.log.header.agentPreset === "coder" &&
      resultObject(result(create)).change_id === r.change.change_id &&
      resultObject(result(create)).status === "proposed" &&
      argumentsOf(change.event).change_id === r.change.change_id &&
      resultObject(result(change)).status === "approved" &&
      resultObject(result(change)).change_id === r.change.change_id,
    "Change create/submit join",
  );
  const collected: OwnedEvent[] = [];
  const submitted: OwnedEvent[] = [];
  for (const [index, job] of r.jobs.entries()) {
    const run = one("shud_run", (args) => args.build_id === job.build_id);
    const args = argumentsOf(run.event);
    requireFact(
      run.log.header.id === job.owner_session &&
        run.log.header.agentPreset === "worker" &&
        args.task_id === r.task.task_id &&
        args.input_dir === job.input_dir &&
        args.threads === 1 &&
        args.end_days === undefined &&
        (args.project === undefined || args.project === "keliya"),
      `Worker run args ${job.run_id}`,
    );
    const submittedResult = result(run);
    requireFact(
      resultText(submittedResult).startsWith(
        `SHUD running: job_id=${job.job_id}, run_id=${job.run_id}, dsh_job_id=${job.dsh_job_id}, run_dir=${job.run_dir}.\n`,
      ),
      `Worker submission result ${job.run_id}`,
    );
    const waits = calls(run.log, "job_output").filter(
      (call) => argumentsOf(call).job_id === job.dsh_job_id && argumentsOf(call).wait === true,
    );
    const collectCall = calls(run.log, "shud_collect").find((call) => {
      const input = argumentsOf(call);
      if (input.run_id !== job.run_id && input.job_id !== job.job_id) return false;
      const completed = completedResultFor(run.log, call, "TOOL_RESULT");
      const value = data(completed);
      if (value.error || object(value.message).isError !== false) return false;
      const output = resultFor(run.log, call, "TOOL_RESULT");
      if (!isDeepStrictEqual(resultObject(output), r.runs[index])) return false;
      return waits.some((wait) => {
        if (wait.seq <= submittedResult.seq) return false;
        const terminal = resultFor(run.log, wait, "WORKER_WAIT");
        return (
          terminal.seq < call.seq &&
          resultText(terminal).includes("[status: completed, SHUD exited with code 0]")
        );
      });
    });
    requireFact(collectCall, `Worker collect result ${job.run_id}`);
    const collect: OwnedEvent = { log: run.log, event: collectCall };
    before(run, collect);
    submitted.push(run);
    collected.push(collect);
  }
  requireFact(
    logs.reduce((count, log) => count + calls(log, "shud_run").length, 0) === 2,
    "Expected two run calls",
  );
  const verify = one("verification_run");
  const verificationArgs = argumentsOf(verify.event),
    verificationOutput = resultObject(result(verify));
  requireFact(
    verify.log.header.agentPreset === "reviewer" &&
      verificationArgs.task_id === r.task.task_id &&
      verificationArgs.base_run_id === r.verification.base_run_id &&
      verificationArgs.candidate_run_id === r.verification.candidate_run_id &&
      verificationOutput.vc_id === r.verification.vc_id &&
      verificationOutput.status === "passed" &&
      isDeepStrictEqual(verificationOutput.observed, r.verification.observed),
    "Verification tool join",
  );
  const generations = calls(e.root, "report_generate").filter(
    (event) =>
      resultObject(resultFor(e.root, event, "REPORT_GENERATION")).report_id === r.report.report_id,
  );
  requireFact(generations.length === 1, "Accepted report generation identity");
  const generate: OwnedEvent = { log: e.root, event: generations[0] };
  const validate: OwnedEvent = {
    log: e.root,
    event: successfulValidation(e.root, r.report.report_id).call,
  };
  const submit = one("report_submit");
  requireFact(
    generate.log === e.root &&
      validate.log === e.root &&
      submit.log === e.root &&
      argumentsOf(generate.event).task_id === r.task.task_id &&
      resultObject(result(generate)).report_id === r.report.report_id &&
      resultObject(result(generate)).status === "draft" &&
      resultObject(result(validate)).ok === true &&
      resultObject(result(validate)).status === "reviewed" &&
      resultObject(result(validate)).report_id === r.report.report_id &&
      argumentsOf(submit.event).report_id === r.report.report_id &&
      resultObject(result(submit)).status === "accepted" &&
      resultObject(result(submit)).report_id === r.report.report_id,
    "Report generation/validation/submission join",
  );
  const chain = [
    task,
    base,
    create,
    change,
    submitted[0],
    collected[0],
    candidate,
    submitted[1],
    collected[1],
    verify,
    generate,
    validate,
    submit,
  ];
  for (let index = 1; index < chain.length; index++) before(chain[index - 1], chain[index]);
  requireFact(r.report.decision_history.length === 1, "Report decision history count");
  for (const owned of [change, submit]) {
    const ask = asks.find(
      (entry) => entry.log === owned.log && data(entry.event).callId === data(owned.event).callId,
    );
    requireFact(ask, "Approval call/owner join");
    const decisions = owned.log.events.filter(
      (event) => event.type === "approval/decided" && data(event).id === data(ask.event).id,
    );
    const changeApproval = owned === change;
    const id = changeApproval ? r.change.change_id : r.report.report_id;
    requireFact(
      data(ask.event).reason ===
        `PI approval required for ${changeApproval ? "change" : "report"} ${id}` &&
        decisions.length === 1 &&
        data(decisions[0]).outcome === "allowed-once" &&
        owned.event.seq < ask.event.seq &&
        ask.event.seq < decisions[0].seq &&
        decisions[0].seq < result(owned).seq,
      `Approval allowed-once join ${id}`,
    );
    requireFact(
      (changeApproval ? r.change.approval_ref : r.report.decision_history[0].approval_ref) ===
        data(owned.event).callId,
      `Approval reference ${id}`,
    );
  }
  requireFact(
    r.report.decision_history[0].outcome === "accepted" &&
      r.report.decision_history[0].report_id === r.report.report_id &&
      r.report.decision_history[0].decision_id === resultObject(result(submit)).decision_id,
    "Report decision identity",
  );
}
