import { describe, expect, test } from "bun:test";
import { BaseTool, ToolRegistry } from "@zero-os/core";
import type { ToolContext, ToolLogger, ToolResult } from "@zero-os/shared";
import {
  assertAllToolsPolicyGated,
  assertPolicyGatedToolRegistry,
  createPolicyGateEvaluator,
  createPolicyGatedToolRegistry,
  isPolicyGatedTool,
  wrapToolWithPolicyGate
} from "./policy-gate-registry";

describe("policy-gated zero tool registry", () => {
  test("denies before executing the underlying bash BaseTool", async () => {
    const bashTool = new RecordingTool("bash");
    const registry = createPolicyGatedToolRegistry([bashTool], {
      evaluate: createPolicyGateEvaluator({
        rules: [
          {
            ruleId: "raw-data-write",
            description: "Reject writes to raw data.",
            evaluate: () => ({
              decision: "deny",
              reason: "raw data writes are blocked",
              remediation: {
                next_action: "adjust_scope",
                hint: "Use a governed workspace path instead of data/raw.",
                ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
              }
            })
          }
        ]
      })
    });

    const result = await registry.get("bash")?.run(createToolContext("worker"), {
      command: "printf nope > data/raw/input.csv"
    });

    expect(result?.success).toBe(false);
    expect(result?.output).toContain("policy_gate_denied");
    expect(result?.output).toContain("raw data writes are blocked");
    const payload = JSON.parse(result?.output ?? "{}") as {
      ruleId?: string;
      reason?: string;
      remediation?: {
        next_action?: string;
        hint?: string;
        ref?: string;
      };
    };
    expect(payload.ruleId).toBe("raw-data-write");
    expect(payload.reason).toBe("raw data writes are blocked");
    expect(payload.remediation?.next_action).toBe("adjust_scope");
    expect(payload.remediation?.hint).toBe("Use a governed workspace path instead of data/raw.");
    expect(payload.remediation?.ref).toBe(
      "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
    );
    expect(bashTool.calls).toBe(0);
  });

  test("wraps all registered zero tools including spawn, bash, and edit", async () => {
    const tools = [
      new RecordingTool("spawn_agent"),
      new RecordingTool("bash"),
      new RecordingTool("edit")
    ];

    const registry = createPolicyGatedToolRegistry(tools, {
      evaluate: async () => ({ decision: "allow" })
    });

    assertPolicyGatedToolRegistry(registry);
    expect(registry.getDefinitions().map((definition) => definition.name)).toEqual([
      "spawn_agent",
      "bash",
      "edit"
    ]);

    for (const tool of registry.list()) {
      const result = await tool.run(createToolContext("coordinator"), {});
      expect(result.success).toBe(true);
      expect(isPolicyGatedTool(tool)).toBe(true);
    }

    expect(tools.map((tool) => tool.calls)).toEqual([1, 1, 1]);
  });

  test("assembly fails when any registered zero tool bypasses the wrapper", () => {
    const registry = new ToolRegistry();
    registry.register(
      wrapToolWithPolicyGate(new RecordingTool("bash"), {
        evaluate: async () => ({ decision: "allow" })
      })
    );
    registry.register(new RecordingTool("edit"));

    expect(() => assertPolicyGatedToolRegistry(registry)).toThrow("edit");
  });

  test("forged policy-gated symbol does not satisfy assembly", () => {
    const forgedTool = new RecordingTool("edit");
    (forgedTool as unknown as Record<symbol, true>)[Symbol.for("shud-harness.policy-gated-tool")] =
      true;

    expect(isPolicyGatedTool(forgedTool)).toBe(false);
    expect(() => assertAllToolsPolicyGated([forgedTool])).toThrow("edit");
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
