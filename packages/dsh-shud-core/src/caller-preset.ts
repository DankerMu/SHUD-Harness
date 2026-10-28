/** Read attribution without mapping preset ids to roles or requiring a caller. */
export function readCallerPresetId(
  agent?: { session?: { header?: { agentPreset?: unknown } | null } | null } | null,
): string {
  const preset = agent?.session?.header?.agentPreset;
  return typeof preset === "string" && preset.length > 0 ? preset : "unknown";
}
