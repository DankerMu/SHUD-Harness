import { describe, expect, test } from "bun:test";
import type { ErrorRecord } from "@shud-harness/core";
import { buildToolFailedWsEvent } from "./index";

describe("backend ws tool.failed skeleton", () => {
  test("builds only the existing tool.failed event with remediation payload", () => {
    const error = sampleErrorRecord();
    const event = buildToolFailedWsEvent({
      seq: 7,
      eventId: "evt-7",
      ts: "2026-07-04T00:00:00.000Z",
      toolId: "bash",
      rule: "raw-data-write",
      decision: "denied_by_sandbox",
      profileId: "shud-raw-seatbelt-test",
      error
    });

    expect(event).toEqual({
      seq: 7,
      event_id: "evt-7",
      event: "tool.failed",
      ts: "2026-07-04T00:00:00.000Z",
      payload: {
        tool_id: "bash",
        rule: "raw-data-write",
        decision: "denied_by_sandbox",
        profile_id: "shud-raw-seatbelt-test",
        error
      }
    });
    expect(event.event).not.toBe("policy.denied");
    expect(event.payload.error.remediation?.next_action).toBe("adjust_scope");
  });
});

function sampleErrorRecord(): ErrorRecord {
  return {
    error_id: "raw-data-write:denied_by_sandbox:shud-raw-seatbelt-test",
    category: "sandbox_error",
    severity: "error",
    message: "Raw data write denied by OS sandbox.",
    user_message: "data/raw is protected evidence input and cannot be mutated by bash.",
    evidence_refs: ["openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md"],
    retryable: false,
    recommended_next_actions: ["Write derived files outside data/raw."],
    remediation: {
      next_action: "adjust_scope",
      hint: "Write derived files outside data/raw.",
      ref: "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md"
    },
    created_at: "2026-07-04T00:00:00.000Z"
  };
}
