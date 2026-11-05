import type { SessionLog } from "../../shud-session-log.ts";
import type { ReplayRecords } from "../test-harness.ts";

type Role = "coordinator" | "coder" | "worker" | "reviewer";
const tools: Record<Role, string[]> = {
  coordinator: [
    "task_create",
    "report_generate",
    "report_validate",
    "report_submit",
    "subagent",
    "subagent_coder",
    "subagent_reviewer",
    "job_output",
    "job_list",
  ],
  coder: ["read", "edit", "bash", "change_create", "change_submit", "shud_build"],
  worker: ["shud_run", "shud_collect", "job_output", "job_list", "job_kill"],
  reviewer: ["read", "verification_run", "shud_collect", "job_output", "job_list"],
};

export interface ReplayDiagnosticFailure {
  sessionId: string;
  name: string;
  callId: string;
  arguments: Record<string, unknown>;
  eventError: boolean;
}

export interface ReplayCollectionScenario {
  observers?: readonly ("reviewer" | "coordinator")[];
  repeatWorker?: boolean;
  baseCollection?: "missing" | "failed";
}

/** Canonical event envelopes, with local sequences and one shared causal clock. */
export function replayLogs(
  records: ReplayRecords,
  paths: { workspace: string; home: string; prompt: string },
  diagnostics: readonly ReplayDiagnosticFailure[] = [],
  collections: ReplayCollectionScenario = {},
) {
  const { task, change, builds, runs, verification, report } = records;
  let clock = Date.parse("2026-11-02T09:00:00Z");
  const children: SessionLog[] = [];
  function append(log: SessionLog, type: string, data: unknown) {
    const event = {
      type,
      seq: log.events.length,
      time: ++clock,
      data,
      ...(["system/message", "user/message", "assistant/message", "tool/result"].includes(type)
        ? { surfaceOp: "append" as const }
        : {}),
    };
    log.events.push(event);
    log.asOfSeq = event.seq;
    log.flushedThroughSeq = event.seq;
    return event;
  }
  function session(id: string, role: Role): SessionLog {
    const createdAt = ++clock;
    return {
      header: {
        type: "session",
        version: 4,
        id,
        createdAt,
        cwd: paths.workspace,
        agentPreset: role,
        isSeeded: false,
        delegationDepth: role === "coordinator" ? 0 : 1,
        ...(role === "coordinator" ? {} : { origin: "subagent", parentSession: "replay-root" }),
      },
      events: [],
      asOfSeq: -1,
      flushedThroughSeq: -1,
      canonicalLog: `${paths.home}/sessions/2026-11-02/${id}/session.v4.jsonl.zstd`,
    };
  }
  function start(log: SessionLog, role: Role, text: string) {
    append(log, "turn/start", { turn: 1 });
    if (role !== "coordinator") {
      append(log, "subagent/descriptor", { version: 3, provider: "spawn", mode: "one-shot" });
    }
    append(log, "step/start", { turn: 1, step: 1 });
    append(log, "request/header", {
      reason: "initial",
      header: {
        config: { provider: "fixture", model: "fixture-model" },
        tools: [
          ...tools[role],
          ...(role === "coordinator" && collections.observers?.includes("coordinator")
            ? ["shud_collect"]
            : []),
        ].map((name) => ({
          name,
          description: name,
          parameters: { type: "object" },
        })),
      },
    });
    append(log, "system/message", {
      turn: 1,
      step: 1,
      message: {
        id: `${String(log.header.id)}-system`,
        role: "system",
        source: { kind: "system-prompt" },
        content: [{ type: "text", text: `Constructed ${role} instructions.` }],
      },
    });
    append(log, "user/message", {
      id: `${String(log.header.id)}-prompt`,
      role: "user",
      content: [{ type: "text", text }],
      source:
        role === "coordinator"
          ? { kind: "user" }
          : { kind: "coordinator", form: "relay", senderSessionId: "replay-root" },
    });
  }
  function call(log: SessionLog, name: string, id: string, args: unknown) {
    const block = { type: "tool-call", id, name, arguments: JSON.stringify(args) };
    append(log, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: `${id}-assistant`,
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [block],
      },
      stream: [
        {
          type: "chunk",
          time: 0,
          chunk: { type: "block-start", index: 0, blockType: "tool-call" },
        },
        { type: "tool-call-chunks", time0: 0, index: 0, dt: [], id, name, args: [block.arguments] },
        { type: "chunk", time: 0, chunk: { type: "block-end", index: 0, block } },
        { type: "chunk", time: 0, chunk: { type: "finish", reason: { kind: "tool-calls" } } },
      ],
    });
    append(log, "tool/call", {
      turn: 1,
      step: 1,
      callId: id,
      name,
      arguments: JSON.stringify(args),
    });
  }
  function result(
    log: SessionLog,
    id: string,
    value: unknown,
    failure?: Pick<ReplayDiagnosticFailure, "eventError">,
  ) {
    append(log, "tool/result", {
      turn: 1,
      step: 1,
      ...(failure?.eventError
        ? {
            error: {
              name: "Error",
              code: "FIXTURE_DIAGNOSTIC",
              reason: "Synthetic ordinary tool failure",
            },
          }
        : {}),
      message: {
        id: `${id}-result`,
        role: "tool",
        toolCallId: id,
        source: { kind: "tool", callId: id },
        content: [
          { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
        ],
        isError: failure !== undefined,
      },
    });
  }
  function invoke(
    log: SessionLog,
    name: string,
    id: string,
    args: unknown,
    value: unknown,
    completedAt?: string,
  ) {
    call(log, name, id, args);
    if (completedAt !== undefined) clock = Math.max(clock, Date.parse(completedAt));
    result(log, id, value);
  }
  function rereadCollectedRuns(log: SessionLog, key: "run_id" | "job_id") {
    for (const { job, record } of runs)
      invoke(
        log,
        "shud_collect",
        `call-reread-${String(log.header.id)}-${job.run_id}`,
        { [key]: job[key] },
        record,
      );
  }
  function approve(
    log: SessionLog,
    toolName: string,
    callId: string,
    id: string,
    reason: string,
    decidedAt: string,
  ) {
    append(log, "approval/asked", { id, toolName, callId, reason });
    clock = Math.max(clock, Date.parse(decidedAt) - 1);
    append(log, "approval/decided", { id, outcome: "allowed-once" });
  }
  const root = session("replay-root", "coordinator");
  start(root, "coordinator", paths.prompt);
  invoke(
    root,
    "task_create",
    "call-task-create",
    {
      type: "code_change",
      title: task.title,
      question_or_goal: task.question_or_goal,
    },
    { task_id: task.task_id, status: "planned" },
  );

  function delegate(
    id: string,
    role: Exclude<Role, "coordinator">,
    instruction: string,
    work: (log: SessionLog) => void,
  ) {
    const tool = role === "worker" ? "subagent" : `subagent_${role}`;
    const callId = `dispatch-${id}`;
    call(root, tool, callId, { description: id, prompt: instruction });
    const child = session(id, role);
    append(root, "subagent/catalog", {
      version: 0,
      childId: id,
      childCreatedAt: child.header.createdAt,
      mode: "one-shot",
    });
    result(root, callId, `started subagent ${id}`);
    start(child, role, instruction);
    for (const diagnostic of diagnostics.filter((entry) => entry.sessionId === id)) {
      call(child, diagnostic.name, diagnostic.callId, diagnostic.arguments);
      result(child, diagnostic.callId, "Synthetic ordinary tool failure", diagnostic);
    }
    work(child);
    append(child, "step/end", { turn: 1, step: 1 });
    append(child, "turn/end", { turn: 1, reason: { kind: "completed" } });
    append(root, "user/message", {
      id: `settled-${id}`,
      role: "user",
      content: [{ type: "text", text: `subagent ${id} completed` }],
      source: {
        kind: "subagent-settled",
        form: "notice",
        summary: "completed",
        senderSessionId: id,
      },
    });
    children.push(child);
  }
  function buildResult(index: number) {
    const build = builds[index];
    return {
      build_id: build.build_id,
      change_id: build.change_id,
      patch_sha256: build.patch_sha256,
      source_commit: build.source_commit,
      rhs_openmp: build.rhs_openmp,
      binary_sha256: build.binary_sha256,
      duration_seconds: build.duration_seconds,
    };
  }
  delegate(
    "coder-base",
    "coder",
    `${task.task_id}: build the clean base, then derive and submit the allowed change from the design path.`,
    (coder) => {
      invoke(
        coder,
        "shud_build",
        "call-build-base",
        { task_id: task.task_id },
        buildResult(0),
        builds[0].created_at,
      );
      invoke(
        coder,
        "change_create",
        "call-change-create",
        {
          task_id: task.task_id,
          semantic_level: "numerical_implementation",
          description: change.description,
        },
        {
          change_id: change.change_id,
          semantic_level: change.semantic_level,
          semantic_floor: change.semantic_floor,
          floor_categories: change.floor_categories,
          risk: change.risk,
          files_changed: change.files_changed,
          patch_path: change.patch_path,
          status: "proposed",
        },
        change.created_at,
      );
      call(coder, "change_submit", "call-change-submit", { change_id: change.change_id });
      approve(
        coder,
        "change_submit",
        "call-change-submit",
        "ask-change",
        `PI approval required for change ${change.change_id}`,
        change.approved_at!,
      );
      result(coder, "call-change-submit", {
        change_id: change.change_id,
        status: "approved",
        approval_ref: "call-change-submit",
      });
    },
  );
  function runWorker(index: number) {
    const { job, record } = runs[index];
    const suffix = index === 0 ? "base" : "candidate";
    delegate(
      `worker-${suffix}`,
      "worker",
      `${task.task_id}: run ${job.build_id} with threads: 1 using ${job.input_dir}, wait and collect without end_days.`,
      (worker) => {
        invoke(
          worker,
          "shud_run",
          `call-run-${suffix}`,
          {
            task_id: task.task_id,
            input_dir: job.input_dir,
            build_id: job.build_id,
            threads: 1,
          },
          `SHUD running: job_id=${job.job_id}, run_id=${job.run_id}, dsh_job_id=${job.dsh_job_id}, run_dir=${job.run_dir}.\nUse job_output to wait for completion.`,
          job.submitted_at!,
        );
        invoke(
          worker,
          "job_output",
          `call-wait-${suffix}`,
          { job_id: job.dsh_job_id, wait: true },
          "[status: completed, SHUD exited with code 0]",
          job.finished_at!,
        );
        if (index !== 0 || collections.baseCollection !== "missing") {
          const id = `call-collect-${suffix}`;
          const failed = index === 0 && collections.baseCollection === "failed";
          call(worker, "shud_collect", id, { run_id: job.run_id });
          result(
            worker,
            id,
            failed ? "Synthetic worker collection failure" : record,
            failed ? { eventError: false } : undefined,
          );
        }
        if (collections.repeatWorker)
          invoke(worker, "shud_collect", `call-reread-${suffix}`, { job_id: job.job_id }, record);
      },
    );
  }
  runWorker(0);
  delegate(
    "coder-candidate",
    "coder",
    `${task.task_id}: build approved ${change.change_id} after the successful base collect.`,
    (coder) => {
      invoke(
        coder,
        "shud_build",
        "call-build-candidate",
        { task_id: task.task_id, change_id: change.change_id, rhs_openmp: true },
        buildResult(1),
        builds[1].created_at,
      );
    },
  );
  runWorker(1);
  delegate(
    "reviewer",
    "reviewer",
    `${task.task_id}: compare ${verification.base_run_id} and ${verification.candidate_run_id}.`,
    (reviewer) => {
      if (collections.observers?.includes("reviewer")) rereadCollectedRuns(reviewer, "run_id");
      invoke(
        reviewer,
        "verification_run",
        "call-verification",
        {
          task_id: task.task_id,
          base_run_id: verification.base_run_id,
          candidate_run_id: verification.candidate_run_id,
          reviewer_notes: verification.reviewer_notes,
          compatibility_verdict: verification.compatibility_verdict,
        },
        {
          vc_id: verification.vc_id,
          status: verification.status,
          observed: verification.observed,
          failure_reason: verification.failure_reason,
        },
        verification.created_at,
      );
    },
  );
  if (collections.observers?.includes("coordinator")) rereadCollectedRuns(root, "job_id");
  invoke(
    root,
    "report_generate",
    "call-report-generate",
    {
      task_id: task.task_id,
      summary: report.summary,
      observations: report.observations,
      limitations: report.limitations,
      pi_questions: report.pi_questions,
    },
    { report_id: report.report_id, status: "draft" },
    report.created_at,
  );
  invoke(
    root,
    "report_validate",
    "call-report-validate",
    { report_id: report.report_id },
    { report_id: report.report_id, ok: true, status: "reviewed" },
  );
  call(root, "report_submit", "call-report-submit", { report_id: report.report_id });
  approve(
    root,
    "report_submit",
    "call-report-submit",
    "ask-report",
    `PI approval required for report ${report.report_id}`,
    report.decision_history[0].decided_at,
  );
  result(root, "call-report-submit", {
    report_id: report.report_id,
    status: "accepted",
    decision_id: report.decision_history[0].decision_id,
  });
  append(root, "step/end", { turn: 1, step: 1 });
  append(root, "turn/end", { turn: 1, reason: { kind: "completed" } });
  return {
    root,
    children,
    delegationBindings: (["coder", "worker", "reviewer"] as const).map((role) => ({
      parentSessionId: "replay-root",
      configPath: `${paths.home}/replay-evidence/effective-config.json`,
      provider: "spawn",
      agentPreset: role,
      toolName: role === "worker" ? "subagent" : `subagent_${role}`,
    })),
  };
}
