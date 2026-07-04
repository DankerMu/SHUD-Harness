import { describe, expect, test } from "bun:test";
import {
  DATA_RAW_WRITE_DENY_RULE_ID,
  DATA_RAW_WRITE_GUARD_CLASS,
  DATA_RAW_WRITE_RULE_REF,
  evaluatePolicyGate,
  makeDataRawPolicyGateContext
} from "@shud-harness/core";
import { buildPolicyGateToolFailedEvent, TOOL_FAILED_EVENT_TYPE } from "./policy-gate-events";

describe("policy-gate WebSocket event skeleton", () => {
  test("builds a tool.failed envelope with seq/event_id and remediation payload", () => {
    const decision = evaluatePolicyGate(
      {
        toolId: "bash",
        role: "worker",
        input: {
          command: "printf x > data/raw/input.csv"
        }
      },
      makeDataRawPolicyGateContext()
    );
    expect(decision.decision).toBe("deny");
    if (decision.decision !== "deny") {
      throw new Error("expected policy denial");
    }

    const event = buildPolicyGateToolFailedEvent({
      seq: 42,
      event_id: "EVT-ISSUE-19",
      session_id: "SESSION-ISSUE-19",
      task_id: "TASK-M1-SPIKE",
      workspace_id: "WORKSPACE-LOCAL",
      timestamp: "2026-07-03T00:00:00.000Z",
      tool_id: "bash",
      decision,
      error_id: "ERR-ISSUE-19"
    });

    expect(event.type).toBe(TOOL_FAILED_EVENT_TYPE);
    expect(event.seq).toBe(42);
    expect(event.event_id).toBe("EVT-ISSUE-19");
    expect(event.payload.rule_id).toBe(DATA_RAW_WRITE_DENY_RULE_ID);
    expect(event.payload.guard_class).toBe(DATA_RAW_WRITE_GUARD_CLASS);
    expect(event.payload.error).toMatchObject({
      error_id: "ERR-ISSUE-19",
      category: "permission_error",
      severity: "error",
      tool_id: "bash",
      rule_id: DATA_RAW_WRITE_DENY_RULE_ID,
      guard_class: DATA_RAW_WRITE_GUARD_CLASS,
      remediation: {
        next_action: "adjust_scope",
        ref: DATA_RAW_WRITE_RULE_REF
      }
    });
    expect(event.payload.error.remediation?.hint).toBeTruthy();
  });
});
