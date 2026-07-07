import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRawDataSeatbeltProfile,
  rawDataDeniedToolResultToToolFailedEventInput,
  rawDataWriteRemediation,
  RawDataSandboxedBashTool,
  RAW_DATA_WRITE_RULE_ID,
  SPAWN_PROFILE_SUBSET_RULE_ID,
  TOOL_PARAMETER_SCHEMA_RULE_ID,
  type ErrorRecord,
  type RawDataToolFailedEventInput,
  type RawDataDenialPayload
} from "@shud-harness/core";
import {
  buildRawDataDeniedPayload,
  rawDataDenialPayloadToToolFailedEventInput
} from "../../../core/test-support/raw-data-sandbox-test-support";
import {
  buildRawDataAdvisoryToolFailedWsEvent,
  buildToolFailedWsEvent,
  type RawDataAdvisoryToolFailedWsEventInput
} from "./index";

describe("backend ws tool.failed skeleton", () => {
  test("builds tool.failed from sandbox-owned raw-data advisory denial evidence", async () => {
    const trusted = await sampleTrustedRawDataAdvisoryToolFailedEvent();
    const event = buildRawDataAdvisoryToolFailedWsEvent({
      seq: 7,
      eventId: "evt-7",
      timestamp: "2026-07-04T00:00:00.000Z",
      toolResult: trusted.toolResult
    });

    expect(event).toEqual({
      seq: 7,
      event_id: "evt-7",
      type: "tool.failed",
      timestamp: "2026-07-04T00:00:00.000Z",
      payload: {
        tool_id: trusted.input.toolId,
        rule: trusted.input.rule,
        decision: trusted.input.decision,
        guard_class: trusted.input.guardClass,
        profile_id: trusted.input.profileId,
        invocation_id: trusted.input.invocationId,
        error: trusted.input.error
      }
    });
    expect(event.type).toBe("tool.failed");
    expect(event.payload.error.error_id).toBe(trusted.input.error.error_id);
    expect(event.payload.error.error_id).toContain(`${RAW_DATA_WRITE_RULE_ID}:denied_by_advisory`);
    expect(event.payload.error.remediation?.next_action).toBe("adjust_scope");
    expect(event.payload.error.remediation?.hint).toContain("data/raw");
    expect(event.payload.error.remediation?.ref).toContain("policy-gate-spike");
  });

  test("raw-data advisory builder ignores caller mutations of helper-returned evidence", async () => {
    const trusted = await sampleTrustedRawDataAdvisoryToolFailedEvent();
    const originalInput = cloneRawDataToolFailedEventInput(trusted.input);
    const helperInput = rawDataDeniedToolResultToToolFailedEventInput(trusted.toolResult);
    if (!helperInput) {
      throw new Error("Expected trusted raw-data advisory tool.failed input.");
    }
    const mutableInput = helperInput as unknown as {
      toolId: string;
      rule: string;
      decision: string;
      profileId: string;
      error: ErrorRecord;
    };

    expect(helperInput).not.toBe(trusted.input);
    expect(helperInput.error).not.toBe(trusted.input.error);

    mutableInput.toolId = "mutated-bash";
    mutableInput.rule = "workspace-quota";
    mutableInput.decision = "allowed";
    mutableInput.profileId = "mutated-profile";
    mutableInput.error.error_id = "mutated-error";
    mutableInput.error.message = "Mutated message.";
    mutableInput.error.evidence_refs.push("mutated-ref");
    if (mutableInput.error.remediation) {
      mutableInput.error.remediation.hint = "mutated hint";
    }

    const event = buildRawDataAdvisoryToolFailedWsEvent({
      seq: 16,
      eventId: "evt-16",
      timestamp: "2026-07-04T00:00:00.000Z",
      toolResult: trusted.toolResult
    });

    expect(event.payload).toMatchObject({
      tool_id: originalInput.toolId,
      rule: originalInput.rule,
      decision: originalInput.decision,
      guard_class: originalInput.guardClass,
      profile_id: originalInput.profileId,
      invocation_id: originalInput.invocationId
    });
    expect(event.payload.error).toEqual(originalInput.error);
    expect(event.payload.error).not.toBe(helperInput.error);

    mutableInput.error.user_message = "Mutated after emit.";
    expect(event.payload.error.user_message).toBe(originalInput.error.user_message);
  });

  test("raw-data advisory builder rejects caller-authored structural payloads", async () => {
    const advisory = await sampleRawDataAdvisoryDenialPayload();

    expect(() =>
      buildRawDataAdvisoryToolFailedWsEvent({
        seq: 8,
        timestamp: "2026-07-04T00:00:00.000Z",
        ...rawDataDenialPayloadToToolFailedEventInput(advisory)
      } as never)
    ).toThrow("Raw-data advisory tool.failed events require RawDataSandboxedBashTool trusted evidence");
  });

  test("raw-data advisory builder rejects cloned trusted inputs and result-shaped clones", async () => {
    const trusted = await sampleTrustedRawDataAdvisoryToolFailedEvent();
    const spreadInput = { ...trusted.input };
    const assignedInput = Object.assign({}, trusted.input);
    const spreadResult = { ...trusted.toolResult };
    const assignedResult = Object.assign({}, trusted.toolResult);

    expect(() =>
      buildRawDataAdvisoryToolFailedWsEvent({
        seq: 12,
        timestamp: "2026-07-04T00:00:00.000Z",
        ...spreadInput
      } as never)
    ).toThrow("Raw-data advisory tool.failed events require RawDataSandboxedBashTool trusted evidence");

    expect(() =>
      buildRawDataAdvisoryToolFailedWsEvent(
        Object.assign(
          {
            seq: 13,
            timestamp: "2026-07-04T00:00:00.000Z"
          },
          assignedInput
        ) as never
      )
    ).toThrow("Raw-data advisory tool.failed events require RawDataSandboxedBashTool trusted evidence");

    expect(() =>
      buildRawDataAdvisoryToolFailedWsEvent({
        seq: 14,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolResult: spreadResult
      } as never)
    ).toThrow("Raw-data advisory tool.failed events require RawDataSandboxedBashTool trusted evidence");

    expect(() =>
      buildRawDataAdvisoryToolFailedWsEvent({
        seq: 15,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolResult: assignedResult
      } as never)
    ).toThrow("Raw-data advisory tool.failed events require RawDataSandboxedBashTool trusted evidence");
  });

  test("generic tool.failed builder rejects raw-data denial-shaped events", async () => {
    const advisory = await sampleRawDataAdvisoryDenialPayload();
    expect(() =>
      buildToolFailedWsEvent({
        seq: 8,
        timestamp: "2026-07-04T00:00:00.000Z",
        ...rawDataDenialPayloadToToolFailedEventInput(advisory)
      })
    ).toThrow("Raw-data denial tool.failed events require");

    const payload = await sampleReservedRawDataSandboxDenialPayload();
    expect(() =>
      buildToolFailedWsEvent({
        seq: 9,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: payload.tool_id,
        rule: payload.rule,
        decision: payload.decision,
        guardClass: payload.guard_class,
        profileId: payload.profile_id,
        invocationId: payload.invocation_id,
        error: payload.error_record
      })
    ).toThrow("Raw-data denial tool.failed events require");
  });

  test("generic tool.failed builder rejects reserved decisions without raw rule authority", () => {
    const remediation = rawDataWriteRemediation();
    const error: ErrorRecord = {
      error_id: "workspace-quota:generic-denial",
      category: "permission_error",
      severity: "error",
      message: "Workspace quota denied.",
      user_message: "Workspace quota denied.",
      evidence_refs: [],
      retryable: false,
      recommended_next_actions: [remediation.hint],
      remediation,
      created_at: "2026-07-04T00:00:00.000Z"
    };

    expect(() =>
      buildToolFailedWsEvent({
        seq: 17,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: "workspace-quota",
        decision: "denied_by_sandbox",
        error
      })
    ).toThrow("Raw-data denial tool.failed events require");

    expect(() =>
      buildToolFailedWsEvent({
        seq: 18,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        decision: "denied_by_sandbox",
        error
      })
    ).toThrow("Raw-data denial tool.failed events require");
  });

  test("generic tool.failed builder rejects raw lifecycle rule without authority guard", () => {
    expect(() =>
      buildToolFailedWsEvent({
        seq: 10,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: RAW_DATA_WRITE_RULE_ID,
        decision: "failed",
        error: sampleRawLifecycleError()
      })
    ).toThrow("Raw-data authority tool.failed events require guardClass authority");
  });

  test("generic tool.failed builder rejects raw lifecycle rule downgraded to capability", () => {
    expect(() =>
      buildToolFailedWsEvent({
        seq: 10,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: RAW_DATA_WRITE_RULE_ID,
        decision: "failed",
        guardClass: "capability",
        error: sampleRawLifecycleError()
      })
    ).toThrow("Raw-data authority tool.failed events require guardClass authority");
  });

  test("generic tool.failed builder rejects raw lifecycle error_id without authority guard", () => {
    expect(() =>
      buildToolFailedWsEvent({
        seq: 10,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: "workspace-quota",
        decision: "failed",
        error: sampleRawLifecycleError()
      })
    ).toThrow("Raw-data authority tool.failed events require guardClass authority");
  });

  test("generic tool.failed builder rejects raw lifecycle error_id downgraded to capability", () => {
    expect(() =>
      buildToolFailedWsEvent({
        seq: 10,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: "workspace-quota",
        decision: "failed",
        guardClass: "capability",
        error: sampleRawLifecycleError()
      })
    ).toThrow("Raw-data authority tool.failed events require guardClass authority");
  });

  test("generic tool.failed builder rejects raw lifecycle failures with authority guard", () => {
    expect(() =>
      buildToolFailedWsEvent({
        seq: 10,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: RAW_DATA_WRITE_RULE_ID,
        decision: "failed",
        guardClass: "authority",
        error: sampleRawLifecycleError()
      })
    ).toThrow("Raw-data authority tool.failed events require trusted producer evidence");
  });

  test("generic tool.failed builder rejects invalid guardClass on non-raw rules", () => {
    expect(() =>
      buildToolFailedWsEvent({
        seq: 20,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: "workspace-quota",
        decision: "failed",
        guardClass: "temporary" as never,
        error: sampleGenericToolFailedError("workspace-quota:failed:invalid-guard")
      })
    ).toThrow("tool.failed guardClass must be authority or capability");
  });

  test("generic tool.failed builder rejects spawn-profile-subset without guardClass", () => {
    expect(() =>
      buildToolFailedWsEvent({
        seq: 21,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: SPAWN_PROFILE_SUBSET_RULE_ID,
        decision: "failed",
        error: sampleGenericToolFailedError("spawn-profile-subset:failed:missing-guard")
      })
    ).toThrow("Reserved authority policy rule tool.failed events require guardClass authority");
  });

  test("generic tool.failed builder rejects spawn-profile-subset downgraded to capability", () => {
    expect(() =>
      buildToolFailedWsEvent({
        seq: 22,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: SPAWN_PROFILE_SUBSET_RULE_ID,
        decision: "failed",
        guardClass: "capability",
        error: sampleGenericToolFailedError("spawn-profile-subset:failed:capability-guard")
      })
    ).toThrow("Reserved authority policy rule tool.failed events require guardClass authority");
  });

  test("generic tool.failed builder rejects tool-parameter-schema-validation without guardClass", () => {
    expect(() =>
      buildToolFailedWsEvent({
        seq: 23,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: TOOL_PARAMETER_SCHEMA_RULE_ID,
        decision: "failed",
        error: sampleGenericToolFailedError(
          "tool-parameter-schema-validation:failed:missing-guard"
        )
      })
    ).toThrow("Reserved authority policy rule tool.failed events require guardClass authority");
  });

  test("generic tool.failed builder rejects tool-parameter-schema-validation downgraded to capability", () => {
    expect(() =>
      buildToolFailedWsEvent({
        seq: 24,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: TOOL_PARAMETER_SCHEMA_RULE_ID,
        decision: "failed",
        guardClass: "capability",
        error: sampleGenericToolFailedError(
          "tool-parameter-schema-validation:failed:capability-guard"
        )
      })
    ).toThrow("Reserved authority policy rule tool.failed events require guardClass authority");
  });

  test("generic tool.failed builder rejects reserved non-raw error_id prefixes without authority guard", () => {
    const cases = [
      {
        seq: 30,
        ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
        guardClass: undefined
      },
      {
        seq: 31,
        ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
        guardClass: "capability" as const
      },
      {
        seq: 32,
        ruleId: TOOL_PARAMETER_SCHEMA_RULE_ID,
        guardClass: undefined
      },
      {
        seq: 33,
        ruleId: TOOL_PARAMETER_SCHEMA_RULE_ID,
        guardClass: "capability" as const
      }
    ];

    for (const testCase of cases) {
      expect(() =>
        buildToolFailedWsEvent({
          seq: testCase.seq,
          timestamp: "2026-07-04T00:00:00.000Z",
          toolId: "bash",
          decision: "failed",
          ...(testCase.guardClass ? { guardClass: testCase.guardClass } : {}),
          error: sampleGenericToolFailedError(`${testCase.ruleId}:failed:error-id-only`)
        })
      ).toThrow("Reserved authority policy rule tool.failed events require guardClass authority");
    }
  });

  test("generic tool.failed builder rejects reserved non-raw error_id prefixes with authority guard", () => {
    for (const [index, ruleId] of [
      SPAWN_PROFILE_SUBSET_RULE_ID,
      TOOL_PARAMETER_SCHEMA_RULE_ID
    ].entries()) {
      expect(() =>
        buildToolFailedWsEvent({
          seq: 34 + index,
          timestamp: "2026-07-04T00:00:00.000Z",
          toolId: "bash",
          decision: "failed",
          guardClass: "authority",
          error: sampleGenericToolFailedError(`${ruleId}:failed:error-id-only-authority`)
        })
      ).toThrow("Reserved authority policy tool.failed events require trusted producer evidence");
    }
  });

  test("generic tool.failed builder rejects reserved non-raw authority rules with authority guard", () => {
    for (const [index, rule] of [
      SPAWN_PROFILE_SUBSET_RULE_ID,
      TOOL_PARAMETER_SCHEMA_RULE_ID
    ].entries()) {
      expect(() =>
        buildToolFailedWsEvent({
          seq: 25 + index,
          timestamp: "2026-07-04T00:00:00.000Z",
          toolId: "bash",
          rule,
          decision: "failed",
          guardClass: "authority",
          error: sampleGenericToolFailedError(`${rule}:failed:authority-guard`)
        })
      ).toThrow("Reserved authority policy tool.failed events require trusted producer evidence");
    }
  });

  test("generic tool.failed builder rejects reserved rule prefix impersonation", () => {
    for (const [index, rule] of [
      RAW_DATA_WRITE_RULE_ID,
      SPAWN_PROFILE_SUBSET_RULE_ID,
      TOOL_PARAMETER_SCHEMA_RULE_ID
    ].entries()) {
      expect(() =>
        buildToolFailedWsEvent({
          seq: 60 + index,
          timestamp: "2026-07-04T00:00:00.000Z",
          toolId: "bash",
          rule: `${rule}:failed:caller-minted`,
          decision: "failed",
          guardClass: "authority",
          error: sampleGenericToolFailedError(`workspace-quota:failed:rule-prefix-${index}`)
        })
      ).toThrow("Reserved authority policy rule prefixes are reserved for error_id");
    }
  });

  test("generic tool.failed builder rejects exact reserved rules with authority guard", () => {
    for (const [index, rule] of [
      RAW_DATA_WRITE_RULE_ID,
      SPAWN_PROFILE_SUBSET_RULE_ID,
      TOOL_PARAMETER_SCHEMA_RULE_ID
    ].entries()) {
      const expected =
        rule === RAW_DATA_WRITE_RULE_ID
          ? "Raw-data authority tool.failed events require trusted producer evidence"
          : "Reserved authority policy tool.failed events require trusted producer evidence";
      expect(() =>
        buildToolFailedWsEvent({
          seq: 70 + index,
          timestamp: "2026-07-04T00:00:00.000Z",
          toolId: "bash",
          rule,
          decision: "failed",
          guardClass: "authority",
          error: sampleGenericToolFailedError(`workspace-quota:failed:exact-rule-${index}`)
        })
      ).toThrow(expected);
    }
  });

  test("generic tool.failed builder rejects caller-minted reserved error_id prefixes with authority guard", () => {
    for (const [index, rule] of [
      RAW_DATA_WRITE_RULE_ID,
      SPAWN_PROFILE_SUBSET_RULE_ID,
      TOOL_PARAMETER_SCHEMA_RULE_ID
    ].entries()) {
      const expected =
        rule === RAW_DATA_WRITE_RULE_ID
          ? "Raw-data authority tool.failed events require trusted producer evidence"
          : "Reserved authority policy tool.failed events require trusted producer evidence";
      expect(() =>
        buildToolFailedWsEvent({
          seq: 80 + index,
          timestamp: "2026-07-04T00:00:00.000Z",
          toolId: "bash",
          decision: "failed",
          guardClass: "authority",
          error: sampleGenericToolFailedError(`${rule}:failed:error-id-authority`)
        })
      ).toThrow(expected);
    }
  });

  test("generic tool.failed builder accepts non-reserved generic failures without guardClass", () => {
    const event = buildToolFailedWsEvent({
      seq: 27,
      timestamp: "2026-07-04T00:00:00.000Z",
      toolId: "bash",
      rule: "workspace-quota",
      decision: "failed",
      error: sampleGenericToolFailedError("workspace-quota:failed:no-guard")
    });

    expect(event.payload).toMatchObject({
      tool_id: "bash",
      rule: "workspace-quota",
      decision: "failed"
    });
    expect(event.payload.guard_class).toBeUndefined();
  });

  test("generic tool.failed builder accepts non-reserved error_id without guardClass", () => {
    const event = buildToolFailedWsEvent({
      seq: 37,
      timestamp: "2026-07-04T00:00:00.000Z",
      toolId: "bash",
      decision: "failed",
      error: sampleGenericToolFailedError("workspace-quota:failed:error-id-only")
    });

    expect(event.payload).toMatchObject({
      tool_id: "bash",
      decision: "failed"
    });
    expect(event.payload.rule).toBeUndefined();
    expect(event.payload.guard_class).toBeUndefined();
  });

  test("generic tool.failed builder accepts non-reserved generic failures with legal guardClass", () => {
    for (const guardClass of ["capability", "authority"] as const) {
      const event = buildToolFailedWsEvent({
        seq: guardClass === "capability" ? 28 : 29,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: "workspace-quota",
        decision: "failed",
        guardClass,
        error: sampleGenericToolFailedError(`workspace-quota:failed:${guardClass}-guard`)
      });

      expect(event.payload).toMatchObject({
        tool_id: "bash",
        rule: "workspace-quota",
        decision: "failed",
        guard_class: guardClass
      });
    }
  });

  test("generic tool.failed builder rejects top-level identity accessors", () => {
    const reads = {
      rule: 0,
      decision: 0,
      guardClass: 0
    };
    expect(() =>
      buildToolFailedWsEvent({
        seq: 90,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        get rule() {
          reads.rule += 1;
          return "workspace-quota";
        },
        get decision() {
          reads.decision += 1;
          return "failed";
        },
        get guardClass() {
          reads.guardClass += 1;
          return "authority";
        },
        error: sampleGenericToolFailedError("workspace-quota:failed:getter-top")
      })
    ).toThrow("tool.failed rule must be a data field");

    expect(reads).toEqual({
      rule: 0,
      decision: 0,
      guardClass: 0
    });
  });

  test("generic tool.failed builder rejects nested error_id accessors", () => {
    const benignErrorId = "workspace-quota:failed:getter-error";
    const reservedErrorId = `${RAW_DATA_WRITE_RULE_ID}:denied_by_sandbox:reserved-profile:TOOL-CALL-WS-GETTER`;
    let errorIdReads = 0;
    const error = {
      get error_id() {
        errorIdReads += 1;
        return errorIdReads === 1 ? benignErrorId : reservedErrorId;
      },
      category: "workspace_error",
      severity: "error",
      message: "Workspace quota check failed.",
      user_message: "Workspace quota check failed.",
      evidence_refs: [],
      retryable: true,
      recommended_next_actions: ["retry after cleanup"],
      created_at: "2026-07-04T00:00:00.000Z"
    } as ErrorRecord;

    expect(() =>
      buildToolFailedWsEvent({
        seq: 91,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: "workspace-quota",
        decision: "failed",
        guardClass: "authority",
        error
      })
    ).toThrow("tool.failed error.error_id must be a data field");

    expect(errorIdReads).toBe(0);
  });

  test("generic tool.failed builder snapshots mutable error payloads", () => {
    const remediation = {
      next_action: "fix_and_retry" as const,
      hint: "Repair workspace state.",
      ref: "docs/03_SPEC/WebSocket_Protocol.md"
    };
    const error: ErrorRecord = {
      error_id: "workspace-quota:failed:lifecycle",
      category: "workspace_error",
      severity: "error",
      message: "Workspace quota check failed.",
      user_message: "Workspace quota check failed.",
      evidence_refs: ["evidence:before"],
      retryable: true,
      recommended_next_actions: ["retry after cleanup"],
      remediation,
      created_at: "2026-07-04T00:00:00.000Z"
    };
    const expectedError = cloneErrorRecordForTest(error);

    const event = buildToolFailedWsEvent({
      seq: 19,
      timestamp: "2026-07-04T00:00:00.000Z",
      toolId: "bash",
      rule: "workspace-quota",
      decision: "failed",
      error
    });

    error.error_id = "mutated-error";
    error.message = "Mutated message.";
    error.user_message = "Mutated user message.";
    error.evidence_refs.push("evidence:after");
    error.recommended_next_actions.push("mutated action");
    remediation.hint = "Mutated remediation.";

    expect(event.payload.error).toEqual(expectedError);
    expect(event.payload.error).not.toBe(error);
    expect(event.payload.error.evidence_refs).toEqual(["evidence:before"]);
    expect(event.payload.error.recommended_next_actions).toEqual(["retry after cleanup"]);
    expect(event.payload.error.remediation?.hint).toBe("Repair workspace state.");
  });

  test("generic tool.failed builder rejects toJSON identity forgery", () => {
    expect(() =>
      buildToolFailedWsEvent({
        seq: 92,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: {
          toJSON: () => SPAWN_PROFILE_SUBSET_RULE_ID
        } as never,
        decision: "failed",
        error: sampleGenericToolFailedError("workspace-quota:failed:rule-to-json")
      })
    ).toThrow("tool.failed rule must be a string");

    expect(() =>
      buildToolFailedWsEvent({
        seq: 93,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: "workspace-quota",
        decision: {
          toJSON: () => "denied_by_sandbox"
        } as never,
        error: sampleGenericToolFailedError("workspace-quota:failed:decision-to-json")
      })
    ).toThrow("tool.failed decision must be a string");

    expect(() =>
      buildToolFailedWsEvent({
        seq: 94,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: "workspace-quota",
        decision: "failed",
        error: {
          ...sampleGenericToolFailedError("workspace-quota:failed:error-id-to-json"),
          error_id: {
            startsWith: () => false,
            toJSON: () => `${RAW_DATA_WRITE_RULE_ID}:denied_by_sandbox:profile:call`
          }
        } as never
      })
    ).toThrow("tool.failed error.error_id must be a string");
  });

  test("generic tool.failed builder rejects reserved error IDs before cloning arrays", () => {
    const error = sampleGenericToolFailedError(
      `${RAW_DATA_WRITE_RULE_ID}:denied_by_sandbox:reserved-profile:TOOL-CALL-WS-2`
    );
    let evidenceRefsReads = 0;
    Object.defineProperty(error, "evidence_refs", {
      enumerable: true,
      get() {
        evidenceRefsReads += 1;
        throw new Error("evidence_refs trap secret");
      }
    });

    expect(() =>
      buildToolFailedWsEvent({
        seq: 95,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: "workspace-quota",
        decision: "failed",
        error
      })
    ).toThrow("Reserved raw-data denial error_id values require");
    expect(evidenceRefsReads).toBe(0);
  });

  test("generic tool.failed builder rejects reserved raw-denial error IDs", () => {
    const remediation = rawDataWriteRemediation();

    expect(() =>
      buildToolFailedWsEvent({
        seq: 11,
        timestamp: "2026-07-04T00:00:00.000Z",
        toolId: "bash",
        rule: RAW_DATA_WRITE_RULE_ID,
        decision: "failed",
        error: {
          error_id: `${RAW_DATA_WRITE_RULE_ID}:denied_by_sandbox:reserved-profile:TOOL-CALL-WS-1`,
          category: "sandbox_error",
          severity: "error",
          message: "Bash command failed.",
          user_message: "Bash command failed.",
          evidence_refs: [],
          retryable: false,
          recommended_next_actions: [remediation.hint],
          remediation,
          created_at: "2026-07-04T00:00:00.000Z"
        }
      })
    ).toThrow("Reserved raw-data denial error_id values require");
  });
});

async function sampleTrustedRawDataAdvisoryToolFailedEvent(): Promise<{
  toolResult: RawDataAdvisoryToolFailedWsEventInput["toolResult"];
  input: RawDataToolFailedEventInput;
}> {
  const root = await mkdtemp(join(tmpdir(), "shud-ws-raw-denial-"));
  try {
    const rawRoot = join(root, "data", "raw");
    const workspaceRoot = join(root, "workspace");
    const tempRoot = join(workspaceRoot, "tmp");
    const profileRoot = join(workspaceRoot, "profiles");
    await mkdir(rawRoot, { recursive: true });
    await mkdir(tempRoot, { recursive: true });
    await mkdir(profileRoot, { recursive: true });

    const tool = new RawDataSandboxedBashTool({
      protectedRawPaths: [rawRoot],
      allowedWriteRoots: [root],
      tempRoot,
      profileRoot,
      fuseRules: []
    });
    const result = await tool.run(
      {
        sessionId: "TEST-SESSION",
        currentToolUseId: "TOOL-CALL-WS-1",
        workDir: root,
        logger: testLogger
      },
      {
        command: "printf nope > data/raw/ws-advisory.txt",
        timeout: 30_000
      }
    );

    expect(result.success).toBe(false);
    const input = rawDataDeniedToolResultToToolFailedEventInput(result);
    if (!input) {
      throw new Error("Expected trusted raw-data advisory tool.failed input.");
    }
    return { toolResult: result, input };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function sampleRawDataAdvisoryDenialPayload(): Promise<
  RawDataDenialPayload & { decision: "denied_by_advisory" }
> {
  const root = await mkdtemp(join(tmpdir(), "shud-ws-raw-denial-"));
  try {
    const rawRoot = join(root, "data", "raw");
    const workspaceRoot = join(root, "workspace");
    const tempRoot = join(workspaceRoot, "tmp");
    await mkdir(rawRoot, { recursive: true });
    await mkdir(tempRoot, { recursive: true });
    const profile = await buildRawDataSeatbeltProfile({
      protectedRawPaths: [rawRoot],
      allowedWriteRoots: [root],
      tempRoot
    });

    return buildRawDataDeniedPayload({
      toolId: "bash",
      reason: "obvious static raw-data write target",
      profile,
      profilePath: join(tempRoot, "profile.sb"),
      invocationId: "TOOL-CALL-WS-1",
      ts: "2026-07-04T00:00:00.000Z"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const testLogger = {
  info(_event: string, _data?: Record<string, unknown>): void {},
  warn(_event: string, _data?: Record<string, unknown>): void {},
  error(_event: string, _data?: Record<string, unknown>): void {}
};

function cloneRawDataToolFailedEventInput(
  input: RawDataToolFailedEventInput
): RawDataToolFailedEventInput {
  return {
    ...input,
    error: {
      ...input.error,
      evidence_refs: [...input.error.evidence_refs],
      recommended_next_actions: [...input.error.recommended_next_actions],
      ...(input.error.remediation ? { remediation: { ...input.error.remediation } } : {})
    }
  };
}

function cloneErrorRecordForTest(error: ErrorRecord): ErrorRecord {
  return {
    ...error,
    evidence_refs: [...error.evidence_refs],
    recommended_next_actions: [...error.recommended_next_actions],
    ...(error.remediation ? { remediation: { ...error.remediation } } : {})
  };
}

function sampleRawLifecycleError(): ErrorRecord {
  const remediation = rawDataWriteRemediation();
  return {
    error_id: `${RAW_DATA_WRITE_RULE_ID}:failed:lifecycle`,
    category: "sandbox_error",
    severity: "error",
    message: "Bash command failed.",
    user_message: "Bash command failed.",
    evidence_refs: [],
    retryable: false,
    recommended_next_actions: [remediation.hint],
    remediation,
    created_at: "2026-07-04T00:00:00.000Z"
  };
}

function sampleGenericToolFailedError(errorId: string): ErrorRecord {
  return {
    error_id: errorId,
    category: "workspace_error",
    severity: "error",
    message: "Workspace quota check failed.",
    user_message: "Workspace quota check failed.",
    evidence_refs: [],
    retryable: true,
    recommended_next_actions: ["retry after cleanup"],
    created_at: "2026-07-04T00:00:00.000Z"
  };
}

async function sampleReservedRawDataSandboxDenialPayload(): Promise<RawDataDenialPayload> {
  const root = await mkdtemp(join(tmpdir(), "shud-ws-raw-denial-"));
  try {
    const rawRoot = join(root, "data", "raw");
    const workspaceRoot = join(root, "workspace");
    const tempRoot = join(workspaceRoot, "tmp");
    await mkdir(rawRoot, { recursive: true });
    await mkdir(tempRoot, { recursive: true });
    const profile = await buildRawDataSeatbeltProfile({
      protectedRawPaths: [rawRoot],
      allowedWriteRoots: [root],
      tempRoot
    });
    const remediation = rawDataWriteRemediation();
    return {
      error: "raw_data_write_denied",
      tool_id: "bash",
      rule: RAW_DATA_WRITE_RULE_ID,
      decision: "denied_by_sandbox",
      guard_class: "authority",
      reason: "trusted OS sandbox source reserved a raw-data write denial",
      remediation,
      profile_id: profile.profileId,
      profile_path: join(tempRoot, "profile.sb"),
      invocation_id: "TOOL-CALL-WS-1",
      error_record: {
        error_id: `${RAW_DATA_WRITE_RULE_ID}:denied_by_sandbox:${profile.profileId}:TOOL-CALL-WS-1`,
        category: "sandbox_error",
        severity: "error",
        message: "Raw data write denied by a trusted OS sandbox event source.",
        user_message: "data/raw is protected evidence input and cannot be mutated by bash.",
        evidence_refs: ["openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md"],
        retryable: false,
        recommended_next_actions: [remediation.hint],
        remediation,
        created_at: "2026-07-04T00:00:00.000Z"
      }
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
