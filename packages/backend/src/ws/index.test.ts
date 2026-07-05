import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRawDataDeniedPayload,
  buildRawDataSeatbeltProfile,
  rawDataDenialPayloadToToolFailedEventInput,
  type RawDataDenialPayload
} from "@shud-harness/core";
import { buildToolFailedWsEvent } from "./index";

describe("backend ws tool.failed skeleton", () => {
  test("builds tool.failed from actual raw-data advisory denial payload", async () => {
    const payload = await sampleRawDataDenialPayload("denied_by_advisory");
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
    // Shape coverage only; M1 post-exec process output does not produce this reserved decision.
    const payload = await sampleRawDataDenialPayload("denied_by_sandbox");
    const event = buildToolFailedWsEvent({
      seq: 8,
      timestamp: "2026-07-04T00:00:00.000Z",
      ...rawDataDenialPayloadToToolFailedEventInput(payload)
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

async function sampleRawDataDenialPayload(
  decision: RawDataDenialPayload["decision"]
): Promise<RawDataDenialPayload> {
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
      decision,
      reason:
        decision === "denied_by_sandbox"
          ? "trusted OS sandbox source reserved a raw-data write denial"
          : "obvious static raw-data write target",
      profile,
      profilePath: join(tempRoot, "profile.sb"),
      invocationId: "TOOL-CALL-WS-1",
      ts: "2026-07-04T00:00:00.000Z"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
