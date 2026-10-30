import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import { createScope } from "@deepseek-ai/dsh-scope";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { defineTool, ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import type { ApprovalOutcome, ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { EvidenceReportSchema, TaskCardSchema } from "@shud-harness/dsh-shud-core";
import type { EvidenceReport } from "@shud-harness/dsh-shud-core";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { expect, vi } from "vitest";
import * as policyGate from "./index.ts";

export const REPORT_ID = "REPORT-20261029T080005-3f9c";
export const OTHER_REPORT_ID = "REPORT-20261029T080005-abcd";
const TASK_ID = "TASK-20261029T080005-1234";
export const SUMMARY_FIRST_LINE = "  ccw evidence, not a scientific conclusion.  ";
export const SUMMARY_SECOND_LINE = "private-second-summary-line";

export function reportFixture(overrides: Partial<EvidenceReport> = {}) {
  return EvidenceReportSchema.parse({
    report_id: REPORT_ID,
    task_id: TASK_ID,
    status: "reviewed",
    summary: `${SUMMARY_FIRST_LINE}\r\n${SUMMARY_SECOND_LINE}`,
    observations: ["private-report-observation"],
    limitations: ["private-report-limitation"],
    pi_questions: ["private-report-question"],
    linked_runs: ["RUN-20261029T080005-a1b2"],
    stack_ids: ["STACK-20261029T080005-b2c3"],
    data_ids: ["DATA-20261029T080005-c3d4"],
    llm_response_models: ["fixture-model"],
    decision_history: [],
    created_at: "2026-10-29T08:00:05Z",
    updated_at: "2026-10-29T08:00:05Z",
    ...overrides,
  });
}

export async function writeReport(cwd: string, report: unknown = reportFixture(), id = REPORT_ID) {
  await mkdir(join(cwd, "reports"), { recursive: true });
  const path = join(cwd, "reports", `${id}.json`);
  await writeFile(path, `${JSON.stringify(report)}\n`);
  return path;
}

export async function writeReportingTask(cwd: string) {
  const card = TaskCardSchema.parse({
    task_id: TASK_ID,
    type: "science_assist",
    status: "reporting",
    runtime_phase: null,
    title: "ccw evidence",
    question_or_goal: "Collect evidence without deciding for PI",
    created_by: "coordinator",
    current_owner: "coordinator",
    reviewer: "pi",
    inference_budget: { mode: "normal" },
    stack_id: null,
    data_id: null,
    linked_jobs: [],
    linked_reports: [REPORT_ID],
    created_at: "2026-10-29T08:00:05Z",
    updated_at: "2026-10-29T08:00:05Z",
  });
  const directory = join(cwd, "tasks", TASK_ID);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "task.json");
  await writeFile(path, `${JSON.stringify(card)}\n`);
  return path;
}

export async function snapshotFile(path: string) {
  return { bytes: await readFile(path), mtimeNs: (await stat(path, { bigint: true })).mtimeNs };
}

export function expectAsk(decision: PreToolDecision) {
  expect(decision.kind).toBe("ask");
  if (decision.kind !== "ask") throw new Error("Expected policy approval request");
  expect(decision.displayReason?.en).toEqual(expect.any(String));
  expect(decision.displayReason?.zh).toEqual(expect.any(String));
  if (!decision.displayReason) throw new Error("Approval presentation is missing");
  return { reason: decision.reason, en: decision.displayReason.en, zh: decision.displayReason.zh };
}

interface HarnessOptions {
  preset?: unknown;
  projections?: boolean;
  approval?: ApprovalOutcome | "absent" | "throw";
  rawDirs?: string[];
}

export async function createPolicyHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "shud-policy-test-"));
  const cwd = join(root, "workspace");
  const ctx = new Context();
  const logs: Array<{ name: string; args: unknown[] }> = [];
  const stopLogging = ctx.logger.exporter({
    export(message) {
      if (message.name === "shud-policy-gate" || message.name === "shud-raw-guard") {
        logs.push({ name: message.name, args: message.args as unknown[] });
      }
    },
  });
  try {
    await mkdir(cwd);
    const session = {
      id: "policy-session" as SessionId,
      header: { cwd: cwd as string | undefined, agentPreset: "coordinator" },
    };
    const current = { preset: "preset" in options ? options.preset : "coordinator" };
    const stateOf = vi.fn((actualSession: object, key: string) =>
      actualSession === session && key === "agentPreset" ? current.preset : undefined,
    );
    const request = vi.fn((input: Parameters<ApprovalService["request"]>[0]) => {
      void input;
      if (options.approval === "throw") return Promise.reject(new Error("approval channel failed"));
      return Promise.resolve(options.approval ?? "allowed-once");
    });
    const providers: Array<Parameters<SystemPrompt["tools"]>[0]> = [];
    await ctx.plugin((services: Context) => {
      services.provide("systemPrompt", {
        tools(provider: Parameters<SystemPrompt["tools"]>[0]) {
          providers.push(provider);
          return () => providers.splice(providers.indexOf(provider), 1);
        },
      });
      if (options.projections !== false) services.provide("sessionProjections", { stateOf });
      if (options.approval !== "absent") services.provide("approval", { request });
    });
    let agentContext: Context | undefined;
    await ctx.plugin({
      inject: options.projections === false ? [] : ["sessionProjections"],
      apply(consumer: Context) {
        agentContext = createScope(consumer, {}).ctx;
      },
    });
    if (!agentContext) throw new Error("Calling context did not activate");
    if (options.projections !== false) {
      const projections: unknown = Reflect.get(agentContext, "sessionProjections");
      if (!projections || typeof projections !== "object") {
        throw new Error("Projection service is unavailable in the calling context");
      }
      const stateOf: unknown = Reflect.get(projections, "stateOf");
      expect(stateOf).toBeTypeOf("function");
    }
    // Only public Agent/Session data are doubled; Cordis scope and ToolRuntime are real.
    const agent = { id: session.id, session, ctx: agentContext } as unknown as Agent;
    await ctx.plugin(ToolRuntime, { mode: "native" });
    let runtime: ToolRuntime | undefined;
    const executions: Array<{ name: string; arguments: unknown }> = [];
    await ctx.plugin({
      inject: ["tools"],
      apply(consumer: Context) {
        runtime = consumer.tools;
        for (const name of [
          "report_submit",
          "report_decide",
          "task_create",
          "shud_run",
          "shud_collect",
          "subagent",
          "bash",
          "write",
          "read",
          "job_output",
          "report_generate",
        ]) {
          consumer.tools.register(
            defineTool({
              name,
              description: "Boundary double counting dispatch, not implementing report transitions",
              parameters: {},
              output: {
                schema: { type: "string" },
                render: (_args, value) => [{ type: "text", text: value }],
              },
              execute(_args, exec) {
                executions.push({ name, arguments: exec.arguments });
                return Promise.resolve("executed");
              },
            }),
          );
        }
      },
    });
    if (!runtime || providers.length !== 1) throw new Error("Native ToolRuntime did not activate");
    const tools = runtime;
    if (options.rawDirs) await ctx.plugin(rawGuard, { rawDirs: options.rawDirs });
    const policyFiber = await ctx.plugin(policyGate);
    const next = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: "cancel" }));
    let callNumber = 0;
    const input = (name: string, args: unknown, caller: Agent | null, signal: AbortSignal) => ({
      callId: `policy-call-${++callNumber}` as ToolCallId,
      name,
      arguments: args,
      ...(caller === null ? {} : { agent: caller }),
      signal,
    });
    return {
      ctx,
      root,
      cwd,
      session,
      agent,
      current,
      stateOf,
      request,
      tools,
      executions,
      logs,
      next,
      policyFiber,
      policyLogs: () =>
        logs.filter((row) => row.name === "shud-policy-gate").map((row) => row.args),
      decide(name: string, args?: unknown, caller: Agent | null = agent) {
        // Direct public waterfall tests intentionally include arguments rejected by runtime normalization.
        const exec = input(name, args, caller, new AbortController().signal) as ToolExecution;
        return ctx.waterfall("tools/pre-execute", exec, next);
      },
      call(
        name: string,
        args: unknown = {},
        caller: Agent | null = agent,
        signal = new AbortController().signal,
      ) {
        return tools.execute(input(name, args, caller, signal));
      },
      async dispose() {
        try {
          await ctx.fiber.dispose();
        } finally {
          await stopLogging();
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await ctx.fiber.dispose();
    } finally {
      await stopLogging();
      await rm(root, { recursive: true, force: true });
    }
    throw error;
  }
}
