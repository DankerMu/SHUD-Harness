import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseTool, BashTool, SpawnAgentTool, ToolRegistry } from "@zero-os/core";
import type {
  FuseRule,
  RunningToolHandle,
  RunningToolRegistry,
  RunningToolTerminalMetadata,
  SecretFilter,
  ToolContext,
  ToolLogger,
  ToolResult
} from "@zero-os/shared";
import {
  PolicyGateRemediationSchema,
  SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES,
  SPAWN_PROFILE_SUBSET_POLICY_REF
} from "./policy-gate-core";
import {
  assertAllToolsPolicyGated,
  assertPolicyGatedToolRegistry,
  createPolicyGateEvaluator,
  createPolicyGatedToolRegistry,
  createShudRuntimeToolRegistry,
  createShudSandboxedBashTool,
  isPolicyGatedTool,
  wrapToolWithPolicyGate
} from "./policy-gate-registry";
import {
  RAW_DATA_WRITE_RULE_ID,
  RawDataSandboxedBashTool,
  buildRawDataSeatbeltProfile,
  createRawDataWriteAdvisoryRule,
  type PolicyGateAuditRow,
  type RawDataDenialPayload
} from "./raw-data-sandbox";
import { getRoleToolIds } from "./role-tool-map";

const requireSeatbeltTests = process.env.SHUD_REQUIRE_SEATBELT_TESTS === "1";
const hasSeatbelt = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
if (requireSeatbeltTests) {
  if (process.platform !== "darwin") {
    throw new Error("SHUD_REQUIRE_SEATBELT_TESTS requires macOS.");
  }
  if (!existsSync("/usr/bin/sandbox-exec")) {
    throw new Error("SHUD_REQUIRE_SEATBELT_TESTS requires /usr/bin/sandbox-exec.");
  }
}
const seatbeltTest = hasSeatbelt ? test : test.skip;

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

  test("evaluator exceptions fail closed without executing the inner tool", async () => {
    const editTool = new RecordingTool("edit");
    const runningToolRegistry = new TestRunningToolRegistry();
    const handle = runningToolRegistry.register({
      toolUseId: "POLICY-EVALUATOR-1",
      toolName: "edit",
      abortable: false
    });
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: () => {
        throw new Error("policy evaluator unavailable");
      }
    });

    const result = await wrapped.run(
      {
        ...createToolContext("worker"),
        currentToolUseId: "POLICY-EVALUATOR-1",
        runningToolRegistry
      },
      {
        command: "write"
      }
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("policy evaluator unavailable");
    expect(result.outputSummary).toContain("Error: policy evaluator unavailable");
    expect(editTool.calls).toBe(0);
    expect(handle.getState()).toBe("finished");
    expect(handle.getTerminalMetadata()).toMatchObject({
      cause: "completed",
      success: false,
      outputSummary: result.outputSummary
    });
  });

  test("malformed raw-rule deny from custom evaluator fails closed and finishes running handle", async () => {
    const bashTool = new RecordingTool("bash");
    const runningToolRegistry = new TestRunningToolRegistry();
    const handle = runningToolRegistry.register({
      toolUseId: "POLICY-MALFORMED-RAW-1",
      toolName: "bash",
      abortable: false
    });
    const wrapped = wrapToolWithPolicyGate(bashTool, {
      evaluate: async () =>
        ({
          decision: "deny",
          ruleId: RAW_DATA_WRITE_RULE_ID,
          reason: "bad raw deny"
        }) as never
    });

    const result = await wrapped.run(
      {
        ...createToolContext("worker"),
        currentToolUseId: "POLICY-MALFORMED-RAW-1",
        runningToolRegistry
      },
      {
        command: "printf nope > data/raw/input.csv"
      }
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Invalid policy gate decision");
    expect(result.output).toContain(RAW_DATA_WRITE_RULE_ID);
    expect(result.output).toContain("remediation");
    expect(result.outputSummary).toContain("Error: Invalid policy gate decision");
    expect(bashTool.calls).toBe(0);
    expect(handle.getState()).toBe("finished");
    expect(handle.getTerminalMetadata()).toEqual({
      finishedAt: expect.any(String),
      cause: "completed",
      success: false,
      outputSummary: result.outputSummary
    });
  });

  test("malformed generic deny from custom evaluator fails without policy_gate_denied payload", async () => {
    const bashTool = new RecordingTool("bash");
    const runningToolRegistry = new TestRunningToolRegistry();
    const handle = runningToolRegistry.register({
      toolUseId: "POLICY-MALFORMED-GENERIC-1",
      toolName: "bash",
      abortable: false
    });
    const wrapped = wrapToolWithPolicyGate(bashTool, {
      evaluate: async () =>
        ({
          decision: "deny",
          ruleId: "generic-deny",
          reason: "bad generic deny"
        }) as never
    });

    const result = await wrapped.run(
      {
        ...createToolContext("worker"),
        currentToolUseId: "POLICY-MALFORMED-GENERIC-1",
        runningToolRegistry
      },
      {
        command: "printf nope > workspace/out.txt"
      }
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Invalid policy gate decision");
    expect(result.output).toContain("generic-deny");
    expect(result.output).toContain("remediation");
    expect(result.output).not.toContain("policy_gate_denied");
    expect(result.outputSummary).toContain("Error: Invalid policy gate decision");
    expect(bashTool.calls).toBe(0);
    expect(handle.getState()).toBe("finished");
    expect(handle.getTerminalMetadata()).toEqual({
      finishedAt: expect.any(String),
      cause: "completed",
      success: false,
      outputSummary: result.outputSummary
    });
  });

  test("invalid remediation from policy evaluator returns failed ToolResult", async () => {
    const bashTool = new RecordingTool("bash");
    const wrapped = wrapToolWithPolicyGate(bashTool, {
      evaluate: createPolicyGateEvaluator({
        rules: [
          {
            ruleId: "invalid-remediation-rule",
            description: "Returns invalid remediation.",
            evaluate: () => ({
              decision: "deny",
              reason: "invalid remediation",
              remediation: {
                next_action: "try_anyway",
                hint: "No route.",
                ref: "spec"
              } as never
            })
          }
        ]
      })
    });

    const result = await wrapped.run(createToolContext("worker"), {
      command: "printf nope > data/raw/input.csv"
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain(
      "Invalid policy gate remediation for invalid-remediation-rule"
    );
    expect(result.outputSummary).toContain("Error: Invalid policy gate remediation");
    expect(bashTool.calls).toBe(0);
  });

  test("policy deny redacts registered secrets before returning", async () => {
    const secret = "fake-policy-deny-secret";
    const secretFilter = new TestSecretFilter();
    secretFilter.addSecret("policy-deny-secret", secret);
    const bashTool = new RecordingTool("bash");
    const registry = createPolicyGatedToolRegistry([bashTool], {
      evaluate: createPolicyGateEvaluator({
        rules: [
          {
            ruleId: "workspace-write-deny",
            description: "Reject writes to raw data.",
            evaluate: () => ({
              decision: "deny",
              reason: `blocked because ${secret}`,
              remediation: {
                next_action: "adjust_scope",
                hint: `Use a governed path, not ${secret}.`,
                ref: `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md#${secret}`
              }
            })
          }
        ]
      })
    });

    const result = await registry.get("bash")?.run(
      {
        ...createToolContext("worker"),
        secretFilter
      },
      {
        command: "printf nope > data/raw/input.csv"
      }
    );

    expect(result?.success).toBe(false);
    expect(result?.output).not.toContain(secret);
    expect(result?.outputSummary).not.toContain(secret);
    expect(result?.output).toContain("[redacted:policy-deny-secret]");
    expect(result?.outputSummary).toContain("[redacted:policy-deny-secret]");
    const payload = JSON.parse(result?.output ?? "{}") as {
      reason?: string;
      remediation?: {
        hint?: string;
        ref?: string;
      };
    };
    expect(payload.reason).toContain("[redacted:policy-deny-secret]");
    expect(payload.remediation?.hint).toContain("[redacted:policy-deny-secret]");
    expect(payload.remediation?.ref).toContain("[redacted:policy-deny-secret]");
    expect(bashTool.calls).toBe(0);
  });

  test("raw-data rule misconfiguration deny redacts registered secrets before returning", async () => {
    const secret = "fake-raw-rule-secret";
    const secretFilter = new TestSecretFilter();
    secretFilter.addSecret("raw-rule-secret", secret);
    const bashTool = new RecordingTool("bash");
    const wrapped = wrapToolWithPolicyGate(bashTool, {
      evaluate: async () => ({
        decision: "deny",
        ruleId: RAW_DATA_WRITE_RULE_ID,
        reason: `outer raw rule leaked ${secret}`,
        remediation: {
          next_action: "fix_and_retry",
          hint: `Remove the outer raw rule containing ${secret}.`,
          ref: `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md#${secret}`
        }
      })
    });

    const result = await wrapped.run(
      {
        ...createToolContext("worker"),
        secretFilter
      },
      {
        command: "printf nope > data/raw/input.csv"
      }
    );

    expect(result.success).toBe(false);
    expect(result.output).not.toContain(secret);
    expect(result.outputSummary).not.toContain(secret);
    expect(result.output).toContain("[redacted:raw-rule-secret]");
    expect(result.outputSummary).toContain("[redacted:raw-rule-secret]");
    const payload = JSON.parse(result.output) as {
      outer_reason?: string;
      remediation?: {
        ref?: string;
      };
    };
    expect(payload.outer_reason).toContain("[redacted:raw-rule-secret]");
    expect(payload.remediation?.ref).toContain("[redacted:raw-rule-secret]");
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

  test("SHUD sandboxed bash loads fuse rules from fuseListPath", async () => {
    const fixture = await createRawFixture();
    try {
      const fuseListPath = join(fixture.root, "fuse-list.yaml");
      await writeFile(
        fuseListPath,
        [
          "rules:",
          "  - pattern: blocked-from-fuse-list",
          "    description: file sentinel"
        ].join("\n"),
        "utf8"
      );
      const tool = createShudSandboxedBashTool({
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseListPath
      });

      const result = await tool.run(fixture.context, {
        command: "printf blocked-from-fuse-list"
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain("Command blocked by fuse list");
      expect(result.output).toContain("file sentinel");
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD sandboxed bash snapshots inline fuse rule objects", async () => {
    const fixture = await createRawFixture();
    try {
      const fuseRules: FuseRule[] = [
        { pattern: "blocked-inline-fuse", description: "inline sentinel" }
      ];
      const tool = createShudSandboxedBashTool({
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules
      });
      fuseRules[0].pattern = "mutated-inline-fuse";
      fuseRules[0].description = "mutated sentinel";

      const result = await tool.run(fixture.context, {
        command: "printf blocked-inline-fuse"
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain("Command blocked by fuse list");
      expect(result.output).toContain("inline sentinel");
      expect(result.output).not.toContain("mutated sentinel");
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("SHUD sandboxed bash snapshots root arrays at factory boundary", async () => {
    const fixture = await createRawFixture();
    try {
      const protectedRawPaths = [fixture.rawRoot];
      const protectedEvidencePaths = [fixture.evidenceRoot];
      const allowedWriteRoots = [fixture.workspaceRoot];
      const tool = createShudSandboxedBashTool({
        protectedRawPaths,
        protectedEvidencePaths,
        allowedWriteRoots,
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        enableAdvisory: false,
        fuseRules: []
      });
      const auditDir = join(
        fixture.workspaceRoot,
        "tasks",
        "TASK-M1-SPIKE",
        "audit"
      );
      await mkdir(auditDir, { recursive: true });
      const expectedProfile = await buildRawDataSeatbeltProfile({
        protectedRawPaths: [fixture.rawRoot],
        protectedEvidencePaths: [fixture.evidenceRoot, auditDir],
        allowedWriteRoots: [fixture.workspaceRoot],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot
      });
      const otherRawRoot = join(fixture.root, "data", "other-raw");
      const otherEvidenceRoot = join(fixture.workspaceRoot, "other-evidence");
      await mkdir(otherRawRoot, { recursive: true });
      await mkdir(otherEvidenceRoot, { recursive: true });

      protectedRawPaths[0] = otherRawRoot;
      protectedEvidencePaths[0] = otherEvidenceRoot;
      allowedWriteRoots.push(fixture.root);

      const result = await tool.run(fixture.context, {
        command:
          "printf ok > workspace/factory-allowed.txt; printf raw > data/raw/factory-denied.txt; printf evidence > workspace/protected-evidence/factory-evidence.txt",
        timeout: 30_000
      });

      expect(result.success).toBe(false);
      expect(await readFile(join(fixture.workspaceRoot, "factory-allowed.txt"), "utf8")).toBe(
        "ok"
      );
      await expect(readFile(join(fixture.rawRoot, "factory-denied.txt"), "utf8")).rejects.toThrow();
      await expect(
        readFile(join(fixture.evidenceRoot, "factory-evidence.txt"), "utf8")
      ).rejects.toThrow();
      const rows = await readRawAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.failed",
        decision: "failed",
        profile_id: expectedProfile.profileId
      });
      expect(rows.at(-1)?.profile_path).toContain(expectedProfile.profileId);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD sandboxed bash rejects ambiguous or missing fuse sources at runtime", async () => {
    const fixture = await createRawFixture();
    try {
      const fuseListPath = join(fixture.root, "fuse-list.yaml");
      await writeFile(fuseListPath, "rules: []\n", "utf8");
      const baseOptions = {
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot
      };

      expect(() =>
        createShudSandboxedBashTool({
          ...baseOptions,
          fuseRules: [],
          fuseListPath
        } as never)
      ).toThrow("exactly one of fuseRules or fuseListPath");

      expect(() => createShudSandboxedBashTool(baseOptions as never)).toThrow(
        "exactly one of fuseRules or fuseListPath"
      );
    } finally {
      await fixture.cleanup();
    }
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

  test("SHUD runtime default evaluator denies spawn profile supersets before execution", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      const agentControl = createAgentControlSpy();

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter
      });

      const result = await registry.get("spawn_agent")?.run(
        {
          ...fixture.context,
          agentControl: agentControl.control,
          projectRoot: fixture.root
        },
        {
          instruction: "Run a worker task.",
          role: "worker",
          tools: ["read", "edit"]
        }
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      const payload = JSON.parse(result?.output ?? "{}") as {
        error?: string;
        ruleId?: string;
        guard_class?: string;
        remediation?: {
          next_action?: string;
          hint?: string;
          ref?: string;
        };
      };
      expect(payload.error).toBe("policy_gate_denied");
      expect(payload.ruleId).toBe("spawn-profile-subset");
      expect(payload.guard_class).toBe("authority");
      expect(payload.remediation?.next_action).toBe("adjust_scope");
      expect(payload.remediation?.hint).toContain("edit");
      expect(payload.remediation?.ref).toContain(
        "docs/02_ARCHITECTURE/Roles_and_Boundaries.md#0-canonical-agent-role-registry"
      );
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime trims reviewer role before denying spawn profile supersets", async () => {
    const fixture = await createRawFixture();
    try {
      await writeHarnessRoleFixture(fixture.root, "reviewer", ["bash", "edit"]);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new BashTool([]));
      const agentControl = createAgentControlSpy();

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter
      });

      const result = await registry.get("spawn_agent")?.run(
        {
          ...fixture.context,
          agentControl: agentControl.control,
          projectRoot: fixture.root
        },
        {
          instruction: "Review this task.",
          role: "reviewer ",
          tools: ["read", "bash"]
        }
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      const payload = JSON.parse(result?.output ?? "{}") as {
        ruleId?: string;
        guard_class?: string;
        remediation?: {
          next_action?: string;
          hint?: string;
          ref?: string;
        };
      };
      expect(payload.ruleId).toBe("spawn-profile-subset");
      expect(payload.guard_class).toBe("authority");
      expect(payload.remediation?.next_action).toBe("adjust_scope");
      expect(payload.remediation?.hint).toContain("bash");
      expect(payload.remediation?.ref).toBe(SPAWN_PROFILE_SUBSET_POLICY_REF);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime custom evaluator allow cannot bypass spawn profile supersets", async () => {
    const fixture = await createRawFixture();
    try {
      await writeWorkerRoleFixture(fixture.root);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      const agentControl = createAgentControlSpy();

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => ({ decision: "allow" })
      });

      const result = await registry.get("spawn_agent")?.run(
        {
          ...fixture.context,
          agentControl: agentControl.control,
          projectRoot: fixture.root
        },
        {
          instruction: "Run a worker task.",
          role: "worker",
          tools: ["read", "edit"]
        }
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      const payload = JSON.parse(result?.output ?? "{}") as {
        ruleId?: string;
        guard_class?: string;
        remediation?: {
          next_action?: string;
          hint?: string;
        };
      };
      expect(payload.ruleId).toBe("spawn-profile-subset");
      expect(payload.guard_class).toBe("authority");
      expect(payload.remediation?.next_action).toBe("adjust_scope");
      expect(payload.remediation?.hint).toContain("edit");
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime custom evaluator mutation cannot widen authorized spawn input", async () => {
    const fixture = await createRawFixture();
    try {
      await writeWorkerRoleFixture(fixture.root);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      const agentControl = createAgentControlSpy();

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async (call) => {
          const spawnInput = call.input as {
            role?: string;
            tools?: string[];
          };
          spawnInput.role = "coder";
          spawnInput.tools?.push("edit");
          return { decision: "allow" };
        }
      });

      const result = await registry.get("spawn_agent")?.run(
        {
          ...fixture.context,
          agentControl: agentControl.control,
          projectRoot: fixture.root
        },
        {
          instruction: "Run a worker task.",
          role: "worker",
          tools: ["read"]
        }
      );

      expect(result?.success).toBe(true);
      expect(agentControl.getSpawnCalls()).toBe(1);
      expect(getCapturedToolNames(agentControl.getLastAgentContext())).toEqual(["read"]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime custom evaluator runs after built-in allow and can deny a canonical subset", async () => {
    const fixture = await createRawFixture();
    try {
      await writeWorkerRoleFixture(fixture.root);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();

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
          ruleId: "custom-canonical-subset-deny",
          reason: "custom evaluator denied canonical subset",
          remediation: {
            next_action: "adjust_scope",
            hint: "Use a different canonical subset for this task.",
            ref: "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md"
          }
        })
      });

      const result = await registry.get("spawn_agent")?.run(
        {
          ...fixture.context,
          agentControl: agentControl.control,
          projectRoot: fixture.root
        },
        {
          instruction: "Run a worker task.",
          role: "worker",
          tools: ["read"]
        }
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      const payload = JSON.parse(result?.output ?? "{}") as {
        ruleId?: string;
        guard_class?: string;
        reason?: string;
      };
      expect(payload.ruleId).toBe("custom-canonical-subset-deny");
      expect(payload.guard_class).toBeUndefined();
      expect(payload.reason).toBe("custom evaluator denied canonical subset");
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime normalizes omitted padded canonical role tools before Zero spawn", async () => {
    const fixture = await createRawFixture();
    try {
      await writeHarnessRoleFixture(fixture.root, "reviewer", ["bash", "edit"]);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("validator.run"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      zeroLikeRegistry.register(new BashTool([]));
      const agentControl = createAgentControlSpy();

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter
      });

      const result = await registry.get("spawn_agent")?.run(
        {
          ...fixture.context,
          agentControl: agentControl.control,
          projectRoot: fixture.root
        },
        {
          instruction: "Review this task.",
          role: "reviewer "
        }
      );

      expect(result?.success).toBe(true);
      expect(agentControl.getSpawnCalls()).toBe(1);
      const spawnedToolIds = getCapturedToolNames(agentControl.getLastAgentContext());
      expect(spawnedToolIds.length).toBeGreaterThan(0);
      const reviewerToolIds = new Set<string>(getRoleToolIds("reviewer"));
      expect(spawnedToolIds.every((toolId) => reviewerToolIds.has(toolId))).toBe(true);
      expect(spawnedToolIds).not.toContain("bash");
      expect(spawnedToolIds).not.toContain("edit");
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime maps allowed_tools alias to Zero tools before spawn", async () => {
    const fixture = await createRawFixture();
    try {
      await writeWorkerRoleFixture(fixture.root);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      zeroLikeRegistry.register(new BashTool([]));
      const agentControl = createAgentControlSpy();

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter
      });

      const result = await registry.get("spawn_agent")?.run(
        {
          ...fixture.context,
          agentControl: agentControl.control,
          projectRoot: fixture.root
        },
        {
          instruction: "Run a worker task.",
          role: "worker",
          allowed_tools: ["read"]
        }
      );

      expect(result?.success).toBe(true);
      expect(agentControl.getSpawnCalls()).toBe(1);
      expect(getCapturedToolNames(agentControl.getLastAgentContext())).toEqual(["read"]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies empty and malformed canonical spawn tools without Zero fallback", async () => {
    const fixture = await createRawFixture();
    try {
      await writeWorkerRoleFixture(fixture.root);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      zeroLikeRegistry.register(new BashTool([]));

      for (const spawnInput of [
        { instruction: "Run a worker task.", role: "worker", tools: [] },
        { instruction: "Run a worker task.", role: "worker", tools: "read" }
      ]) {
        const agentControl = createAgentControlSpy();
        const registry = createShudRuntimeToolRegistry({
          tools: zeroLikeRegistry.list(),
          protectedRawPaths: [fixture.rawRoot],
          allowedWriteRoots: [fixture.root],
          tempRoot: fixture.tempRoot,
          profileRoot: fixture.profileRoot,
          fuseRules: [],
          modelRouter
        });

        const result = await registry.get("spawn_agent")?.run(
          {
            ...fixture.context,
            agentControl: agentControl.control,
            projectRoot: fixture.root
          },
          spawnInput
        );

        expect(result?.success).toBe(false);
        expect(result?.output).toContain("policy_gate_denied");
        const payload = JSON.parse(result?.output ?? "{}") as {
          guard_class?: string;
          remediation?: {
            next_action?: string;
          };
        };
        expect(payload.guard_class).toBe("authority");
        expect(payload.remediation?.next_action).toBe("adjust_scope");
        expect(agentControl.getSpawnCalls()).toBe(0);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime bounds spawn profile excess denial payload", async () => {
    const fixture = await createRawFixture();
    try {
      await writeWorkerRoleFixture(fixture.root);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      const agentControl = createAgentControlSpy();
      const farTailSentinel = "tail-sentinel-that-must-not-appear";
      const excessTools = [
        "extra-0",
        "extra-1",
        "extra-2",
        "extra-3",
        "extra-4",
        "edit",
        "extra-5",
        farTailSentinel
      ];

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter
      });

      const result = await registry.get("spawn_agent")?.run(
        {
          ...fixture.context,
          agentControl: agentControl.control,
          projectRoot: fixture.root
        },
        {
          instruction: "Run a worker task.",
          role: "worker",
          tools: ["read", ...excessTools]
        }
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      expect(result?.output).toContain("edit");
      expect(result?.output).toContain(`${excessTools.length} total`);
      expect(result?.output).not.toContain(farTailSentinel);
      const output = result?.output ?? "";
      expect(excessTools.filter((toolId) => output.includes(toolId)).length).toBeLessThanOrEqual(
        SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES
      );
      expect(result?.output.length).toBeLessThan(900);
      expect(agentControl.getSpawnCalls()).toBe(0);
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

type AgentControl = NonNullable<ToolContext["agentControl"]>;

function createAgentControlSpy(): {
  control: AgentControl;
  getSpawnCalls(): number;
  getLastAgentContext(): unknown;
} {
  let spawnCalls = 0;
  let lastAgentContext: unknown;
  const waitResult = async () => ({ statuses: {}, timedOut: false });
  const control: AgentControl = {
    spawn(
      _agent: unknown,
      context: unknown,
      _instruction: string,
      options?: Parameters<AgentControl["spawn"]>[3]
    ) {
      spawnCalls += 1;
      lastAgentContext = context;
      return { agentId: `agent-${spawnCalls}`, label: options?.label ?? "SubAgent" };
    },
    waitAny: waitResult,
    waitAll: waitResult,
    waitReady: waitResult,
    getStatus: () => undefined,
    getOutput: () => undefined,
    getSnapshot: () => [],
    restoreSnapshot: () => {},
    sendInput: () => ({ success: false, error: "not implemented" }),
    getTraceSpanId: () => undefined,
    getAgentInfo: () => undefined,
    close: () => undefined,
    listAgents: () => [],
    activeAgentCount: 0
  };

  return {
    control,
    getSpawnCalls: () => spawnCalls,
    getLastAgentContext: () => lastAgentContext
  };
}

async function writeWorkerRoleFixture(root: string): Promise<void> {
  await writeHarnessRoleFixture(root, "worker", ["read", "sandbox.exec"]);
}

async function writeHarnessRoleFixture(
  root: string,
  role: string,
  defaultTools: readonly string[]
): Promise<void> {
  const rolesDir = join(root, ".zero", "roles");
  await mkdir(rolesDir, { recursive: true });
  await writeFile(
    join(rolesDir, `${role}.toml`),
    [
      `name = "${role}"`,
      `agent_instruction = "Test ${role} role."`,
      `default_tools = [${defaultTools.map((toolId) => `"${toolId}"`).join(", ")}]`
    ].join("\n"),
    "utf8"
  );
}

function getCapturedToolNames(agentContext: unknown): string[] {
  const maybeContext = agentContext as { tools?: Array<{ name?: unknown }> } | undefined;
  return (
    maybeContext?.tools
      ?.map((tool) => tool.name)
      .filter((toolName): toolName is string => typeof toolName === "string") ?? []
  );
}

class TestRunningToolRegistry implements RunningToolRegistry {
  private readonly handles = new Map<string, TestRunningToolHandle>();

  register(entry: {
    toolUseId: string;
    toolName: string;
    abortable: boolean;
  }): RunningToolHandle {
    const handle = new TestRunningToolHandle(entry);
    this.handles.set(entry.toolUseId, handle);
    return handle;
  }

  get(toolUseId: string): RunningToolHandle | undefined {
    return this.handles.get(toolUseId);
  }
}

class TestRunningToolHandle implements RunningToolHandle {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly abortable: boolean;

  private state: "running" | "abort_requested" | "finished" = "running";
  private abortReason: string | undefined;
  private abortHandler: ((reason?: string) => void) | undefined;
  private terminalMetadata: RunningToolTerminalMetadata | undefined;

  constructor(entry: { toolUseId: string; toolName: string; abortable: boolean }) {
    this.toolUseId = entry.toolUseId;
    this.toolName = entry.toolName;
    this.abortable = entry.abortable;
  }

  getState(): "running" | "abort_requested" | "finished" {
    return this.state;
  }

  getAbortReason(): string | undefined {
    return this.abortReason;
  }

  getTerminalMetadata(): RunningToolTerminalMetadata | undefined {
    return this.terminalMetadata;
  }

  requestAbort(reason?: string): "accepted" | "already_requested" | "already_finished" | "not_abortable" {
    if (!this.abortable) {
      return "not_abortable";
    }
    if (this.state === "finished") {
      return "already_finished";
    }
    if (this.state === "abort_requested") {
      return "already_requested";
    }
    this.state = "abort_requested";
    this.abortReason = reason;
    this.abortHandler?.(reason);
    return "accepted";
  }

  setAbortHandler(handler: (reason?: string) => void): void {
    this.abortHandler = handler;
    if (this.state === "abort_requested") {
      handler(this.abortReason);
    }
  }

  markFinished(metadata: RunningToolTerminalMetadata): boolean {
    if (this.state === "finished") {
      return false;
    }
    this.state = "finished";
    this.terminalMetadata = metadata;
    return true;
  }
}

class TestSecretFilter implements SecretFilter {
  private readonly secrets = new Map<string, string>();

  filter(text: string): string {
    let filtered = text;
    for (const [key, value] of this.secrets) {
      filtered = filtered.split(value).join(`[redacted:${key}]`);
    }
    return filtered;
  }

  addSecret(key: string, value: string): void {
    this.secrets.set(key, value);
  }

  removeSecret(key: string): void {
    this.secrets.delete(key);
  }
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
