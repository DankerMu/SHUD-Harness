export const CORE_TOOL_MODULES = [
  "shud-build",
  "shud-run",
  "rshud-parse",
  "water-balance"
] as const;

export type CoreToolModule = (typeof CORE_TOOL_MODULES)[number];
