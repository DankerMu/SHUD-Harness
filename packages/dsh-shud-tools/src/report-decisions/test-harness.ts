import * as fs from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ApprovalOutcome, ApprovalService } from "@deepseek-ai/dsh-user-approval";
import * as policyGate from "../../../dsh-shud-policy-gate/src/index.ts";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { expect, vi } from "vitest";
import { renderReport } from "@shud-harness/dsh-shud-records";
import { getCard, putCard, treeOrAbsent } from "../task-linked/test-harness.ts";
import {
  REPORT,
  putReport,
  readReport,
  reportHarness,
  reportPath,
  seedEvidence,
  type ReportHarness,
} from "../report-workflow/test-harness.ts";

export const TERMINAL_TOOLS = ["report_submit", "report_decide"] as const;
export type TerminalTool = (typeof TERMINAL_TOOLS)[number];
export const COMMENT = "  PI original words\n补一个 holdout 窗口\n  ";
export const PRIVATE = "PRIVATE_DECISION_IO_447";
export function decisionArgs(tool: TerminalTool) {
  return tool === "report_submit"
    ? { report_id: REPORT }
    : {
        report_id: REPORT,
        disposition: "revision_requested",
        comment: COMMENT,
      };
}

/** Extend the existing real registry/Cordis/runtime harness; only host approval and session data are doubled. */
export async function decisionHarness(
  options: {
    approval?: ApprovalOutcome | "absent" | "throw";
    preset?: string;
  } = {},
) {
  const h = await reportHarness();
  const current = { preset: options.preset ?? "coordinator" };
  const request = vi.fn(
    (_input: Parameters<ApprovalService["request"]>[0]): Promise<ApprovalOutcome> => {
      if (options.approval === "throw") return Promise.reject(new Error("approval channel failed"));
      return Promise.resolve(
        options.approval === "absent" ? "unavailable" : (options.approval ?? "allowed-once"),
      );
    },
  );
  const executions: Array<{ name: string; callId: unknown }> = [];
  const logs: Array<{ name: string; args: unknown[] }> = [];
  const stopLogging = h.ctx.logger.exporter({
    export(message) {
      if (message.name === "shud-policy-gate" || message.name === "shud-raw-guard")
        logs.push({ name: message.name, args: message.args as unknown[] });
    },
  });
  try {
    await h.ctx.plugin((services: Context) => {
      if (options.approval !== "absent") services.provide("approval", { request });
      services.on("tools/execute", (event, next) => {
        executions.push({ name: event.name, callId: event.callId });
        return next();
      });
    });
    await h.agent.ctx.plugin((services: Context) => {
      services.provide("sessionProjections", {
        stateOf(session: object, key: string) {
          return session === h.agent.session && key === "agentPreset" ? current.preset : undefined;
        },
      });
    });
    await h.agent.ctx.plugin({
      inject: ["sessionProjections"],
      apply(consumer: Context) {
        Object.assign(h.agent, { ctx: consumer });
      },
    });
    let sequence = 0;
    return {
      ...h,
      current,
      request,
      executions,
      logs,
      async mount(rawDirs: string[] = ["data/raw"], withRaw = true) {
        if (withRaw) await h.apply(rawGuard, { rawDirs });
        await h.apply(policyGate, {});
      },
      call(
        name: string,
        args: unknown,
        callId: unknown = `decision-call-${++sequence}`,
        withAgent = true,
      ) {
        return h.runtime.execute({
          name,
          arguments: args,
          callId: callId as ToolCallId,
          ...(withAgent ? { agent: h.agent } : {}),
          signal: new AbortController().signal,
        });
      },
      async dispose() {
        try {
          await h.dispose();
        } finally {
          await stopLogging();
        }
      },
    };
  } catch (error) {
    try {
      await h.dispose();
    } finally {
      await stopLogging();
    }
    throw error;
  }
}
export async function seedReviewed(h: ReportHarness) {
  const evidence = await seedEvidence(h);
  const report = putReport(h, evidence.run, { status: "reviewed" });
  const card = putCard(h, { ...getCard(h), status: "reporting", linked_reports: [REPORT] });
  return { ...evidence, report, card };
}
export function expectCanonicalMarkdown(h: ReportHarness, id = REPORT) {
  expect(fs.readFileSync(reportPath(h, id, "md"), "utf8")).toBe(renderReport(h.cwd, id));
}
export function expectSingleDecision(
  h: ReportHarness,
  status: string,
  callId: string,
  comment: string | null,
  id = REPORT,
) {
  const report = readReport(h, id);
  expect(report.status).toBe(status);
  expect(report.decision_history).toHaveLength(1);
  expect(report.decision_history[0]).toMatchObject({
    report_id: id,
    outcome: status,
    approval_ref: callId,
    comment,
  });
  return report.decision_history[0];
}
/** Atomic temp-file failure may change directory mtime, never existing file bytes/mtime or entries. */
export async function durableSnapshot(path: string) {
  return Object.fromEntries(
    Object.entries((await treeOrAbsent(path)) ?? {}).map(([name, value]) => [
      name,
      typeof value === "object" && value !== null && "kind" in value && value.kind === "directory"
        ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "mtimeNs"))
        : value,
    ]),
  );
}
export function ioFault() {
  return Object.assign(new Error(PRIVATE), { code: "EIO" });
}
