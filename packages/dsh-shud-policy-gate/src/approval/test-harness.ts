import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-preset-registry";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import { PermissionPresetService } from "@deepseek-ai/dsh-permission-presets";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { createScope } from "@deepseek-ai/dsh-scope";
import { SessionStore } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { defineTool, ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import { mountIdleTools } from "../../../dsh-shud-tools/src/test-harness.ts";
import * as rawGuard from "../../../dsh-shud-raw-guard/src/index.ts";
import { parseDocument } from "yaml";
import { z } from "zod";
import * as policyGate from "../index.ts";
import { CHANGE_ID, REPORT_ID, writeReport } from "../test-harness.ts";

// Pinned dsh-base 0.2.1-rc.2 composition, not the service's two-preset default.
// The base derives never from environment-selected full access, ask from other startup modes.
// Keep this baseline independent of the SHUD patch so absent overrides reproduce #511.
const basePermission = {
  presets: {
    "read-only": { sandbox: "read-only", approval: "ask" },
    "workspace-write": { sandbox: "workspace-write", approval: "ask" },
    "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
  },
} satisfies NonNullable<Parameters<typeof PermissionPresetService.Config>[0]>;

export const modes = ["read-only", "workspace-write", "danger-full-access"] as const;
export const reportTools = ["report_submit", "report_decide"] as const;
type ReportTool = (typeof reportTools)[number];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function profileOverrides() {
  const mode = process.env.DSH_PERMISSION_MODE ?? "workspace-write";
  if (!modes.some((supported) => supported === mode)) {
    throw new Error(`Unsupported test startup mode: ${mode}`);
  }
  const source = await readFile(
    new URL("../../../../profile/shud/cordis.patch.yml", import.meta.url),
    "utf8",
  );
  // Same inert Loader-tag treatment as scripts/runtime/profile-patch.ts; never eval !!js.
  const document = parseDocument(source, {
    prettyErrors: false,
    merge: false,
    schema: "core",
    customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }],
  });
  if (document.errors.length) throw new Error("Invalid SHUD profile YAML");
  const rows: unknown = document.toJS({ maxAliasCount: 100 });
  if (!Array.isArray(rows)) throw new Error("SHUD profile patch must be a sequence");
  const entries: unknown[] = rows;
  function config<T>(id: string, base: T): T {
    const matches = entries.filter(
      (row: unknown): row is Record<string, unknown> =>
        typeof row === "object" && row !== null && "id" in row && row.id === id,
    );
    if (matches.length > 1) throw new Error(`Ambiguous SHUD ${id} patch`);
    // Loader id patches replace config wholesale. No patch means the real base survives.
    return matches.length === 0 ? base : (matches[0].config as T);
  }
  return {
    startup: mode as SandboxMode,
    permission: config<NonNullable<Parameters<typeof PermissionPresetService.Config>[0]>>(
      "permission",
      basePermission,
    ),
    approval: config<NonNullable<Parameters<typeof ApprovalService.Config>[0]>>("approval", {
      policy: mode === "danger-full-access" ? "never" : "ask",
    }),
  };
}

export async function mountApprovalHarness(
  realChangeTools = false,
  rawDirs?: (cwd: string) => string[],
  approvalService = true,
) {
  const config = await profileOverrides();
  const cwd = await mkdtemp(join(tmpdir(), "shud-full-access-approval-"));
  const ctx = new Context();
  const abort = new AbortController();
  const watchdog = deferred<{ kind: "timeout" }>();
  const operations: Promise<unknown>[] = [];
  const releases: Array<() => void> = [];
  const executions: string[] = [];
  const logs: Array<{ name: string; args: unknown[] }> = [];
  const stopLogging = ctx.logger.exporter({
    export(message) {
      if (message.name === "shud-policy-gate" || message.name === "shud-raw-guard") {
        logs.push({ name: message.name, args: message.args as unknown[] });
      }
    },
  });
  let deadline: NodeJS.Timeout | undefined;
  async function dispose() {
    abort.abort();
    for (const release of releases) release();
    try {
      // A watchdog expiry bounds cleanup; it is not evidence of operation settlement.
      await Promise.race([Promise.all(operations), watchdog.promise]);
    } finally {
      clearTimeout(deadline);
      try {
        await ctx.fiber.dispose();
      } finally {
        await stopLogging();
        await rm(cwd, { recursive: true, force: true });
      }
    }
  }
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt);
    if (approvalService) await ctx.plugin(ApprovalService, config.approval);
    // Only the filesystem executor's composition default is consumed; no shell runs.
    ctx.provide("shell", {
      sandboxMode: config.startup,
      resolve() {
        throw new Error("This approval regression must not execute a shell");
      },
      run() {
        throw new Error("This approval regression must not execute a shell");
      },
      start() {
        throw new Error("This approval regression must not execute a shell");
      },
    });
    // Keep the genuine profile-configured plugin registered. Without approval its required
    // injection cannot activate; never substitute a provider or claim a selected permission mode.
    const permissionFiber = ctx.plugin(PermissionPresetService, config.permission);
    if (approvalService) await permissionFiber;
    await ctx.plugin(ToolRuntime, { mode: "native" });
    if (rawDirs) await ctx.plugin(rawGuard, { rawDirs: rawDirs(cwd) });
    await ctx.plugin(policyGate);
    if (realChangeTools) await mountIdleTools(ctx, cwd);
    await writeReport(cwd);
    let caller: Context | undefined;
    await ctx.plugin({
      inject: ["tools", "sessionProjections", "systemPrompt"],
      apply(consumer: Context) {
        caller = createScope(consumer, {}).ctx;
        if (realChangeTools) {
          consumer.on("tools/execute", (execution, next) => {
            executions.push(execution.name);
            return next();
          });
          // Public projection boundary; no preset loader or role-restrict configuration changes.
          const schema = z.string().nullable();
          consumer.sessionProjections.register<"agentPreset", string | null>({
            key: "agentPreset",
            stateSchema: schema,
            init: (header) => header.agentPreset ?? "coder",
            apply: (state, event) =>
              event.type === "agent-preset/selected" ? event.data.agentPreset : state,
            wire: { viewSchema: schema, view: (state) => state },
            stateVersion: 1,
          });
          return;
        }
        for (const name of reportTools) {
          consumer.tools.register(
            defineTool({
              name,
              description: "Execution boundary counter; does not implement report transitions",
              parameters: {},
              output: {
                schema: { type: "string" },
                render: (_args, value) => [{ type: "text", text: value }],
              },
              execute() {
                executions.push(name);
                return Promise.resolve("executed");
              },
            }),
          );
        }
      },
    });
    if (!caller) throw new Error("Tool caller did not activate");
    const callerContext = caller;
    const createSession = (seed?: readonly SessionEvent[]) =>
      ctx.sessions.create(undefined, { meta: { cwd }, ...(seed ? { seed } : {}) });
    const session = createSession();
    let callNumber = 0;
    // Failure-only watchdog: actual events/promises determine every passing assertion.
    // Real scheduling is retained; no sleep is used to guess when dispatch has happened.
    deadline = setTimeout(() => watchdog.resolve({ kind: "timeout" }), 2000);
    return {
      ctx,
      callerContext,
      session,
      cwd,
      executions,
      logs,
      createSession,
      dispose,
      watchdog: watchdog.promise,
      hold(expectedRequests = 1) {
        const answer = deferred<ApprovalOutcome>();
        const dispatched = deferred<{ kind: "dispatched" }>();
        const requests: ApprovalRequest[] = [];
        ctx.on("approval/request", (request) => {
          requests.push(request);
          if (requests.length === expectedRequests) dispatched.resolve({ kind: "dispatched" });
          return answer.promise;
        });
        releases.push(() => answer.resolve("cancelled"));
        return { answer, dispatched: dispatched.promise, requests };
      },
      call(tool: ReportTool | "change_submit", target = session, suppliedAgent?: Agent) {
        const agent =
          suppliedAgent ??
          ({ id: target.id, session: target, ctx: callerContext } as unknown as Agent);
        let settled = false;
        const callId = `full-access-${tool}-${++callNumber}` as ToolCallId;
        const done = ctx.tools
          .execute({
            name: tool,
            arguments:
              tool === "change_submit"
                ? { change_id: CHANGE_ID }
                : {
                    report_id: REPORT_ID,
                    ...(tool === "report_decide"
                      ? { disposition: "revision_requested", comment: "PI original words" }
                      : {}),
                  },
            callId,
            agent,
            signal: abort.signal,
          })
          .then(
            (result) => {
              settled = true;
              return { kind: "settled" as const, result };
            },
            (error: unknown) => {
              settled = true;
              return { kind: "failed" as const, error };
            },
          );
        operations.push(done);
        return { done, agent, callId, isSettled: () => settled };
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
