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

  test("generic tool.failed builder still accepts raw lifecycle failures", () => {
    const remediation = rawDataWriteRemediation();
    const event = buildToolFailedWsEvent({
      seq: 10,
      timestamp: "2026-07-04T00:00:00.000Z",
      toolId: "bash",
      rule: RAW_DATA_WRITE_RULE_ID,
      decision: "failed",
      error: {
        error_id: "raw-data-write:failed:lifecycle",
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
    });

    expect(event.payload).toMatchObject({
      tool_id: "bash",
      rule: RAW_DATA_WRITE_RULE_ID,
      decision: "failed"
    });
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
