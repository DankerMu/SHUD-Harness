import { BaseTool, SpawnAgentTool, ToolRegistry, loadFuseList } from "@zero-os/core";
import { toErrorMessage } from "@zero-os/shared";
import type { FuseRule, ToolContext, ToolDefinition, ToolResult } from "@zero-os/shared";
import {
  EMPTY_POLICY_GATE_CONTEXT,
  evaluatePolicyGate,
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

export interface PolicyGateWrapperOptions {
  toolId?: string;
  role?: HarnessRole;
  evaluate: PolicyGateEvaluator;
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
  options: ShudSandboxedBashToolOptions
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
    toolId: "bash",
    fuseRules: cloneFuseRules(fuseRules)
  });
}

export function createShudRuntimeToolRegistry(
  options: ShudRuntimeToolRegistryOptions
): ToolRegistry {
  const registry = new ToolRegistry();
  const evaluate = options.evaluate ?? createPolicyGateEvaluator(EMPTY_POLICY_GATE_CONTEXT);
  let includesSpawnAgent = false;

  for (const tool of options.tools ?? []) {
    if (tool.name === "spawn_agent") {
      includesSpawnAgent = true;
      continue;
    }

    if (tool.name === "bash") {
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
        toolId: "spawn_agent"
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
    const decision = await this.options.evaluate(
      {
        toolId: this.policyGateToolId,
        role: this.options.role ?? resolveRole(toolContext),
        input,
        workDir: toolContext.workDir
      },
      {
        tool: this.innerTool,
        toolContext
      }
    );

    if (decision.decision === "deny") {
      const durationMs = Date.now() - startTime;
      if (decision.ruleId === RAW_DATA_WRITE_RULE_ID) {
        return this.finalizeDeniedResult(
          toolContext,
          buildRawDataRuleMisconfiguredResult(this.policyGateToolId, decision),
          durationMs
        );
      }
      return this.finalizeDeniedResult(
        toolContext,
        buildPolicyGateDeniedResult(this.policyGateToolId, decision),
        durationMs
      );
    }

    return this.innerTool.run(toolContext, input);
  }

  protected async execute(): Promise<ToolResult> {
    throw new Error("PolicyGatedBaseToolAdapter delegates through run().");
  }

  private async finalizeDeniedResult(
    toolContext: ToolContext,
    result: ToolResult,
    durationMs: number
  ): Promise<ToolResult> {
    try {
      await this.afterExecute(toolContext, result, durationMs);
      return result;
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      toolContext.logger.error("tool_call_error", {
        tool: this.name,
        error: errorMessage,
        durationMs
      });
      return {
        success: false,
        output: errorMessage,
        outputSummary: `Error: ${errorMessage.slice(0, 100)}`
      };
    }
  }
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

function buildPolicyGateDeniedResult(
  toolId: string,
  decision: Extract<PolicyGateDecision, { decision: "deny" }>
): ToolResult {
  const payload = {
    error: "policy_gate_denied",
    tool_id: toolId,
    reason: decision.reason,
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
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
