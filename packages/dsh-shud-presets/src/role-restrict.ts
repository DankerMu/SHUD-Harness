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

export function apply(ctx: Context): void {
  // An undefined value still tracks a live, currently unrestricted Agent.
  const agents = new Map<Agent, Restriction | undefined>();

  function bind(agent: Agent): void {
    const previous = agents.get(agent);
    const role = presetIdToRole(readCallerPresetId(agent));
    if (role === "unknown") {
      agents.set(agent, undefined);
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
    // Keep the prior mask and role until the replacement is actually installed.
    agents.set(agent, { role, release });
    previous?.release();
  }

  ctx.on("agent/created", ({ agent }) => {
    if (!agents.has(agent)) agents.set(agent, undefined);
    bind(agent);
    return undefined;
  });
  ctx.on("agent-preset/selected", (sessionId) => {
    for (const agent of agents.keys()) {
      if (agent.session.id === sessionId) bind(agent);
    }
  });
  ctx.on("agent/disposed", ({ agent }) => {
    const restriction = agents.get(agent);
    agents.delete(agent);
    restriction?.release();
  });
  ctx.effect(() => () => {
    for (const restriction of agents.values()) restriction?.release();
    agents.clear();
  });
}
