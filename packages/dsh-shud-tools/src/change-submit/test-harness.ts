import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { expect } from "vitest";
import { createToolHarness } from "../test-harness.ts";
import {
  CHANGE_ID,
  snapshotFile,
  writeProposedChange,
} from "../../../dsh-shud-policy-gate/src/test-harness.ts";

export { CHANGE_ID, snapshotFile, writeProposedChange };
export async function submitHarness() {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  return {
    ...h,
    submit(
      args: unknown = { change_id: CHANGE_ID },
      callId = "change-submit-contract",
      agent: Agent | null = h.agent,
    ) {
      return h.runtime.execute({
        name: "change_submit",
        arguments: args,
        callId: callId as ToolCallId,
        ...(agent === null ? {} : { agent }),
        signal: new AbortController().signal,
      });
    },
  };
}
export function failure(result: ToolExecutionResult, pattern: RegExp) {
  expect(result.isError).toBe(true);
  if (!result.isError) throw new Error("Expected change_submit error");
  expect(result.error.message).toMatch(pattern);
  expect(result.error.message).not.toContain("PRIVATE_");
  return result.error.message;
}
