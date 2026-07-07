import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseTool,
  BashTool,
  EditTool,
  ReadTool,
  SpawnAgentTool,
  ToolRegistry,
  WaitAgentTool,
  WriteTool
} from "@zero-os/core";
import type {
  FuseRule,
  RunningToolHandle,
  RunningToolRegistry,
  RunningToolTerminalMetadata,
  SecretFilter,
  ToolContext,
  ToolDefinition,
  ToolLogger,
  ToolResult
} from "@zero-os/shared";
import { z } from "zod";
import {
  PolicyGateRemediationSchema,
  SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS,
  SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES,
  SPAWN_PROFILE_SUBSET_POLICY_REF,
  SPAWN_PROFILE_SUBSET_RULE_ID
} from "./policy-gate-core";
import {
  assertAllToolsPolicyGated,
  assertPolicyGatedToolRegistry,
  createPolicyGateEvaluator,
  createPolicyGatedToolRegistry,
  createShudRuntimeToolRegistry,
  createShudSandboxedBashTool,
  isPolicyGatedTool,
  wrapAllRegisteredTools,
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

  test("non-spawn input preparation failures finalize without executing the inner tool", async () => {
    const editTool = new RecordingTool("edit");
    const runningToolRegistry = new TestRunningToolRegistry();
    const handle = runningToolRegistry.register({
      toolUseId: "POLICY-PREPARE-1",
      toolName: "edit",
      abortable: false
    });
    let customCalls = 0;
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async () => {
        customCalls += 1;
        return { decision: "allow" };
      }
    });
    const sentinel = "UNREGISTERED_SECRET_FROM_GETTER";
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "command", {
      enumerable: true,
      get() {
        throw new Error(sentinel);
      }
    });

    const result = await wrapped.run(
      {
        ...createToolContext("worker"),
        currentToolUseId: "POLICY-PREPARE-1",
        runningToolRegistry
      },
      input
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("policy_gate_input_preparation_failed");
    expect(result.output).not.toContain(sentinel);
    expect(result.output).not.toContain("policy_gate_denied");
    expect(result.output).not.toContain("raw_data_write_denied");
    expect(result.outputSummary).toBe("Policy gate input preparation failed for edit");
    expect(result.outputSummary).not.toContain(sentinel);
    const payload = JSON.parse(result.output) as {
      error?: string;
      tool_id?: string;
      reason?: string;
      remediation?: unknown;
    };
    expect(payload).toMatchObject({
      error: "policy_gate_input_preparation_failed",
      tool_id: "edit",
      reason: "Policy gate could not safely prepare the tool input before evaluation.",
      remediation: {
        next_action: "fix_and_retry",
        ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
      }
    });
    expect(PolicyGateRemediationSchema.safeParse(payload.remediation).success).toBe(true);
    expect(JSON.stringify(payload.remediation)).not.toContain(sentinel);
    expect(customCalls).toBe(0);
    expect(editTool.calls).toBe(0);
    expect(handle.getState()).toBe("finished");
    expect(handle.getTerminalMetadata()).toEqual({
      finishedAt: expect.any(String),
      cause: "completed",
      success: false,
      outputSummary: result.outputSummary
    });
  });

  test("non-spawn input preparation rejects prototype-polluting fallback inputs", async () => {
    const bashLikeTool = new RequiredCommandRecordingTool("bash");
    const wrapped = wrapToolWithPolicyGate(bashLikeTool, {
      evaluate: async () => {
        throw new Error("custom evaluator must not run for unsafe input");
      }
    });
    const input: Record<string, unknown> = {
      forceStructuredCloneFailure: () => "not cloneable"
    };
    Object.defineProperty(input, "__proto__", {
      configurable: true,
      enumerable: true,
      value: {
        command: "printf inherited-command"
      }
    });

    const result = await wrapped.run(createToolContext("worker"), input);

    expect(result.success).toBe(false);
    expect(result.output).toContain("policy_gate_input_preparation_failed");
    expect(result.output).not.toContain("inherited-command");
    expect(result.outputSummary).toBe("Policy gate input preparation failed for bash");
    expect(bashLikeTool.calls).toBe(0);
  });

  test("proxy array inputs fail before array key or descriptor traps", async () => {
    const editTool = new RecordingTool("edit");
    let evaluatorCalls = 0;
    let ownKeysCalls = 0;
    let descriptorCalls = 0;
    const input = new Proxy(Array.from({ length: 1_025 }, (_, index) => index), {
      ownKeys(target) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        descriptorCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
    });
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async () => {
        evaluatorCalls += 1;
        return { decision: "allow" };
      }
    });

    const result = await wrapped.run(createToolContext("worker"), input);

    expect(result.success).toBe(false);
    expect(result.output).toContain("policy_gate_input_preparation_failed");
    expect(evaluatorCalls).toBe(0);
    expect(editTool.calls).toBe(0);
    expect(ownKeysCalls).toBe(0);
    expect(descriptorCalls).toBe(0);
  });

  test("over-length ordinary arrays fail before array key discovery or numeric descriptor reads", async () => {
    const editTool = new RecordingTool("edit");
    const input = Array.from({ length: 1_025 }, (_, index) => index);
    let evaluatorCalls = 0;
    let arrayOwnKeysCalls = 0;
    let arrayNumericDescriptorReads = 0;
    const originalOwnKeys = Reflect.ownKeys;
    const originalGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
    Reflect.ownKeys = ((target: object): (string | symbol)[] => {
      if (Array.isArray(target)) {
        arrayOwnKeysCalls += 1;
        throw new Error("array ownKeys must not be called");
      }
      return originalOwnKeys(target);
    }) as typeof Reflect.ownKeys;
    Reflect.getOwnPropertyDescriptor = ((
      target: object,
      propertyKey: PropertyKey
    ): PropertyDescriptor | undefined => {
      if (Array.isArray(target) && isExpectedNumericArrayDescriptorKey(propertyKey, target.length)) {
        arrayNumericDescriptorReads += 1;
        throw new Error(`array numeric descriptor must not be read: ${String(propertyKey)}`);
      }
      return originalGetOwnPropertyDescriptor(target, propertyKey);
    }) as typeof Reflect.getOwnPropertyDescriptor;

    try {
      const wrapped = wrapToolWithPolicyGate(editTool, {
        evaluate: async () => {
          evaluatorCalls += 1;
          return { decision: "allow" };
        }
      });

      const result = await wrapped.run(createToolContext("worker"), input);

      expect(result.success).toBe(false);
      expect(result.output).toContain("policy_gate_input_preparation_failed");
    } finally {
      Reflect.ownKeys = originalOwnKeys;
      Reflect.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
    }

    expect(arrayOwnKeysCalls).toBe(0);
    expect(arrayNumericDescriptorReads).toBe(0);
    expect(evaluatorCalls).toBe(0);
    expect(editTool.calls).toBe(0);
  });

  test("ordinary arrays ignore over-budget non-index own properties without array key discovery", async () => {
    const editTool = new RecordingTool("edit");
    const sentinel = "ARRAY_NON_INDEX_PROPERTY_SENTINEL";
    const values = ["alpha", , "gamma"] as unknown[];
    for (let index = 0; index < 300; index += 1) {
      Object.defineProperty(values, `extra_${index}`, {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error(`${sentinel}_${index}`);
        }
      });
    }
    Object.defineProperty(values, "callable", {
      configurable: true,
      enumerable: true,
      value: () => sentinel
    });
    Object.defineProperty(values, "symbolValue", {
      configurable: true,
      enumerable: true,
      value: Symbol(sentinel)
    });
    Object.defineProperty(values, "bigintValue", {
      configurable: true,
      enumerable: true,
      value: 1n
    });
    Object.defineProperty(values, "__proto__", {
      configurable: true,
      enumerable: true,
      value: {
        polluted: true
      }
    });
    Object.defineProperty(values, "constructor", {
      configurable: true,
      enumerable: true,
      value: {
        prototype: {
          polluted: true
        }
      }
    });
    Object.defineProperty(values, "prototype", {
      configurable: true,
      enumerable: true,
      value: {
        polluted: true
      }
    });
    Object.defineProperty(values, Symbol("ignored-array-extra"), {
      configurable: true,
      enumerable: true,
      value: sentinel
    });

    let arrayOwnKeysCalls = 0;
    let arrayNonIndexDescriptorReads = 0;
    let evaluatorObservation:
      | {
          direct: unknown[];
          hasSparseHole: boolean;
          extraVisible: boolean;
          unsafeVisible: boolean;
          constructorValue: unknown;
        }
      | undefined;
    const originalOwnKeys = Reflect.ownKeys;
    const originalGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
    Reflect.ownKeys = ((target: object): (string | symbol)[] => {
      if (Array.isArray(target)) {
        arrayOwnKeysCalls += 1;
        throw new Error("array ownKeys must not be called");
      }
      return originalOwnKeys(target);
    }) as typeof Reflect.ownKeys;
    Reflect.getOwnPropertyDescriptor = ((
      target: object,
      propertyKey: PropertyKey
    ): PropertyDescriptor | undefined => {
      if (Array.isArray(target) && !isExpectedNumericArrayDescriptorKey(propertyKey, target.length)) {
        arrayNonIndexDescriptorReads += 1;
        throw new Error(`array non-index descriptor must not be read: ${String(propertyKey)}`);
      }
      return originalGetOwnPropertyDescriptor(target, propertyKey);
    }) as typeof Reflect.getOwnPropertyDescriptor;

    try {
      const wrapped = wrapToolWithPolicyGate(editTool, {
        evaluate: async (call) => {
          const evaluatorValues = (call.input as { values: unknown[] }).values;
          evaluatorObservation = {
            direct: [evaluatorValues[0], evaluatorValues[1], evaluatorValues[2]],
            hasSparseHole: Object.prototype.hasOwnProperty.call(evaluatorValues, "1"),
            extraVisible: Object.prototype.hasOwnProperty.call(evaluatorValues, "extra_0"),
            unsafeVisible:
              Object.prototype.hasOwnProperty.call(evaluatorValues, "callable") ||
              Object.prototype.hasOwnProperty.call(evaluatorValues, "symbolValue") ||
              Object.prototype.hasOwnProperty.call(evaluatorValues, "bigintValue") ||
              Object.prototype.hasOwnProperty.call(evaluatorValues, "__proto__") ||
              Object.prototype.hasOwnProperty.call(evaluatorValues, "constructor") ||
              Object.prototype.hasOwnProperty.call(evaluatorValues, "prototype"),
            constructorValue: (evaluatorValues as { constructor?: unknown }).constructor
          };
          return { decision: "allow" };
        }
      });

      const result = await wrapped.run(createToolContext("worker"), { values });

      expect(result.success).toBe(true);
      expect(editTool.calls).toBe(1);
    } finally {
      Reflect.ownKeys = originalOwnKeys;
      Reflect.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
    }

    expect(arrayOwnKeysCalls).toBe(0);
    expect(arrayNonIndexDescriptorReads).toBe(0);
    expect(evaluatorObservation).toEqual({
      direct: ["alpha", undefined, "gamma"],
      hasSparseHole: false,
      extraVisible: false,
      unsafeVisible: false,
      constructorValue: undefined
    });
    const executionValues = (editTool.lastInput as { values?: unknown[] }).values;
    expect(executionValues).toHaveLength(3);
    expect(executionValues?.[0]).toBe("alpha");
    expect(executionValues?.[1]).toBeUndefined();
    expect(executionValues?.[2]).toBe("gamma");
    expect(Object.prototype.hasOwnProperty.call(executionValues, "1")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(executionValues, "extra_0")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(executionValues, "callable")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(executionValues, "symbolValue")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(executionValues, "bigintValue")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(executionValues, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(executionValues, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(executionValues, "prototype")).toBe(false);
  });

  test("wide ordinary objects fail before per-key value reads", async () => {
    const editTool = new RecordingTool("edit");
    let evaluatorCalls = 0;
    let hostileGetterReads = 0;
    const sentinel = "WIDE_OBJECT_HOSTILE_GETTER_SECRET";
    const input = createObjectWithKeyCount(257);
    Object.defineProperty(input, "hostile", {
      configurable: true,
      enumerable: true,
      get() {
        hostileGetterReads += 1;
        throw new Error(sentinel);
      }
    });
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async () => {
        evaluatorCalls += 1;
        return { decision: "allow" };
      }
    });

    const result = await wrapped.run(createToolContext("worker"), input);

    expect(result.success).toBe(false);
    expect(result.output).toContain("policy_gate_input_preparation_failed");
    expect(result.output).not.toContain(sentinel);
    expect(evaluatorCalls).toBe(0);
    expect(editTool.calls).toBe(0);
    expect(hostileGetterReads).toBe(0);
  });

  test("proxy-hostile non-spawn input fails closed without leaking trap text", async () => {
    const editTool = new RecordingTool("edit");
    const runningToolRegistry = new TestRunningToolRegistry();
    const handle = runningToolRegistry.register({
      toolUseId: "POLICY-HOSTILE-PROXY-1",
      toolName: "edit",
      abortable: false
    });
    let evaluatorCalls = 0;
    const sentinel = "HOSTILE_PROXY_TRAP_SECRET";
    let ownKeysCalls = 0;
    let descriptorCalls = 0;
    const input = new Proxy(
      {},
      {
        ownKeys() {
          ownKeysCalls += 1;
          throw new Error(sentinel);
        },
        getOwnPropertyDescriptor(target, property) {
          descriptorCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        }
      }
    );
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async () => {
        evaluatorCalls += 1;
        return { decision: "allow" };
      }
    });

    const result = await wrapped.run(
      {
        ...createToolContext("worker"),
        currentToolUseId: "POLICY-HOSTILE-PROXY-1",
        runningToolRegistry
      },
      input
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("policy_gate_input_preparation_failed");
    expect(result.output).not.toContain(sentinel);
    expect(result.outputSummary).toBe("Policy gate input preparation failed for edit");
    expect(result.outputSummary).not.toContain(sentinel);
    expect(evaluatorCalls).toBe(0);
    expect(editTool.calls).toBe(0);
    expect(ownKeysCalls).toBe(0);
    expect(descriptorCalls).toBe(0);
    expect(handle.getState()).toBe("finished");
    expect(handle.getTerminalMetadata()).toMatchObject({
      cause: "completed",
      success: false,
      outputSummary: result.outputSummary
    });
  });

  test("drifting proxy descriptors fail closed before evaluator or inner execution", async () => {
    const editTool = new RecordingTool("edit");
    let evaluatorCalls = 0;
    let ownKeysCalls = 0;
    let descriptorCalls = 0;
    const sentinel = "DRIFTING_PROXY_DANGER_SECRET";
    const input = new Proxy(
      {
        command: "safe"
      },
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(_target, property) {
          descriptorCalls += 1;
          if (property === "command") {
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              value: descriptorCalls === 1 ? "safe" : sentinel
            };
          }
          return undefined;
        }
      }
    );
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async () => {
        evaluatorCalls += 1;
        return { decision: "allow" };
      }
    });

    const result = await wrapped.run(createToolContext("worker"), input);

    expect(result.success).toBe(false);
    expect(result.output).toContain("policy_gate_input_preparation_failed");
    expect(result.output).not.toContain(sentinel);
    expect(result.outputSummary).toBe("Policy gate input preparation failed for edit");
    expect(evaluatorCalls).toBe(0);
    expect(editTool.calls).toBe(0);
    expect(ownKeysCalls).toBe(0);
    expect(descriptorCalls).toBe(0);
  });

  test("non-spawn input preparation rejects isolated unsafe generic inputs", async () => {
    const symbolKey = Symbol("unsafe-key");
    const protoDataKeyInput: Record<string, unknown> = {
      command: "original"
    };
    Object.defineProperty(protoDataKeyInput, "__proto__", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        polluted: true
      }
    });
    const cases: Array<{ label: string; input: unknown }> = [
      {
        label: "function value",
        input: {
          command: "original",
          unsafe: () => "not cloneable"
        }
      },
      {
        label: "symbol value",
        input: {
          command: Symbol("unsafe-value")
        }
      },
      {
        label: "bigint value",
        input: {
          command: "original",
          count: 1n
        }
      },
      {
        label: "symbol key",
        input: {
          command: "original",
          [symbolKey]: "unsafe"
        }
      },
      {
        label: "own __proto__ data key",
        input: protoDataKeyInput
      },
      {
        label: "constructor key",
        input: {
          command: "original",
          constructor: {
            prototype: {
              polluted: true
            }
          }
        }
      },
      {
        label: "prototype key",
        input: {
          command: "original",
          prototype: {
            polluted: true
          }
        }
      }
    ];

    for (const testCase of cases) {
      const editTool = new RecordingTool(`edit-${testCase.label}`);
      let evaluatorCalls = 0;
      const wrapped = wrapToolWithPolicyGate(editTool, {
        toolId: "edit",
        evaluate: async () => {
          evaluatorCalls += 1;
          return { decision: "allow" };
        }
      });

      const result = await wrapped.run(createToolContext("worker"), testCase.input);

      expect(result.success).toBe(false);
      expect(result.output).toContain("policy_gate_input_preparation_failed");
      expect(result.outputSummary).toBe("Policy gate input preparation failed for edit");
      expect(evaluatorCalls).toBe(0);
      expect(editTool.calls).toBe(0);
    }
  });

  test("non-spawn input preparation rejects non-ordinary non-array inputs", async () => {
    class ClassBackedInput {
      command = "original";
    }
    const customPrototypeInput = Object.create({ inherited: true }) as Record<string, unknown>;
    customPrototypeInput.command = "original";
    const cases: Array<{ label: string; input: unknown }> = [
      {
        label: "class instance",
        input: new ClassBackedInput()
      },
      {
        label: "date",
        input: new Date("2026-07-06T00:00:00.000Z")
      },
      {
        label: "map",
        input: new Map([["command", "original"]])
      },
      {
        label: "custom prototype",
        input: customPrototypeInput
      }
    ];

    for (const testCase of cases) {
      const editTool = new RecordingTool(`edit-${testCase.label}`);
      let evaluatorCalls = 0;
      const wrapped = wrapToolWithPolicyGate(editTool, {
        toolId: "edit",
        evaluate: async () => {
          evaluatorCalls += 1;
          return { decision: "allow" };
        }
      });

      const result = await wrapped.run(createToolContext("worker"), testCase.input);

      expect(result.success).toBe(false);
      expect(result.output).toContain("policy_gate_input_preparation_failed");
      expect(result.outputSummary).toBe("Policy gate input preparation failed for edit");
      expect(evaluatorCalls).toBe(0);
      expect(editTool.calls).toBe(0);
    }
  });

  test("non-spawn input preparation rejects non-ordinary arrays", async () => {
    class ArrayBackedInput extends Array<string> {}
    const topLevelCustomPrototype = ["original"];
    Object.setPrototypeOf(topLevelCustomPrototype, {
      marker: "custom-array-prototype"
    });
    const nestedCustomPrototype = ["original"];
    Object.setPrototypeOf(nestedCustomPrototype, {
      marker: "nested-custom-array-prototype"
    });
    const cases: Array<{ label: string; input: unknown }> = [
      {
        label: "array subclass top-level",
        input: new ArrayBackedInput("original")
      },
      {
        label: "custom prototype top-level",
        input: topLevelCustomPrototype
      },
      {
        label: "array subclass nested",
        input: {
          values: new ArrayBackedInput("original")
        }
      },
      {
        label: "custom prototype nested",
        input: {
          values: nestedCustomPrototype
        }
      }
    ];

    for (const testCase of cases) {
      const editTool = new RecordingTool(`edit-${testCase.label}`);
      let evaluatorCalls = 0;
      const wrapped = wrapToolWithPolicyGate(editTool, {
        toolId: "edit",
        evaluate: async () => {
          evaluatorCalls += 1;
          return { decision: "allow" };
        }
      });

      const result = await wrapped.run(createToolContext("worker"), testCase.input);

      expect(result.success).toBe(false);
      expect(result.output).toContain("policy_gate_input_preparation_failed");
      expect(result.outputSummary).toBe("Policy gate input preparation failed for edit");
      expect(evaluatorCalls).toBe(0);
      expect(editTool.calls).toBe(0);
    }
  });

  test("oversized non-spawn inputs fail closed before evaluator and inner tool execution", async () => {
    const tailSentinel = "STRING_BUDGET_TAIL_SENTINEL";
    const cases: Array<{ label: string; input: unknown }> = [
      {
        label: "deep",
        input: createNestedPolicyGateInput(33)
      },
      {
        label: "array-length",
        input: {
          values: Array.from({ length: 1_025 }, () => "x")
        }
      },
      {
        label: "object-key-count",
        input: createObjectWithKeyCount(257)
      },
      {
        label: "node-count",
        input: createNodeDensePolicyGateInput()
      },
      {
        label: "string-budget",
        input: {
          command: `${"x".repeat(131_073)}${tailSentinel}`
        }
      }
    ];

    for (const testCase of cases) {
      const editTool = new RecordingTool("edit");
      const runningToolRegistry = new TestRunningToolRegistry();
      const toolUseId = `POLICY-BUDGET-${testCase.label}`;
      const handle = runningToolRegistry.register({
        toolUseId,
        toolName: "edit",
        abortable: false
      });
      let evaluatorCalls = 0;
      const wrapped = wrapToolWithPolicyGate(editTool, {
        evaluate: async () => {
          evaluatorCalls += 1;
          return { decision: "allow" };
        }
      });

      const result = await wrapped.run(
        {
          ...createToolContext("worker"),
          currentToolUseId: toolUseId,
          runningToolRegistry
        },
        testCase.input
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("policy_gate_input_preparation_failed");
      expect(result.output).not.toContain(tailSentinel);
      expect(result.outputSummary).toBe("Policy gate input preparation failed for edit");
      expect(evaluatorCalls).toBe(0);
      expect(editTool.calls).toBe(0);
      expect(handle.getState()).toBe("finished");
      expect(handle.getTerminalMetadata()).toMatchObject({
        cause: "completed",
        success: false,
        outputSummary: result.outputSummary
      });
    }
  });

  test("non-spawn execution snapshots preserve ordinary plain-object compatibility", async () => {
    const editTool = new RecordingTool("edit");
    const input = {
      command: "original",
      nested: {
        flag: "original"
      },
      values: ["alpha", "beta"]
    };
    let evaluatorInputPrototype: object | null | undefined;
    let evaluatorNestedPrototype: object | null | undefined;
    let evaluatorInputExtensible: boolean | undefined;
    let evaluatorNestedExtensible: boolean | undefined;
    let evaluatorArrayPrototype: object | null | undefined;
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async (call) => {
        const evaluatorInput = call.input as { nested: object; values: unknown[] };
        evaluatorInputPrototype = Object.getPrototypeOf(evaluatorInput);
        evaluatorNestedPrototype = Object.getPrototypeOf(evaluatorInput.nested);
        evaluatorInputExtensible = Object.isExtensible(evaluatorInput);
        evaluatorNestedExtensible = Object.isExtensible(evaluatorInput.nested);
        evaluatorArrayPrototype = Object.getPrototypeOf(evaluatorInput.values);
        return { decision: "allow" };
      }
    });

    const result = await wrapped.run(createToolContext("worker"), input);

    expect(result.success).toBe(true);
    expect(editTool.calls).toBe(1);
    const executionInput = editTool.lastInput as {
      command?: unknown;
      nested?: { flag?: unknown; hasOwnProperty?: (key: string) => boolean };
      values?: string[];
      hasOwnProperty?: (key: string) => boolean;
    };
    expect(Object.getPrototypeOf(executionInput)).toBe(Object.prototype);
    expect(executionInput instanceof Object).toBe(true);
    expect(executionInput.hasOwnProperty?.("command")).toBe(true);
    expect(Object.getPrototypeOf(executionInput.nested as object)).toBe(Object.prototype);
    expect(executionInput.nested instanceof Object).toBe(true);
    expect(executionInput.nested?.hasOwnProperty?.("flag")).toBe(true);
    expect(Array.isArray(executionInput.values)).toBe(true);
    expect(Object.getPrototypeOf(executionInput.values as object)).toBe(Array.prototype);
    expect(evaluatorInputPrototype).toBeNull();
    expect(evaluatorNestedPrototype).toBeNull();
    expect(evaluatorInputExtensible).toBe(false);
    expect(evaluatorNestedExtensible).toBe(false);
    expect(evaluatorArrayPrototype).not.toBe(Array.prototype);
  });

  test("non-spawn evaluator direct mutations are isolated from inner execution", async () => {
    const cases: Array<{ label: string; mutate: (input: unknown) => void }> = [
      {
        label: "top-level",
        mutate(input) {
          (input as { command: string }).command = "mutated";
        }
      },
      {
        label: "nested",
        mutate(input) {
          (input as { nested: { flag: string } }).nested.flag = "mutated";
        }
      },
      {
        label: "descriptor-nested",
        mutate(input) {
          const nested = Object.getOwnPropertyDescriptor(input as object, "nested")?.value as {
            flag: string;
          };
          nested.flag = "mutated";
        }
      },
      {
        label: "array-element",
        mutate(input) {
          (input as { values: string[] }).values[0] = "mutated";
        }
      }
    ];

    for (const testCase of cases) {
      const editTool = new RecordingTool("edit");
      const input = {
        command: "original",
        nested: {
          flag: "original"
        },
        values: ["original"]
      };
      const wrapped = wrapToolWithPolicyGate(editTool, {
        evaluate: async (call) => {
          testCase.mutate(call.input);
          return { decision: "allow" };
        }
      });

      const result = await wrapped.run(createToolContext("worker"), input);

      expect(result.success).toBe(true);
      expect(editTool.calls).toBe(1);
      expect((editTool.lastInput as { command?: unknown }).command).toBe("original");
      expect((editTool.lastInput as { nested?: { flag?: unknown } }).nested?.flag).toBe(
        "original"
      );
      expect((editTool.lastInput as { values?: string[] }).values).toEqual(["original"]);
      expect(input).toEqual({
        command: "original",
        nested: {
          flag: "original"
        },
        values: ["original"]
      });
    }
  });

  test("unsupported non-spawn evaluator array push fails closed without inner execution", async () => {
    const editTool = new RecordingTool("edit");
    const runningToolRegistry = new TestRunningToolRegistry();
    const handle = runningToolRegistry.register({
      toolUseId: "POLICY-UNSUPPORTED-PUSH-1",
      toolName: "edit",
      abortable: false
    });
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async (call) => {
        (call.input as { values: string[] }).values.push("mutated");
        return { decision: "allow" };
      }
    });

    const result = await wrapped.run(
      {
        ...createToolContext("worker"),
        currentToolUseId: "POLICY-UNSUPPORTED-PUSH-1",
        runningToolRegistry
      },
      {
        values: ["original"]
      }
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("push");
    expect(result.outputSummary).toContain("Error:");
    expect(editTool.calls).toBe(0);
    expect(handle.getState()).toBe("finished");
    expect(handle.getTerminalMetadata()).toMatchObject({
      cause: "completed",
      success: false,
      outputSummary: result.outputSummary
    });
  });

  test("honest non-spawn evaluator can structuredClone input before allowing", async () => {
    const editTool = new RecordingTool("edit");
    const input = {
      command: "original",
      nested: {
        flag: "original"
      },
      values: ["alpha", "beta"]
    };
    let evaluatorClone: unknown;
    let evaluatorArrayReads:
      | {
          iterated: string[];
          spread: string[];
          includesBeta: boolean;
          mapped: string[];
          pushValue: unknown;
          filterValue: unknown;
        }
      | undefined;
    let evaluatorInputPrototype: object | null | undefined;
    let evaluatorNestedPrototype: object | null | undefined;
    let evaluatorArrayPrototype: object | null | undefined;
    let evaluatorArrayParentPrototype: object | null | undefined;
    let evaluatorArrayConstructor: unknown;
    let evaluatorArrayMapFunctionPrototype: object | null | undefined;
    let evaluatorMapResultPrototype: object | null | undefined;
    let evaluatorMapResultParentPrototype: object | null | undefined;
    let evaluatorIteratorPrototype: object | null | undefined;
    let evaluatorIteratorNextPrototype: object | null | undefined;
    let evaluatorInputExtensible: boolean | undefined;
    let evaluatorNestedExtensible: boolean | undefined;
    let evaluatorArrayExtensible: boolean | undefined;
    let evaluatorMapResultExtensible: boolean | undefined;
    let evaluatorArrayLengthWritable: boolean | undefined;
    let evaluatorMapResultLengthWritable: boolean | undefined;
    let evaluatorArrayPrototypeFrozen: boolean | undefined;
    let evaluatorArrayMapFunctionFrozen: boolean | undefined;
    let evaluatorIteratorFrozen: boolean | undefined;
    let evaluatorIteratorNextFunctionFrozen: boolean | undefined;
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async (call) => {
        evaluatorClone = structuredClone(call.input);
        const values = (call.input as { values: string[] }).values;
        const iterated: string[] = [];
        for (const value of values) {
          iterated.push(value);
        }
        const mapped = values.map((value) => value.toUpperCase());
        const iterator = values[Symbol.iterator]();
        evaluatorArrayReads = {
          iterated,
          spread: [...values],
          includesBeta: values.includes("beta"),
          mapped,
          pushValue: (values as { push?: unknown }).push,
          filterValue: (values as { filter?: unknown }).filter
        };
        evaluatorInputPrototype = Object.getPrototypeOf(call.input as object);
        evaluatorNestedPrototype = Object.getPrototypeOf(
          (call.input as { nested: object }).nested
        );
        evaluatorInputExtensible = Object.isExtensible(call.input as object);
        evaluatorNestedExtensible = Object.isExtensible((call.input as { nested: object }).nested);
        evaluatorArrayExtensible = Object.isExtensible(values);
        evaluatorMapResultExtensible = Object.isExtensible(mapped);
        evaluatorArrayLengthWritable = Object.getOwnPropertyDescriptor(values, "length")?.writable;
        evaluatorMapResultLengthWritable = Object.getOwnPropertyDescriptor(
          mapped,
          "length"
        )?.writable;
        evaluatorArrayPrototype = Object.getPrototypeOf(values);
        evaluatorArrayPrototypeFrozen =
          evaluatorArrayPrototype === null ? undefined : Object.isFrozen(evaluatorArrayPrototype);
        evaluatorArrayParentPrototype =
          evaluatorArrayPrototype === null ? null : Object.getPrototypeOf(evaluatorArrayPrototype);
        evaluatorArrayConstructor = (values as { constructor?: unknown }).constructor;
        evaluatorArrayMapFunctionPrototype =
          evaluatorArrayPrototype === null
            ? null
            : Object.getPrototypeOf(
                (evaluatorArrayPrototype as Record<PropertyKey, unknown>).map as object
              );
        evaluatorArrayMapFunctionFrozen =
          evaluatorArrayPrototype === null
            ? undefined
            : Object.isFrozen(
                (evaluatorArrayPrototype as Record<PropertyKey, unknown>).map as object
              );
        evaluatorMapResultPrototype = Object.getPrototypeOf(mapped);
        evaluatorMapResultParentPrototype =
          evaluatorMapResultPrototype === null
            ? null
            : Object.getPrototypeOf(evaluatorMapResultPrototype);
        evaluatorIteratorPrototype = Object.getPrototypeOf(iterator as object);
        evaluatorIteratorFrozen = Object.isFrozen(iterator as object);
        evaluatorIteratorNextPrototype = Object.getPrototypeOf(
          (iterator as { next: () => IteratorResult<string> }).next
        );
        evaluatorIteratorNextFunctionFrozen = Object.isFrozen(
          (iterator as { next: () => IteratorResult<string> }).next
        );
        return { decision: "allow" };
      }
    });

    const result = await wrapped.run(createToolContext("worker"), input);

    expect(result.success).toBe(true);
    expect(evaluatorClone).toEqual({
      command: "original",
      nested: {
        flag: "original"
      },
      values: ["alpha", "beta"]
    });
    expect(evaluatorArrayReads).toEqual({
      iterated: ["alpha", "beta"],
      spread: ["alpha", "beta"],
      includesBeta: true,
      mapped: ["ALPHA", "BETA"],
      pushValue: undefined,
      filterValue: undefined
    });
    expect(evaluatorInputPrototype).toBeNull();
    expect(evaluatorNestedPrototype).toBeNull();
    expect(evaluatorInputExtensible).toBe(false);
    expect(evaluatorNestedExtensible).toBe(false);
    expect(evaluatorArrayExtensible).toBe(false);
    expect(evaluatorMapResultExtensible).toBe(false);
    expect(evaluatorArrayLengthWritable).toBe(false);
    expect(evaluatorMapResultLengthWritable).toBe(false);
    expect(evaluatorArrayPrototype).not.toBeNull();
    expect(evaluatorArrayPrototype).not.toBe(Array.prototype);
    expect(evaluatorArrayPrototypeFrozen).toBe(true);
    expect(evaluatorArrayParentPrototype).toBeNull();
    expect(evaluatorArrayConstructor).toBeUndefined();
    expect(evaluatorArrayMapFunctionPrototype).toBeNull();
    expect(evaluatorArrayMapFunctionFrozen).toBe(true);
    expect(evaluatorMapResultPrototype).not.toBeNull();
    expect(evaluatorMapResultPrototype).not.toBe(Array.prototype);
    expect(evaluatorMapResultParentPrototype).toBeNull();
    expect(evaluatorIteratorPrototype).toBeNull();
    expect(evaluatorIteratorFrozen).toBe(true);
    expect(evaluatorIteratorNextPrototype).toBeNull();
    expect(evaluatorIteratorNextFunctionFrozen).toBe(true);
    expect(editTool.calls).toBe(1);
    expect((editTool.lastInput as { command?: unknown }).command).toBe("original");
    expect((editTool.lastInput as { nested?: { flag?: unknown } }).nested?.flag).toBe("original");
    const executionValues = (editTool.lastInput as { values?: string[] }).values;
    expect(executionValues?.[0]).toBe("alpha");
    expect(Array.isArray(executionValues)).toBe(true);
    expect(executionValues?.includes("beta")).toBe(true);
    expect(executionValues?.map((value) => value.toUpperCase())).toEqual(["ALPHA", "BETA"]);
    expect(Object.getPrototypeOf(editTool.lastInput as object)).toBe(Object.prototype);
    expect(
      Object.getPrototypeOf((editTool.lastInput as { nested: object }).nested)
    ).toBe(Object.prototype);
    expect(editTool.lastInput).not.toBe(input);
    expect((editTool.lastInput as { nested: unknown }).nested).not.toBe(input.nested);
  });

  test("non-spawn evaluator array length growth attempts keep supported reads bounded", async () => {
    const editTool = new RecordingTool("edit");
    const inflatedLength = 2_048;
    let observation:
      | {
          valuesLengthSetSucceeded: boolean;
          mappedLengthSetSucceeded: boolean;
          valuesLength: number;
          mappedLength: number;
          valuesLengthWritable: boolean | undefined;
          mappedLengthWritable: boolean | undefined;
          valuesIncludesMissing: boolean;
          mappedIncludesMissing: boolean;
          valuesMapLength: number;
          mappedMapLength: number;
          valuesSpreadLength: number;
          mappedSpreadLength: number;
          valuesIteratorCount: number;
          mappedIteratorCount: number;
          valuesMapCallbacks: number;
          mappedMapCallbacks: number;
        }
      | undefined;
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async (call) => {
        const values = (call.input as { values: string[] }).values;
        const mapped = values.map((value) => value);
        values[0] = "evaluator-local";
        mapped[0] = "mapped-local";

        const valuesLengthSetSucceeded = attemptMutation(() => {
          values.length = inflatedLength;
        });
        const mappedLengthSetSucceeded = attemptMutation(() => {
          mapped.length = inflatedLength;
        });

        let valuesMapCallbacks = 0;
        const valuesMappedAfterGrowth = values.map((value) => {
          valuesMapCallbacks += 1;
          return value;
        });
        let mappedMapCallbacks = 0;
        const mappedAfterGrowth = mapped.map((value) => {
          mappedMapCallbacks += 1;
          return value;
        });
        let valuesIteratorCount = 0;
        for (const _value of values) {
          valuesIteratorCount += 1;
        }
        let mappedIteratorCount = 0;
        for (const _value of mapped) {
          mappedIteratorCount += 1;
        }

        observation = {
          valuesLengthSetSucceeded,
          mappedLengthSetSucceeded,
          valuesLength: values.length,
          mappedLength: mapped.length,
          valuesLengthWritable: Object.getOwnPropertyDescriptor(values, "length")?.writable,
          mappedLengthWritable: Object.getOwnPropertyDescriptor(mapped, "length")?.writable,
          valuesIncludesMissing: values.includes("missing-after-growth"),
          mappedIncludesMissing: mapped.includes("missing-after-growth"),
          valuesMapLength: valuesMappedAfterGrowth.length,
          mappedMapLength: mappedAfterGrowth.length,
          valuesSpreadLength: [...values].length,
          mappedSpreadLength: [...mapped].length,
          valuesIteratorCount,
          mappedIteratorCount,
          valuesMapCallbacks,
          mappedMapCallbacks
        };
        return { decision: "allow" };
      }
    });

    const result = await wrapped.run(createToolContext("worker"), { values: ["alpha", "beta"] });

    expect(result.success).toBe(true);
    expect(editTool.calls).toBe(1);
    expect(observation).toEqual({
      valuesLengthSetSucceeded: expect.any(Boolean),
      mappedLengthSetSucceeded: expect.any(Boolean),
      valuesLength: 2,
      mappedLength: 2,
      valuesLengthWritable: false,
      mappedLengthWritable: false,
      valuesIncludesMissing: false,
      mappedIncludesMissing: false,
      valuesMapLength: 2,
      mappedMapLength: 2,
      valuesSpreadLength: 2,
      mappedSpreadLength: 2,
      valuesIteratorCount: 2,
      mappedIteratorCount: 2,
      valuesMapCallbacks: 2,
      mappedMapCallbacks: 2
    });
    expect((editTool.lastInput as { values?: string[] }).values).toEqual(["alpha", "beta"]);
  });

  test("non-spawn evaluator prototype mutation paths cannot affect inner execution", async () => {
    const editTool = new RecordingTool("edit");
    const objectPrototypeSentinel = "__policyGateObjectPrototypeResidue";
    const functionPrototypeSentinel = "__policyGateFunctionPrototypeResidue";
    const arrayPrototypeSentinel = "__policyGateArrayPrototypeResidue";
    const arrayMethodSentinel = "__policyGateArrayMethodResidue";
    const mapResultPrototypeSentinel = "__policyGateMapResultPrototypeResidue";
    const iteratorPrototypeSentinel = "__policyGateIteratorPrototypeResidue";
    const iteratorFunctionSentinel = "__policyGateIteratorFunctionResidue";
    const arrayConstructorSentinel = "__policyGateArrayConstructorResidue";
    let constructorPrototypePathReachable: boolean | undefined;
    let topReparentSucceeded: boolean | undefined;
    let nestedReparentSucceeded: boolean | undefined;
    let arrayReparentSucceeded: boolean | undefined;
    let arrayPrototypeReparentSucceeded: boolean | undefined;
    let arrayMethodFunctionReparentSucceeded: boolean | undefined;
    let iteratorReparentSucceeded: boolean | undefined;
    let iteratorNextFunctionReparentSucceeded: boolean | undefined;
    let mapResultArrayReparentSucceeded: boolean | undefined;
    let mapResultPrototypeReparentSucceeded: boolean | undefined;
    let mapResultMethodFunctionReparentSucceeded: boolean | undefined;
    let arrayMethodFunctionPrototype: object | null | undefined;
    let iteratorPrototype: object | null | undefined;
    let iteratorNextFunctionPrototype: object | null | undefined;
    const input = {
      command: "original",
      nested: {
        flag: "original"
      },
      values: ["original"]
    };
    const originalArrayPrototypeMapPrototype = Object.getPrototypeOf(Array.prototype.map);
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async (call) => {
        topReparentSucceeded = attemptMutation(() => {
          Object.setPrototypeOf(call.input as object, Object.prototype);
        });
        const topPrototype = Object.getPrototypeOf(call.input as object) as
          | Record<string, unknown>
          | null;
        if (topPrototype) {
          topPrototype[objectPrototypeSentinel] = "mutated";
        }

        const values = (call.input as { values: unknown[] }).values;
        const constructorValue = (values as { constructor?: unknown }).constructor;
        constructorPrototypePathReachable = constructorValue !== undefined && constructorValue !== null;
        if (constructorPrototypePathReachable) {
          const constructorFunctionPrototype = Object.getPrototypeOf(constructorValue as object) as
            | Record<string, unknown>
            | null;
          if (constructorFunctionPrototype) {
            constructorFunctionPrototype[functionPrototypeSentinel] = "mutated";
          }
        }

        const nestedPrototype = Object.getPrototypeOf(
          (call.input as { nested: object }).nested
        ) as Record<string, unknown> | null;
        nestedReparentSucceeded = attemptMutation(() => {
          Object.setPrototypeOf((call.input as { nested: object }).nested, Object.prototype);
        });
        if (nestedPrototype) {
          nestedPrototype[objectPrototypeSentinel] = "mutated";
        }

        const arrayPrototype = Object.getPrototypeOf(values) as Record<PropertyKey, unknown> | null;
        if (arrayPrototype) {
          arrayPrototypeReparentSucceeded = attemptMutation(() => {
            Object.setPrototypeOf(arrayPrototype, Array.prototype);
          });
          attemptMutation(() => {
            arrayPrototype[arrayPrototypeSentinel] = "mutated";
          });
          const mapMethod = arrayPrototype.map as Record<string, unknown> | undefined;
          if (mapMethod) {
            attemptMutation(() => {
              mapMethod[arrayMethodSentinel] = "mutated";
            });
            arrayMethodFunctionPrototype = Object.getPrototypeOf(mapMethod as object);
            arrayMethodFunctionReparentSucceeded = attemptMutation(() => {
              Object.setPrototypeOf(mapMethod as object, Function.prototype);
            });
            attemptMutation(() => {
              if (arrayMethodFunctionPrototype) {
                (arrayMethodFunctionPrototype as Record<string, unknown>)[
                  functionPrototypeSentinel
                ] = "mutated";
              }
            });
          }
        }

        const mappedValues = values.map((value) => value);
        const mappedPrototype = Object.getPrototypeOf(mappedValues) as
          | Record<string, unknown>
          | null;
        mapResultArrayReparentSucceeded = attemptMutation(() => {
          Object.setPrototypeOf(mappedValues, Array.prototype);
        });
        if (mappedPrototype) {
          mapResultPrototypeReparentSucceeded = attemptMutation(() => {
            Object.setPrototypeOf(mappedPrototype, Array.prototype);
          });
          attemptMutation(() => {
            mappedPrototype[mapResultPrototypeSentinel] = "mutated";
          });
          const mappedMapMethod = mappedPrototype.map as object | undefined;
          if (mappedMapMethod) {
            mapResultMethodFunctionReparentSucceeded = attemptMutation(() => {
              Object.setPrototypeOf(mappedMapMethod, Function.prototype);
            });
            attemptMutation(() => {
              (mappedMapMethod as Record<string, unknown>)[arrayMethodSentinel] = "mutated";
            });
          }
        }

        const iterator = values[Symbol.iterator]();
        iteratorPrototype = Object.getPrototypeOf(iterator as object);
        iteratorReparentSucceeded = attemptMutation(() => {
          Object.setPrototypeOf(iterator as object, Object.prototype);
        });
        if (iteratorPrototype) {
          attemptMutation(() => {
            (iteratorPrototype as Record<string, unknown>)[iteratorPrototypeSentinel] = "mutated";
          });
        }
        iteratorNextFunctionPrototype = Object.getPrototypeOf(
          (iterator as { next: () => IteratorResult<unknown> }).next
        );
        iteratorNextFunctionReparentSucceeded = attemptMutation(() => {
          Object.setPrototypeOf(
            (iterator as { next: () => IteratorResult<unknown> }).next,
            Function.prototype
          );
        });
        attemptMutation(() => {
          (iterator as Record<PropertyKey, unknown>)[iteratorPrototypeSentinel] = "mutated";
        });
        attemptMutation(() => {
          ((iterator as { next: () => IteratorResult<unknown> }).next as unknown as Record<
            string,
            unknown
          >)[iteratorFunctionSentinel] = "mutated";
        });
        attemptMutation(() => {
          if (iteratorNextFunctionPrototype) {
            (iteratorNextFunctionPrototype as Record<string, unknown>)[
              functionPrototypeSentinel
            ] = "mutated";
          }
        });
        arrayReparentSucceeded = attemptMutation(() => {
          Object.setPrototypeOf(values, Array.prototype);
        });
        const reparentedArrayPrototype = Object.getPrototypeOf(values) as Record<
          PropertyKey,
          unknown
        > | null;
        if (reparentedArrayPrototype) {
          attemptMutation(() => {
            reparentedArrayPrototype[arrayPrototypeSentinel] = "mutated";
          });
          attemptMutation(() => {
            (reparentedArrayPrototype.map as Record<string, unknown>)[arrayMethodSentinel] =
              "mutated";
          });
        }
        const reparentedConstructor = (values as { constructor?: unknown }).constructor;
        if (typeof reparentedConstructor === "function") {
          attemptMutation(() => {
            (reparentedConstructor as unknown as Record<string, unknown>)[
              arrayConstructorSentinel
            ] = "mutated";
          });
          attemptMutation(() => {
            (Object.getPrototypeOf(reparentedConstructor) as Record<string, unknown>)[
              functionPrototypeSentinel
            ] = "mutated";
          });
        }
        return { decision: "allow" };
      }
    });

    try {
      const result = await wrapped.run(createToolContext("worker"), input);

      expect(result.success).toBe(true);
      expect(editTool.calls).toBe(1);
      expect((editTool.lastInput as { command?: unknown }).command).toBe("original");
      expect((editTool.lastInput as { nested?: { flag?: unknown } }).nested?.flag).toBe(
        "original"
      );
      expect((editTool.lastInput as { values?: string[] }).values?.[0]).toBe("original");
      expect((Object.prototype as Record<string, unknown>)[objectPrototypeSentinel]).toBeUndefined();
      expect(
        (Object.prototype as Record<string, unknown>)[functionPrototypeSentinel]
      ).toBeUndefined();
      expect((Array.prototype as Record<string, unknown>)[arrayPrototypeSentinel]).toBeUndefined();
      expect(
        (Array.prototype as Record<string, unknown>)[mapResultPrototypeSentinel]
      ).toBeUndefined();
      expect((Array.prototype.map as Record<string, unknown>)[arrayMethodSentinel]).toBeUndefined();
      expect((Array as unknown as Record<string, unknown>)[arrayConstructorSentinel]).toBeUndefined();
      expect((Function.prototype as Record<string, unknown>)[functionPrototypeSentinel]).toBeUndefined();
      expect(constructorPrototypePathReachable).toBe(false);
      expect(topReparentSucceeded).toBe(false);
      expect(nestedReparentSucceeded).toBe(false);
      expect(arrayReparentSucceeded).toBe(false);
      expect(arrayPrototypeReparentSucceeded).toBe(false);
      expect(arrayMethodFunctionReparentSucceeded).toBe(false);
      expect(iteratorReparentSucceeded).toBe(false);
      expect(iteratorNextFunctionReparentSucceeded).toBe(false);
      expect(mapResultArrayReparentSucceeded).toBe(false);
      expect(mapResultPrototypeReparentSucceeded).toBe(false);
      expect(mapResultMethodFunctionReparentSucceeded).toBe(false);
      expect(arrayMethodFunctionPrototype).toBeNull();
      expect(iteratorPrototype).toBeNull();
      expect(iteratorNextFunctionPrototype).toBeNull();
      expect(Object.getPrototypeOf(Array.prototype.map)).toBe(originalArrayPrototypeMapPrototype);
    } finally {
      delete (Object.prototype as Record<string, unknown>)[objectPrototypeSentinel];
      delete (Object.prototype as Record<string, unknown>)[functionPrototypeSentinel];
      delete (Array.prototype as Record<string, unknown>)[arrayPrototypeSentinel];
      delete (Array.prototype as Record<string, unknown>)[mapResultPrototypeSentinel];
      delete (Array.prototype.map as Record<string, unknown>)[arrayMethodSentinel];
      delete (Array as unknown as Record<string, unknown>)[arrayConstructorSentinel];
      delete (Function.prototype as Record<string, unknown>)[functionPrototypeSentinel];
    }
  });

  test("non-spawn evaluator iterator result objects cannot create global prototype residue", async () => {
    const editTool = new RecordingTool("edit");
    const iteratorResultSentinel = "__policyGateIteratorResultGlobalResidue";
    const blockedReparents = {
      object: false,
      array: false,
      function: false
    };
    let observation:
      | {
          valuesYieldedReparents: GlobalPrototypeReparentOutcomes;
          valuesDoneReparents: GlobalPrototypeReparentOutcomes;
          mappedYieldedReparents: GlobalPrototypeReparentOutcomes;
          mappedDoneReparents: GlobalPrototypeReparentOutcomes;
          valuesYieldedFrozen: boolean;
          valuesDoneFrozen: boolean;
          mappedYieldedFrozen: boolean;
          mappedDoneFrozen: boolean;
          valuesYieldedValue: unknown;
          valuesDoneDone: boolean | undefined;
          mappedYieldedValue: unknown;
          mappedDoneDone: boolean | undefined;
          residueBeforeAllow: GlobalPrototypeResidueObservation;
        }
      | undefined;
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async (call) => {
        const values = (call.input as { values: string[] }).values;
        const mapped = values.map((value) => value);
        const valuesIterator = values[Symbol.iterator]();
        const valuesYieldedResult = valuesIterator.next();
        const valuesDoneResult = valuesIterator.next();
        const mappedIterator = mapped[Symbol.iterator]();
        const mappedYieldedResult = mappedIterator.next();
        const mappedDoneResult = mappedIterator.next();

        observation = {
          valuesYieldedReparents: attemptGlobalPrototypeReparents(
            valuesYieldedResult as object,
            iteratorResultSentinel
          ),
          valuesDoneReparents: attemptGlobalPrototypeReparents(
            valuesDoneResult as object,
            iteratorResultSentinel
          ),
          mappedYieldedReparents: attemptGlobalPrototypeReparents(
            mappedYieldedResult as object,
            iteratorResultSentinel
          ),
          mappedDoneReparents: attemptGlobalPrototypeReparents(
            mappedDoneResult as object,
            iteratorResultSentinel
          ),
          valuesYieldedFrozen: Object.isFrozen(valuesYieldedResult as object),
          valuesDoneFrozen: Object.isFrozen(valuesDoneResult as object),
          mappedYieldedFrozen: Object.isFrozen(mappedYieldedResult as object),
          mappedDoneFrozen: Object.isFrozen(mappedDoneResult as object),
          valuesYieldedValue: valuesYieldedResult.value,
          valuesDoneDone: valuesDoneResult.done,
          mappedYieldedValue: mappedYieldedResult.value,
          mappedDoneDone: mappedDoneResult.done,
          residueBeforeAllow: readGlobalPrototypeResidue(iteratorResultSentinel)
        };
        return { decision: "allow" };
      }
    });

    try {
      const result = await wrapped.run(createToolContext("worker"), { values: ["original"] });

      expect(result.success).toBe(true);
      expect(editTool.calls).toBe(1);
      expect(observation).toEqual({
        valuesYieldedReparents: blockedReparents,
        valuesDoneReparents: blockedReparents,
        mappedYieldedReparents: blockedReparents,
        mappedDoneReparents: blockedReparents,
        valuesYieldedFrozen: true,
        valuesDoneFrozen: true,
        mappedYieldedFrozen: true,
        mappedDoneFrozen: true,
        valuesYieldedValue: "original",
        valuesDoneDone: true,
        mappedYieldedValue: "original",
        mappedDoneDone: true,
        residueBeforeAllow: {
          object: undefined,
          array: undefined,
          function: undefined
        }
      });
      expect(readGlobalPrototypeResidue(iteratorResultSentinel)).toEqual({
        object: undefined,
        array: undefined,
        function: undefined
      });
      expect((editTool.lastInput as { values?: string[] }).values).toEqual(["original"]);
    } finally {
      deleteGlobalPrototypeResidue(iteratorResultSentinel);
    }
  });

  test("non-spawn evaluator arrays cannot create Array.prototype residue through reparenting", async () => {
    const editTool = new RecordingTool("edit");
    const arrayPrototypeSentinel = "__policyGateInputDerivedArrayPrototypeResidue";
    let valuesReparentSucceeded: boolean | undefined;
    let mapResultReparentSucceeded: boolean | undefined;
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async (call) => {
        const values = (call.input as { values: string[] }).values;
        valuesReparentSucceeded = attemptMutation(() => {
          Object.setPrototypeOf(values, Array.prototype);
        });
        const valuesPrototype = Object.getPrototypeOf(values) as Record<PropertyKey, unknown> | null;
        if (valuesPrototype) {
          attemptMutation(() => {
            valuesPrototype[arrayPrototypeSentinel] = "mutated";
          });
        }

        const mappedValues = values.map((value) => value);
        mapResultReparentSucceeded = attemptMutation(() => {
          Object.setPrototypeOf(mappedValues, Array.prototype);
        });
        const mappedPrototype = Object.getPrototypeOf(mappedValues) as
          | Record<PropertyKey, unknown>
          | null;
        if (mappedPrototype) {
          attemptMutation(() => {
            mappedPrototype[arrayPrototypeSentinel] = "mutated";
          });
        }

        return { decision: "allow" };
      }
    });

    try {
      const result = await wrapped.run(createToolContext("worker"), { values: ["original"] });

      expect(result.success).toBe(true);
      expect(editTool.calls).toBe(1);
      expect(valuesReparentSucceeded).toBe(false);
      expect(mapResultReparentSucceeded).toBe(false);
      expect(
        (Array.prototype as Record<string, unknown>)[arrayPrototypeSentinel]
      ).toBeUndefined();
    } finally {
      delete (Array.prototype as Record<string, unknown>)[arrayPrototypeSentinel];
    }
  });

  test("non-spawn evaluator exposed methods and prototypes do not retain cross-call residue", async () => {
    const editTool = new RecordingTool("edit");
    const prototypeSentinel = "__policyGateCrossCallPrototypeResidue";
    const methodSentinel = "__policyGateCrossCallMethodResidue";
    const iteratorSentinel = "__policyGateCrossCallIteratorResidue";
    const iteratorResultSentinel = "__policyGateCrossCallIteratorResultResidue";
    let evaluatorCalls = 0;
    let secondObservation:
      | {
          arrayPrototypeResidue: unknown;
          arrayMethodResidue: unknown;
          mapResultPrototypeResidue: unknown;
          mapResultMethodResidue: unknown;
          iteratorResidue: unknown;
          iteratorNextResidue: unknown;
          iteratorResultResidue: unknown;
          iteratorDoneResultResidue: unknown;
          mapResultIteratorResultResidue: unknown;
          mapResultIteratorDoneResultResidue: unknown;
          globalIteratorResultResidue: GlobalPrototypeResidueObservation;
        }
      | undefined;
    const wrapped = wrapToolWithPolicyGate(editTool, {
      evaluate: async (call) => {
        evaluatorCalls += 1;
        const values = (call.input as { values: unknown[] }).values;
        const arrayPrototype = Object.getPrototypeOf(values) as Record<PropertyKey, unknown>;
        const arrayMapMethod = arrayPrototype.map as Record<string, unknown>;
        const mapped = values.map((value) => value);
        const mapResultPrototype = Object.getPrototypeOf(mapped) as Record<PropertyKey, unknown>;
        const mapResultMapMethod = mapResultPrototype.map as Record<string, unknown>;
        const iterator = values[Symbol.iterator]() as IterableIterator<unknown> &
          Record<string, unknown>;
        const iteratorNext = iterator.next as unknown as Record<string, unknown>;
        const iteratorYieldedResult = iterator.next() as IteratorResult<unknown> &
          Record<string, unknown>;
        const iteratorDoneResult = iterator.next() as IteratorResult<unknown> &
          Record<string, unknown>;
        const mapResultIterator = mapped[Symbol.iterator]() as IterableIterator<unknown>;
        const mapResultIteratorYieldedResult = mapResultIterator.next() as IteratorResult<unknown> &
          Record<string, unknown>;
        const mapResultIteratorDoneResult = mapResultIterator.next() as IteratorResult<unknown> &
          Record<string, unknown>;

        if (evaluatorCalls === 1) {
          attemptMutation(() => {
            arrayPrototype[prototypeSentinel] = "mutated";
          });
          attemptMutation(() => {
            arrayMapMethod[methodSentinel] = "mutated";
          });
          attemptMutation(() => {
            mapResultPrototype[prototypeSentinel] = "mutated";
          });
          attemptMutation(() => {
            mapResultMapMethod[methodSentinel] = "mutated";
          });
          attemptMutation(() => {
            iterator[iteratorSentinel] = "mutated";
          });
          attemptMutation(() => {
            iteratorNext[iteratorSentinel] = "mutated";
          });
          attemptMutation(() => {
            iteratorYieldedResult[iteratorResultSentinel] = "mutated";
          });
          attemptMutation(() => {
            iteratorDoneResult[iteratorResultSentinel] = "mutated";
          });
          attemptMutation(() => {
            mapResultIteratorYieldedResult[iteratorResultSentinel] = "mutated";
          });
          attemptMutation(() => {
            mapResultIteratorDoneResult[iteratorResultSentinel] = "mutated";
          });
          attemptGlobalPrototypeReparents(iteratorYieldedResult as object, iteratorResultSentinel);
          attemptGlobalPrototypeReparents(iteratorDoneResult as object, iteratorResultSentinel);
          attemptGlobalPrototypeReparents(
            mapResultIteratorYieldedResult as object,
            iteratorResultSentinel
          );
          attemptGlobalPrototypeReparents(
            mapResultIteratorDoneResult as object,
            iteratorResultSentinel
          );
        } else {
          secondObservation = {
            arrayPrototypeResidue: arrayPrototype[prototypeSentinel],
            arrayMethodResidue: arrayMapMethod[methodSentinel],
            mapResultPrototypeResidue: mapResultPrototype[prototypeSentinel],
            mapResultMethodResidue: mapResultMapMethod[methodSentinel],
            iteratorResidue: iterator[iteratorSentinel],
            iteratorNextResidue: iteratorNext[iteratorSentinel],
            iteratorResultResidue: iteratorYieldedResult[iteratorResultSentinel],
            iteratorDoneResultResidue: iteratorDoneResult[iteratorResultSentinel],
            mapResultIteratorResultResidue:
              mapResultIteratorYieldedResult[iteratorResultSentinel],
            mapResultIteratorDoneResultResidue:
              mapResultIteratorDoneResult[iteratorResultSentinel],
            globalIteratorResultResidue: readGlobalPrototypeResidue(iteratorResultSentinel)
          };
        }

        return { decision: "allow" };
      }
    });

    try {
      const firstResult = await wrapped.run(createToolContext("worker"), { values: ["first"] });
      const secondResult = await wrapped.run(createToolContext("worker"), { values: ["second"] });

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(editTool.calls).toBe(2);
      expect(secondObservation).toEqual({
        arrayPrototypeResidue: undefined,
        arrayMethodResidue: undefined,
        mapResultPrototypeResidue: undefined,
        mapResultMethodResidue: undefined,
        iteratorResidue: undefined,
        iteratorNextResidue: undefined,
        iteratorResultResidue: undefined,
        iteratorDoneResultResidue: undefined,
        mapResultIteratorResultResidue: undefined,
        mapResultIteratorDoneResultResidue: undefined,
        globalIteratorResultResidue: {
          object: undefined,
          array: undefined,
          function: undefined
        }
      });
    } finally {
      deleteGlobalPrototypeResidue(iteratorResultSentinel);
    }
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
      const input =
        tool.name === "spawn_agent"
          ? { instruction: "Review the wrapper smoke test.", role: "reviewer", tools: ["read"] }
          : {};
      const result = await tool.run(createToolContext("coordinator"), input);
      expect(result.success).toBe(true);
      expect(isPolicyGatedTool(tool)).toBe(true);
    }

    expect(tools.map((tool) => tool.calls)).toEqual([1, 1, 1]);
  });

  test("factory-returned registry owns model-visible definitions when inner toDefinition diverges", () => {
    const tool = new DivergentDefinitionTool(
      "generic.definition",
      "generic.leaked.definition",
      "Leaked definition description without required governance sections."
    );
    const registry = createPolicyGatedToolRegistry([tool], {
      evaluate: async () => ({ decision: "allow" })
    });

    let definition = registry
      .getDefinitions()
      .find((candidate) => candidate.name === "generic.definition");
    expect(definition).toBeDefined();
    expect(definition?.name).toBe("generic.definition");
    expect(definition?.description).toBe(tool.description);
    expect(definition?.description).toContain("何时该用:");
    expect(definition?.parameters).toEqual(tool.parameters);
    expect(definition?.parameters).not.toBe(tool.parameters);
    expect(definition?.parameters).not.toEqual({ leaked: true });

    const replacement = new DivergentDefinitionTool(
      "generic.definition",
      "generic.replacement.leaked",
      "Replacement leaked definition description without required sections."
    );
    registry.register(
      wrapToolWithPolicyGate(replacement, {
        evaluate: async () => ({ decision: "allow" })
      })
    );

    definition = registry
      .getDefinitions()
      .find((candidate) => candidate.name === "generic.definition");
    expect(definition?.name).toBe("generic.definition");
    expect(definition?.description).toBe(replacement.description);
    expect(definition?.description).toContain("何时不该用:");
    expect(definition?.parameters).toEqual(replacement.parameters);
    expect(definition?.parameters).not.toBe(replacement.parameters);
  });

  test("factory-returned registry snapshots metadata against retained inner tool mutation", () => {
    const tool = new RecordingTool("generic.snapshot");
    const originalName = tool.name;
    const originalDescription = tool.description;
    const originalParameters = tool.parameters;
    const leakedParameters = {
      type: "object",
      properties: {
        leaked: {
          type: "string"
        }
      },
      additionalProperties: false
    };
    const registry = createPolicyGatedToolRegistry([tool], {
      evaluate: async () => ({ decision: "allow" })
    });

    (tool as unknown as { name: string }).name = "generic.snapshot.leaked";
    tool.description = "何时该用: This mutated description intentionally drops governance sections.";
    tool.parameters = leakedParameters;

    const definitions = registry.getDefinitions();
    const definition = definitions.find((candidate) => candidate.name === originalName);

    expect(registry.get(originalName)).toBeDefined();
    expect(registry.get("generic.snapshot.leaked")).toBeUndefined();
    expect(definition).toBeDefined();
    expect(definition?.name).toBe(originalName);
    expect(definition?.description).toBe(originalDescription);
    expect(definition?.description).toContain("何时该用:");
    expect(definition?.description).toContain("何时不该用:");
    expect(definition?.description).toContain("成功与失败样态:");
    expect(definition?.description).not.toContain("mutated description");
    expect(definition?.parameters).toEqual(originalParameters);
    expect(definition?.parameters).not.toBe(originalParameters);
    expect(definition?.parameters).not.toEqual(leakedParameters);
    expect(definitions.map((candidate) => candidate.name)).not.toContain("generic.snapshot.leaked");
  });

  test("factory-returned registry owns wrapper kind and capability snapshots", () => {
    const tool = new RecordingTool("generic.wrapper.snapshot");
    const originalKind: BaseTool["kind"] = "tool";
    const originalCapabilities = Object.freeze(["vision"]);
    tool.kind = originalKind;
    tool.requiredModelCapabilities = originalCapabilities;
    const registry = createPolicyGatedToolRegistry([tool], {
      evaluate: async () => ({ decision: "allow" })
    });

    const registered = registry.get("generic.wrapper.snapshot");
    expect(registered).toBeDefined();
    if (!registered) {
      throw new Error("generic.wrapper.snapshot should be registered");
    }

    attemptRegisteredWrapperFieldMutation(registered, {
      kind: "mcp",
      requiredModelCapabilities: ["mutated-capability"]
    });

    const listed = registry.list().find((candidate) => candidate.name === "generic.wrapper.snapshot");
    const definition = registry
      .getDefinitions()
      .find((candidate) => candidate.name === "generic.wrapper.snapshot");
    expect(listed).toBe(registered);
    expect(definition?.kind).toBe(originalKind);
    expect(registered.kind).toBe(originalKind);
    expect(listed?.kind).toBe(originalKind);
    expect(registered.requiredModelCapabilities).toEqual(originalCapabilities);
    expect(registered.requiredModelCapabilities).not.toBe(originalCapabilities);
    expect(listed?.requiredModelCapabilities).toEqual(originalCapabilities);
    expect(Object.isFrozen(registered.requiredModelCapabilities)).toBe(true);
  });

  test("factory-returned registry rejects exposed wrapper authority shadowing", async () => {
    const tool = new RecordingTool("generic.wrapper.authority");
    const originalDescription = tool.description;
    const originalParameters = tool.parameters;
    const replacementInnerTool = new RecordingTool("generic.wrapper.shadow.inner");
    const shadowParameters = {
      type: "object",
      properties: {
        leaked: {
          type: "boolean"
        }
      },
      additionalProperties: false
    };
    let evaluatorCalls = 0;
    const registry = createPolicyGatedToolRegistry([tool], {
      evaluate: async (call) => {
        evaluatorCalls += 1;
        if ((call.input as { blocked?: unknown }).blocked === true) {
          return {
            decision: "deny",
            ruleId: "registry-owned-deny",
            reason: "blocked by registry-owned evaluator",
            remediation: {
              next_action: "adjust_scope",
              hint: "Use a registry-authorized input.",
              ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
            }
          };
        }
        return { decision: "allow" };
      }
    });

    const registered = registry.get("generic.wrapper.authority");
    expect(registered).toBeDefined();
    if (!registered) {
      throw new Error("generic.wrapper.authority should be registered");
    }
    const listed = registry
      .list()
      .find((candidate) => candidate.name === "generic.wrapper.authority");
    expect(listed).toBe(registered);

    attemptRegisteredWrapperAuthorityMutation(registered, {
      name: "generic.wrapper.shadowed",
      description: "Shadowed description without governance sections.",
      parameters: shadowParameters,
      innerTool: replacementInnerTool,
      policyGateToolId: "spawn_agent",
      options: {
        evaluate: async () => ({ decision: "allow" }),
        validateExecutionInput: () => ({
          decision: "deny",
          ruleId: "shadow-validator-deny",
          reason: "shadow validator should not run",
          remediation: {
            next_action: "fix_and_retry",
            hint: "This mutated validator must not control execution.",
            ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
          }
        })
      }
    });

    expectWrapperAuthorityPropertiesHardened(registered);
    expect(registered.name).toBe("generic.wrapper.authority");
    expect(registered.description).toBe(originalDescription);
    expect(registered.parameters).toEqual(originalParameters);
    expect(registered.parameters).not.toBe(originalParameters);
    expect(isPolicyGatedTool(registered) && registered.innerTool).toBe(tool);
    expect(isPolicyGatedTool(registered) && registered.policyGateToolId).toBe(
      "generic.wrapper.authority"
    );
    expect((registered as unknown as { options?: unknown }).options).toBeUndefined();

    const definition = registry
      .getDefinitions()
      .find((candidate) => candidate.name === "generic.wrapper.authority");
    expect(definition?.name).toBe("generic.wrapper.authority");
    expect(definition?.description).toBe(originalDescription);
    expect(definition?.parameters).toEqual(originalParameters);
    expect(definition?.parameters).not.toEqual(shadowParameters);
    expect(registry.get("generic.wrapper.shadowed")).toBeUndefined();
    expect(registry.getDefinitions().map((candidate) => candidate.name)).not.toContain(
      "generic.wrapper.shadowed"
    );

    const denied = await registered.run(createToolContext("worker"), { blocked: true });
    expect(denied.success).toBe(false);
    expect(denied.output).toContain("registry-owned-deny");

    const allowed = await registered.run(createToolContext("worker"), { blocked: false });
    expect(allowed).toEqual({
      success: true,
      output: "generic.wrapper.authority executed",
      outputSummary: "generic.wrapper.authority executed"
    });
    expect(evaluatorCalls).toBe(2);
    expect(tool.calls).toBe(1);
    expect(tool.lastInput).toEqual({ blocked: false });
    expect(replacementInnerTool.calls).toBe(0);
  });

  test("generic registry lint rejects the 21st visible tool without a role", () => {
    const tools = Array.from({ length: 21 }, (_, index) => new RecordingTool(`generic.${index}`));

    expect(() =>
      createPolicyGatedToolRegistry(tools, {
        evaluate: async () => ({ decision: "allow" })
      })
    ).toThrow(
      /Policy-gated tool registration lint failed for role unknown-role: visible tool count 21 exceeds 20; excess count 1/
    );
  });

  test("factory-returned registry rejects post-return 21st wrapped tool registration", () => {
    const tools = Array.from({ length: 20 }, (_, index) => new RecordingTool(`generic.${index}`));
    const registry = createPolicyGatedToolRegistry(tools, {
      role: "worker",
      evaluate: async () => ({ decision: "allow" })
    });
    const extraTool = wrapToolWithPolicyGate(new RecordingTool("generic.20"), {
      evaluate: async () => ({ decision: "allow" })
    });

    expect(() => registry.register(extraTool)).toThrow(
      /Policy-gated tool registration lint failed for role worker: visible tool count 21 exceeds 20; excess count 1/
    );
    expect(registry.get("generic.20")).toBeUndefined();
    expect(registry.list().map((tool) => tool.name)).not.toContain("generic.20");
    expect(registry.getDefinitions().map((definition) => definition.name)).not.toContain(
      "generic.20"
    );
  });

  test("factory-returned registry rejects post-return wrapped tools with bad descriptions", () => {
    const registry = createPolicyGatedToolRegistry([new RecordingTool("generic.good")], {
      evaluate: async () => ({ decision: "allow" })
    });
    const badTool = new RecordingTool("generic.bad.description");
    badTool.description = [
      "何时该用: Use this fixture for mutation-boundary description lint.",
      "成功与失败样态: Success should never pass registry mutation validation."
    ].join("\n");
    const wrappedBadTool = wrapToolWithPolicyGate(badTool, {
      evaluate: async () => ({ decision: "allow" })
    });

    expect(() => registry.register(wrappedBadTool)).toThrow(
      /generic\.bad\.description: missing 何时不该用/
    );
    expect(registry.get("generic.bad.description")).toBeUndefined();
    expect(registry.list().map((tool) => tool.name)).not.toContain("generic.bad.description");
    expect(registry.getDefinitions().map((definition) => definition.name)).not.toContain(
      "generic.bad.description"
    );
  });

  test("factory-returned registry replacements use Zero same-name semantics without double-counting", () => {
    const tools = Array.from({ length: 20 }, (_, index) => new RecordingTool(`generic.${index}`));
    const registry = createPolicyGatedToolRegistry(tools, {
      role: "worker",
      evaluate: async () => ({ decision: "allow" })
    });
    const replacementInnerTool = new RecordingTool("generic.19");
    const replacementTool = wrapToolWithPolicyGate(replacementInnerTool, {
      evaluate: async () => ({ decision: "allow" })
    });

    expect(() => registry.register(replacementTool)).not.toThrow();
    expect(registry.list()).toHaveLength(20);
    const registeredReplacement = registry.get("generic.19");
    expect(registeredReplacement).not.toBe(replacementTool);
    expect(isPolicyGatedTool(registeredReplacement!)).toBe(true);
    if (!isPolicyGatedTool(registeredReplacement!)) {
      throw new Error("replacement should be wrapped by registry authority");
    }
    expect(registeredReplacement.innerTool).toBe(replacementInnerTool);
    expect(() => assertPolicyGatedToolRegistry(registry, { role: "worker" })).not.toThrow();

    const originalReplacementDescription = replacementInnerTool.description;
    const originalReplacementParameters = replacementInnerTool.parameters;
    const leakedReplacementParameters = {
      type: "object",
      properties: {
        replacementLeak: {
          type: "boolean"
        }
      },
      additionalProperties: false
    };
    (replacementInnerTool as unknown as { name: string }).name = "generic.19.leaked";
    replacementInnerTool.description = "何时该用: Replacement mutation drops required sections.";
    replacementInnerTool.parameters = leakedReplacementParameters;

    const replacementDefinition = registry
      .getDefinitions()
      .find((candidate) => candidate.name === "generic.19");
    expect(registry.get("generic.19")).toBe(registeredReplacement);
    expect(registry.get("generic.19.leaked")).toBeUndefined();
    expect(replacementDefinition?.name).toBe("generic.19");
    expect(replacementDefinition?.description).toBe(originalReplacementDescription);
    expect(replacementDefinition?.description).toContain("何时不该用:");
    expect(replacementDefinition?.parameters).toEqual(originalReplacementParameters);
    expect(replacementDefinition?.parameters).not.toBe(originalReplacementParameters);
    expect(replacementDefinition?.parameters).not.toEqual(leakedReplacementParameters);
  });

  test("factory-returned registry rewraps stale post-return replacements with current evaluator", async () => {
    const registry = createPolicyGatedToolRegistry([new RecordingTool("edit")], {
      evaluate: async () => ({
        decision: "deny",
        ruleId: "registry-owned-deny",
        reason: "blocked by registry-owned evaluator",
        remediation: {
          next_action: "adjust_scope",
          hint: "Use a tool allowed by the registry owner.",
          ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
        }
      })
    });
    const staleReplacementInnerTool = new RecordingTool("edit");
    const staleAllowReplacement = wrapToolWithPolicyGate(staleReplacementInnerTool, {
      evaluate: async () => ({ decision: "allow" })
    });

    expect(() => registry.register(staleAllowReplacement)).not.toThrow();
    const registeredReplacement = registry.get("edit");
    expect(registeredReplacement).not.toBe(staleAllowReplacement);
    expect(isPolicyGatedTool(registeredReplacement!)).toBe(true);

    const result = await registeredReplacement?.run(createToolContext("coder"), {});

    expect(result?.success).toBe(false);
    expect(result?.output).toContain("policy_gate_denied");
    expect(result?.output).toContain("registry-owned-deny");
    expect(staleReplacementInnerTool.calls).toBe(0);
  });

  test("factory-returned registry keeps evaluator authority after visible options mutation", async () => {
    const registry = createPolicyGatedToolRegistry([new RecordingTool("generic.authority")], {
      evaluate: async () => ({
        decision: "deny",
        ruleId: "registry-owned-deny",
        reason: "blocked by registry-owned evaluator",
        remediation: {
          next_action: "adjust_scope",
          hint: "Use a registry-authorized input.",
          ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
        }
      })
    });
    const fakeOptions = {
      evaluate: async () => ({ decision: "allow" as const })
    };
    const mutableRegistry = registry as unknown as {
      options?: typeof fakeOptions;
    };

    if (mutableRegistry.options && typeof mutableRegistry.options === "object") {
      attemptMutation(() => {
        mutableRegistry.options!.evaluate = fakeOptions.evaluate;
      });
    }
    attemptMutation(() => {
      mutableRegistry.options = fakeOptions;
    });
    attemptMutation(() => {
      Object.defineProperty(mutableRegistry, "options", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: fakeOptions
      });
    });

    const replacementTool = new RecordingTool("generic.authority");
    expect(() => registry.register(replacementTool)).not.toThrow();
    const registeredReplacement = registry.get("generic.authority");
    expect(isPolicyGatedTool(registeredReplacement!)).toBe(true);
    expect(isPolicyGatedTool(registeredReplacement!) && registeredReplacement.innerTool).toBe(
      replacementTool
    );
    expect((registry as unknown as { options?: unknown }).options).toBeUndefined();

    const result = await registeredReplacement?.run(createToolContext("worker"), {});

    expect(result?.success).toBe(false);
    expect(result?.output).toContain("policy_gate_denied");
    expect(result?.output).toContain("registry-owned-deny");
    expect(replacementTool.calls).toBe(0);
  });

  test("factory-returned registry public methods ignore inherited tools map mutation", async () => {
    const originalTool = new RecordingTool("generic.tools.authority");
    const registry = createPolicyGatedToolRegistry([originalTool], {
      evaluate: async () => ({
        decision: "deny",
        ruleId: "registry-owned-deny",
        reason: "blocked by registry-owned evaluator",
        remediation: {
          next_action: "adjust_scope",
          hint: "Use a registry-authorized input.",
          ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
        }
      })
    });
    const registeredTool = registry.get("generic.tools.authority");
    const attackerTool = new RecordingTool("generic.tools.authority");
    const injectedTool = new RecordingTool("generic.tools.injected");
    const mutableRegistry = registry as unknown as {
      tools?: Map<string, BaseTool>;
    };

    if (mutableRegistry.tools instanceof Map) {
      mutableRegistry.tools.set("generic.tools.authority", attackerTool);
      mutableRegistry.tools.set("generic.tools.injected", injectedTool);
      mutableRegistry.tools.delete("generic.tools.authority");
      mutableRegistry.tools.clear();
    }
    attemptMutation(() => {
      mutableRegistry.tools = new Map([
        ["generic.tools.authority", attackerTool],
        ["generic.tools.injected", injectedTool]
      ]);
    });

    expect(registry.get("generic.tools.authority")).toBe(registeredTool);
    expect(registry.get("generic.tools.injected")).toBeUndefined();
    expect(registry.has("generic.tools.authority")).toBe(true);
    expect(registry.has("generic.tools.injected")).toBe(false);
    expect(registry.list()).toEqual([registeredTool]);
    expect(registry.getDefinitions().map((definition) => definition.name)).toEqual([
      "generic.tools.authority"
    ]);
    expect(isPolicyGatedTool(registeredTool!)).toBe(true);

    const result = await registry
      .get("generic.tools.authority")
      ?.run(createToolContext("worker"), {});

    expect(result?.success).toBe(false);
    expect(result?.output).toContain("policy_gate_denied");
    expect(result?.output).toContain("registry-owned-deny");
    expect(originalTool.calls).toBe(0);
    expect(attackerTool.calls).toBe(0);
    expect(injectedTool.calls).toBe(0);
  });

  test("factory-returned registry wraps post-return unwrapped tool registration", () => {
    const registry = createPolicyGatedToolRegistry([new RecordingTool("generic.good")], {
      evaluate: async () => ({ decision: "allow" })
    });

    expect(() => registry.register(new RecordingTool("generic.unwrapped"))).not.toThrow();
    expect(isPolicyGatedTool(registry.get("generic.unwrapped")!)).toBe(true);
    expect(registry.getDefinitions().map((definition) => definition.name)).toContain(
      "generic.unwrapped"
    );
  });

  test("generic wrap seam rejects descriptions missing required section headings", () => {
    const badTool = new RecordingTool("generic.bad.description");
    badTool.description = [
      "何时该用: Use this fixture for generic wrap lint.",
      "成功与失败样态: Success returns a fixture result."
    ].join("\n");

    expect(() =>
      wrapAllRegisteredTools([badTool], {
        evaluate: async () => ({ decision: "allow" })
      })
    ).toThrow(/generic\.bad\.description: missing 何时不该用/);
  });

  test("direct spawn wrapper executes only sanitized spawn input", async () => {
    const spawnTool = new RecordingTool("spawn_agent");
    const tailSentinel = "ignored-tail-sentinel-that-must-not-appear";
    let evaluatorInput: unknown;
    const wrapped = wrapToolWithPolicyGate(spawnTool, {
      toolId: "spawn_agent",
      evaluate: async (call) => {
        evaluatorInput = call.input;
        return { decision: "allow" };
      }
    });

    const result = await wrapped.run(createToolContext("coordinator"), {
      instruction: "Run a worker task.",
      role: "worker",
      allowed_tools: [" read ", "read"],
      ignoredBlob: `${"x".repeat(200_000)}${tailSentinel}`,
      ignoredFunction: () => tailSentinel
    });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain(tailSentinel);
    expect(evaluatorInput).toEqual({
      instruction: "Run a worker task.",
      role: "worker",
      tools: ["read"]
    });
    expect(spawnTool.lastInput).toEqual({
      instruction: "Run a worker task.",
      role: "worker",
      tools: ["read"]
    });
    expect(evaluatorInput).not.toHaveProperty("allowed_tools");
    expect(evaluatorInput).not.toHaveProperty("ignoredBlob");
    expect(evaluatorInput).not.toHaveProperty("ignoredFunction");
    expect(spawnTool.lastInput).not.toHaveProperty("allowed_tools");
    expect(spawnTool.lastInput).not.toHaveProperty("ignoredBlob");
    expect(spawnTool.lastInput).not.toHaveProperty("ignoredFunction");
  });

  test("SHUD runtime assembly rejects the 21st role-visible tool", () => {
    const tools = Array.from({ length: 19 }, (_, index) => new RecordingTool(`extra.${index}`));

    expect(() =>
      createShudRuntimeToolRegistry(
        createMinimalShudRuntimeRegistryOptions({
          role: "worker",
          tools
        })
      )
    ).toThrow(
      /Policy-gated tool registration lint failed for role worker: visible tool count 21 exceeds 20; excess count 1/
    );
  });

  test("SHUD runtime assembly rejects the 21st visible tool when role is omitted", () => {
    const tools = Array.from({ length: 19 }, (_, index) => new RecordingTool(`extra.${index}`));

    expect(() =>
      createShudRuntimeToolRegistry(
        createMinimalShudRuntimeRegistryOptions({
          tools
        })
      )
    ).toThrow(
      /Policy-gated tool registration lint failed for role unknown-role: visible tool count 21 exceeds 20; excess count 1/
    );
  });

  test("SHUD runtime adapts real Zero native tool descriptions before strict lint", () => {
    const registry = createShudRuntimeToolRegistry(
      createMinimalShudRuntimeRegistryOptions({
        tools: [new ReadTool(), new WriteTool(), new EditTool(), new WaitAgentTool()]
      })
    );

    assertPolicyGatedToolRegistry(registry);
    for (const toolId of ["read", "write", "edit", "wait_agent"] as const) {
      const definition = registry.getDefinitions().find((candidate) => candidate.name === toolId);
      expect(definition?.description).toContain("何时该用:");
      expect(definition?.description).toContain("何时不该用:");
      expect(definition?.description).toContain("成功与失败样态:");
    }
  });

  test("SHUD runtime assembly rejects tool descriptions missing required sections", () => {
    const badTool = new RecordingTool("bad.description");
    badTool.description = [
      "何时该用: Use this fixture for description lint tests.",
      "成功与失败样态: Success returns a fixture result; failure throws during assembly."
    ].join("\n");

    expect(() =>
      createShudRuntimeToolRegistry(
        createMinimalShudRuntimeRegistryOptions({
          tools: [badTool]
        })
      )
    ).toThrow(/bad\.description: missing 何时不该用/);
  });

  test("description lint rejects section labels without bodies", () => {
    const badTool = new RecordingTool("bad.empty.sections");
    badTool.description = ["何时该用:", "何时不该用:", "成功与失败样态:"].join("\n");

    expect(() =>
      createShudRuntimeToolRegistry(
        createMinimalShudRuntimeRegistryOptions({
          tools: [badTool]
        })
      )
    ).toThrow(/bad\.empty\.sections: empty 何时该用, 何时不该用, 成功与失败样态/);
  });

  test("description lint rejects mid-sentence section-label stuffing", () => {
    const badTool = new RecordingTool("bad.stuffed.sections");
    badTool.description =
      "This sentence mentions 何时该用, 何时不该用, and 成功与失败样态 without section headings.";

    expect(() =>
      createShudRuntimeToolRegistry(
        createMinimalShudRuntimeRegistryOptions({
          tools: [badTool]
        })
      )
    ).toThrow(/bad\.stuffed\.sections: missing 何时该用, 何时不该用, 成功与失败样态/);
  });

  test("description lint accepts multiline section bodies", () => {
    const tool = new RecordingTool("good.multiline.description");
    tool.description = [
      "何时该用:",
      "Use this fixture when the body is on the next line.",
      "何时不该用：",
      "Do not use it as a real tool.",
      "成功与失败样态:",
      "Success assembles the registry; failure belongs to the lint harness."
    ].join("\n");

    expect(() =>
      createShudRuntimeToolRegistry(
        createMinimalShudRuntimeRegistryOptions({
          tools: [tool]
        })
      )
    ).not.toThrow();
  });

  test("manual registry assertion rejects direct-wrapped tools above the visible count limit", () => {
    const registry = new ToolRegistry();
    const tools = Array.from(
      { length: 21 },
      (_, index) => new RecordingTool(`manual.${index}`)
    );
    for (const tool of tools) {
      registry.register(
        wrapToolWithPolicyGate(tool, {
          evaluate: async () => ({ decision: "allow" })
        })
      );
    }

    expect(() => assertPolicyGatedToolRegistry(registry, { role: "worker" })).toThrow(
      /Policy-gated tool registration lint failed for role worker: visible tool count 21 exceeds 20; excess count 1/
    );
  });

  test("manual registry assertion rejects direct-wrapped tools with bad descriptions", () => {
    const badTool = new RecordingTool("manual.bad.description");
    badTool.description = [
      "何时该用: Use this fixture for manual registry lint.",
      "成功与失败样态: Success should never pass final registry validation."
    ].join("\n");
    const registry = new ToolRegistry();
    registry.register(
      wrapToolWithPolicyGate(badTool, {
        evaluate: async () => ({ decision: "allow" })
      })
    );

    expect(() => assertPolicyGatedToolRegistry(registry)).toThrow(
      /manual\.bad\.description: missing 何时不该用/
    );
  });

  test("Zod parameter schema rejection finalizes without executing the inner tool", async () => {
    const zodTool = new ZodRecordingTool(
      "zod.parameters",
      z.object({
        command: z.string()
      })
    );
    const runningToolRegistry = new TestRunningToolRegistry();
    const handle = runningToolRegistry.register({
      toolUseId: "POLICY-ZOD-1",
      toolName: "zod.parameters",
      abortable: false
    });
    let evaluatorCalls = 0;
    const wrapped = wrapToolWithPolicyGate(zodTool, {
      evaluate: async () => {
        evaluatorCalls += 1;
        return { decision: "allow" };
      }
    });

    const result = await wrapped.run(
      {
        ...createToolContext("worker"),
        currentToolUseId: "POLICY-ZOD-1",
        runningToolRegistry
      },
      {
        command: 42
      }
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("policy_gate_denied");
    expect(result.output).toContain("tool-parameter-schema-validation");
    const payload = JSON.parse(result.output) as {
      error?: string;
      ruleId?: string;
      reason?: string;
      remediation?: {
        next_action?: string;
        hint?: string;
        ref?: string;
      };
    };
    expect(payload.error).toBe("policy_gate_denied");
    expect(payload.ruleId).toBe("tool-parameter-schema-validation");
    expect(payload.reason).toContain("command");
    expect(payload.remediation?.next_action).toBe("fix_and_retry");
    expect(payload.remediation?.hint).toContain("Zod parameter schema");
    expect(payload.remediation?.ref).toBe(
      "docs/02_ARCHITECTURE/Control_Kernel.md#53-工具面治理约定"
    );
    expect(PolicyGateRemediationSchema.safeParse(payload.remediation).success).toBe(true);
    expect(evaluatorCalls).toBe(1);
    expect(zodTool.calls).toBe(0);
    expect(handle.getState()).toBe("finished");
    expect(handle.getTerminalMetadata()).toMatchObject({
      cause: "completed",
      success: false,
      outputSummary: result.outputSummary
    });
  });

  test("factory-returned registry snapshots Zod schema carrier against retained inner mutation", async () => {
    const zodTool = new ZodRecordingTool(
      "zod.schema.snapshot",
      z.object({
        command: z.string()
      })
    );
    let evaluatorCalls = 0;
    const registry = createPolicyGatedToolRegistry([zodTool], {
      evaluate: async () => {
        evaluatorCalls += 1;
        return { decision: "allow" };
      }
    });

    (zodTool as unknown as { parameterSchema: unknown }).parameterSchema = z.object({
      command: z.unknown()
    });

    const result = await registry.get("zod.schema.snapshot")?.run(createToolContext("worker"), {
      command: 42
    });

    expect(result?.success).toBe(false);
    expect(result?.output).toContain("policy_gate_denied");
    expect(result?.output).toContain("tool-parameter-schema-validation");
    const payload = JSON.parse(result?.output ?? "{}") as {
      error?: string;
      ruleId?: string;
      reason?: string;
      remediation?: {
        next_action?: string;
        hint?: string;
        ref?: string;
      };
    };
    expect(payload.error).toBe("policy_gate_denied");
    expect(payload.ruleId).toBe("tool-parameter-schema-validation");
    expect(payload.reason).toContain("command");
    expect(payload.remediation?.next_action).toBe("fix_and_retry");
    expect(payload.remediation?.hint).toContain("Zod parameter schema");
    expect(payload.remediation?.ref).toBe(
      "docs/02_ARCHITECTURE/Control_Kernel.md#53-工具面治理约定"
    );
    expect(PolicyGateRemediationSchema.safeParse(payload.remediation).success).toBe(true);
    expect(evaluatorCalls).toBe(1);
    expect(zodTool.calls).toBe(0);
  });

  test("wrapped Zod schema validation ignores retained safeParse monkey-patches", async () => {
    const schema = z.object({
      command: z.string()
    });
    const zodTool = new ZodRecordingTool("zod.safeparse.patch.wrap", schema);
    let evaluatorCalls = 0;
    const wrapped = wrapToolWithPolicyGate(zodTool, {
      evaluate: async () => {
        evaluatorCalls += 1;
        return { decision: "allow" };
      }
    });

    monkeyPatchZodSafeParseToAccept(schema, {
      command: "patched-valid"
    });

    const result = await wrapped.run(createToolContext("worker"), {
      command: 42
    });

    expectToolParameterSchemaValidationDenial(result);
    expect(evaluatorCalls).toBe(1);
    expect(zodTool.calls).toBe(0);
  });

  test("factory-returned registry Zod validation ignores retained safeParse monkey-patches", async () => {
    const schema = z.object({
      command: z.string()
    });
    const zodTool = new ZodRecordingTool("zod.safeparse.patch.registry", schema);
    let evaluatorCalls = 0;
    const registry = createPolicyGatedToolRegistry([zodTool], {
      evaluate: async () => {
        evaluatorCalls += 1;
        return { decision: "allow" };
      }
    });

    monkeyPatchZodSafeParseToAccept(schema, {
      command: "patched-valid"
    });

    const result = await registry.get("zod.safeparse.patch.registry")?.run(
      createToolContext("worker"),
      {
        command: 42
      }
    );

    expectToolParameterSchemaValidationDenial(result);
    expect(evaluatorCalls).toBe(1);
    expect(zodTool.calls).toBe(0);
  });

  test("Zod parameter schema rejection survives a throwing evaluator", async () => {
    const zodTool = new ZodRecordingTool(
      "zod.invalid.throwing.evaluator",
      z.object({
        command: z.string()
      })
    );
    let evaluatorCalls = 0;
    const wrapped = wrapToolWithPolicyGate(zodTool, {
      evaluate: async () => {
        evaluatorCalls += 1;
        throw new Error("throwing evaluator must not replace schema denial");
      }
    });

    const result = await wrapped.run(createToolContext("worker"), {
      command: 42
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("policy_gate_denied");
    expect(result.output).toContain("tool-parameter-schema-validation");
    expect(result.output).not.toContain("throwing evaluator");
    const payload = JSON.parse(result.output) as {
      error?: string;
      ruleId?: string;
      remediation?: {
        next_action?: string;
        hint?: string;
        ref?: string;
      };
    };
    expect(payload.error).toBe("policy_gate_denied");
    expect(payload.ruleId).toBe("tool-parameter-schema-validation");
    expect(payload.remediation?.next_action).toBe("fix_and_retry");
    expect(payload.remediation?.hint).toContain("Zod parameter schema");
    expect(payload.remediation?.ref).toBe(
      "docs/02_ARCHITECTURE/Control_Kernel.md#53-工具面治理约定"
    );
    expect(PolicyGateRemediationSchema.safeParse(payload.remediation).success).toBe(true);
    expect(evaluatorCalls).toBe(1);
    expect(zodTool.calls).toBe(0);
  });

  test("policy evaluator denial wins before invalid Zod schema details", async () => {
    const zodTool = new ZodRecordingTool(
      "zod.denied.first",
      z.object({
        command: z.string()
      })
    );
    let evaluatorCalls = 0;
    const wrapped = wrapToolWithPolicyGate(zodTool, {
      evaluate: async () => {
        evaluatorCalls += 1;
        return {
          decision: "deny",
          ruleId: "authorization-deny",
          reason: "role is not authorized for this tool",
          remediation: {
            next_action: "adjust_scope",
            hint: "Use a tool allowed for this role.",
            ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
          }
        };
      }
    });

    const result = await wrapped.run(createToolContext("worker"), {
      command: 42
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("authorization-deny");
    expect(result.output).not.toContain("tool-parameter-schema-validation");
    expect(result.output).not.toContain("Expected string");
    expect(evaluatorCalls).toBe(1);
    expect(zodTool.calls).toBe(0);
  });

  test("valid Zod path runs evaluator once and executes with parsed input", async () => {
    const zodTool = new ZodRecordingTool(
      "zod.valid.parsed",
      z.object({
        count: z.coerce.number().default(1).transform((value) => value + 1),
        label: z.string().default("default-label")
      })
    );
    let evaluatorCalls = 0;
    let evaluatorInput: unknown;
    let validatorInput: unknown;
    const wrapped = wrapToolWithPolicyGate(zodTool, {
      evaluate: async (call) => {
        evaluatorCalls += 1;
        evaluatorInput = call.input;
        return { decision: "allow" };
      },
      validateExecutionInput: (input) => {
        validatorInput = input;
        return undefined;
      }
    });

    const result = await wrapped.run(createToolContext("worker"), {
      count: "4"
    });

    expect(result).toEqual({
      success: true,
      output: "zod.valid.parsed executed",
      outputSummary: "zod.valid.parsed executed"
    });
    expect(evaluatorCalls).toBe(1);
    expect(zodTool.calls).toBe(1);
    expect(zodTool.lastInput).toEqual({
      count: 5,
      label: "default-label"
    });
    expect(evaluatorInput).toEqual(zodTool.lastInput);
    expect(validatorInput).toBe(zodTool.lastInput);
  });

  test("valid Zod parsed-only values can be denied by the evaluator", async () => {
    const zodTool = new ZodRecordingTool(
      "zod.parsed.denied",
      z.object({
        count: z.coerce.number().default(1).transform((value) => value + 1),
        label: z.string().default("default-label")
      })
    );
    let evaluatorInput: unknown;
    const wrapped = wrapToolWithPolicyGate(zodTool, {
      evaluate: async (call) => {
        evaluatorInput = call.input;
        const input = call.input as { count?: unknown; label?: unknown };
        if (input.count === 5 && input.label === "default-label") {
          return {
            decision: "deny",
            ruleId: "parsed-zod-deny",
            reason: "parsed count crossed the evaluator threshold",
            remediation: {
              next_action: "adjust_scope",
              hint: "Lower the parsed count before retrying.",
              ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
            }
          };
        }
        return { decision: "allow" };
      },
      validateExecutionInput: () => {
        throw new Error("validator must not run after evaluator denial");
      }
    });

    const result = await wrapped.run(createToolContext("worker"), {
      count: "4"
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("parsed-zod-deny");
    expect(result.output).toContain("parsed count crossed the evaluator threshold");
    expect(evaluatorInput).toEqual({
      count: 5,
      label: "default-label"
    });
    expect(zodTool.calls).toBe(0);
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
      const scopedSandboxRegistry = (
        (isPolicyGatedTool(spawn!) ? spawn.innerTool : spawn) as SpawnAgentTool & {
          buildScopedRegistry(toolNames?: string[]): ToolRegistry;
        }
      ).buildScopedRegistry(["sandbox.exec"]);
      expect(scopedSandboxRegistry.get("sandbox.exec")).toBe(registry.get("sandbox.exec"));
      expect(isPolicyGatedTool(scopedSandboxRegistry.get("sandbox.exec")!)).toBe(true);
      expect(
        isPolicyGatedTool(scopedSandboxRegistry.get("sandbox.exec")!) &&
          scopedSandboxRegistry.get("sandbox.exec")!.innerTool
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
      expect(payload.remediation?.hint).toContain("(1 total)");
      expect(payload.remediation?.ref).toContain(
        "docs/02_ARCHITECTURE/Roles_and_Boundaries.md#0-canonical-agent-role-registry"
      );
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies missing explicit spawn tools before custom evaluator and spawn", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
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
          tools: ["shud.run"]
        }
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      const payload = JSON.parse(result?.output ?? "{}") as {
        error?: string;
        ruleId?: string;
        guard_class?: string;
        reason?: string;
        remediation?: {
          next_action?: string;
          hint?: string;
          ref?: string;
        };
      };
      expect(payload.error).toBe("policy_gate_denied");
      expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
      expect(payload.guard_class).toBe("authority");
      expect(payload.reason).toContain("shud.run");
      expect(payload.remediation?.next_action).toBe("adjust_scope");
      expect(payload.remediation?.hint).toContain("shud.run");
      expect(payload.remediation?.ref).toBe(SPAWN_PROFILE_SUBSET_POLICY_REF);
      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies missing injected canonical spawn tools before custom evaluator and spawn", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
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
          role: "worker"
        }
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      const payload = JSON.parse(result?.output ?? "{}") as {
        error?: string;
        ruleId?: string;
        guard_class?: string;
        reason?: string;
        remediation?: {
          next_action?: string;
          hint?: string;
          ref?: string;
        };
      };
      expect(payload.error).toBe("policy_gate_denied");
      expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
      expect(payload.guard_class).toBe("authority");
      expect(payload.reason).toContain("artifact.write");
      expect(payload.reason).toContain("total");
      expect(payload.remediation?.next_action).toBe("adjust_scope");
      expect(payload.remediation?.hint).toContain("artifact.write");
      expect(payload.remediation?.ref).toBe(SPAWN_PROFILE_SUBSET_POLICY_REF);
      expect(result?.output.length).toBeLessThan(900);
      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies invalid spawn mode before custom evaluator and spawn", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
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
          instruction: "Run worker",
          role: "worker",
          tools: ["read"],
          mode: "detached"
        }
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      const payload = JSON.parse(result?.output ?? "{}") as {
        error?: string;
        ruleId?: string;
        guard_class?: string;
        reason?: string;
        remediation?: {
          next_action?: string;
          hint?: string;
          ref?: string;
        };
      };
      expect(payload.error).toBe("policy_gate_denied");
      expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
      expect(payload.guard_class).toBe("authority");
      expect(payload.reason).toContain("mode");
      expect(payload.reason).toContain("detached");
      expect(payload.remediation?.next_action).toBe("adjust_scope");
      expect(payload.remediation?.hint).toContain("standard");
      expect(payload.remediation?.hint).toContain("interactive");
      expect(payload.remediation?.ref).toBe(SPAWN_PROFILE_SUBSET_POLICY_REF);
      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies missing spawn instruction before custom evaluator and spawn", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
          return { decision: "allow" };
        }
      });

      for (const spawnInput of [
        {
          role: "worker",
          tools: ["read"]
        },
        {
          instruction: undefined,
          role: "worker",
          tools: ["read"]
        },
        {
          instruction: "   ",
          role: "worker",
          tools: ["read"]
        },
        {
          role: "worker",
          tools: ["read"],
          mode: 1
        }
      ]) {
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
          error?: string;
          ruleId?: string;
          guard_class?: string;
          reason?: string;
          remediation?: {
            next_action?: string;
            hint?: string;
            ref?: string;
          };
        };
        expect(payload.error).toBe("policy_gate_denied");
        expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
        expect(payload.guard_class).toBe("authority");
        expect(payload.reason).toContain("instruction");
        expect(payload.remediation?.next_action).toBe("adjust_scope");
        expect(payload.remediation?.hint).toContain("instruction");
        expect(payload.remediation?.ref).toBe(SPAWN_PROFILE_SUBSET_POLICY_REF);
      }
      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies spawn without a canonical role before Zero defaults or explicit tools", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      zeroLikeRegistry.register(new RecordingTool("bash"));
      const agentControl = createAgentControlSpy();
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
          return { decision: "allow" };
        }
      });

      for (const input of [
        {
          instruction: "Run a task with default tools."
        },
        {
          instruction: "Run a task with explicit edit.",
          tools: ["edit"]
        },
        {
          instruction: "Run a task with an allowed_tools alias.",
          allowed_tools: ["edit"]
        },
        {
          instruction: "Run a task with a noncanonical role.",
          role: "custom_role",
          tools: ["edit"]
        }
      ]) {
        const result = await registry.get("spawn_agent")?.run(
          {
            ...fixture.context,
            agentControl: agentControl.control,
            projectRoot: fixture.root
          },
          input
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
        expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
        expect(payload.guard_class).toBe("authority");
        expect(payload.remediation?.next_action).toBe("adjust_scope");
        expect(payload.remediation?.hint).toContain("canonical SHUD spawn role");
        expect(payload.remediation?.ref).toBe(SPAWN_PROFILE_SUBSET_POLICY_REF);
      }
      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies array spawn input before custom evaluator and spawn", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      const agentControl = createAgentControlSpy();
      const input = ["not a spawn record"] as unknown[] & Record<string, unknown>;
      input.instruction = "Run a worker task.";
      input.role = "worker";
      input.tools = ["edit"];
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
          return { decision: "allow" };
        }
      });

      const result = await registry.get("spawn_agent")?.run(
        {
          ...fixture.context,
          agentControl: agentControl.control,
          projectRoot: fixture.root
        },
        input
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      const payload = JSON.parse(result?.output ?? "{}") as {
        ruleId?: string;
        guard_class?: string;
        remediation?: {
          next_action?: string;
        };
      };
      expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
      expect(payload.guard_class).toBe("authority");
      expect(payload.remediation?.next_action).toBe("adjust_scope");
      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies accessor-backed spawn tools without executing them", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      let customCalls = 0;
      let accessorReads = 0;
      const accessorTools: unknown[] = [];
      Object.defineProperty(accessorTools, "0", {
        configurable: true,
        enumerable: true,
        get() {
          accessorReads += 1;
          return "read";
        }
      });

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
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
          tools: accessorTools
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
          ref?: string;
        };
      };
      expect(payload.error).toBe("policy_gate_denied");
      expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
      expect(payload.guard_class).toBe("authority");
      expect(payload.remediation?.next_action).toBe("adjust_scope");
      expect(payload.remediation?.ref).toBe(SPAWN_PROFILE_SUBSET_POLICY_REF);
      expect(accessorReads).toBe(0);
      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime snapshots proxy-backed spawn tools without direct get traps", async () => {
    const fixture = await createRawFixture();
    try {
      await writeWorkerRoleFixture(fixture.root);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      let customCalls = 0;
      let proxyReads = 0;
      const proxyTools = new Proxy(["read"], {
        get(target, property, receiver) {
          proxyReads += 1;
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          return Reflect.getOwnPropertyDescriptor(target, property);
        }
      });

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
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
          tools: proxyTools
        }
      );

      expect(result?.success).toBe(true);
      expect(proxyReads).toBe(0);
      expect(customCalls).toBe(1);
      expect(agentControl.getSpawnCalls()).toBe(1);
      expect(getCapturedToolNames(agentControl.getLastAgentContext())).toEqual(["read"]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies revoked spawn input before custom evaluator and spawn", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
          return { decision: "allow" };
        }
      });

      const revokedRecord = Proxy.revocable(
        {
          instruction: "Run a worker task.",
          role: "worker",
          tools: ["read"]
        },
        {}
      );
      revokedRecord.revoke();
      const cases: Array<{ label: string; input: unknown }> = [
        { label: "top-level", input: revokedRecord.proxy }
      ];
      for (const field of ["tools", "allowed_tools"] as const) {
        const revokedAllowlist = Proxy.revocable(["read"], {});
        revokedAllowlist.revoke();
        cases.push({
          label: field,
          input: {
            instruction: "Run a worker task.",
            role: "worker",
            [field]: revokedAllowlist.proxy
          }
        });
      }

      for (const testCase of cases) {
        const runningToolRegistry = new TestRunningToolRegistry();
        const toolUseId = `SPAWN-REVOKED-${testCase.label}`;
        const handle = runningToolRegistry.register({
          toolUseId,
          toolName: "spawn_agent",
          abortable: false
        });

        const result = await registry.get("spawn_agent")?.run(
          {
            ...fixture.context,
            currentToolUseId: toolUseId,
            runningToolRegistry,
            agentControl: agentControl.control,
            projectRoot: fixture.root
          },
          testCase.input
        );

        expect(result?.success).toBe(false);
        expect(result?.output).toContain("policy_gate_denied");
        const payload = JSON.parse(result?.output ?? "{}") as {
          error?: string;
          ruleId?: string;
          guard_class?: string;
          remediation?: {
            next_action?: string;
          };
        };
        expect(payload.error).toBe("policy_gate_denied");
        expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
        expect(payload.guard_class).toBe("authority");
        expect(payload.remediation?.next_action).toBe("adjust_scope");
        expect(handle.getState()).toBe("finished");
        expect(handle.getTerminalMetadata()).toMatchObject({
          cause: "completed",
          success: false,
          outputSummary: result?.outputSummary
        });
      }

      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies boxed role and callable spawn input before custom evaluator and spawn", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
          return { decision: "allow" };
        }
      });

      const callableInput = function spawnInput() {};
      Object.assign(callableInput, {
        instruction: "Run a worker task.",
        role: "worker",
        tools: ["read"]
      });

      for (const spawnInput of [
        {
          instruction: "Run a worker task.",
          role: new String("worker"),
          tools: ["read"]
        },
        callableInput
      ]) {
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
          error?: string;
          ruleId?: string;
          guard_class?: string;
          remediation?: {
            next_action?: string;
          };
        };
        expect(payload.error).toBe("policy_gate_denied");
        expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
        expect(payload.guard_class).toBe("authority");
        expect(payload.remediation?.next_action).toBe("adjust_scope");
      }

      expect(customCalls).toBe(0);
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

  test("SHUD runtime denies dual tools aliases before custom evaluator and spawn", async () => {
    const fixture = await createRawFixture();
    try {
      await writeWorkerRoleFixture(fixture.root);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      const agentControl = createAgentControlSpy();
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
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
          tools: ["read"],
          allowed_tools: ["edit"]
        }
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      expect(result?.output).toContain("edit");
      const payload = JSON.parse(result?.output ?? "{}") as {
        ruleId?: string;
        guard_class?: string;
        remediation?: {
          next_action?: string;
          hint?: string;
          ref?: string;
        };
      };
      expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
      expect(payload.guard_class).toBe("authority");
      expect(payload.remediation?.next_action).toBe("adjust_scope");
      expect(payload.remediation?.hint).toContain("edit");
      expect(payload.remediation?.ref).toBe(SPAWN_PROFILE_SUBSET_POLICY_REF);
      expect(customCalls).toBe(0);
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

  test("SHUD runtime executes only the sanitized spawn snapshot for drifting proxy input", async () => {
    const fixture = await createRawFixture();
    try {
      await writeWorkerRoleFixture(fixture.root);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      const agentControl = createAgentControlSpy();
      let toolsDescriptorReads = 0;
      const safeInput = {
        instruction: "Run a worker task.",
        role: "worker",
        tools: ["read"]
      };
      const proxyInput = new Proxy(safeInput, {
        ownKeys() {
          return ["instruction", "role", "tools"];
        },
        getOwnPropertyDescriptor(_target, property) {
          if (property === "instruction") {
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              value: "Run a worker task."
            };
          }
          if (property === "role") {
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              value: "worker"
            };
          }
          if (property === "tools") {
            toolsDescriptorReads += 1;
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              value: toolsDescriptorReads === 1 ? ["read"] : ["read", "edit"]
            };
          }
          return undefined;
        },
        get(_target, property) {
          if (property === "tools") {
            return ["read", "edit"];
          }
          return Reflect.get(safeInput, property);
        }
      });
      let seenTools: unknown;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async (call) => {
          seenTools = (call.input as { tools?: unknown }).tools;
          return { decision: "allow" };
        }
      });

      const result = await registry.get("spawn_agent")?.run(
        {
          ...fixture.context,
          agentControl: agentControl.control,
          projectRoot: fixture.root
        },
        proxyInput
      );

      expect(result?.success).toBe(true);
      expect(seenTools).toEqual(["read"]);
      expect(agentControl.getSpawnCalls()).toBe(1);
      expect(getCapturedToolNames(agentControl.getLastAgentContext())).toEqual(["read"]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies oversized canonical tools before custom evaluator and spawn", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      const agentControl = createAgentControlSpy();
      const tailSentinel = "tail-sentinel-that-must-not-appear";
      const tools = [
        ...Array.from({ length: SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS }, () => "read"),
        tailSentinel
      ];
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
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
          tools
        }
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      expect(result?.output).not.toContain(tailSentinel);
      const payload = JSON.parse(result?.output ?? "{}") as {
        error?: string;
        ruleId?: string;
        guard_class?: string;
        remediation?: {
          next_action?: string;
        };
      };
      expect(payload.error).toBe("policy_gate_denied");
      expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
      expect(payload.guard_class).toBe("authority");
      expect(payload.remediation?.next_action).toBe("adjust_scope");
      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime omits large ignored spawn fields from custom evaluator input", async () => {
    const fixture = await createRawFixture();
    try {
      await writeWorkerRoleFixture(fixture.root);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      const tailSentinel = "ignored-tail-sentinel-that-must-not-appear";
      let customSawIgnoredField = false;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async (call) => {
          const input = call.input as Record<string, unknown>;
          customSawIgnoredField = "ignoredBlob" in input || "ignoredFunction" in input;
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
          tools: ["read"],
          ignoredBlob: `${"x".repeat(200_000)}${tailSentinel}`,
          ignoredFunction: () => tailSentinel
        }
      );

      expect(result?.success).toBe(true);
      expect(result?.output).not.toContain(tailSentinel);
      expect(customSawIgnoredField).toBe(false);
      expect(agentControl.getSpawnCalls()).toBe(1);
      expect(getCapturedToolNames(agentControl.getLastAgentContext())).toEqual(["read"]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies consumed accessor spawn fields without echoing sensitive keys", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      const tailSentinel = "sensitive-key-tail-that-must-not-appear";
      const sensitiveKey = `ignored_${"x".repeat(128)}_${tailSentinel}`;
      const input: Record<string, unknown> = {
        instruction: "Run a worker task.",
        role: "worker"
      };
      Object.defineProperty(input, "tools", {
        enumerable: true,
        get() {
          throw new Error(tailSentinel);
        }
      });
      Object.defineProperty(input, sensitiveKey, {
        enumerable: true,
        get() {
          return tailSentinel;
        }
      });
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
          return { decision: "allow" };
        }
      });

      const result = await registry.get("spawn_agent")?.run(
        {
          ...fixture.context,
          agentControl: agentControl.control,
          projectRoot: fixture.root
        },
        input
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      expect(result?.output).not.toContain(sensitiveKey);
      expect(result?.output).not.toContain(tailSentinel);
      const payload = JSON.parse(result?.output ?? "{}") as {
        ruleId?: string;
        guard_class?: string;
        remediation?: {
          next_action?: string;
        };
      };
      expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
      expect(payload.guard_class).toBe("authority");
      expect(payload.remediation?.next_action).toBe("adjust_scope");
      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies no-role over-budget tools before custom evaluator and spawn", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      const tailSentinel = "tail-sentinel-that-must-not-appear";
      const tools = [
        ...Array.from({ length: SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS }, () => "read"),
        tailSentinel
      ];
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
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
          instruction: "Run an unscoped task.",
          tools
        }
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      expect(result?.output).not.toContain(tailSentinel);
      const payload = JSON.parse(result?.output ?? "{}") as {
        ruleId?: string;
        guard_class?: string;
        remediation?: {
          next_action?: string;
        };
      };
      expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
      expect(payload.guard_class).toBe("authority");
      expect(payload.remediation?.next_action).toBe("adjust_scope");
      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime over-budget tools deny before hostile sibling getters are read", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      const tailSentinel = "tail-sentinel-that-must-not-appear";
      const getterSentinel = "throwing-getter-sentinel";
      const input: Record<string, unknown> = {
        instruction: "Run a worker task.",
        role: "worker",
        tools: [
          ...Array.from({ length: SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS }, () => "read"),
          tailSentinel
        ]
      };
      Object.defineProperty(input, "hostile", {
        enumerable: true,
        get() {
          throw new Error(getterSentinel);
        }
      });
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
          return { decision: "allow" };
        }
      });

      const result = await registry.get("spawn_agent")?.run(
        {
          ...fixture.context,
          agentControl: agentControl.control,
          projectRoot: fixture.root
        },
        input
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      expect(result?.output).not.toContain(tailSentinel);
      expect(result?.output).not.toContain(getterSentinel);
      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime custom evaluator sees trimmed canonical spawn role", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      let seenRole: unknown;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async (call) => {
          seenRole = (call.input as { role?: unknown }).role;
          if (seenRole === "reviewer") {
            return {
              decision: "deny",
              ruleId: "custom-reviewer-deny",
              reason: "custom evaluator denied reviewer",
              remediation: {
                next_action: "adjust_scope",
                hint: "Use a different reviewer delegation path.",
                ref: "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md"
              }
            };
          }
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
          instruction: "Review this task.",
          role: " reviewer ",
          tools: ["read"]
        }
      );

      expect(result?.success).toBe(false);
      expect(seenRole).toBe("reviewer");
      const payload = JSON.parse(result?.output ?? "{}") as {
        ruleId?: string;
      };
      expect(payload.ruleId).toBe("custom-reviewer-deny");
      expect(agentControl.getSpawnCalls()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime custom evaluator sees allowed_tools as normalized tools", async () => {
    const fixture = await createRawFixture();
    try {
      await writeWorkerRoleFixture(fixture.root);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      const agentControl = createAgentControlSpy();
      let seenTools: unknown;
      let seenAlias: unknown;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async (call) => {
          const input = call.input as {
            tools?: unknown;
            allowed_tools?: unknown;
          };
          seenTools = input.tools;
          seenAlias = input.allowed_tools;
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
          allowed_tools: [" read ", "sandbox.exec", "read"]
        }
      );

      expect(result?.success).toBe(true);
      expect(seenTools).toEqual(["read", "sandbox.exec"]);
      expect(seenAlias).toBeUndefined();
      expect(agentControl.getSpawnCalls()).toBe(1);
      expect(getCapturedToolNames(agentControl.getLastAgentContext())).toEqual([
        "read",
        "sandbox.exec"
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime treats explicit undefined spawn allowlists as omitted", async () => {
    const fixture = await createRawFixture();
    try {
      await writeWorkerRoleFixture(fixture.root);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("artifact.write"));
      zeroLikeRegistry.register(new RecordingTool("harness.memory.propose"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("rshud.compute_metrics"));
      zeroLikeRegistry.register(new RecordingTool("rshud.read_output"));
      zeroLikeRegistry.register(new RecordingTool("shud.build"));
      zeroLikeRegistry.register(new RecordingTool("shud.run"));
      const agentControl = createAgentControlSpy();
      const seenTools: unknown[] = [];
      const seenAliases: unknown[] = [];

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async (call) => {
          const input = call.input as {
            tools?: unknown;
            allowed_tools?: unknown;
          };
          seenTools.push(input.tools);
          seenAliases.push(input.allowed_tools);
          return { decision: "allow" };
        }
      });

      for (const spawnInput of [
        {
          instruction: "Run a worker task.",
          role: "worker",
          tools: undefined
        },
        {
          instruction: "Run a worker task.",
          role: "worker",
          allowed_tools: undefined
        },
        {
          instruction: "Run a worker task.",
          role: "worker",
          tools: undefined,
          allowed_tools: ["read"]
        }
      ]) {
        const result = await registry.get("spawn_agent")?.run(
          {
            ...fixture.context,
            agentControl: agentControl.control,
            projectRoot: fixture.root
          },
          spawnInput
        );
        expect(result?.success).toBe(true);
      }

      expect(seenTools).toEqual([[...getRoleToolIds("worker")], [...getRoleToolIds("worker")], ["read"]]);
      expect(seenAliases).toEqual([undefined, undefined, undefined]);
      expect(agentControl.getSpawnCalls()).toBe(3);
      expect(getCapturedToolNames(agentControl.getLastAgentContext())).toEqual(["read"]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies non-plain uncloneable spawn input before custom mutation", async () => {
    const fixture = await createRawFixture();
    try {
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("edit"));
      const agentControl = createAgentControlSpy();
      class NonPlainSpawnInput {
        instruction = "Run a worker task.";
        role = "worker";
        tools = ["read"];
        uncloneable = () => "not cloneable";
      }
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async (call) => {
          customCalls += 1;
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
        new NonPlainSpawnInput()
      );

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      const payload = JSON.parse(result?.output ?? "{}") as {
        ruleId?: string;
        guard_class?: string;
      };
      expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
      expect(payload.guard_class).toBe("authority");
      expect(customCalls).toBe(0);
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
      zeroLikeRegistry.register(new RecordingTool("harness.memory.propose"));
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
      expect(spawnedToolIds).toEqual([...getRoleToolIds("reviewer")]);
      expect(spawnedToolIds).not.toContain("bash");
      expect(spawnedToolIds).not.toContain("edit");
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime denies Zero-blocked canonical spawn tools before custom evaluator and spawn", async () => {
    const fixture = await createRawFixture();
    try {
      await writeHarnessRoleFixture(fixture.root, "coordinator", ["read"]);
      const modelRouter = createSpawnModelRouterStub();
      const zeroLikeRegistry = new ToolRegistry();
      zeroLikeRegistry.register(new RecordingTool("spawn_agent"));
      zeroLikeRegistry.register(new RecordingTool("wait_agent"));
      zeroLikeRegistry.register(new RecordingTool("read"));
      zeroLikeRegistry.register(new RecordingTool("harness.job.collect"));
      zeroLikeRegistry.register(new RecordingTool("harness.job.submit"));
      zeroLikeRegistry.register(new RecordingTool("harness.memory.propose"));
      zeroLikeRegistry.register(new RecordingTool("harness.report.generate"));
      const agentControl = createAgentControlSpy();
      let customCalls = 0;

      const registry = createShudRuntimeToolRegistry({
        tools: zeroLikeRegistry.list(),
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        modelRouter,
        evaluate: async () => {
          customCalls += 1;
          return { decision: "allow" };
        }
      });

      for (const { spawnInput, expectedToolId } of [
        {
          spawnInput: {
            instruction: "Coordinate the next step.",
            role: "coordinator"
          },
          expectedToolId: "spawn_agent"
        },
        {
          spawnInput: {
            instruction: "Coordinate the next step.",
            role: "coordinator",
            tools: ["spawn_agent"]
          },
          expectedToolId: "spawn_agent"
        },
        {
          spawnInput: {
            instruction: "Coordinate the next step.",
            role: "coordinator",
            tools: ["wait_agent"]
          },
          expectedToolId: "wait_agent"
        },
        {
          spawnInput: {
            instruction: "Coordinate the next step.",
            role: "coordinator",
            allowed_tools: ["wait_agent"]
          },
          expectedToolId: "wait_agent"
        }
      ]) {
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
          error?: string;
          ruleId?: string;
          guard_class?: string;
          reason?: string;
          remediation?: {
            next_action?: string;
            hint?: string;
            ref?: string;
          };
        };
        expect(payload.error).toBe("policy_gate_denied");
        expect(payload.ruleId).toBe(SPAWN_PROFILE_SUBSET_RULE_ID);
        expect(payload.guard_class).toBe("authority");
        expect(payload.reason).toContain(expectedToolId);
        expect(payload.remediation?.next_action).toBe("adjust_scope");
        expect(payload.remediation?.hint).toContain(expectedToolId);
        expect(payload.remediation?.ref).toBe(SPAWN_PROFILE_SUBSET_POLICY_REF);
      }
      expect(customCalls).toBe(0);
      expect(agentControl.getSpawnCalls()).toBe(0);
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

  test("outer raw deny with inner advisory disabled does not execute sandbox.exec side effects", async () => {
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

      const result = await registry.get("sandbox.exec")?.run(fixture.context, {
        command:
          "printf side-effect > workspace/outer-disabled-sandbox-side-effect.txt; printf nope > data/raw/outer-disabled-sandbox.txt"
      });

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_raw_data_rule_misconfigured");
      expectOuterRawRuleMisconfiguration(result);
      expect(result?.output).not.toContain("raw_data_write_denied");
      expect(result?.output).not.toContain("policy_gate_denied");
      await expect(readFile(join(fixture.workspaceRoot, "outer-disabled-sandbox-side-effect.txt"), "utf8")).rejects.toThrow();
      await expect(readFile(join(fixture.rawRoot, "outer-disabled-sandbox.txt"), "utf8")).rejects.toThrow();
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

  test("SHUD runtime registry owns wrapper kind and capability snapshots", async () => {
    const fixture = await createRawFixture();
    try {
      const edit = new RecordingTool("edit");
      const originalKind: BaseTool["kind"] = "built-in";
      const originalCapabilities = Object.freeze(["vision"]);
      edit.kind = originalKind;
      edit.requiredModelCapabilities = originalCapabilities;
      const registry = createShudRuntimeToolRegistry({
        tools: [edit],
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: []
      });

      const registered = registry.get("edit");
      expect(registered).toBeDefined();
      if (!registered) {
        throw new Error("edit should be registered in the SHUD runtime registry");
      }

      attemptRegisteredWrapperFieldMutation(registered, {
        kind: "mcp",
        requiredModelCapabilities: ["mutated-capability"]
      });

      const listed = registry.list().find((candidate) => candidate.name === "edit");
      const definition = registry.getDefinitions().find((candidate) => candidate.name === "edit");
      expect(listed).toBe(registered);
      expect(definition?.kind).toBe(originalKind);
      expect(registered.kind).toBe(originalKind);
      expect(listed?.kind).toBe(originalKind);
      expect(registered.requiredModelCapabilities).toEqual(originalCapabilities);
      expect(registered.requiredModelCapabilities).not.toBe(originalCapabilities);
      expect(listed?.requiredModelCapabilities).toEqual(originalCapabilities);
      expect(Object.isFrozen(registered.requiredModelCapabilities)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime registry rejects model-visible wrapper shadowing", async () => {
    const fixture = await createRawFixture();
    try {
      const edit = new RecordingTool("edit");
      const originalDescription = edit.description;
      const originalParameters = edit.parameters;
      const replacementInnerTool = new RecordingTool("edit.shadow.inner");
      const shadowParameters = {
        type: "object",
        properties: {
          leaked: {
            type: "boolean"
          }
        },
        additionalProperties: false
      };
      const registry = createShudRuntimeToolRegistry({
        tools: [edit],
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: []
      });

      const registered = registry.get("edit");
      expect(registered).toBeDefined();
      if (!registered) {
        throw new Error("edit should be registered in the SHUD runtime registry");
      }

      attemptRegisteredWrapperAuthorityMutation(registered, {
        name: "edit.shadowed",
        description: "Shadowed runtime description without governance sections.",
        parameters: shadowParameters,
        innerTool: replacementInnerTool,
        policyGateToolId: "spawn_agent",
        options: {
          evaluate: async () => ({ decision: "allow" })
        }
      });

      expectWrapperAuthorityPropertiesHardened(registered);
      const listed = registry.list().find((candidate) => candidate.name === "edit");
      const definition = registry.getDefinitions().find((candidate) => candidate.name === "edit");
      expect(listed).toBe(registered);
      expect(registered.name).toBe("edit");
      expect(registered.description).toBe(originalDescription);
      expect(registered.parameters).toEqual(originalParameters);
      expect(definition?.name).toBe("edit");
      expect(definition?.description).toBe(originalDescription);
      expect(definition?.parameters).toEqual(originalParameters);
      expect(definition?.parameters).not.toEqual(shadowParameters);
      expect(registry.get("edit.shadowed")).toBeUndefined();
      expect(registry.getDefinitions().map((candidate) => candidate.name)).not.toContain(
        "edit.shadowed"
      );

      const result = await registered.run(fixture.context, {});
      expect(result).toEqual({
        success: true,
        output: "edit executed",
        outputSummary: "edit executed"
      });
      expect(edit.calls).toBe(1);
      expect(replacementInnerTool.calls).toBe(0);
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

  test("SHUD runtime rewraps stale post-return replacements with the current evaluator", async () => {
    const fixture = await createRawFixture();
    try {
      const registry = createShudRuntimeToolRegistry({
        tools: [new RecordingTool("edit")],
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: [],
        evaluate: async () => ({
          decision: "deny",
          ruleId: "runtime-owned-deny",
          reason: "blocked by current runtime evaluator",
          remediation: {
            next_action: "adjust_scope",
            hint: "Use an allowed tool for this runtime role.",
            ref: "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md"
          }
        })
      });
      const staleReplacementInnerTool = new RecordingTool("edit");
      const staleAllowReplacement = wrapToolWithPolicyGate(staleReplacementInnerTool, {
        evaluate: async () => ({ decision: "allow" })
      });

      expect(() => registry.register(staleAllowReplacement)).not.toThrow();
      const registeredReplacement = registry.get("edit");
      expect(registeredReplacement).not.toBe(staleAllowReplacement);
      expect(isPolicyGatedTool(registeredReplacement!)).toBe(true);

      const result = await registeredReplacement?.run(fixture.context, {});

      expect(result?.success).toBe(false);
      expect(result?.output).toContain("policy_gate_denied");
      expect(result?.output).toContain("runtime-owned-deny");
      expect(staleReplacementInnerTool.calls).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("SHUD runtime registry public methods ignore inherited tools map mutation for edit", async () => {
    const fixture = await createRawFixture();
    try {
      const edit = new RecordingTool("edit");
      const registry = createShudRuntimeToolRegistry({
        tools: [edit],
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        fuseRules: []
      });
      const registeredEdit = registry.get("edit");
      if (!registeredEdit) {
        throw new Error("edit should be registered in the SHUD runtime registry");
      }
      const attackerEdit = new RecordingTool("edit");
      const injectedTool = new RecordingTool("runtime.injected");
      const mutableRegistry = registry as unknown as {
        tools?: Map<string, BaseTool>;
      };

      if (mutableRegistry.tools instanceof Map) {
        mutableRegistry.tools.set("edit", attackerEdit);
        mutableRegistry.tools.set("runtime.injected", injectedTool);
        mutableRegistry.tools.delete("edit");
        mutableRegistry.tools.clear();
      }
      attemptMutation(() => {
        mutableRegistry.tools = new Map([
          ["edit", attackerEdit],
          ["runtime.injected", injectedTool]
        ]);
      });

      expect(registry.get("edit")).toBe(registeredEdit);
      expect(registry.get("runtime.injected")).toBeUndefined();
      expect(registry.has("edit")).toBe(true);
      expect(registry.has("runtime.injected")).toBe(false);
      expect(registry.list().find((tool) => tool.name === "edit")).toBe(registeredEdit);
      expect(
        registry.getDefinitions().filter((definition) => definition.name === "edit")
      ).toHaveLength(1);
      expect(isPolicyGatedTool(registeredEdit)).toBe(true);

      const result = await registry.get("edit")?.run(fixture.context, {});

      expect(result).toEqual({
        success: true,
        output: "edit executed",
        outputSummary: "edit executed"
      });
      expect(edit.calls).toBe(1);
      expect(attackerEdit.calls).toBe(0);
      expect(injectedTool.calls).toBe(0);
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
  lastInput: unknown;

  constructor(readonly name: string) {
    super();
    this.description = createCompleteToolDescription(name);
  }

  protected async execute(_ctx: ToolContext, input: unknown): Promise<ToolResult> {
    this.calls += 1;
    this.lastInput = input;
    return {
      success: true,
      output: `${this.name} executed`,
      outputSummary: `${this.name} executed`
    };
  }
}

class DivergentDefinitionTool extends RecordingTool {
  constructor(
    name: string,
    private readonly definitionName: string,
    private readonly definitionDescription: string
  ) {
    super(name);
  }

  override toDefinition(): ToolDefinition {
    return {
      ...super.toDefinition(),
      name: this.definitionName,
      description: this.definitionDescription,
      parameters: { leaked: true }
    };
  }
}

class RequiredCommandRecordingTool extends RecordingTool {
  parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      command: {
        type: "string"
      }
    },
    required: ["command"],
    additionalProperties: true
  };
}

class ZodRecordingTool extends RecordingTool {
  constructor(
    name: string,
    readonly parameterSchema: unknown
  ) {
    super(name);
  }
}

function attemptRegisteredWrapperFieldMutation(
  tool: BaseTool,
  replacement: {
    kind: BaseTool["kind"];
    requiredModelCapabilities: readonly string[];
  }
): void {
  const mutations: Array<() => void> = [
    () => {
      tool.kind = replacement.kind;
    },
    () => {
      tool.requiredModelCapabilities = replacement.requiredModelCapabilities;
    }
  ];

  for (const mutate of mutations) {
    try {
      mutate();
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
    }
  }
}

function attemptRegisteredWrapperAuthorityMutation(
  tool: BaseTool,
  replacement: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    innerTool: BaseTool;
    policyGateToolId: string;
    options: Record<string, unknown>;
  }
): void {
  const mutableTool = tool as BaseTool & {
    innerTool?: BaseTool;
    policyGateToolId?: string;
    options?: unknown;
  };
  const exposedOptions = mutableTool.options;
  if (exposedOptions !== null && typeof exposedOptions === "object") {
    const mutableOptions = exposedOptions as Record<string, unknown>;
    attemptMutation(() => {
      mutableOptions.evaluate = replacement.options.evaluate;
    });
    attemptMutation(() => {
      Object.defineProperty(mutableOptions, "evaluate", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: replacement.options.evaluate
      });
    });
  }

  const replacements: Record<string, unknown> = {
    name: replacement.name,
    description: replacement.description,
    parameters: replacement.parameters,
    innerTool: replacement.innerTool,
    policyGateToolId: replacement.policyGateToolId,
    options: replacement.options
  };

  for (const [field, value] of Object.entries(replacements)) {
    attemptMutation(() => {
      (mutableTool as unknown as Record<string, unknown>)[field] = value;
    });
    attemptMutation(() => {
      Object.defineProperty(mutableTool, field, {
        configurable: true,
        enumerable: true,
        writable: true,
        value
      });
    });
  }
}

function expectWrapperAuthorityPropertiesHardened(tool: BaseTool): void {
  expect(Object.isExtensible(tool)).toBe(false);
  for (const field of [
    "name",
    "description",
    "parameters",
    "innerTool",
    "policyGateToolId"
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(tool, field);
    expect(descriptor).toBeDefined();
    if (!descriptor || !("get" in descriptor)) {
      throw new Error(`${field} should be a hardened accessor property`);
    }
    expect(descriptor.configurable).toBe(false);
    expect(descriptor.set).toBeUndefined();
  }
  for (const field of ["kind", "requiredModelCapabilities"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(tool, field);
    expect(descriptor).toBeDefined();
    if (!descriptor || !("writable" in descriptor)) {
      throw new Error(`${field} should be a hardened data property`);
    }
    expect(descriptor.configurable).toBe(false);
    expect(descriptor.writable).toBe(false);
  }
  expect(Object.prototype.hasOwnProperty.call(tool, "options")).toBe(false);
}

function monkeyPatchZodSafeParseToAccept(schema: unknown, data: unknown): void {
  const mutableSchema = schema as {
    safeParse(input: unknown): unknown;
  };
  mutableSchema.safeParse = () => ({
    success: true,
    data
  });
  expect(mutableSchema.safeParse({ command: 42 })).toEqual({
    success: true,
    data
  });
}

function createCompleteToolDescription(name: string): string {
  return [
    `何时该用: Use ${name} when a test needs a policy-gated tool fixture.`,
    `何时不该用: Do not use ${name} to exercise real filesystem, model, or SHUD solver behavior.`,
    `成功与失败样态: Success records the input and returns a fixture result; failure is injected by the wrapper or test harness.`
  ].join("\n");
}

function createMinimalShudRuntimeRegistryOptions(
  overrides: Partial<{
    tools: readonly BaseTool[];
    role: "coordinator" | "repo_explorer" | "worker" | "coder" | "reviewer";
  }> = {}
) {
  return {
    protectedRawPaths: ["/tmp/shud-harness-test/data/raw"],
    allowedWriteRoots: ["/tmp/shud-harness-test/workspace"],
    tempRoot: "/tmp/shud-harness-test/tmp",
    profileRoot: "/tmp/shud-harness-test/profiles",
    fuseRules: [],
    ...overrides
  };
}

function createNestedPolicyGateInput(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {
    leaf: "value"
  };
  for (let index = 0; index < depth; index += 1) {
    value = {
      child: value
    };
  }
  return value;
}

function createObjectWithKeyCount(count: number): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`key_${index}`, "value"])
  );
}

function createNodeDensePolicyGateInput(): Record<string, unknown> {
  return {
    batches: Array.from({ length: 10 }, () =>
      Array.from({ length: 1_024 }, () => ({
        value: "x"
      }))
    )
  };
}

function isExpectedNumericArrayDescriptorKey(propertyKey: PropertyKey, length: number): boolean {
  if (typeof propertyKey !== "string") {
    return false;
  }
  const index = Number(propertyKey);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === propertyKey;
}

type GlobalPrototypeReparentOutcomes = {
  object: boolean;
  array: boolean;
  function: boolean;
};

type GlobalPrototypeResidueObservation = {
  object: unknown;
  array: unknown;
  function: unknown;
};

function attemptGlobalPrototypeReparents(
  value: object,
  sentinel: string
): GlobalPrototypeReparentOutcomes {
  const outcomes: GlobalPrototypeReparentOutcomes = {
    object: false,
    array: false,
    function: false
  };
  const probes: Array<[keyof GlobalPrototypeReparentOutcomes, object]> = [
    ["object", Object.prototype],
    ["array", Array.prototype],
    ["function", Function.prototype]
  ];

  for (const [label, prototype] of probes) {
    const succeeded = attemptMutation(() => {
      Object.setPrototypeOf(value, prototype);
    });
    outcomes[label] = succeeded;
    if (succeeded && Object.getPrototypeOf(value) === prototype) {
      attemptMutation(() => {
        (prototype as Record<string, unknown>)[sentinel] = "mutated";
      });
    }
  }

  return outcomes;
}

function readGlobalPrototypeResidue(sentinel: string): GlobalPrototypeResidueObservation {
  return {
    object: (Object.prototype as Record<string, unknown>)[sentinel],
    array: (Array.prototype as Record<string, unknown>)[sentinel],
    function: (Function.prototype as Record<string, unknown>)[sentinel]
  };
}

function deleteGlobalPrototypeResidue(sentinel: string): void {
  delete (Object.prototype as Record<string, unknown>)[sentinel];
  delete (Array.prototype as Record<string, unknown>)[sentinel];
  delete (Function.prototype as Record<string, unknown>)[sentinel];
}

function attemptMutation(mutator: () => void): boolean {
  try {
    mutator();
    return true;
  } catch {
    return false;
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

function expectToolParameterSchemaValidationDenial(result: ToolResult | undefined): void {
  expect(result?.success).toBe(false);
  expect(result?.output).toContain("policy_gate_denied");
  expect(result?.output).toContain("tool-parameter-schema-validation");
  const payload = JSON.parse(result?.output ?? "{}") as {
    error?: string;
    ruleId?: string;
    reason?: string;
    remediation?: {
      next_action?: string;
      hint?: string;
      ref?: string;
    };
  };
  expect(payload.error).toBe("policy_gate_denied");
  expect(payload.ruleId).toBe("tool-parameter-schema-validation");
  expect(payload.reason).toContain("command");
  expect(payload.remediation?.next_action).toBe("fix_and_retry");
  expect(payload.remediation?.hint).toContain("Zod parameter schema");
  expect(payload.remediation?.ref).toBe(
    "docs/02_ARCHITECTURE/Control_Kernel.md#53-工具面治理约定"
  );
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
