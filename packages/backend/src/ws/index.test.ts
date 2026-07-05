import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRawDataDeniedPayload,
  buildRawDataSeatbeltProfile,
  rawDataDenialPayloadToToolFailedEventInput,
  rawDataWriteRemediation,
  RAW_DATA_WRITE_RULE_ID,
  type RawDataDenialPayload
} from "@shud-harness/core";
import { buildToolFailedWsEvent } from "./index";

describe("backend ws tool.failed skeleton", () => {
  test("builds tool.failed from actual raw-data advisory denial payload", async () => {
    const payload = await sampleRawDataAdvisoryDenialPayload();
    const event = buildToolFailedWsEvent({
      seq: 7,
      eventId: "evt-7",
      timestamp: "2026-07-04T00:00:00.000Z",
      ...rawDataDenialPayloadToToolFailedEventInput(payload)
    });

    expect(event).toEqual({
      seq: 7,
      event_id: "evt-7",
      type: "tool.failed",
      timestamp: "2026-07-04T00:00:00.000Z",
      payload: {
        tool_id: payload.tool_id,
        rule: payload.rule,
        decision: payload.decision,
        guard_class: payload.guard_class,
        profile_id: payload.profile_id,
        invocation_id: payload.invocation_id,
        error: payload.error_record
      }
    });
    expect(event.type).toBe("tool.failed");
    expect(event.payload.error.error_id).toBe(payload.error_record.error_id);
    expect(event.payload.error.remediation?.next_action).toBe("adjust_scope");
    expect(event.payload.error.remediation?.hint).toContain("data/raw");
    expect(event.payload.error.remediation?.ref).toContain("policy-gate-spike");
  });

  test("builds tool.failed from reserved trusted raw-data sandbox denial payload shape", async () => {
    // Shape coverage only; this fixture does not use public core builders to mint reserved authority.
    const payload = await sampleReservedRawDataSandboxDenialPayload();
    const event = buildToolFailedWsEvent({
      seq: 8,
      timestamp: "2026-07-04T00:00:00.000Z",
      toolId: payload.tool_id,
      rule: payload.rule,
      decision: payload.decision,
      guardClass: payload.guard_class,
      profileId: payload.profile_id,
      invocationId: payload.invocation_id,
      error: payload.error_record
    });

    expect(event.event_id).toBe("tool.failed:8");
    expect(event.type).toBe("tool.failed");
    expect(event.timestamp).toBe("2026-07-04T00:00:00.000Z");
    expect(event.payload).toMatchObject({
      tool_id: payload.tool_id,
      rule: payload.rule,
      decision: "denied_by_sandbox",
      guard_class: "authority",
      profile_id: payload.profile_id,
      invocation_id: payload.invocation_id
    });
    expect(event.payload.error).toBe(payload.error_record);
    expect(event.payload.error.error_id).toContain("denied_by_sandbox");
    expect(event.payload.error.remediation?.next_action).toBe("adjust_scope");
    expect(event.payload.error.remediation?.hint).toContain("data/raw");
    expect(event.payload.error.remediation?.ref).toContain("policy-gate-spike");
  });
});

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
