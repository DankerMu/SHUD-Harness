import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import { PermissionPresetService } from "@deepseek-ai/dsh-permission-presets";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { createScope } from "@deepseek-ai/dsh-scope";
import { SessionStore } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { defineTool, ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseDocument } from "yaml";
import * as policyGate from "./index.ts";
import { REPORT_ID, writeReport } from "./test-harness.ts";

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

const modes = ["read-only", "workspace-write", "danger-full-access"] as const;
const reportTools = ["report_submit", "report_decide"] as const;
type ReportTool = (typeof reportTools)[number];

beforeEach(() => vi.stubEnv("DSH_PERMISSION_MODE", "workspace-write"));
afterEach(() => vi.unstubAllEnvs());

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
    new URL("../../../profile/shud/cordis.patch.yml", import.meta.url),
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

async function mountApprovalHarness() {
  const config = await profileOverrides();
  const cwd = await mkdtemp(join(tmpdir(), "shud-full-access-approval-"));
  const ctx = new Context();
  const abort = new AbortController();
  const watchdog = deferred<{ kind: "timeout" }>();
  const operations: Promise<unknown>[] = [];
  const releases: Array<() => void> = [];
  const executions: string[] = [];
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
        await rm(cwd, { recursive: true, force: true });
      }
    }
  }
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ApprovalService, config.approval);
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
    await ctx.plugin(PermissionPresetService, config.permission);
    await ctx.plugin(ToolRuntime, { mode: "native" });
    await ctx.plugin(policyGate);
    await writeReport(cwd);
    let caller: Context | undefined;
    await ctx.plugin({
      inject: ["tools", "sessionProjections"],
      apply(consumer: Context) {
        caller = createScope(consumer, {}).ctx;
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
      session,
      executions,
      createSession,
      dispose,
      watchdog: watchdog.promise,
      hold() {
        const answer = deferred<ApprovalOutcome>();
        const dispatched = deferred<{ kind: "dispatched" }>();
        const requests: ApprovalRequest[] = [];
        ctx.on("approval/request", (request) => {
          requests.push(request);
          dispatched.resolve({ kind: "dispatched" });
          return answer.promise;
        });
        releases.push(() => answer.resolve("cancelled"));
        return { answer, dispatched: dispatched.promise, requests };
      },
      call(tool: ReportTool, target = session) {
        const agent = { id: target.id, session: target, ctx: callerContext } as unknown as Agent;
        let settled = false;
        const done = ctx.tools
          .execute({
            name: tool,
            arguments: {
              report_id: REPORT_ID,
              ...(tool === "report_decide"
                ? { disposition: "revision_requested", comment: "PI original words" }
                : {}),
            },
            callId: `full-access-${tool}-${++callNumber}` as ToolCallId,
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
        return { done, agent, isSettled: () => settled };
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function decisions(session: Session) {
  return session.snapshotEvents().filter((event) => event.type === "approval/decided");
}

for (const tool of reportTools) {
  test(`full filesystem access dispatches ${tool} and waits for PI before allowing one execution`, async () => {
    const h = await mountApprovalHarness();
    try {
      const held = h.hold();
      h.ctx.permissionPresets.set(h.session, "danger-full-access");
      h.session.append("turn/start", { turn: 1 });
      const operation = h.call(tool);
      const first = await Promise.race([held.dispatched, operation.done, h.watchdog]);
      expect(h.ctx.permissionPresets.current(h.session)).toBe("danger-full-access");
      expect(h.ctx.sessionProjections.stateOf(h.session, "permissions")).toMatchObject({
        sandbox: "danger-full-access",
        approval: "ask",
      });
      expect(first).toMatchObject({ kind: "dispatched" });
      expect(held.requests).toHaveLength(1);
      expect(held.requests[0]).toMatchObject({
        toolName: tool,
        reason: `${policyGate.REPORT_APPROVAL_REASON_PREFIX} ${REPORT_ID}`,
      });
      expect(held.requests[0].agent).toBe(operation.agent);
      expect(operation.isSettled()).toBe(false);
      expect(h.executions).toEqual([]);
      expect(decisions(h.session)).toEqual([]);
      held.answer.resolve("allowed-once");
      expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
        kind: "settled",
        result: { isError: false, value: "executed" },
      });
      expect(h.executions).toEqual([tool]);
      expect(decisions(h.session)).toMatchObject([{ data: { outcome: "allowed-once" } }]);
    } finally {
      await h.dispose();
    }
  });

  test.each(["rejected", "cancelled", "unavailable"] as const)(
    `${tool} under full access fails closed when approval is %s`,
    async (outcome) => {
      const h = await mountApprovalHarness();
      try {
        // No listener is installed for unavailable: exercise real no-answerer fallthrough.
        const held = outcome === "unavailable" ? undefined : h.hold();
        h.ctx.permissionPresets.set(h.session, "danger-full-access");
        h.session.append("turn/start", { turn: 1 });
        const operation = h.call(tool);
        if (held) {
          expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
            kind: "dispatched",
          });
          held.answer.resolve(outcome);
        }
        expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
          kind: "settled",
          result: { isError: true },
        });
        expect(h.executions).toEqual([]);
        expect(decisions(h.session)).toMatchObject([{ data: { outcome } }]);
      } finally {
        await h.dispose();
      }
    },
  );
}

test("all three filesystem modes retain ask and repeated selection appends nothing", async () => {
  const h = await mountApprovalHarness();
  try {
    expect(h.ctx.permissionPresets.names).toEqual(modes);
    for (const mode of modes) {
      h.ctx.permissionPresets.set(h.session, mode);
      expect(h.ctx.permissionPresets.current(h.session)).toBe(mode);
      expect(h.ctx.sessionProjections.stateOf(h.session, "permissions")).toMatchObject({
        sandbox: mode,
        approval: "ask",
      });
      const before = h.session.snapshotEvents();
      h.ctx.permissionPresets.set(h.session, mode);
      expect(h.session.snapshotEvents()).toEqual(before);
    }
  } finally {
    await h.dispose();
  }
});

test("environment-selected full access starts with ask and reaches approval without reselection", async () => {
  vi.stubEnv("DSH_PERMISSION_MODE", "danger-full-access");
  const h = await mountApprovalHarness();
  try {
    expect(h.ctx.approval.config.policy).toBe("ask");
    expect(h.ctx.permissionPresets.current(h.session)).toBe("danger-full-access");
    expect(h.ctx.sessionProjections.stateOf(h.session, "permissions")).toMatchObject({
      sandbox: "danger-full-access",
      approval: "ask",
    });
    const held = h.hold();
    h.session.append("turn/start", { turn: 1 });
    const operation = h.call("report_submit");
    expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
      kind: "dispatched",
    });
    expect(operation.isSettled()).toBe(false);
    held.answer.resolve("allowed-once");
    expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
      kind: "settled",
      result: { isError: false },
    });
    expect(h.executions).toEqual(["report_submit"]);
  } finally {
    await h.dispose();
  }
});

test("restored full-access never history remains intact until explicit preset reselection", async () => {
  const h = await mountApprovalHarness();
  try {
    // Durable old-session fixture, constructed through real Session append and replay APIs.
    h.session.append("permission/preset", { preset: "danger-full-access" });
    h.session.append("sandbox/mode", { mode: "danger-full-access" });
    h.session.append("approval/policy", { policy: "never" });
    const history = structuredClone(h.session.snapshotEvents());
    const restored = h.createSession(history);
    expect(restored.snapshotEvents().slice(0, history.length)).toEqual(history);
    // Restoration may append lifecycle bookkeeping, but must not rewrite permission intent.
    expect(
      restored
        .snapshotEvents()
        .slice(history.length)
        .filter(
          ({ type }) =>
            type === "permission/preset" || type === "sandbox/mode" || type === "approval/policy",
        ),
    ).toEqual([]);
    expect(h.ctx.approval.overrideOf(restored)).toBe("never");
    expect(h.ctx.permissionPresets.current(restored)).toBe("custom");
    const held = h.hold();
    restored.append("turn/start", { turn: 1 });
    const rejected = h.call("report_submit", restored);
    const denial = await Promise.race([rejected.done, h.watchdog]);
    expect(denial).toMatchObject({
      kind: "settled",
      result: { isError: true },
    });
    if (denial.kind !== "settled" || !denial.result.isError) {
      throw new Error("Legacy never policy did not reject the report tool");
    }
    expect(denial.result.error.message).toContain("rejected");
    expect(held.requests).toEqual([]);
    expect(h.executions).toEqual([]);
    expect(decisions(restored)).toMatchObject([{ data: { outcome: "rejected" } }]);
    const beforeReselection = structuredClone(restored.snapshotEvents());
    h.ctx.permissionPresets.set(restored, "danger-full-access");
    expect(restored.snapshotEvents().slice(0, beforeReselection.length)).toEqual(beforeReselection);
    expect(
      restored
        .snapshotEvents()
        .slice(beforeReselection.length)
        .map(({ type, data }) => ({
          type,
          data,
        })),
    ).toEqual([
      { type: "permission/preset", data: { preset: "danger-full-access" } },
      { type: "approval/policy", data: { policy: "ask" } },
    ]);
    expect(h.ctx.permissionPresets.current(restored)).toBe("danger-full-access");
    expect(h.ctx.sessionProjections.stateOf(restored, "permissions")).toMatchObject({
      sandbox: "danger-full-access",
      approval: "ask",
    });
    const afterReselection = restored.snapshotEvents();
    h.ctx.permissionPresets.set(restored, "danger-full-access");
    expect(restored.snapshotEvents()).toEqual(afterReselection);
    const operation = h.call("report_submit", restored);
    expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
      kind: "dispatched",
    });
    expect(operation.isSettled()).toBe(false);
    held.answer.resolve("allowed-once");
    expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
      kind: "settled",
      result: { isError: false },
    });
    expect(h.executions).toEqual(["report_submit"]);
    expect(restored.snapshotEvents().slice(0, history.length)).toEqual(history);
  } finally {
    await h.dispose();
  }
});
