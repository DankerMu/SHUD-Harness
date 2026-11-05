import { parseDocument } from "yaml";
import { object, requireFact, text } from "./shud-restart-evidence.ts";
export function configurationRows(source: string, label: string): Record<string, unknown>[] {
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      merge: false,
      schema: "core",
      customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }],
    });
    requireFact(
      document.errors.length === 0 && document.warnings.length === 0,
      `Invalid ${label} YAML`,
    );
    const value: unknown = document.toJS({ maxAliasCount: 100 });
    requireFact(Array.isArray(value), `${label} must be a sequence`);
    return value.map(object);
  } catch {
    throw new Error(`Invalid ${label} YAML or mapping entry shape`);
  }
}
export function effectiveConfig(
  source: string,
  roles: readonly ("worker" | "coder" | "reviewer")[],
) {
  const rows = configurationRows(source, "effective profile");
  function row(id: string) {
    const found = rows.filter((entry) => entry.id === id && entry.disabled !== true);
    requireFact(found.length === 1, "Missing or ambiguous required effective profile row");
    return object(found[0].config);
  }
  const coordinator = row("preset-coordinator");
  requireFact(
    coordinator.id === "coordinator" && Array.isArray(coordinator.plugins),
    "Missing effective coordinator composition",
  );
  const plugins = coordinator.plugins.map(object);
  const delegations = roles.map((role) => {
    const id = role === "worker" ? "tool-subagent" : `tool-subagent-${role}`;
    const toolName = role === "worker" ? "subagent" : `subagent_${role}`;
    const delegates = plugins.filter(
      (entry) =>
        entry.id === id &&
        entry.disabled !== true &&
        entry.name === "@deepseek-ai/dsh-tool-subagent",
    );
    requireFact(delegates.length === 1, "Missing effective coordinator delegation binding");
    const delegate = object(delegates[0].config);
    requireFact(
      delegate.provider === "spawn" &&
        delegate.agentPreset === role &&
        delegate.toolName === toolName,
      `Effective delegation must explicitly configure spawn/${role}`,
    );
    return { provider: "spawn", agentPreset: role, toolName };
  });
  const jobs = row("shud-jobs");
  const llm = object(jobs.llm);
  requireFact(
    llm.base_url === row("llm-deepseek").baseURL &&
      llm.request_alias === row("agent-default-model").model,
    "Effective model capture route mismatch",
  );
  return {
    delegations,
    base_url: text(llm.base_url),
    request_alias: text(llm.request_alias),
  };
}
