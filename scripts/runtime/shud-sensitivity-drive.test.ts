import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { RunJob } from "../../packages/dsh-shud-core/src/schemas/index.ts";
import { makeRunJob } from "../../packages/dsh-shud-records/src/task-lifecycle-test-harness.ts";
import { pending, peer } from "./replay/approval-peer.ts";
import { makeReplayFixture } from "./replay/test-harness.ts";
import type { ReplayEvidence } from "./shud-replay-evidence.ts";
import type { CanonicalEvent } from "./shud-restart-evidence.ts";
import { openReportApprovals } from "./shud-first-task-approval.ts";
import { batchProgress } from "./shud-sensitivity.ts";
import type { SessionLog } from "./shud-session-log.ts";

const ROOT = "session-sensitivity-root";
const FIRST = "session-sensitivity-worker-a";
const SECOND = "session-sensitivity-worker-b";
const HOST_A = "shud-00000000000000a1";
const HOST_B = "shud-00000000000000b2";

function session(id: string, agentPreset: string): SessionLog {
  const child = agentPreset === "coordinator" ? {} : { origin: "subagent", parentSession: ROOT };
  return {
    header: { type: "session", version: 4, id, cwd: "/ws", agentPreset, ...child },
    events: [],
    asOfSeq: -1,
    canonicalLog: `/home/sessions/p/${id}/session.v4.jsonl.zstd`,
    flushedThroughSeq: -1,
  };
}
function emit(log: SessionLog, type: string, data: unknown): CanonicalEvent {
  const event = { type, seq: log.events.length, time: 1_000 + log.events.length, data };
  log.events.push(event);
  log.asOfSeq = event.seq;
  log.flushedThroughSeq = event.seq;
  return event;
}
function toolRound(log: SessionLog, name: string, callId: string, isError = false): void {
  emit(log, "tool/call", { callId, name, arguments: "{}" });
  emit(log, "tool/result", {
    message: { role: "tool", toolCallId: callId, source: { kind: "tool", callId }, isError },
  });
}
function settled(root: SessionLog, child: string): void {
  emit(root, "user/message", { source: { kind: "subagent-settled", senderSessionId: child } });
}

/** One delegated worker turn: catalog, child turn with one shud_run, then (when settled) notice. */
function delegate(root: SessionLog, child: SessionLog, settles: boolean): void {
  emit(root, "turn/start", {});
  emit(root, "subagent/catalog", { childId: child.header.id });
  emit(child, "turn/start", {});
  toolRound(child, "shud_run", `call-run-${String(child.header.id)}`);
  emit(root, "turn/end", { reason: { kind: "completed" } });
  if (!settles) return;
  emit(child, "turn/end", { reason: { kind: "completed" } });
  settled(root, String(child.header.id));
}

/**
 * Coordinator creates the plan, delegates a worker and (unless `redelegated: false`) a second one,
 * then (when `submitted`) submits the report; `secondSettled: false` leaves the second mid-turn.
 */
function batchLogs(
  options: { redelegated?: boolean; secondSettled?: boolean; submitted?: boolean } = {},
) {
  const { redelegated = true, secondSettled = true, submitted = true } = options;
  const root = session(ROOT, "coordinator");
  const children = [session(FIRST, "worker")];
  emit(root, "turn/start", {});
  toolRound(root, "analysis_create", "call-analysis");
  emit(root, "turn/end", { reason: { kind: "completed" } });
  delegate(root, children[0], true);
  if (redelegated) {
    children.push(session(SECOND, "worker"));
    delegate(root, children[1], secondSettled);
  }
  if (!redelegated || secondSettled) {
    emit(root, "turn/start", {});
    if (submitted) toolRound(root, "report_submit", "call-report-submit");
    emit(root, "turn/end", { reason: { kind: "completed" } });
  }
  return { root, children };
}
function job(n: number, overrides: Partial<RunJob>): RunJob {
  return makeRunJob(`JOB-20261110T090000-000${n}`, { owner_session: FIRST, ...overrides });
}
const COLLECTED = [
  job(1, { status: "collected", dsh_job_id: HOST_A, dsh_job_ids: [HOST_A] }),
  job(2, { status: "collected", dsh_job_id: HOST_B, dsh_job_ids: [HOST_B] }),
];
function roster(statuses: Record<string, string>) {
  const calls: { sessionIds: string[]; ids: string[]; accepted: readonly string[] }[] = [];
  return {
    calls,
    jobsTerminal(sessionIds: string[], ids: string[], accepted: readonly string[]) {
      calls.push({ sessionIds, ids, accepted });
      return Promise.resolve({ terminal: ids.every((id) => accepted.includes(statuses[id])) });
    },
  };
}

test("a re-delegated second worker still running keeps the batch waiting", async () => {
  const host = roster({});
  const state = await batchProgress(batchLogs({ secondSettled: false }), COLLECTED, host);
  expect(state).toEqual({ state: "running" });
  expect(host.calls).toEqual([]);
});

test("all sessions settled, a successful report_submit and terminal jobs finish the batch", async () => {
  const host = roster({ [HOST_A]: "completed", [HOST_B]: "completed" });
  expect(await batchProgress(batchLogs(), COLLECTED, host)).toEqual({ state: "done" });
  expect(host.calls).toEqual([
    {
      sessionIds: [ROOT, FIRST, SECOND],
      ids: [HOST_A, HOST_B],
      accepted: ["completed", "failed", "killed"],
    },
  ]);
});

test("all sessions settled without a successful report_submit stops the wait early", async () => {
  const logs = batchLogs({ submitted: false });
  const host = roster({ [HOST_A]: "completed", [HOST_B]: "completed" });
  expect(await batchProgress(logs, COLLECTED, host)).toEqual({
    state: "stopped",
    reason: "Coordinator settled without a successful report_submit",
  });
  const failed = batchLogs({ submitted: false });
  const end = failed.root.events.pop()!;
  toolRound(failed.root, "report_submit", "call-report-submit", true);
  emit(failed.root, end.type, end.data);
  expect((await batchProgress(failed, COLLECTED, host)).state).toBe("stopped");
});

test("an approval asked for another tool stops the wait early", async () => {
  const logs = batchLogs({ secondSettled: false });
  emit(logs.children[1], "approval/asked", {
    id: "ask-run",
    toolName: "shud_run",
    callId: "call-run-b",
  });
  expect(await batchProgress(logs, COLLECTED, roster({}))).toEqual({
    state: "stopped",
    reason: "Unexpected approval shud_run call-run-b",
  });
});

test("a RunJob still running keeps the batch waiting", async () => {
  const jobs = [COLLECTED[0], job(2, { status: "running", dsh_job_id: HOST_B })];
  expect(await batchProgress(batchLogs(), jobs, roster({ [HOST_A]: "completed" }))).toEqual({
    state: "running",
  });
});

test("a submission that never started a host job counts by its own RunJob status", async () => {
  const jobs = [COLLECTED[0], job(2, { status: "failed", dsh_job_id: null, dsh_job_ids: [] })];
  const host = roster({ [HOST_A]: "completed" });
  expect(await batchProgress(batchLogs(), jobs, host)).toEqual({ state: "done" });
  expect(host.calls[0].ids).toEqual([HOST_A]);
});

function reportFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "sensitivity-approval-")));
  const original = makeReplayFixture();
  const snapshot = JSON.parse(
    JSON.stringify(original.snapshot).replaceAll("/fixture/replay workspace", root),
  ) as ReplayEvidence;
  fs.mkdirSync(join(root, "reports"));
  fs.writeFileSync(
    join(root, `reports/${original.report.report_id}.json`),
    JSON.stringify({ ...original.report, status: "reviewed", decision_history: [] }),
  );
  return { root, snapshot, reportId: original.report.report_id };
}
const request = (agentId: string, toolName: string, callId: string, reason: string) => ({
  event: "approval/request",
  agentId,
  request: { toolName, callId, reason },
});

test("only the report_submit ask is answered Allow once; shud_run and analysis_create are not", async () => {
  const h = reportFixture();
  const remote = await peer(pending(h.snapshot.root, "call-report-submit"));
  let close: (() => Promise<void>) | undefined;
  try {
    const transport = await openReportApprovals(remote.host, "replay-root", h.root);
    close = transport.close;
    const asks = [
      request("worker-base", "shud_run", "call-run", "PI approval required for run"),
      request("replay-root", "analysis_create", "call-analysis", "PI approval required for plan"),
      request(
        "replay-root",
        "report_submit",
        "call-report-submit",
        `PI approval required for report ${h.reportId}`,
      ),
    ];
    for (const [index, ask] of asks.entries()) {
      remote.send({ type: "waterfall", eventId: `ask-${index}`, ...ask });
      await remote.waitFor(index + 1);
    }
    expect(remote.published.map((entry) => [entry.eventId, entry.outcome])).toEqual([
      ["ask-0", { kind: "next" }],
      ["ask-1", { kind: "next" }],
      ["ask-2", { kind: "result", value: "allowed-once" }],
    ]);
  } finally {
    try {
      await close?.();
    } finally {
      await remote.dispose();
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }
});

test("job terminality accepts the statuses the caller names on the shared transport", async () => {
  let status = "running";
  const remote = await peer(undefined, () => [{ id: HOST_A, kind: "shud", status }]);
  const h = reportFixture();
  let close: (() => Promise<void>) | undefined;
  try {
    const transport = await openReportApprovals(remote.host, "replay-root", h.root);
    close = transport.close;
    const sensitivity = ["completed", "failed", "killed"];
    expect((await transport.jobsTerminal([ROOT], [HOST_A], sensitivity)).terminal).toBe(false);
    status = "failed";
    expect((await transport.jobsTerminal([ROOT], [HOST_A], ["completed"])).terminal).toBe(false);
    expect((await transport.jobsTerminal([ROOT], [HOST_A], sensitivity)).terminal).toBe(true);
    // A pset whose host job failed and whose RunJob collected a failed RunRecord is done.
    const failedSet = [job(1, { status: "collected", dsh_job_id: HOST_A, dsh_job_ids: [HOST_A] })];
    expect(await batchProgress(batchLogs({ redelegated: false }), failedSet, transport)).toEqual({
      state: "done",
    });
    expect(remote.published).toEqual([]);
  } finally {
    try {
      await close?.();
    } finally {
      await remote.dispose();
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }
});
