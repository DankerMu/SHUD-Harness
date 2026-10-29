import type { PolicyGateToolCall } from "./types.ts";

export function spawnToolCall(input: Record<string, unknown>): PolicyGateToolCall {
  return {
    toolId: "spawn_agent",
    role: "coordinator",
    input: {
      instruction: "Run the delegated task.",
      ...input,
    },
    workDir: "/workspace/tasks/TASK-M1-SPIKE",
  };
}
