import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseTool, BashTool, SpawnAgentTool, ToolRegistry } from "@zero-os/core";
import type { ToolContext, ToolLogger, ToolResult } from "@zero-os/shared";
import { PolicyGateRemediationSchema } from "./policy-gate-core";
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
  createRawDataWriteAdvisoryRule,
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
            ruleId: "workspace-write-deny",
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
    expect(payload.ruleId).toBe("workspace-write-deny");
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
        protectedEvidencePaths: [fixture.evidenceRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [{ pattern: "blocked-by-registry-fuse", description: "registry sentinel" }]
      });
      const bash = registry.get("bash");

      assertPolicyGatedToolRegistry(registry);
      expect(bash && isPolicyGatedTool(bash)).toBe(true);
      expect(isPolicyGatedTool(bash!) && bash.innerTool).toBeInstanceOf(RawDataSandboxedBashTool);
      expect(registry.list().find((tool) => tool.name === "bash")).toBe(bash);

      const scopedRegistry = new ToolRegistry();
      scopedRegistry.register(registry.get("bash")!);
      expect(scopedRegistry.get("bash")).toBe(bash);
      expect(isPolicyGatedTool(scopedRegistry.get("bash")!)).toBe(true);
      expect(
        isPolicyGatedTool(scopedRegistry.get("bash")!) && scopedRegistry.get("bash")!.innerTool
      ).toBeInstanceOf(RawDataSandboxedBashTool);

      const rawRead = await bash?.run(fixture.context, { command: "cat data/raw/input.csv" });
      expect(rawRead?.success).toBe(true);
      expect(rawRead?.output).toContain("raw,input");

      const workspaceWrite = await bash?.run(fixture.context, {
        command: "printf allowed > workspace/out.txt"
      });
      expect(workspaceWrite?.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "out.txt"), "utf8")).toBe("allowed");

      const protectedEvidenceWrite = await bash?.run(fixture.context, {
        command: "printf blocked > workspace/protected-evidence/out.txt"
      });
      expect(protectedEvidenceWrite?.success).toBe(false);
      await expect(readFile(join(fixture.evidenceRoot, "out.txt"), "utf8")).rejects.toThrow();

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

  seatbeltTest("SHUD runtime registry denies raw ancestor rename under broad allowed root", async () => {
    const fixture = await createRawFixture();
    try {
      const registry = createShudRuntimeToolRegistry({
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        enableAdvisory: false,
        fuseRules: []
      });
      const rawInput = join(fixture.rawRoot, "input.csv");
      const before = await readFile(rawInput, "utf8");

      const result = await registry.get("bash")?.run(fixture.context, {
        command: "mv data data.moved; printf MUTATED > data.moved/raw/input.csv",
        timeout: 30_000
      });

      expect(result?.success).toBe(false);
      expect(existsSync(join(fixture.root, "data"))).toBe(true);
      await expect(readFile(join(fixture.root, "data.moved", "raw", "input.csv"), "utf8")).rejects.toThrow();
      expect(await readFile(rawInput, "utf8")).toBe(before);
      const rows = await readRawAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.failed",
        decision: "failed"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("SHUD runtime registry propagates pathResolutionRoot to sandboxed bash", async () => {
    const fixture = await createRawFixture();
    try {
      const nestedWorkDir = join(fixture.workspaceRoot, "nested");
      await mkdir(nestedWorkDir, { recursive: true });
      const registry = createShudRuntimeToolRegistry({
        protectedRawPaths: ["data/raw"],
        allowedWriteRoots: ["workspace"],
        tempRoot: "workspace/tmp",
        profileRoot: "workspace/profiles",
        auditWorkspaceRoot: "workspace",
        pathResolutionRoot: fixture.root,
        fuseRules: []
      });

      const result = await registry.get("bash")?.run(
        {
          ...fixture.context,
          workDir: nestedWorkDir
        },
        { command: "cat ../../data/raw/input.csv" }
      );

      expect(result?.success).toBe(true);
      expect(result?.output).toContain("raw,input");
      const rows = await readRawAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("SHUD runtime registry defaults audit root from pathResolutionRoot", async () => {
    const fixture = await createRawFixture();
    try {
      const nestedWorkDir = join(fixture.workspaceRoot, "nested", "child");
      await mkdir(nestedWorkDir, { recursive: true });
      const registry = createShudRuntimeToolRegistry({
        protectedRawPaths: ["data/raw"],
        allowedWriteRoots: ["workspace"],
        tempRoot: "workspace/tmp",
        profileRoot: "workspace/profiles",
        pathResolutionRoot: fixture.root,
        fuseRules: []
      });

      const result = await registry.get("bash")?.run(
        {
          ...fixture.context,
          workDir: nestedWorkDir
        },
        { command: `printf ok > ${join(fixture.workspaceRoot, "registry-default-audit.txt")}` }
      );

      expect(result?.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "registry-default-audit.txt"), "utf8")).toBe(
        "ok"
      );
      const rows = await readRawAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
      await expect(
        readFile(
          join(nestedWorkDir, "tasks", "TASK-M1-SPIKE", "audit", "policy-gate.ndjson"),
          "utf8"
        )
      ).rejects.toThrow();
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
      assertPolicyGatedToolRegistry(registry);

      const spawn = registry.get("spawn_agent");
      expect(spawn && isPolicyGatedTool(spawn)).toBe(true);
      expect(isPolicyGatedTool(spawn!) && spawn.innerTool).toBeInstanceOf(SpawnAgentTool);
      expect(spawn).not.toBe(staleSpawn);

      const scopedRegistry = (
        (isPolicyGatedTool(spawn!) ? spawn.innerTool : spawn) as SpawnAgentTool & {
          buildScopedRegistry(toolNames?: string[]): ToolRegistry;
        }
      ).buildScopedRegistry(["bash"]);

      expect(scopedRegistry.get("bash")).toBe(registry.get("bash"));
      expect(isPolicyGatedTool(scopedRegistry.get("bash")!)).toBe(true);
      expect(
        isPolicyGatedTool(scopedRegistry.get("bash")!) && scopedRegistry.get("bash")!.innerTool
      ).toBeInstanceOf(RawDataSandboxedBashTool);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime policy evaluator denies bash, edit, and spawn before execution", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const edit = new RecordingTool("edit");
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new BashTool([]));
      zeroLikeRegistry.register(edit);
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => ({
          decision: "deny",
          ruleId: "runtime-deny",
          reason: "blocked by runtime evaluator",
          remediation: {
            next_action: "adjust_scope",
            hint: "Use an allowed tool for this role.",
            ref: "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md"
          }
        })
      });

      assertPolicyGatedToolRegistry(registry);
      const bashDenied = await registry.get("bash")?.run(fixture.context, {
        command: "printf side-effect > workspace/denied-by-policy.txt"
      });
      const editDenied = await registry.get("edit")?.run(fixture.context, {});
      const spawnDenied = await registry.get("spawn_agent")?.run(fixture.context, {
        instruction: "should not spawn",
        tools: ["bash"]
      });

      expect(bashDenied?.success).toBe(false);
      expect(bashDenied?.output).toContain("policy_gate_denied");
      await expect(readFile(join(fixture.workspaceRoot, "denied-by-policy.txt"), "utf8")).rejects.toThrow();
      expect(editDenied?.success).toBe(false);
      expect(edit.calls).toBe(0);
      expect(spawnDenied?.success).toBe(false);
      expect(spawnDenied?.output).toContain("policy_gate_denied");
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime fails closed when custom outer evaluator owns raw advisory composition", async () => {
    const fixture = await createRawFixture();
    try {
      const registry = createShudRuntimeToolRegistry({
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        evaluate: createPolicyGateEvaluator({
          rules: [createRawDataWriteAdvisoryRule([fixture.rawRoot])]
        })
      });

      const result = await registry.get("bash")?.run(fixture.context, {
        command: "printf nope > data/raw/outer-raw-advisory.txt"
      });

      expect(result?.success).toBe(false);
      expectOuterRawRuleMisconfiguration(result);
      expect(result?.output).not.toContain("raw_data_write_denied");
      expect(result?.output).not.toContain("policy_gate_denied");
      await expect(readFile(join(fixture.rawRoot, "outer-raw-advisory.txt"), "utf8")).rejects.toThrow();
      await expect(readRawAuditRows(fixture.root)).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  test("outer raw deny with inner advisory disabled does not execute bash side effects", async () => {
    const fixture = await createRawFixture();
    try {
      const registry = createShudRuntimeToolRegistry({
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        enableAdvisory: false,
        fuseRules: [],
        evaluate: createPolicyGateEvaluator({
          rules: [createRawDataWriteAdvisoryRule([fixture.rawRoot])]
        })
      });

      const result = await registry.get("bash")?.run(fixture.context, {
        command:
          "printf side-effect > workspace/outer-disabled-side-effect.txt; printf nope > data/raw/outer-disabled.txt"
      });

      expect(result?.success).toBe(false);
      expectOuterRawRuleMisconfiguration(result);
      expect(result?.output).not.toContain("raw_data_write_denied");
      expect(result?.output).not.toContain("policy_gate_denied");
      await expect(readFile(join(fixture.workspaceRoot, "outer-disabled-side-effect.txt"), "utf8")).rejects.toThrow();
      await expect(readFile(join(fixture.rawRoot, "outer-disabled.txt"), "utf8")).rejects.toThrow();
      await expect(readRawAuditRows(fixture.root)).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  test("outer raw deny root mismatch returns explicit non-trusted composition error", async () => {
    const fixture = await createRawFixture();
    try {
      const outerRawRoot = join(fixture.root, "outer", "raw");
      await mkdir(outerRawRoot, { recursive: true });
      const registry = createShudRuntimeToolRegistry({
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        enableAdvisory: false,
        fuseRules: [],
        evaluate: createPolicyGateEvaluator({
          rules: [createRawDataWriteAdvisoryRule([outerRawRoot])]
        })
      });

      const result = await registry.get("bash")?.run(fixture.context, {
        command: `if false; then printf nope > data/raw/inner.txt; fi; printf side-effect > workspace/mismatch-side-effect.txt; printf nope > ${join(outerRawRoot, "outer-denied.txt")}`
      });

      expect(result?.success).toBe(false);
      expectOuterRawRuleMisconfiguration(result);
      expect(result?.output).not.toContain("raw_data_write_denied");
      expect(result?.output).not.toContain("policy_gate_denied");
      await expect(readFile(join(fixture.workspaceRoot, "mismatch-side-effect.txt"), "utf8")).rejects.toThrow();
      await expect(readFile(join(fixture.rawRoot, "inner.txt"), "utf8")).rejects.toThrow();
      await expect(readFile(join(outerRawRoot, "outer-denied.txt"), "utf8")).rejects.toThrow();
      await expect(readRawAuditRows(fixture.root)).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime rewraps prewrapped tools with the current evaluator", async () => {
    const fixture = await createRawFixture();
    try {
      const edit = new RecordingTool("edit");
      const staleAllowEdit = wrapToolWithPolicyGate(edit, {
        evaluate: async () => ({ decision: "allow" })
      });

      const registry = createShudRuntimeToolRegistry({
        tools: [staleAllowEdit],
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        evaluate: async () => ({
          decision: "deny",
          ruleId: "runtime-deny",
          reason: "blocked by current evaluator",
          remediation: {
            next_action: "adjust_scope",
            hint: "Use an allowed tool for this role.",
            ref: "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md"
          }
        })
      });

      const result = await registry.get("edit")?.run(fixture.context, {});

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      expect(result?.output).toContain("blocked by current evaluator");
      expect(edit.calls).toBe(0);
      expect(registry.get("edit")).not.toBe(staleAllowEdit);
      expect(isPolicyGatedTool(registry.get("edit")!)).toBe(true);
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

function expectOuterRawRuleMisconfiguration(result: ToolResult | undefined): void {
  const payload = JSON.parse(result?.output ?? "{}") as {
    error?: string;
    rule?: string;
    reason?: string;
    outer_reason?: string;
    profile_id?: string;
    profile_path?: string;
    remediation?: {
      next_action?: string;
      hint?: string;
      ref?: string;
    };
  };

  expect(payload.error).toBe("policy_gate_raw_data_rule_misconfigured");
  expect(payload.rule).toBe(RAW_DATA_WRITE_RULE_ID);
  expect(payload.reason).toContain("RawDataSandboxedBashTool");
  expect(payload.outer_reason).toBe("obvious static raw-data write target");
  expect(payload.profile_id).toBeUndefined();
  expect(payload.profile_path).toBeUndefined();
  expect(payload.remediation?.next_action).toBe("fix_and_retry");
  expect(payload.remediation?.hint).toContain("RawDataSandboxedBashTool");
  expect(PolicyGateRemediationSchema.safeParse(payload.remediation).success).toBe(true);
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
  evidenceRoot: string;
  profileRoot: string;
  tempRoot: string;
  context: ToolContext;
  cleanup(): Promise<void>;
}

async function createRawFixture(): Promise<RawFixture> {
  const root = await mkdtemp(join(tmpdir(), "shud-registry-raw-"));
  const rawRoot = join(root, "data", "raw");
  const workspaceRoot = join(root, "workspace");
  const evidenceRoot = join(workspaceRoot, "protected-evidence");
  const profileRoot = join(workspaceRoot, "profiles");
  const tempRoot = join(workspaceRoot, "tmp");
  await mkdir(rawRoot, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(profileRoot, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await writeFile(join(rawRoot, "input.csv"), "raw,input\n", "utf8");

  return {
    root,
    rawRoot,
    workspaceRoot,
    evidenceRoot,
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
