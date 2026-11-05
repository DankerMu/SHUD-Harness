import { Context } from "@deepseek-ai/cordis";
import type { Agent, SessionStartSource } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { createScope } from "@deepseek-ai/dsh-scope";
import type { CreateSessionOptions, Session, SessionEvent } from "@deepseek-ai/dsh-session";
import * as coderApproval from "../../../../dsh-shud-presets/src/coder-approval.ts";
import { mountApprovalHarness } from "../test-harness.ts";
import { snapshotFile, writeProposedChange, writeChangeSentinel } from "../../test-harness.ts";

type Meta = NonNullable<CreateSessionOptions["meta"]>;
export interface CoderOptions {
  parentMeta?: Meta;
  childMeta?: Meta;
  parentPolicy?: "ask" | "never";
  childPolicy?: "ask" | "never";
  delegation?: boolean;
  priorTurn?: boolean;
  seed?: readonly SessionEvent[];
  inheritedEventCount?: CreateSessionOptions["inheritedEventCount"];
  runtimeDepth?: unknown;
  approvalService?: boolean;
  registry?: boolean;
}

export function policyEvents(session: Session) {
  return session.snapshotEvents().filter((event) => event.type === "approval/policy");
}

export async function mountCoderHarness(options: CoderOptions = {}) {
  const h = await mountApprovalHarness(true, undefined, options.approvalService !== false);
  try {
    const fixture = await writeProposedChange(h.cwd);
    const sibling = await writeChangeSentinel(h.cwd, fixture.change);
    const paths = [fixture.changePath, fixture.taskPath, fixture.patchPath, ...sibling.paths];
    const before = await Promise.all(paths.map(snapshotFile));
    const parentSession = h.ctx.sessions.create(undefined, {
      meta: { cwd: h.cwd, agentPreset: "coordinator", ...options.parentMeta },
    });
    parentSession.append("approval/policy", { policy: options.parentPolicy ?? "ask" });
    const session = h.ctx.sessions.prepare(undefined, {
      meta: {
        cwd: h.cwd,
        parentSession: parentSession.id,
        origin: "subagent",
        isSeeded: false,
        delegationDepth: 1,
        agentPreset: "coder",
        ...options.childMeta,
      },
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.inheritedEventCount === undefined
        ? {}
        : { inheritedEventCount: options.inheritedEventCount }),
    });
    // Actual setup-window ordering; no fixture-owned reconstruction of the production projection.
    if (options.delegation !== false)
      session.append("approval/policy", { policy: "never", source: "delegation" });
    if (options.childPolicy) session.append("approval/policy", { policy: options.childPolicy });
    if (options.priorTurn) {
      session.append("turn/start", { turn: 1 });
      session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    }
    h.ctx.effect(function* () {
      yield h.ctx.sessions.enter(session);
      h.ctx.sessions.announce(session);
    });
    const notices: UserMessage[] = [];
    // Agent identity, live registry ownership and inbox are external doubles. Services are real.
    const parent = {
      id: parentSession.id,
      session: parentSession,
      ctx: h.callerContext,
      options: options.runtimeDepth === undefined ? {} : { subagentDepth: options.runtimeDepth },
    } as unknown as Agent;
    const child = {
      id: session.id,
      session,
      options: {},
      inject: (message: UserMessage) => {
        notices.push(message);
      },
    } as unknown as Agent;
    const childScope = createScope(h.callerContext, child);
    Object.assign(child, { ctx: childScope.ctx });
    const registry: { child: Agent | undefined; parent: Agent | undefined; owned: boolean } = {
      child,
      parent,
      owned: true,
    };
    if (options.registry !== false)
      h.ctx.provide("agents", {
        get: (id: string) =>
          id === session.id
            ? registry.child
            : id === parentSession.id
              ? registry.parent
              : undefined,
        isOwnedBy: (id: string, owner: Agent) =>
          registry.owned && id === session.id && owner === parent,
      });
    let plugin = h.ctx.plugin(coderApproval);
    await plugin;
    return {
      ...h,
      session,
      fixture,
      sibling,
      paths,
      before,
      parentSession,
      parent,
      child,
      registry,
      notices,
      announce: (source: SessionStartSource = "startup", signal?: AbortSignal) =>
        h.ctx.serial("agent/created", { agent: child, source, ...(signal ? { signal } : {}) }),
      snapshot: () => Promise.all(paths.map(snapshotFile)),
      async unmount() {
        await plugin.dispose();
      },
      async remount() {
        plugin = h.ctx.plugin(coderApproval);
        await plugin;
      },
      // A schema-valid service always defaults to ask. Only malformed parent capability tests
      // use this read-only boundary double; child request dispatch is never replaced.
      missingParentCapability(kind: "service" | "policy") {
        const context = new Context();
        if (kind === "policy")
          context.provide("approval", { overrideOf: () => undefined, config: {} });
        Object.assign(parent, { ctx: context });
        h.ctx.effect(() => () => context.fiber.dispose());
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}
