import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { BaseTool } from "@zero-os/core";
import type { ToolContext, ToolLogger, ToolResult } from "@zero-os/shared";
import {
  createPolicyGateEvaluator,
  createPolicyGatedToolRegistry
} from "./policy-gate-registry";
import { appendPolicyGateAuditRow } from "./policy-gate-audit";
import {
  DATA_RAW_WRITE_DENY_RULE,
  DATA_RAW_WRITE_DENY_RULE_ID,
  DATA_RAW_WRITE_GUARD_CLASS,
  makeDataRawPolicyGateContext
} from "./data-raw-write-rule";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("data/raw write deny policy", () => {
  test("denies wrapped bash writes before the command implementation executes", async () => {
    const bashTool = new RecordingTool("bash");
    const registry = createPolicyGatedToolRegistry([bashTool], {
      evaluate: createPolicyGateEvaluator(makeDataRawPolicyGateContext())
    });

    const result = await registry.get("bash")?.run(createToolContext("worker"), {
      command: "printf x > data/raw/input.csv"
    });

    expect(result?.success).toBe(false);
    expect(bashTool.calls).toBe(0);

    const payload = JSON.parse(result?.output ?? "{}") as {
      rule_id?: string;
      guard_class?: string;
      remediation?: {
        next_action?: string;
        hint?: string;
        ref?: string;
      };
    };
    expect(payload.rule_id).toBe(DATA_RAW_WRITE_DENY_RULE_ID);
    expect(payload.guard_class).toBe(DATA_RAW_WRITE_GUARD_CLASS);
    expect(payload.remediation?.next_action).toBeTruthy();
    expect(payload.remediation?.hint).toBeTruthy();
    expect(payload.remediation?.ref).toBeTruthy();
  });

  test("read-only data/raw bash commands still execute through the wrapper", async () => {
    const bashTool = new RecordingTool("bash");
    const registry = createPolicyGatedToolRegistry([bashTool], {
      evaluate: createPolicyGateEvaluator(makeDataRawPolicyGateContext())
    });

    const result = await registry.get("bash")?.run(createToolContext("worker"), {
      command: "cat data/raw/input.csv"
    });

    expect(result?.success).toBe(true);
    expect(result?.output).toBe("bash executed");
    expect(bashTool.calls).toBe(1);
  });

  test("audit helper appends a minimal row under the no-TaskCard fixture path", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "shud-policy-audit-"));
    tempDirs.push(workspaceRoot);

    const result = await appendPolicyGateAuditRow(
      {
        event: "tool.failed",
        tool_id: "bash",
        rule: DATA_RAW_WRITE_DENY_RULE_ID,
        decision: "deny",
        guard_class: DATA_RAW_WRITE_GUARD_CLASS
      },
      {
        workspaceRoot,
        now: () => "2026-07-03T00:00:00.000Z"
      }
    );

    expect(path.relative(workspaceRoot, result.auditDir)).toBe(
      "workspace/tasks/TASK-M1-SPIKE/audit"
    );

    const rows = (await readFile(result.auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "tool.failed",
      tool_id: "bash",
      rule: DATA_RAW_WRITE_DENY_RULE_ID,
      decision: "deny",
      ts: "2026-07-03T00:00:00.000Z"
    });
  });

  test("data/raw rule exposes a legal guard_class marker", () => {
    expect(DATA_RAW_WRITE_DENY_RULE.guard_class).toBe("authority");
  });
});

class RecordingTool extends BaseTool {
  description: string;
  parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      command: { type: "string" }
    },
    required: ["command"]
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
