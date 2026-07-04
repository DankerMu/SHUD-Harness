import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { BaseTool } from "@zero-os/core";
import type { ToolContext, ToolLogger, ToolResult } from "@zero-os/shared";
import {
  appendPolicyGateAuditRow,
  buildPolicyGateAuditRowFromDeniedDecision,
  buildPolicyGateDeniedToolPayload,
  createPolicyGatedToolRegistry,
  DATA_RAW_WRITE_DENY_RULE_ID,
  DATA_RAW_WRITE_GUARD_CLASS,
  DATA_RAW_WRITE_RULE_REF,
  evaluatePolicyGate,
  makeDataRawPolicyGateContext,
  type PolicyGateDecision
} from "@shud-harness/core";
import { buildPolicyGateToolFailedEvent, TOOL_FAILED_EVENT_TYPE } from "./policy-gate-events";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

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

  test("links wrapped tool denial, WebSocket payload, and audit row from one policy decision", async () => {
    let capturedDecision: Extract<PolicyGateDecision, { decision: "deny" }> | undefined;
    const bashTool = new RecordingTool("bash");
    const registry = createPolicyGatedToolRegistry([bashTool], {
      evaluate: (call) => {
        const decision = evaluatePolicyGate(call, makeDataRawPolicyGateContext());
        if (decision.decision === "deny") {
          capturedDecision = decision;
        }
        return decision;
      }
    });

    const result = await registry.get("bash")?.run(createToolContext("worker"), {
      command: "bash -c 'printf x > data/raw/input.csv'"
    });

    expect(result?.success).toBe(false);
    expect(bashTool.calls).toBe(0);
    expect(capturedDecision).toBeDefined();
    if (!capturedDecision) {
      throw new Error("expected captured policy denial");
    }

    const toolPayload = JSON.parse(result?.output ?? "{}") as {
      tool_id?: string;
      rule_id?: string;
      guard_class?: string;
      remediation?: {
        ref?: string;
      };
    };
    expect(toolPayload).toEqual(buildPolicyGateDeniedToolPayload("bash", capturedDecision));

    const event = buildPolicyGateToolFailedEvent({
      seq: 43,
      event_id: "EVT-ISSUE-19-LINKED",
      session_id: "SESSION-ISSUE-19",
      task_id: "TASK-M1-SPIKE",
      workspace_id: "WORKSPACE-LOCAL",
      timestamp: "2026-07-03T00:00:00.000Z",
      tool_id: "bash",
      decision: capturedDecision,
      error_id: "ERR-ISSUE-19-LINKED"
    });

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "shud-policy-ws-audit-"));
    tempDirs.push(workspaceRoot);
    const auditResult = await appendPolicyGateAuditRow(
      buildPolicyGateAuditRowFromDeniedDecision({
        toolId: "bash",
        decision: capturedDecision
      }),
      {
        workspaceRoot,
        now: () => "2026-07-03T00:00:00.000Z"
      }
    );
    const [auditRow] = (await readFile(auditResult.auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(toolPayload.tool_id).toBe(event.payload.tool_id);
    expect(auditRow.tool_id).toBe(toolPayload.tool_id);
    expect(toolPayload.rule_id).toBe(event.payload.rule_id);
    expect(auditRow.rule).toBe(toolPayload.rule_id);
    expect(toolPayload.guard_class).toBe(event.payload.guard_class);
    expect(auditRow.guard_class).toBe(toolPayload.guard_class);
    expect(toolPayload.remediation?.ref).toBe(event.payload.error.remediation?.ref);
    expect(auditRow.remediation_ref).toBe(toolPayload.remediation?.ref);
  });
});

class RecordingTool extends BaseTool {
  description: string;
  parameters: Record<string, unknown> = {
    type: "object",
    additionalProperties: true
  };
  calls = 0;

  constructor(readonly name: string) {
    super();
    this.description = `Test tool ${name}`;
  }

  protected async execute(): Promise<ToolResult> {
    this.calls += 1;
    return {
      success: true,
      output: `${this.name} executed`,
      outputSummary: `${this.name} executed`
    };
  }
}

function createToolContext(role: string): ToolContext & { role: string } {
  return {
    role,
    sessionId: "TEST-SESSION",
    workDir: "/tmp/shud-harness-test",
    logger: testLogger
  };
}

const testLogger: ToolLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};
