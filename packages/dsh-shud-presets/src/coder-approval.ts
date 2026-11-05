import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-session-projection";
import type {} from "@deepseek-ai/dsh-system-prompt";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { readCallerPresetId } from "@shud-harness/dsh-shud-core";
import { z } from "zod";

export const name = "shud-coder-approval";
export const inject = ["sessionProjections", "systemPrompt"];

const stateSchema = z.strictObject({
  inherited: z.number().int().nonnegative(),
  policyCount: z.number().int().min(0).max(2),
  started: z.boolean(),
  latest: z
    .strictObject({
      policy: z.enum(["ask", "never"]),
      delegation: z.boolean(),
      seq: z.number().int().nonnegative(),
    })
    .nullable(),
});
type InitializationState = z.infer<typeof stateSchema>;

declare module "@deepseek-ai/dsh-session-projection" {
  interface SessionProjectionStateMap {
    shudCoderApproval: InitializationState;
  }
}
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "shud-coder-approval": {
      kind: "shud-coder-approval";
      policySeq: number;
      parentSession: string;
      parentPolicy: "ask";
    };
  }
}

function currentPolicy(agent: Agent) {
  const approval = agent.ctx.get("approval");
  return approval?.overrideOf(agent.session) ?? approval?.config.policy;
}

function delegatedCoder(agent: Agent): boolean {
  return agent.session.header.origin === "subagent" && readCallerPresetId(agent) === "coder";
}

export function apply(ctx: Context): void {
  const seen = new WeakSet<Agent>();
  const explanations = new WeakMap<Agent, string>();
  let active = true;
  ctx.effect(() => () => {
    active = false;
  });
  ctx.sessionProjections.register<"shudCoderApproval", InitializationState>({
    key: "shudCoderApproval",
    stateSchema,
    stateVersion: 1,
    init: (_header, inherited) => ({ inherited, policyCount: 0, started: false, latest: null }),
    apply(state, event) {
      if (event.seq < state.inherited) return state;
      if (event.type === "turn/start" && !state.started) return { ...state, started: true };
      if (event.type !== "approval/policy") return state;
      return {
        ...state,
        policyCount: Math.min(2, state.policyCount + 1),
        latest: {
          policy: event.data.policy,
          delegation: event.data.source === "delegation",
          seq: event.seq,
        },
      };
    },
  });

  // Distinct registered name is essential: admission refresh re-resolves providers by name.
  const contextName = "shud-coder-approval:delegation";
  function explanation(agent: Agent | undefined): string {
    if (!agent) return "";
    const original = explanations.get(agent);
    if (original === undefined) return "";
    if (!delegatedCoder(agent) || currentPolicy(agent) !== "ask") return original;
    return (
      "You are a delegated coder. SHUD approval policy is ask: operations requiring approval " +
      "must reach an available answerer; only allowed-once permits that one action. No answerer " +
      "or any other outcome fails closed. This policy is not an approval or a PI click. Your sandbox " +
      "scope remains fixed at delegation and cannot be widened from inside this session. " +
      "If access exceeds that sandbox, state the limitation for the delegating agent; do not retry it."
    );
  }
  ctx.systemPrompt.context({
    name: contextName,
    order: ctx.systemPrompt.getContextOrder("SUBAGENT_DELEGATION"),
    text: ({ agent }) => explanation(agent),
  });
  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const assembly = await next();
    // The provider is global but its entry is routed only from an accepted host delegation entry.
    const contexts = assembly.contexts.filter((entry) => entry.name !== contextName);
    // Disposal cannot cancel an entered waterfall; it must revoke routing after the await.
    if (!active) return { ...assembly, contexts };
    const agent = context.agent;
    const original = contexts.find((entry) => entry.name === "subagent:delegation");
    if (agent && delegatedCoder(agent) && original) {
      explanations.set(agent, original.text);
      return {
        ...assembly,
        contexts: contexts.map((entry) =>
          entry === original ? { ...entry, name: contextName, text: explanation(agent) } : entry,
        ),
      };
    }
    return { ...assembly, contexts };
  });

  ctx.on("agent/created", ({ agent, source, signal }) => {
    if (!active || seen.has(agent)) return undefined;
    seen.add(agent);
    if (source !== "startup" || signal?.aborted || !delegatedCoder(agent)) return undefined;
    const { session } = agent;
    const header = session.header;
    const registry = agent.ctx.get("agents");
    if (
      !registry ||
      agent.id !== session.id ||
      header.id !== session.id ||
      registry.get(agent.id) !== agent ||
      header.isSeeded !== false ||
      !header.parentSession ||
      header.parentSession === session.id
    )
      return undefined;
    const parent = registry.get(header.parentSession);
    if (
      !parent ||
      parent.id !== header.parentSession ||
      parent.session.id !== parent.id ||
      parent.session.header.id !== parent.id ||
      !registry.isOwnedBy(agent.id, parent)
    )
      return undefined;
    // The pinned host treats absent depth as zero only for a top-level parent here.
    const parentDepth =
      parent.session.header.delegationDepth ??
      (parent.session.header.origin === undefined &&
      parent.session.header.parentSession === undefined
        ? 0
        : undefined);
    if (
      parentDepth === undefined ||
      !Number.isSafeInteger(parentDepth) ||
      parentDepth < 0 ||
      !Number.isSafeInteger(header.delegationDepth) ||
      header.delegationDepth !== parentDepth + 1
    )
      return undefined;
    if (!parent.options || typeof parent.options !== "object") return undefined;
    const runtimeDepth: unknown = Reflect.get(parent.options, "subagentDepth");
    if (
      runtimeDepth !== undefined &&
      (typeof runtimeDepth !== "number" ||
        !Number.isSafeInteger(runtimeDepth) ||
        runtimeDepth < 0 ||
        Object.is(runtimeDepth, -0) ||
        runtimeDepth > parentDepth)
    )
      return undefined;
    const state = ctx.sessionProjections.stateOf(session, "shudCoderApproval");
    if (
      !state ||
      state.inherited !== 0 ||
      state.started ||
      state.policyCount !== 1 ||
      state.latest?.policy !== "never" ||
      !state.latest.delegation ||
      currentPolicy(agent) !== "never"
    )
      return undefined;

    // No await between this live authorization observation and the initialization write.
    // This is a publication-time opt-in, not a pre-await parent-policy inheritance snapshot.
    if (!active || signal?.aborted || currentPolicy(parent) !== "ask") return undefined;
    const policySeq = session.seq;
    try {
      setApprovalPolicy(session, "ask");
      agent.inject(
        createUserMessage({
          content: [
            {
              type: "text",
              text:
                `SHUD initialized this fresh delegated coder's approval policy to ask at child policy seq ${policySeq}. ` +
                `Live parent ${parent.id} explicitly resolved to ask at this initialization boundary. ` +
                "This is policy initialization, not a user policy switch, approval, or PI click. " +
                "Each required approval still needs an answerer and allowed-once; the sandbox is unchanged.",
            },
          ],
          source: {
            kind: "shud-coder-approval",
            policySeq,
            parentSession: parent.id,
            parentPolicy: "ask",
          },
        }),
      );
    } catch (cause) {
      try {
        const latest = ctx.sessionProjections.stateOf(session, "shudCoderApproval")?.latest;
        // Sequence ownership, not just value equality: never clobber an intervening external ask.
        if (
          latest?.seq === policySeq &&
          latest.policy === "ask" &&
          !latest.delegation &&
          currentPolicy(agent) === "ask"
        )
          setApprovalPolicy(session, "never");
      } catch (rollback) {
        throw new AggregateError([cause, rollback], `${name}: initialization and rollback failed`, {
          cause: rollback,
        });
      }
      throw new Error(`${name}: initialization failed`, { cause });
    }
    return undefined;
  });
}
