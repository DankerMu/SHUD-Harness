/**
 * Read current attribution from the public session projection, never the creation header.
 * Nonempty custom identities are preserved; unavailable identity is unknown.
 */
export function readCallerPresetId(
  agent?: {
    readonly session?: object | null;
    readonly ctx?: unknown;
  } | null,
): string {
  try {
    const session = agent?.session;
    if (!session) return "unknown";
    const ctx = agent?.ctx;
    if (!ctx || typeof ctx !== "object") return "unknown";
    const projections: unknown = Reflect.get(ctx, "sessionProjections");
    if (
      !projections ||
      typeof projections !== "object" ||
      !("stateOf" in projections) ||
      typeof projections.stateOf !== "function"
    ) {
      return "unknown";
    }
    // Keep the host's generic registry type outside core and preserve its method receiver.
    const reader = projections as { stateOf(session: object, key: string): unknown };
    const preset = reader.stateOf(session, "agentPreset");
    return typeof preset === "string" && preset.length > 0 ? preset : "unknown";
  } catch {
    return "unknown";
  }
}

/** Only the two active preset ids confer a policy role; custom attribution stays separate. */
export function presetIdToRole(presetId: string): "coordinator" | "worker" | "unknown" {
  return presetId === "coordinator" || presetId === "worker" ? presetId : "unknown";
}
