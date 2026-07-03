export const CORE_AGENT_MODULES = [
  "coordinator",
  "explorer",
  "worker",
  "reviewer",
  "park-resume",
  "research-closure"
] as const;

export type CoreAgentModule = (typeof CORE_AGENT_MODULES)[number];
