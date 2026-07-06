import { BaseTool, SpawnAgentTool, ToolRegistry, loadFuseList } from "@zero-os/core";
import { toErrorMessage } from "@zero-os/shared";
import type { FuseRule, ToolContext, ToolDefinition, ToolResult } from "@zero-os/shared";
import { types as nodeUtilTypes } from "node:util";
import {
  evaluatePolicyGate,
  normalizeSpawnAgentInput,
  PolicyGuardClassSchema,
  PolicyGateRemediationSchema,
  SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES,
  SPAWN_PROFILE_SUBSET_POLICY_REF,
  SPAWN_PROFILE_SUBSET_RULE,
  SPAWN_PROFILE_SUBSET_RULE_ID,
  SPAWN_PROFILE_TOOL_ID_SAMPLE_MAX_CHARS,
  type HarnessRole,
  type PolicyGateContext,
  type PolicyGateDecision,
  type PolicyGateRemediation,
  type PolicyGateToolCall
} from "./policy-gate-core";
import {
  RAW_DATA_WRITE_RULE_ID,
  RawDataSandboxedBashTool,
  type RawDataSeatbeltProfileOptions
} from "./raw-data-sandbox";

export type {
  HarnessRole,
  PolicyGateContext,
  PolicyGateDecision,
  PolicyGateRemediation,
  PolicyGateToolCall,
  PolicyRule,
  PolicyRuleDecision
} from "./policy-gate-core";

export interface PolicyGateEvaluationContext {
  tool: BaseTool;
  toolContext: ToolContext;
}

export type PolicyGateEvaluator = (
  call: PolicyGateToolCall,
  context: PolicyGateEvaluationContext
) => PolicyGateDecision | Promise<PolicyGateDecision>;

export type PolicyGateExecutionInputValidator = (
  input: unknown
) => Extract<PolicyGateDecision, { decision: "deny" }> | undefined;

export interface PolicyGateWrapperOptions {
  toolId?: string;
  role?: HarnessRole;
  evaluate: PolicyGateEvaluator;
  validateExecutionInput?: PolicyGateExecutionInputValidator;
}

export type ShudBashFuseSource =
  | { fuseRules: readonly FuseRule[]; fuseListPath?: never }
  | { fuseListPath: string; fuseRules?: never };

export type ShudSandboxedBashToolOptions = RawDataSeatbeltProfileOptions &
  ShudBashFuseSource & {
    enableAdvisory?: boolean;
    pathResolutionRoot?: string;
    auditWorkspaceRoot?: string;
    auditTaskId?: string;
  };

export type ShudRuntimeToolRegistryOptions = ShudSandboxedBashToolOptions & {
  tools?: readonly BaseTool[];
  evaluate?: PolicyGateEvaluator;
  role?: HarnessRole;
  modelRouter?: ConstructorParameters<typeof SpawnAgentTool>[0];
  metrics?: ConstructorParameters<typeof SpawnAgentTool>[2];
};

export type PolicyGatedTool = BaseTool & {
  readonly innerTool: BaseTool;
  readonly policyGateToolId: string;
};

const policyGatedTools = new WeakSet<BaseTool>();

export function createPolicyGateEvaluator(context: PolicyGateContext): PolicyGateEvaluator {
  return (call) => evaluatePolicyGate(call, context);
}

export const DEFAULT_SHUD_POLICY_GATE_CONTEXT: PolicyGateContext = Object.freeze({
  rules: Object.freeze([SPAWN_PROFILE_SUBSET_RULE])
});

// Mirrors Zero's sub-agent hard filter at the pinned zero submodule boundary.
const ZERO_SUB_AGENT_BLOCKED_TOOL_IDS = new Set([
  "spawn_agent",
  "wait_agent",
  "close_agent",
  "send_input"
]);

const GENERIC_POLICY_GATE_INPUT_MAX_DEPTH = 32;
const GENERIC_POLICY_GATE_INPUT_MAX_NODES = 10_000;
const GENERIC_POLICY_GATE_INPUT_MAX_ARRAY_LENGTH = 1_024;
const GENERIC_POLICY_GATE_INPUT_MAX_OBJECT_KEYS = 256;
const GENERIC_POLICY_GATE_INPUT_MAX_STRING_CHARS = 131_072;
const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function createShudPolicyGateEvaluator(
  customEvaluate?: PolicyGateEvaluator
): PolicyGateEvaluator {
  const authorityEvaluate = createPolicyGateEvaluator(DEFAULT_SHUD_POLICY_GATE_CONTEXT);
  if (!customEvaluate) {
    return authorityEvaluate;
  }

  return async (call, context) => {
    const authorityDecision = await authorityEvaluate(call, context);
    if (authorityDecision.decision === "deny") {
      return authorityDecision;
    }

    return customEvaluate(call, context);
  };
}

export function wrapToolWithPolicyGate(
  tool: BaseTool,
  options: PolicyGateWrapperOptions
): PolicyGatedTool {
  const wrapped = new PolicyGatedBaseToolAdapter(unwrapPolicyGatedTool(tool), options);
  policyGatedTools.add(wrapped);
  return wrapped;
}

export function wrapAllRegisteredTools(
  tools: readonly BaseTool[],
  options: Omit<PolicyGateWrapperOptions, "toolId">
): PolicyGatedTool[] {
  const wrappedTools = tools.map((tool) =>
    wrapToolWithPolicyGate(tool, {
      ...options,
      toolId: tool.name
    })
  );
  assertAllToolsPolicyGated(wrappedTools);
  return wrappedTools;
}

export function createPolicyGatedToolRegistry(
  tools: readonly BaseTool[],
  options: Omit<PolicyGateWrapperOptions, "toolId">
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of wrapAllRegisteredTools(tools, options)) {
    registry.register(tool);
  }
  assertPolicyGatedToolRegistry(registry);
  return registry;
}

export function createShudSandboxedBashTool(
  options: ShudSandboxedBashToolOptions,
  toolId = "bash"
): RawDataSandboxedBashTool {
  const fuseRules = resolveShudBashFuseRules(options);
  const profileOptions = snapshotRawDataSeatbeltProfileOptions(options);
  return new RawDataSandboxedBashTool({
    protectedRawPaths: profileOptions.protectedRawPaths,
    protectedEvidencePaths: profileOptions.protectedEvidencePaths,
    allowedWriteRoots: profileOptions.allowedWriteRoots,
    tempRoot: profileOptions.tempRoot,
    profileRoot: profileOptions.profileRoot,
    enableAdvisory: options.enableAdvisory,
    pathResolutionRoot: options.pathResolutionRoot,
    auditWorkspaceRoot: options.auditWorkspaceRoot,
    auditTaskId: options.auditTaskId,
    toolId,
    fuseRules: cloneFuseRules(fuseRules)
  });
}

export function createShudRuntimeToolRegistry(
  options: ShudRuntimeToolRegistryOptions
): ToolRegistry {
  const registry = new ToolRegistry();
  const evaluate = createShudPolicyGateEvaluator(options.evaluate);
  let includesSpawnAgent = false;

  for (const tool of options.tools ?? []) {
    if (tool.name === "spawn_agent") {
      includesSpawnAgent = true;
      continue;
    }

    if (tool.name === "bash" || tool.name === "sandbox.exec") {
      continue;
    }

    registry.register(
      wrapToolWithPolicyGate(tool, {
        evaluate,
        role: options.role,
        toolId: tool.name
      })
    );
  }

  registry.register(
    wrapToolWithPolicyGate(createShudSandboxedBashTool(options), {
      evaluate,
      role: options.role,
      toolId: "bash"
    })
  );
  registry.register(
    wrapToolWithPolicyGate(createShudSandboxedBashTool(options, "sandbox.exec"), {
      evaluate,
      role: options.role,
      toolId: "sandbox.exec"
    })
  );

  if (includesSpawnAgent) {
    if (!options.modelRouter) {
      throw new Error(
        "SHUD runtime registry cannot reuse a prebuilt spawn_agent; provide modelRouter to rebuild it against the final registry."
      );
    }
    registry.register(
      wrapToolWithPolicyGate(new SpawnAgentTool(options.modelRouter, registry, options.metrics), {
        evaluate,
        role: options.role,
        toolId: "spawn_agent",
        validateExecutionInput: createSpawnAgentToolAvailabilityValidator(registry)
      })
    );
  }

  assertPolicyGatedToolRegistry(registry);
  return registry;
}

export function assertPolicyGatedToolRegistry(registry: ToolRegistry): void {
  assertAllToolsPolicyGated(registry.list());
}

export function assertAllToolsPolicyGated(tools: readonly BaseTool[]): void {
  const unwrappedToolIds = tools
    .filter((tool) => !isPolicyGatedTool(tool))
    .map((tool) => tool.name || "<unknown>");

  if (unwrappedToolIds.length > 0) {
    throw new Error(
      `Policy-gated tool assembly failed; unwrapped tool ids: ${unwrappedToolIds.join(", ")}`
    );
  }
}

export function isPolicyGatedTool(tool: BaseTool): tool is PolicyGatedTool {
  return policyGatedTools.has(tool);
}

function unwrapPolicyGatedTool(tool: BaseTool): BaseTool {
  let current = tool;
  while (isPolicyGatedTool(current)) {
    current = current.innerTool;
  }
  return current;
}

class PolicyGatedBaseToolAdapter extends BaseTool implements PolicyGatedTool {
  readonly policyGateToolId: string;

  constructor(
    readonly innerTool: BaseTool,
    private readonly options: PolicyGateWrapperOptions
  ) {
    super();
    this.policyGateToolId = options.toolId ?? innerTool.name;
    this.kind = innerTool.kind;
    this.requiredModelCapabilities = innerTool.requiredModelCapabilities;
  }

  get name(): string {
    return this.innerTool.name;
  }

  get description(): string {
    return this.innerTool.description;
  }

  get parameters(): Record<string, unknown> {
    return this.innerTool.parameters;
  }

  toDefinition(): ToolDefinition {
    return this.innerTool.toDefinition();
  }

  async run(toolContext: ToolContext, input: unknown): Promise<ToolResult> {
    const startTime = Date.now();
    let decision: PolicyGateDecision;
    const role = this.options.role ?? resolveRole(toolContext);
    let preparedInput:
      | {
          decision: "allow";
          executionInput: unknown;
          evaluatorInput: unknown;
        }
      | Extract<PolicyGateDecision, { decision: "deny" }>;
    try {
      preparedInput = this.preparePolicyGateInput(toolContext, role, input);
    } catch {
      const durationMs = Date.now() - startTime;
      return this.finalizePolicyGateResult(
        toolContext,
        buildPolicyGatePreparationFailedResult(this.policyGateToolId),
        durationMs
      );
    }
    if (preparedInput.decision === "deny") {
      const durationMs = Date.now() - startTime;
      return this.finalizePolicyGateResult(
        toolContext,
        buildPolicyGateDeniedResult(this.policyGateToolId, preparedInput),
        durationMs
      );
    }

    const executionValidationDecision = this.options.validateExecutionInput?.(
      preparedInput.executionInput
    );
    if (executionValidationDecision) {
      const durationMs = Date.now() - startTime;
      return this.finalizePolicyGateResult(
        toolContext,
        buildPolicyGateDeniedResult(this.policyGateToolId, executionValidationDecision),
        durationMs
      );
    }

    try {
      const candidate = await this.options.evaluate(
        {
          toolId: this.policyGateToolId,
          role,
          input: preparedInput.evaluatorInput,
          workDir: toolContext.workDir
        },
        {
          tool: this.innerTool,
          toolContext
        }
      );
      decision = validatePolicyGateDecision(this.policyGateToolId, candidate);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = toErrorMessage(error);
      return this.finalizePolicyGateResult(
        toolContext,
        {
          success: false,
          output: errorMessage,
          outputSummary: `Error: ${errorMessage.slice(0, 100)}`
        },
        durationMs
      );
    }

    if (decision.decision === "deny") {
      const durationMs = Date.now() - startTime;
      if (decision.ruleId === RAW_DATA_WRITE_RULE_ID) {
        return this.finalizePolicyGateResult(
          toolContext,
          buildRawDataRuleMisconfiguredResult(this.policyGateToolId, decision),
          durationMs
        );
      }
      return this.finalizePolicyGateResult(
        toolContext,
        buildPolicyGateDeniedResult(this.policyGateToolId, decision),
        durationMs
      );
    }

    return this.innerTool.run(toolContext, preparedInput.executionInput);
  }

  protected async execute(): Promise<ToolResult> {
    throw new Error("PolicyGatedBaseToolAdapter delegates through run().");
  }

  private async finalizePolicyGateResult(
    toolContext: ToolContext,
    result: ToolResult,
    durationMs: number
  ): Promise<ToolResult> {
    let finalResult = result;
    try {
      await this.afterExecute(toolContext, finalResult, durationMs);
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      toolContext.logger.error("tool_call_error", {
        tool: this.name,
        error: errorMessage,
        durationMs
      });
      finalResult = {
        success: false,
        output: errorMessage,
        outputSummary: `Error: ${errorMessage.slice(0, 100)}`
      };
    }
    this.markRunningToolFinished(toolContext, finalResult);
    return finalResult;
  }

  private markRunningToolFinished(toolContext: ToolContext, result: ToolResult): void {
    const toolUseId = toolContext.currentToolUseId;
    const runningHandle =
      toolUseId && toolContext.runningToolRegistry
        ? toolContext.runningToolRegistry.get(toolUseId)
        : undefined;
    runningHandle?.markFinished({
      finishedAt: new Date().toISOString(),
      cause: "completed",
      success: result.success,
      outputSummary: result.outputSummary
    });
  }

  private preparePolicyGateInput(
    toolContext: ToolContext,
    role: HarnessRole | "unknown",
    input: unknown
  ):
    | {
        decision: "allow";
        executionInput: unknown;
        evaluatorInput: unknown;
      }
    | Extract<PolicyGateDecision, { decision: "deny" }> {
    if (this.policyGateToolId === "spawn_agent") {
      const normalizedInput = normalizeSpawnAgentInput({
        toolId: this.policyGateToolId,
        role,
        input,
        workDir: toolContext.workDir
      });
      if (normalizedInput.decision === "deny") {
        return normalizedInput;
      }

      return {
        decision: "allow",
        executionInput: normalizedInput.input,
        evaluatorInput: clonePolicyGateInput(normalizedInput.input)
      };
    }

    const { executionInput, evaluatorInput } = prepareGenericPolicyGateInputSnapshots(input);
    return {
      decision: "allow",
      executionInput,
      evaluatorInput
    };
  }
}

function createSpawnAgentToolAvailabilityValidator(
  registry: ToolRegistry
): PolicyGateExecutionInputValidator {
  return (input) => validateSpawnAgentToolAvailability(input, registry);
}

function validateSpawnAgentToolAvailability(
  input: unknown,
  registry: ToolRegistry
): Extract<PolicyGateDecision, { decision: "deny" }> | undefined {
  const toolIds = readNormalizedSpawnToolIds(input);
  if (toolIds.length === 0) {
    return undefined;
  }

  const unavailableToolIds = uniqueStrings(
    toolIds.filter((toolId) => !registry.get(toolId) || ZERO_SUB_AGENT_BLOCKED_TOOL_IDS.has(toolId))
  );
  if (unavailableToolIds.length === 0) {
    return undefined;
  }

  return buildSpawnToolAvailabilityDeny(unavailableToolIds);
}

function readNormalizedSpawnToolIds(input: unknown): string[] {
  if (input === null || typeof input !== "object") {
    return [];
  }

  const tools = (input as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools.filter((toolId): toolId is string => typeof toolId === "string");
}

function buildSpawnToolAvailabilityDeny(
  unavailableToolIds: readonly string[]
): Extract<PolicyGateDecision, { decision: "deny" }> {
  const unavailableSummary = formatToolIdSummary(unavailableToolIds);
  return {
    decision: "deny",
    ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
    reason: `spawn_agent normalized tool contract includes ${unavailableToolIds.length} tool id(s) unavailable in the spawned scoped registry; examples: ${unavailableSummary}.`,
    remediation: {
      next_action: "adjust_scope",
      hint: `Register missing SHUD runtime tools or remove Zero-blocked spawn tools before spawning; unavailable examples: ${unavailableSummary}.`,
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function formatToolIdSummary(toolIds: readonly string[]): string {
  const samples = toolIds.slice(0, SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES).map(formatToolIdSample);
  const suffix =
    toolIds.length > SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES ? ` (${toolIds.length} total)` : "";
  return `${samples.join(", ")}${suffix}`;
}

function formatToolIdSample(toolId: string): string {
  if (toolId.length <= SPAWN_PROFILE_TOOL_ID_SAMPLE_MAX_CHARS) {
    return toolId;
  }

  return `${toolId.slice(0, SPAWN_PROFILE_TOOL_ID_SAMPLE_MAX_CHARS - 3)}...`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function validatePolicyGateDecision(toolId: string, candidate: unknown): PolicyGateDecision {
  if (candidate === null || typeof candidate !== "object") {
    throw new Error(`Invalid policy gate decision for ${toolId}: decision`);
  }

  const rawDecision = candidate as Record<string, unknown>;
  if (rawDecision.decision === "allow") {
    return { decision: "allow" };
  }

  if (rawDecision.decision !== "deny") {
    throw new Error(`Invalid policy gate decision for ${toolId}: decision`);
  }

  const ruleId = rawDecision.ruleId;
  const reason = rawDecision.reason;
  const rawGuardClass = rawDecision.guardClass ?? rawDecision.guard_class;
  const validRuleId = typeof ruleId === "string" ? ruleId : undefined;
  const validReason = typeof reason === "string" ? reason : undefined;
  const issuePaths: string[] = [];
  if (validRuleId === undefined) {
    issuePaths.push("ruleId");
  }
  if (validReason === undefined) {
    issuePaths.push("reason");
  }

  const parsedRemediation = PolicyGateRemediationSchema.safeParse(rawDecision.remediation);
  let remediation: PolicyGateRemediation | undefined;
  if (!parsedRemediation.success) {
    issuePaths.push(
      ...parsedRemediation.error.issues.map((issue) =>
        issue.path.length > 0 ? `remediation.${issue.path.join(".")}` : "remediation"
      )
    );
  } else {
    remediation = parsedRemediation.data;
  }

  const parsedGuardClass =
    rawGuardClass === undefined ? undefined : PolicyGuardClassSchema.safeParse(rawGuardClass);
  if (parsedGuardClass && !parsedGuardClass.success) {
    issuePaths.push("guardClass");
  }

  if (
    issuePaths.length > 0 ||
    validRuleId === undefined ||
    validReason === undefined ||
    !remediation
  ) {
    const ruleLabel = validRuleId && validRuleId.trim() !== "" ? validRuleId : "<missing>";
    const invalidFields = issuePaths.length > 0 ? issuePaths : ["decision"];
    throw new Error(
      `Invalid policy gate decision for ${toolId} (rule ${ruleLabel}): ${invalidFields.join(", ")}`
    );
  }

  return {
    decision: "deny",
    ruleId: validRuleId,
    reason: validReason,
    remediation,
    ...(parsedGuardClass?.success ? { guardClass: parsedGuardClass.data } : {})
  };
}

function snapshotRawDataSeatbeltProfileOptions(
  options: RawDataSeatbeltProfileOptions
): RawDataSeatbeltProfileOptions {
  const snapshot: RawDataSeatbeltProfileOptions = {
    protectedRawPaths: frozenStringArray(options.protectedRawPaths),
    allowedWriteRoots: frozenStringArray(options.allowedWriteRoots)
  };
  if (options.protectedEvidencePaths !== undefined) {
    snapshot.protectedEvidencePaths = frozenStringArray(options.protectedEvidencePaths);
  }
  if (options.tempRoot !== undefined) {
    snapshot.tempRoot = options.tempRoot;
  }
  if (options.profileRoot !== undefined) {
    snapshot.profileRoot = options.profileRoot;
  }
  return snapshot;
}

function frozenStringArray(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function buildRawDataRuleMisconfiguredResult(
  toolId: string,
  decision: Extract<PolicyGateDecision, { decision: "deny" }>
): ToolResult {
  const remediation: PolicyGateRemediation = {
    next_action: "fix_and_retry",
    hint: "Remove RAW_DATA_WRITE_RULE_ID from the outer policy evaluator and let RawDataSandboxedBashTool own raw advisory, audit reservation, and tool-failed evidence.",
    ref: decision.remediation.ref
  };
  const payload = {
    error: "policy_gate_raw_data_rule_misconfigured",
    tool_id: toolId,
    rule: RAW_DATA_WRITE_RULE_ID,
    reason:
      "Outer policy gate attempted to deny raw-data writes. Raw advisory and raw-denial evidence ownership belongs inside RawDataSandboxedBashTool.",
    outer_reason: decision.reason,
    remediation
  };

  return {
    success: false,
    output: JSON.stringify(payload),
    outputSummary: `Policy gate raw-data rule misconfigured for ${toolId}: ${decision.reason}`
  };
}

function buildPolicyGatePreparationFailedResult(toolId: string): ToolResult {
  const remediation: PolicyGateRemediation = {
    next_action: "fix_and_retry",
    hint: "Provide plain JSON-compatible tool input so the policy gate can safely inspect it before execution.",
    ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
  };
  const payload = {
    error: "policy_gate_input_preparation_failed",
    tool_id: toolId,
    reason: "Policy gate could not safely prepare the tool input before evaluation.",
    remediation
  };

  return {
    success: false,
    output: JSON.stringify(payload),
    outputSummary: `Policy gate input preparation failed for ${toolId}`
  };
}

function buildPolicyGateDeniedResult(
  toolId: string,
  decision: Extract<PolicyGateDecision, { decision: "deny" }>
): ToolResult {
  const payload = {
    error: "policy_gate_denied",
    tool_id: toolId,
    reason: decision.reason,
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
    ...(decision.guardClass ? { guard_class: decision.guardClass } : {}),
    ...(decision.remediation ? { remediation: decision.remediation } : {})
  };

  return {
    success: false,
    output: JSON.stringify(payload),
    outputSummary: `Policy gate denied ${toolId}: ${decision.reason}`
  };
}

function resolveShudBashFuseRules(options: ShudBashFuseSource): readonly FuseRule[] {
  const rawOptions = options as Record<string, unknown>;
  const hasFuseRules = Object.prototype.hasOwnProperty.call(rawOptions, "fuseRules");
  const hasFuseListPath = Object.prototype.hasOwnProperty.call(rawOptions, "fuseListPath");

  if (hasFuseRules === hasFuseListPath) {
    throw new Error("SHUD sandboxed bash requires exactly one of fuseRules or fuseListPath.");
  }

  if (hasFuseRules) {
    if (!Array.isArray(rawOptions.fuseRules)) {
      throw new Error("SHUD sandboxed bash fuseRules must be an array.");
    }
    return cloneFuseRules(rawOptions.fuseRules as readonly FuseRule[]);
  }

  if (typeof rawOptions.fuseListPath !== "string" || rawOptions.fuseListPath.trim() === "") {
    throw new Error("SHUD sandboxed bash fuseListPath must be a non-empty string.");
  }

  return cloneFuseRules(loadFuseList(rawOptions.fuseListPath));
}

function cloneFuseRules(rules: readonly FuseRule[]): FuseRule[] {
  return rules.map((rule) => ({
    pattern: rule.pattern,
    description: rule.description
  }));
}

interface GenericPolicyGateInputBudgetState {
  nodes: number;
  stringChars: number;
}

interface GenericPolicyGateSnapshotState extends GenericPolicyGateInputBudgetState {
  snapshots: WeakMap<object, unknown>;
}

type GenericPolicyGateDataDescriptor = PropertyDescriptor & {
  value: unknown;
};

type GenericPolicyGateCloneMode = "execution" | "evaluator";

function prepareGenericPolicyGateInputSnapshots(value: unknown): {
  executionInput: unknown;
  evaluatorInput: unknown;
} {
  const canonicalInput = materializeGenericPolicyGateInput(value, {
    nodes: 0,
    stringChars: 0,
    snapshots: new WeakMap<object, unknown>()
  });
  return {
    executionInput: cloneGenericPolicyGateMaterializedInput(canonicalInput, {
      mode: "execution"
    }),
    evaluatorInput: cloneGenericPolicyGateMaterializedInput(canonicalInput, {
      mode: "evaluator"
    })
  };
}

function materializeGenericPolicyGateInput(
  value: unknown,
  state: GenericPolicyGateSnapshotState,
  depth = 0
): unknown {
  if (depth > GENERIC_POLICY_GATE_INPUT_MAX_DEPTH) {
    throw new Error("Policy gate input exceeds depth budget.");
  }

  state.nodes += 1;
  if (state.nodes > GENERIC_POLICY_GATE_INPUT_MAX_NODES) {
    throw new Error("Policy gate input exceeds node budget.");
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    addGenericPolicyGateStringBudget(value.length, state);
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "undefined") {
    return value;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error("Policy gate input contains unsafe value types.");
  }
  if (typeof value !== "object") {
    throw new Error("Policy gate input contains unsupported value types.");
  }

  const objectValue = value as object;
  const existingSnapshot = state.snapshots.get(objectValue);
  if (existingSnapshot) {
    return existingSnapshot;
  }

  if (nodeUtilTypes.isProxy(objectValue)) {
    throw new Error("Policy gate input must be stable ordinary structured data.");
  }

  if (Array.isArray(objectValue)) {
    assertOrdinaryGenericPolicyGateArray(objectValue);
    return materializeGenericPolicyGateArray(objectValue, state, depth);
  }

  const prototype = Object.getPrototypeOf(objectValue);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Policy gate input must be plain structured data.");
  }

  return materializeGenericPolicyGatePlainObject(objectValue, state, depth);
}

function assertOrdinaryGenericPolicyGateArray(value: readonly unknown[]): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("Policy gate input arrays must be ordinary structured data.");
  }
}

function materializeGenericPolicyGateArray(
  value: readonly unknown[],
  state: GenericPolicyGateSnapshotState,
  depth: number
): unknown[] {
  const length = readGenericPolicyGateArrayLength(value);
  if (length > GENERIC_POLICY_GATE_INPUT_MAX_ARRAY_LENGTH) {
    throw new Error("Policy gate input exceeds array length budget.");
  }

  const snapshot = new Array<unknown>(length);
  state.snapshots.set(value, snapshot);

  for (let index = 0; index < length; index += 1) {
    const descriptor = readGenericPolicyGateArrayIndexDataDescriptor(value, index);
    if (!descriptor) {
      continue;
    }

    snapshot[index] = materializeGenericPolicyGateInput(descriptor.value, state, depth + 1);
  }

  return snapshot;
}

function materializeGenericPolicyGatePlainObject(
  value: object,
  state: GenericPolicyGateSnapshotState,
  depth: number
): Record<string, unknown> {
  const snapshot = Object.create(null) as Record<string, unknown>;
  state.snapshots.set(value, snapshot);
  const keys = getBoundedGenericPolicyGateObjectKeys(value);

  for (const key of keys) {
    assertSafeGenericPolicyGatePropertyKey(key, state, true);
    const descriptor = readGenericPolicyGateDataDescriptor(value, key);
    const snapshotValue = materializeGenericPolicyGateInput(descriptor.value, state, depth + 1);
    if (!descriptor.enumerable) {
      continue;
    }
    Object.defineProperty(snapshot, key, {
      value: snapshotValue,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }

  return snapshot;
}

function readGenericPolicyGateArrayLength(value: readonly unknown[]): number {
  const length = Reflect.get(value, "length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 4_294_967_295
  ) {
    throw new Error("Policy gate input contains an unsafe array length.");
  }
  return length;
}

function getBoundedGenericPolicyGateObjectKeys(value: object): (string | symbol)[] {
  const keys = Reflect.ownKeys(value);
  if (keys.length > GENERIC_POLICY_GATE_INPUT_MAX_OBJECT_KEYS) {
    throw new Error("Policy gate input exceeds object key budget.");
  }
  return keys;
}

function readGenericPolicyGateDataDescriptor(
  value: object,
  key: string | symbol
): GenericPolicyGateDataDescriptor {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    throw new Error("Policy gate input contains unsafe accessors.");
  }
  return descriptor as GenericPolicyGateDataDescriptor;
}

function readGenericPolicyGateArrayIndexDataDescriptor(
  value: readonly unknown[],
  index: number
): GenericPolicyGateDataDescriptor | undefined {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
  if (!descriptor) {
    return undefined;
  }
  if (
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    throw new Error("Policy gate input contains unsafe accessors.");
  }
  return descriptor as GenericPolicyGateDataDescriptor;
}

function assertSafeGenericPolicyGatePropertyKey(
  key: string | symbol,
  state: GenericPolicyGateInputBudgetState,
  countStringBudget: boolean
): asserts key is string {
  if (typeof key === "symbol") {
    throw new Error("Policy gate input contains unsafe symbol keys.");
  }
  if (countStringBudget) {
    addGenericPolicyGateStringBudget(key.length, state);
  }
  if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
    throw new Error("Policy gate input contains prototype-polluting keys.");
  }
}

function addGenericPolicyGateStringBudget(
  length: number,
  state: GenericPolicyGateInputBudgetState
): void {
  state.stringChars += length;
  if (state.stringChars > GENERIC_POLICY_GATE_INPUT_MAX_STRING_CHARS) {
    throw new Error("Policy gate input exceeds string budget.");
  }
}

function cloneGenericPolicyGateMaterializedInput(
  value: unknown,
  options: { mode: GenericPolicyGateCloneMode }
): unknown {
  return cloneGenericPolicyGateMaterializedValue(
    value,
    {
      nodes: 0,
      stringChars: 0,
      snapshots: new WeakMap<object, unknown>()
    },
    options
  );
}

function cloneGenericPolicyGateMaterializedValue(
  value: unknown,
  state: GenericPolicyGateSnapshotState,
  options: { mode: GenericPolicyGateCloneMode },
  depth = 0
): unknown {
  if (depth > GENERIC_POLICY_GATE_INPUT_MAX_DEPTH) {
    throw new Error("Policy gate input exceeds depth budget.");
  }

  state.nodes += 1;
  if (state.nodes > GENERIC_POLICY_GATE_INPUT_MAX_NODES) {
    throw new Error("Policy gate input exceeds node budget.");
  }

  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    addGenericPolicyGateStringBudget(value.length, state);
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "undefined") {
    return value;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error("Policy gate input contains unsafe value types.");
  }
  if (typeof value !== "object") {
    throw new Error("Policy gate input contains unsupported value types.");
  }

  const objectValue = value as object;
  const existingSnapshot = state.snapshots.get(objectValue);
  if (existingSnapshot) {
    return existingSnapshot;
  }

  if (Array.isArray(objectValue)) {
    return cloneGenericPolicyGateMaterializedArray(objectValue, state, options, depth);
  }

  const prototype = Object.getPrototypeOf(objectValue);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Policy gate input must be plain structured data.");
  }

  return cloneGenericPolicyGateMaterializedPlainObject(objectValue, state, options, depth);
}

function cloneGenericPolicyGateMaterializedArray(
  value: readonly unknown[],
  state: GenericPolicyGateSnapshotState,
  options: { mode: GenericPolicyGateCloneMode },
  depth: number
): unknown[] {
  const length = readGenericPolicyGateArrayLength(value);
  if (length > GENERIC_POLICY_GATE_INPUT_MAX_ARRAY_LENGTH) {
    throw new Error("Policy gate input exceeds array length budget.");
  }

  const snapshot = new Array<unknown>(length);
  if (options.mode === "evaluator") {
    Object.setPrototypeOf(snapshot, createIsolatedArrayPrototype());
  }
  state.snapshots.set(value, snapshot);

  for (let index = 0; index < length; index += 1) {
    const descriptor = readGenericPolicyGateArrayIndexDataDescriptor(value, index);
    if (!descriptor) {
      continue;
    }

    const snapshotValue = cloneGenericPolicyGateMaterializedValue(
      descriptor.value,
      state,
      options,
      depth + 1
    );
    snapshot[index] = snapshotValue;
  }

  if (options.mode === "evaluator") {
    finalizeIsolatedEvaluatorArray(snapshot);
  }
  return snapshot;
}

function cloneGenericPolicyGateMaterializedPlainObject(
  value: object,
  state: GenericPolicyGateSnapshotState,
  options: { mode: GenericPolicyGateCloneMode },
  depth: number
): Record<string, unknown> {
  const snapshot =
    options.mode === "execution"
      ? ({} as Record<string, unknown>)
      : (Object.create(null) as Record<string, unknown>);
  state.snapshots.set(value, snapshot);
  const keys = getBoundedGenericPolicyGateObjectKeys(value);

  for (const key of keys) {
    assertSafeGenericPolicyGatePropertyKey(key, state, true);
    const descriptor = readGenericPolicyGateDataDescriptor(value, key);
    const snapshotValue = cloneGenericPolicyGateMaterializedValue(
      descriptor.value,
      state,
      options,
      depth + 1
    );
    if (!descriptor.enumerable) {
      continue;
    }
    Object.defineProperty(snapshot, key, {
      value: snapshotValue,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }

  if (options.mode === "evaluator") {
    Object.preventExtensions(snapshot);
  }
  return snapshot;
}

function createIsolatedArrayPrototype(): object {
  const prototype = Object.create(null) as Record<PropertyKey, unknown>;
  defineIsolatedArrayPrototypeMethod(prototype, Symbol.iterator, isolatedArrayIterator);
  defineIsolatedArrayPrototypeMethod(prototype, "includes", isolatedArrayIncludes);
  defineIsolatedArrayPrototypeMethod(prototype, "map", isolatedArrayMap);
  Object.freeze(prototype);
  return prototype;
}

function defineIsolatedArrayPrototypeMethod(
  prototype: Record<PropertyKey, unknown>,
  key: PropertyKey,
  method: (...args: unknown[]) => unknown
): void {
  Object.defineProperty(prototype, key, {
    value: method,
    enumerable: false,
    configurable: true,
    writable: true
  });
}

const isolatedArrayIncludes = isolateFunction(
  {
    includes(this: unknown, searchElement: unknown, fromIndex?: unknown): boolean {
      const receiver = requireIsolatedArrayReceiver(this);
      const length = readGenericPolicyGateArrayLength(receiver);
      const start = normalizeArrayStartIndex(length, fromIndex);
      for (let index = start; index < length; index += 1) {
        if (sameValueZero(receiver[index], searchElement)) {
          return true;
        }
      }
      return false;
    }
  }.includes
);

const isolatedArrayMap = isolateFunction(
  {
    map(this: unknown, callback: unknown, thisArg?: unknown): unknown[] {
      const receiver = requireIsolatedArrayReceiver(this);
      if (typeof callback !== "function") {
        throw new TypeError("Array map callback must be a function.");
      }
      const length = readGenericPolicyGateArrayLength(receiver);
      const result = createIsolatedEvaluatorArray(length);
      for (let index = 0; index < length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(receiver, index)) {
          continue;
        }
        result[index] = Reflect.apply(callback, thisArg, [receiver[index], index, receiver]);
      }
      return finalizeIsolatedEvaluatorArray(result);
    }
  }.map
);

const isolatedArrayIterator = isolateFunction(
  {
    [Symbol.iterator](this: unknown): IterableIterator<unknown> {
      return createIsolatedArrayIterator(requireIsolatedArrayReceiver(this));
    }
  }[Symbol.iterator]
);

function createIsolatedEvaluatorArray(length: number): unknown[] {
  const array = new Array<unknown>(length);
  Object.setPrototypeOf(array, createIsolatedArrayPrototype());
  return array;
}

function finalizeIsolatedEvaluatorArray<T extends unknown[]>(array: T): T {
  Object.preventExtensions(array);
  Object.defineProperty(array, "length", {
    writable: false
  });
  return array;
}

function createIsolatedArrayIterator(receiver: unknown[]): IterableIterator<unknown> {
  let index = 0;
  const iterator = Object.create(null) as IterableIterator<unknown>;
  Object.defineProperty(iterator, "next", {
    value: isolateFunction({
      next(): IteratorResult<unknown> {
        const length = readGenericPolicyGateArrayLength(receiver);
        if (index >= length) {
          return createIsolatedArrayIteratorResult(undefined, true);
        }
        const valueAtIndex = receiver[index];
        index += 1;
        return createIsolatedArrayIteratorResult(valueAtIndex, false);
      }
    }.next),
    enumerable: false,
    configurable: true,
    writable: true
  });
  Object.defineProperty(iterator, Symbol.iterator, {
    value: isolateFunction({
      [Symbol.iterator](this: IterableIterator<unknown>): IterableIterator<unknown> {
        return this;
      }
    }[Symbol.iterator]),
    enumerable: false,
    configurable: true,
    writable: true
  });
  Object.freeze(iterator);
  return iterator;
}

function createIsolatedArrayIteratorResult(value: unknown, done: boolean): IteratorResult<unknown> {
  const result = Object.create(null) as IteratorResult<unknown>;
  Object.defineProperty(result, "value", {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
  Object.defineProperty(result, "done", {
    value: done,
    enumerable: true,
    configurable: true,
    writable: true
  });
  Object.freeze(result);
  return result;
}

function requireIsolatedArrayReceiver(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Policy gate evaluator array method called on incompatible receiver.");
  }
  return value;
}

function normalizeArrayStartIndex(length: number, fromIndex: unknown): number {
  const integer = toIntegerOrInfinity(fromIndex);
  if (integer === Number.POSITIVE_INFINITY) {
    return length;
  }
  if (integer >= 0) {
    return Math.min(integer, length);
  }
  return Math.max(length + integer, 0);
}

function toIntegerOrInfinity(value: unknown): number {
  const number = value === undefined ? 0 : Number(value);
  if (Number.isNaN(number) || number === 0) {
    return 0;
  }
  if (!Number.isFinite(number)) {
    return number;
  }
  return Math.trunc(number);
}

function sameValueZero(left: unknown, right: unknown): boolean {
  return left === right || (left !== left && right !== right);
}

function isolateFunction<T extends (...args: unknown[]) => unknown>(value: T): T {
  Object.setPrototypeOf(value, null);
  Object.freeze(value);
  return value;
}

function clonePolicyGateInput(value: unknown): unknown {
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error("Policy gate input must be structured-cloneable data.");
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  try {
    return structuredClone(value);
  } catch {
    throw new Error("Policy gate input must be structured-cloneable data.");
  }
}

function resolveRole(toolContext: ToolContext): HarnessRole | "unknown" {
  const contextWithRole = toolContext as ToolContext & {
    role?: unknown;
    agentRole?: unknown;
  };
  const role = contextWithRole.role ?? contextWithRole.agentRole;
  return isHarnessRole(role) ? role : "unknown";
}

function isHarnessRole(value: unknown): value is HarnessRole {
  return (
    value === "coordinator" ||
    value === "repo_explorer" ||
    value === "worker" ||
    value === "coder" ||
    value === "reviewer"
  );
}
