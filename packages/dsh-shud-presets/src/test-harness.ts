import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-preset-registry/types";
import { createScope } from "@deepseek-ai/dsh-scope";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { defineTool, ToolRuntime } from "@deepseek-ai/dsh-tools";
import { vi } from "vitest";

// Independent oracle: agent-presets' exact effective surfaces, not the implementation's map.
export const COORDINATOR_TOOLS = [
  "task_create",
  "report_generate",
  "report_validate",
  "report_submit",
  "report_decide",
  "shud_collect",
  "subagent",
  "job_output",
  "job_list",
  "job_kill",
].sort();
export const WORKER_TOOLS = [
  "shud_run",
  "shud_collect",
  "job_output",
  "job_list",
  "job_kill",
].sort();
const GLOBAL_TOOLS = [
  "task_create",
  "report_generate",
  "report_validate",
  "report_submit",
  "report_decide",
  "shud_run",
  "shud_collect",
  "bash",
  "read",
  "write",
  "edit",
  "list_subagent_models",
];
const JOB_TOOLS = ["job_output", "job_list", "job_kill"];

function registerTool(ctx: Context, name: string) {
  return ctx.tools.register(
    defineTool({
      name,
      description: "Registration-only boundary tool; no SHUD process or report side effects",
      parameters: {},
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      execute: () => Promise.resolve("boundary tool"),
    }),
  );
}

export interface HarnessOptions {
  missing?: string;
  projections?: boolean;
}

interface AgentFixture {
  agent: Agent;
  session: { id: SessionId; header: { agentPreset: string } };
  surface(): string[];
  setProjection(value: unknown): void;
  setLocalSubagent(enabled: boolean): void;
  announce(): Promise<unknown>;
  selected(payload?: string): void;
  announceDisposed(): void;
  disposeScopes(): Promise<void>;
}

export interface RoleHarness {
  ctx: Context;
  stateOf: (session: object, key: string) => unknown;
  registerGlobal(name: string): () => void;
  prepareAgent(preset?: unknown, sessionId?: SessionId): AgentFixture;
  dispose(): Promise<void>;
}

export async function createRoleHarness(options: HarnessOptions = {}): Promise<RoleHarness> {
  const ctx = new Context();
  const projections = new Map<object, unknown>();
  const stateOf = vi.fn((session: object, key: string) =>
    key === "agentPreset" ? projections.get(session) : undefined,
  );
  try {
    const providers: Array<Parameters<SystemPrompt["tools"]>[0]> = [];
    await ctx.plugin((services: Context) => {
      services.provide("systemPrompt", {
        tools(provider: Parameters<SystemPrompt["tools"]>[0]) {
          providers.push(provider);
          return () => providers.splice(providers.indexOf(provider), 1);
        },
      });
      if (options.projections !== false) services.provide("sessionProjections", { stateOf });
    });
    await ctx.plugin(ToolRuntime, { mode: "native" });
    let consumer: Context | undefined;
    await ctx.plugin({
      inject: ["tools", ...(options.projections === false ? [] : ["sessionProjections"])],
      apply(active: Context) {
        consumer = active;
        for (const name of GLOBAL_TOOLS) {
          if (name !== options.missing) registerTool(active, name);
        }
      },
    });
    if (!consumer || providers.length !== 1) throw new Error("Native ToolRuntime did not activate");
    const owner = consumer;
    let agentNumber = 0;
    return {
      ctx,
      stateOf,
      registerGlobal: (name: string) => registerTool(owner, name),
      prepareAgent(preset: unknown = "coordinator", sessionId?: SessionId) {
        const session = {
          id: sessionId ?? (`role-session-${++agentNumber}` as SessionId),
          header: { agentPreset: "coordinator" },
        };
        projections.set(session, preset);
        // Public Agent/Session data are doubled, never scope keys or restriction behavior.
        const agent = { id: session.id, session } as unknown as Agent;
        const presetKey = {};
        const presetScope = createScope(owner, presetKey);
        for (const name of JOB_TOOLS) {
          if (name !== options.missing) registerTool(presetScope.ctx, name);
        }
        const agentScope = createScope(owner, agent, { parent: presetKey });
        Object.assign(agent, { ctx: agentScope.ctx });
        let releaseSubagent: (() => void) | undefined;
        const setLocalSubagent = (enabled: boolean) => {
          if (enabled && !releaseSubagent) releaseSubagent = registerTool(agent.ctx, "subagent");
          if (!enabled && releaseSubagent) {
            releaseSubagent();
            releaseSubagent = undefined;
          }
        };
        setLocalSubagent(preset === "coordinator");
        return {
          agent,
          session,
          surface: () =>
            owner.tools
              .schemas(agent)
              .map((tool) => tool.name)
              .sort(),
          setProjection: (value: unknown) => projections.set(session, value),
          setLocalSubagent,
          announce: () => ctx.serial("agent/created", { agent, source: "startup" }),
          selected: (payload = "worker") => ctx.emit("agent-preset/selected", session.id, payload),
          // Observe plugin-owned cleanup separately from scope teardown, which could hide a leak.
          announceDisposed: () => ctx.emit("agent/disposed", { agent }),
          async disposeScopes() {
            await agentScope.dispose();
            await presetScope.dispose();
          },
        };
      },
      async dispose() {
        await ctx.fiber.dispose();
      },
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
