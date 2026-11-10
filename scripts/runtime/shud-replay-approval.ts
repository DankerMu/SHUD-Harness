import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  ChangeRequestSchema,
  ChangeIdSchema,
  EvidenceReportSchema,
  ReportIdSchema,
} from "../../packages/dsh-shud-core/src/schemas/index.ts";
import { object, requireFact, text } from "./shud-restart-evidence.ts";
import {
  calls,
  data,
  argumentsOf,
  resultFor,
  resultObject,
  successfulValidation,
} from "./shud-evidence-events.ts";
import { openOwnedApprovals } from "./shud-approval-transport.ts";
import { replayAsks } from "./shud-replay-flow.ts";
import { collectReplayLogs } from "./shud-replay-snapshot.ts";
import { regular, type SessionLog } from "./shud-session-log.ts";
import { load, readFileBounded, type WebHost } from "./shud-web-driver.ts";
import { REPLAY_COMMIT, REPLAY_FILES } from "./shud-replay-contract.ts";

interface ReplayApprovalState {
  observe(this: void, root: SessionLog, children: SessionLog[]): void;
  authorize(this: void, invocation: Record<string, unknown>, signal: AbortSignal): Promise<boolean>;
  healthy(this: void): void;
}

/** Predicate state is shared by stream callbacks and canonical polling, not two budgets. */
export function replayApprovalState(
  rootId: string,
  workspace: string,
  refresh: () => Promise<{ root: SessionLog; children: SessionLog[] }>,
): ReplayApprovalState {
  const answered = new Set<string>();
  const tools = new Set<string>();
  let failure: Error | undefined;
  function healthy(): void {
    if (failure) throw failure;
  }
  function observe(root: SessionLog, children: SessionLog[]): void {
    try {
      requireFact(
        root.header.id === rootId &&
          root.header.cwd === workspace &&
          root.header.agentPreset === "coordinator",
        "Replay approval root identity",
      );
      const catalog = root.events
        .filter((event) => event.type === "subagent/catalog")
        .map((event) => text(data(event).childId));
      for (const child of children)
        requireFact(
          catalog.includes(text(child.header.id)) &&
            child.header.parentSession === rootId &&
            child.header.origin === "subagent" &&
            child.header.cwd === workspace,
          "Replay approval child owner mismatch",
        );
      replayAsks([root, ...children]);
      healthy();
    } catch (error) {
      failure =
        error instanceof Error
          ? error
          : new Error("Replay approval observation failed", { cause: error });
      throw failure;
    }
  }
  async function authorize(
    invocation: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<boolean> {
    healthy();
    signal.throwIfAborted();
    if (invocation.event !== "approval/request") return false;
    try {
      const request = object(invocation.request);
      const caller = text(invocation.agentId),
        callId = text(request.callId),
        tool = text(request.toolName);
      const snapshot = await refresh();
      observe(snapshot.root, snapshot.children);
      const log = [snapshot.root, ...snapshot.children].find((entry) => entry.header.id === caller);
      requireFact(log, `Unowned approval caller ${caller}`);
      const switches = log.events.filter((event) => event.type === "agent-preset/selected");
      const role = switches.length
        ? data(switches[switches.length - 1]).agentPreset
        : log.header.agentPreset;
      requireFact(
        (tool === "change_submit" && role === "coder" && caller !== rootId) ||
          (tool === "report_submit" && role === "coordinator" && caller === rootId),
        `Unexpected approval ${tool} ${callId}`,
      );
      const matches = replayAsks([snapshot.root, ...snapshot.children]).filter(
        (entry) =>
          entry.log === log &&
          data(entry.event).callId === callId &&
          data(entry.event).toolName === tool,
      );
      requireFact(matches.length === 1, `Approval asked identity ${tool} ${callId}`);
      const ask = matches[0].event,
        askId = text(data(ask).id);
      requireFact(
        !log.events.some((event) => event.type === "approval/decided" && data(event).id === askId),
        `Approval already decided ${callId}`,
      );
      const call = calls(log, tool).find((event) => data(event).callId === callId)!;
      requireFact(
        !log.events.some(
          (event) =>
            event.type === "tool/result" && object(data(event).message).toolCallId === callId,
        ),
        `Approval call already completed ${callId}`,
      );
      requireFact(request.reason === data(ask).reason, `Approval reason mismatch ${callId}`);
      const args = argumentsOf(call);
      const createdTasks = calls(snapshot.root, "task_create");
      requireFact(
        createdTasks.length === 1 && argumentsOf(createdTasks[0]).type === "code_change",
        "Approval requires the owned code_change task",
      );
      const taskId = text(
        resultObject(resultFor(snapshot.root, createdTasks[0], "TASK_CREATE")).task_id,
      );
      if (tool === "change_submit") {
        const id = ChangeIdSchema.parse(args.change_id);
        requireFact(
          request.reason === `PI approval required for change ${id}`,
          `Change approval reason ${callId}`,
        );
        const path = join(workspace, "changes", `${id}.json`);
        regular(path, "change approval target");
        const change = ChangeRequestSchema.parse(load(path));
        requireFact(
          change.change_id === id &&
            change.task_id === taskId &&
            change.created_by === "coder" &&
            change.status === "proposed" &&
            change.approval_ref === null &&
            change.base_commit === REPLAY_COMMIT &&
            change.semantic_level === "numerical_implementation" &&
            change.risk === "high",
          `Change approval business identity ${id}`,
        );
        requireFact(
          change.files_changed.every((path) => REPLAY_FILES.some((allowed) => allowed === path)) &&
            ["Makefile", "src/Model/MD_rhs_core.cpp"].every((path) =>
              change.files_changed.includes(path),
            ),
          `Change approval file allowance ${id}`,
        );
        const producers = [snapshot.root, ...snapshot.children]
          .flatMap((session) =>
            calls(session, "change_create").map((event) => ({ session, event })),
          )
          .filter(
            ({ session, event }) =>
              resultObject(resultFor(session, event, "CHANGE_CREATE")).change_id === id,
          );
        requireFact(
          producers.length === 1 &&
            producers[0].session === log &&
            resultFor(log, producers[0].event, "CHANGE_CREATE").seq < call.seq,
          `Change approval successful producer ${id}`,
        );
        const patch = join(workspace, change.patch_path);
        regular(patch, "approved patch");
        requireFact(
          createHash("sha256").update(readFileBounded(patch).bytes).digest("hex") ===
            change.patch_sha256,
          `Change approval patch digest ${id}`,
        );
      } else {
        const id = ReportIdSchema.parse(args.report_id);
        requireFact(
          request.reason === `PI approval required for report ${id}`,
          `Report approval reason ${callId}`,
        );
        const path = join(workspace, "reports", `${id}.json`);
        regular(path, "report approval target");
        const report = EvidenceReportSchema.parse(load(path));
        requireFact(
          report.report_id === id &&
            report.task_id === taskId &&
            report.status === "reviewed" &&
            report.decision_history.length === 0,
          `Report approval business identity ${id}`,
        );
        const validation = successfulValidation(log, id);
        requireFact(
          validation.result.seq < call.seq,
          `Report approval successful validation ${id}`,
        );
      }
      signal.throwIfAborted();
      healthy();
      const key = `${caller}/${callId}/${askId}`;
      requireFact(
        !answered.has(key) && !tools.has(tool),
        `Approval already answered ${tool} ${callId}`,
      );
      answered.add(key);
      tools.add(tool);
      return true;
    } catch (error) {
      failure =
        error instanceof Error
          ? error
          : new Error("Replay approval processing failed", { cause: error });
      throw failure;
    }
  }
  return { observe, authorize, healthy };
}

export async function openReplayApprovals(
  host: WebHost,
  home: string,
  rootId: string,
  workspace: string,
) {
  const state = replayApprovalState(rootId, workspace, () => collectReplayLogs(home, rootId, host));
  const transport = await openOwnedApprovals(host, state.authorize, {
    streamId: "replay-approvals",
    label: "Replay",
    healthy: state.healthy,
  });
  return {
    observe: state.observe,
    healthy() {
      state.healthy();
      transport.healthy();
    },
    jobsTerminal: (sessionIds: string[], currentJobIds: string[]) =>
      transport.jobsTerminal(sessionIds, currentJobIds, ["completed"]),
    close: transport.close,
  };
}
