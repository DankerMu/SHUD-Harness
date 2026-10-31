import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-preset-registry/types";
import type {} from "@deepseek-ai/dsh-tools";
import { getRoleToolIds, presetIdToRole, readCallerPresetId } from "@shud-harness/dsh-shud-core";

export const name = "shud-role-restrict";

interface Restriction {
  role: "coordinator" | "worker";
  release: () => void;
}

interface AgentBinding {
  revision: number;
  restriction: Restriction | undefined;
}

export function apply(ctx: Context): void {
  const agents = new Map<Agent, AgentBinding>();
  let active = true;

  function bind(agent: Agent, binding: AgentBinding): void {
    // Even a same-role event invalidates a bind interrupted by tools/change.
    const revision = ++binding.revision;
    const previous = binding.restriction;
    const role = presetIdToRole(readCallerPresetId(agent));
    if (role === "unknown") {
      binding.restriction = undefined;
      previous?.release();
      return;
    }
    if (previous?.role === role) return;
    const { inherited } = getRoleToolIds(role);
    if (inherited.length === 0) {
      throw new Error(`${name}: ${role} inherited tool list is empty`);
    }
    let release: () => void;
    try {
      release = agent.ctx.tools.restrict({ allow: inherited });
    } catch (cause) {
      throw new Error(`${name}: cannot bind ${role} inherited tools: ${inherited.join(", ")}`, {
        cause,
      });
    }
    if (!active || agents.get(agent) !== binding || binding.revision !== revision) {
      // A nested selection or disposal owns the latest state, not this pending mask.
      release();
      return;
    }
    // Keep the prior mask and role until the replacement is actually installed.
    binding.restriction = { role, release };
    previous?.release();
  }

  const stopListening = [
    ctx.on("agent/created", ({ agent }) => {
      if (!active) return undefined;
      let binding = agents.get(agent);
      if (!binding) {
        binding = { revision: 0, restriction: undefined };
        agents.set(agent, binding);
      }
      bind(agent, binding);
      return undefined;
    }),
    ctx.on("agent-preset/selected", (sessionId) => {
      if (!active) return;
      for (const [agent, binding] of agents) {
        if (agent.session.id === sessionId) bind(agent, binding);
      }
    }),
    ctx.on("agent/disposed", ({ agent }) => {
      const binding = agents.get(agent);
      if (!binding) return;
      agents.delete(agent);
      binding.revision++;
      const restriction = binding.restriction;
      binding.restriction = undefined;
      restriction?.release();
    }),
  ];
  ctx.effect(() => () => {
    active = false;
    const errors: unknown[] = [];
    for (const stop of stopListening) {
      try {
        stop();
      } catch (error) {
        errors.push(error);
      }
    }
    const restrictions: Restriction[] = [];
    for (const binding of agents.values()) {
      binding.revision++;
      if (binding.restriction) restrictions.push(binding.restriction);
      binding.restriction = undefined;
    }
    agents.clear();
    for (const restriction of restrictions) {
      try {
        restriction.release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, `${name}: lifecycle cleanup failed`);
    }
  });
}
