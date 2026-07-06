import { BaseTool, SpawnAgentTool, ToolRegistry, loadFuseList } from "@zero-os/core";
import { toErrorMessage } from "@zero-os/shared";
import type { FuseRule, ToolContext, ToolDefinition, ToolResult } from "@zero-os/shared";
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

    const executionInput = clonePolicyGateInput(input);
    return {
      decision: "allow",
      executionInput,
      evaluatorInput: clonePolicyGateInput(executionInput)
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

  const missingToolIds = uniqueStrings(toolIds.filter((toolId) => !registry.get(toolId)));
  if (missingToolIds.length === 0) {
    return undefined;
  }

  return buildSpawnToolAvailabilityDeny(missingToolIds);
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
  missingToolIds: readonly string[]
): Extract<PolicyGateDecision, { decision: "deny" }> {
  const missingSummary = formatToolIdSummary(missingToolIds);
  return {
    decision: "deny",
    ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
    reason: `spawn_agent normalized tool contract includes ${missingToolIds.length} tool id(s) unavailable in the SHUD runtime registry; examples: ${missingSummary}.`,
    remediation: {
      next_action: "adjust_scope",
      hint: `Register the missing SHUD runtime tools or request only available spawn tools; missing examples: ${missingSummary}.`,
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

function clonePolicyGateInput(value: unknown): unknown {
  if (typeof value === "function" || typeof value === "symbol") {
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
