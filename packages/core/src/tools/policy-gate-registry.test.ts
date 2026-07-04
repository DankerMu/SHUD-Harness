import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseTool, BashTool, SpawnAgentTool, ToolRegistry } from "@zero-os/core";
import type { ToolContext, ToolLogger, ToolResult } from "@zero-os/shared";
import {
  assertAllToolsPolicyGated,
  assertPolicyGatedToolRegistry,
  createPolicyGateEvaluator,
  createPolicyGatedToolRegistry,
  createShudRuntimeToolRegistry,
  isPolicyGatedTool,
  wrapToolWithPolicyGate
} from "./policy-gate-registry";
import {
  RAW_DATA_WRITE_RULE_ID,
  RawDataSandboxedBashTool,
  type PolicyGateAuditRow,
  type RawDataDenialPayload
} from "./raw-data-sandbox";

const seatbeltTest =
  process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") ? test : test.skip;

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

  seatbeltTest("SHUD runtime registry obtains wrapped bash with raw sandbox and fused BashTool", async () => {
    const fixture = await createRawFixture();
    try {
      const registry = createShudRuntimeToolRegistry({
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [{ pattern: "blocked-by-registry-fuse", description: "registry sentinel" }]
      });
      const bash = registry.get("bash");

      expect(bash).toBeInstanceOf(RawDataSandboxedBashTool);
      expect(registry.list().find((tool) => tool.name === "bash")).toBe(bash);

      const scopedRegistry = new ToolRegistry();
      scopedRegistry.register(registry.get("bash")!);
      expect(scopedRegistry.get("bash")).toBe(bash);
      expect(scopedRegistry.get("bash")).toBeInstanceOf(RawDataSandboxedBashTool);

      const rawRead = await bash?.run(fixture.context, { command: "cat data/raw/input.csv" });
      expect(rawRead?.success).toBe(true);
      expect(rawRead?.output).toContain("raw,input");

      const workspaceWrite = await bash?.run(fixture.context, {
        command: "printf allowed > workspace/out.txt"
      });
      expect(workspaceWrite?.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "out.txt"), "utf8")).toBe("allowed");

      const fused = await bash?.run(fixture.context, { command: "printf blocked-by-registry-fuse" });
      expect(fused?.success).toBe(false);
      expect(fused?.output).toContain("registry sentinel");

      const denied = await bash?.run(fixture.context, {
        command: "printf nope > data/raw/registry-denied.txt"
      });
      const payload = JSON.parse(denied?.output ?? "{}") as RawDataDenialPayload;
      expect(denied?.success).toBe(false);
      expect(payload.rule).toBe(RAW_DATA_WRITE_RULE_ID);
      expect(payload.decision).toBe("denied_by_advisory");
      await expect(readFile(join(fixture.rawRoot, "registry-denied.txt"), "utf8")).rejects.toThrow();

      const rows = await readRawAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.failed",
        tool_id: "bash",
        rule: RAW_DATA_WRITE_RULE_ID,
        decision: payload.decision,
        guard_class: payload.guard_class,
        profile_id: payload.profile_id,
        error_id: payload.error_record.error_id,
        invocation_id: "REGISTRY-CALL-1"
      });
      expect(rows.at(-1)?.profile_id).toMatch(/^shud-raw-seatbelt-/);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime rebuilds spawn_agent so scoped registries inherit sandboxed bash", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new BashTool([]));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      const staleSpawn = new SpawnAgentTool(modelRouter, zeroLikeRegistry);
      zeroLikeRegistry.register(staleSpawn);

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter
      });

      const spawn = registry.get("spawn_agent");
      expect(spawn).toBeInstanceOf(SpawnAgentTool);
      expect(spawn).not.toBe(staleSpawn);

      const scopedRegistry = (
        spawn as SpawnAgentTool & {
          buildScopedRegistry(toolNames?: string[]): ToolRegistry;
        }
      ).buildScopedRegistry(["bash"]);

      expect(scopedRegistry.get("bash")).toBe(registry.get("bash"));
      expect(scopedRegistry.get("bash")).toBeInstanceOf(RawDataSandboxedBashTool);
    } finally {
      await fixture.cleanup();
    }
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

function createSpawnModelRouterStub(): ConstructorParameters<typeof SpawnAgentTool>[0] {
  return {
    getRegistry: () => ({ listModels: () => [] }),
    resolveModel: () => undefined,
    getCurrentModel: () => undefined,
    getAdapter: () => undefined,
    getModelLabel: () => "test/model"
  } as unknown as ConstructorParameters<typeof SpawnAgentTool>[0];
}

const testLogger: ToolLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

interface RawFixture {
  root: string;
  rawRoot: string;
  workspaceRoot: string;
  profileRoot: string;
  tempRoot: string;
  context: ToolContext;
  cleanup(): Promise<void>;
}

async function createRawFixture(): Promise<RawFixture> {
  const root = await mkdtemp(join(tmpdir(), "shud-registry-raw-"));
  const rawRoot = join(root, "data", "raw");
  const workspaceRoot = join(root, "workspace");
  const profileRoot = join(workspaceRoot, "profiles");
  const tempRoot = join(workspaceRoot, "tmp");
  await mkdir(rawRoot, { recursive: true });
  await mkdir(profileRoot, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await writeFile(join(rawRoot, "input.csv"), "raw,input\n", "utf8");

  return {
    root,
    rawRoot,
    workspaceRoot,
    profileRoot,
    tempRoot,
    context: {
      sessionId: "TEST-SESSION",
      currentToolUseId: "REGISTRY-CALL-1",
      workDir: root,
      logger: testLogger
    },
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

async function readRawAuditRows(root: string): Promise<PolicyGateAuditRow[]> {
  const auditFile = join(
    root,
    "workspace",
    "tasks",
    "TASK-M1-SPIKE",
    "audit",
    "policy-gate.ndjson"
  );
  const content = await readFile(auditFile, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PolicyGateAuditRow);
}
