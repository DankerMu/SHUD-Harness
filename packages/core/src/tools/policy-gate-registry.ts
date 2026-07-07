import {
  BaseTool,
  EditTool,
  ReadTool,
  SpawnAgentTool,
  ToolRegistry,
  WaitAgentTool,
  WriteTool,
  loadFuseList
} from "@zero-os/core";
import { toErrorMessage } from "@zero-os/shared";
import type { FuseRule, ToolContext, ToolDefinition, ToolResult } from "@zero-os/shared";
import { types as nodeUtilTypes } from "node:util";
import { ZodType } from "zod";
import {
  assertPolicyGateContextGuardClasses,
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

export interface PolicyGatedToolRegistrationLintOptions {
  role?: HarnessRole;
  requireDescriptionSections?: boolean;
}

export interface PolicyGatedToolRegistryAssertionOptions {
  role?: HarnessRole;
}

interface LintEnforcingPolicyGatedToolRegistryOptions
  extends PolicyGatedToolRegistryAssertionOptions {
  evaluate: PolicyGateEvaluator;
  validateExecutionInput?: PolicyGateExecutionInputValidator;
  resolveValidateExecutionInput?: (
    tool: BaseTool
  ) => PolicyGateExecutionInputValidator | undefined;
  normalizeTool?: (tool: BaseTool) => BaseTool;
}

export interface ToolZodParameterSchemaCarrier {
  readonly parameterSchema?: unknown;
  readonly zodParameters?: unknown;
  readonly zodSchema?: unknown;
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
const ROLE_VISIBLE_TOOL_COUNT_LIMIT = 20;
const CONTROL_KERNEL_TOOL_GOVERNANCE_REF =
  "docs/02_ARCHITECTURE/Control_Kernel.md#53-工具面治理约定";
const TOOL_PARAMETER_SCHEMA_RULE_ID = "tool-parameter-schema-validation";
const TOOL_PARAMETER_SCHEMA_MAX_ISSUES = 3;
const TOOL_PARAMETER_SCHEMA_ISSUE_MAX_CHARS = 240;
const SHUD_TOOL_DESCRIPTION_REQUIRED_SECTIONS = Object.freeze([
  "何时该用",
  "何时不该用",
  "成功与失败样态"
] as const);
const SHUD_SPAWN_AGENT_DESCRIPTION = [
  "何时该用: 仅当 coordinator 需要把已明确边界的工作委派给 canonical 子角色时使用。",
  "何时不该用: 不用于绕过当前角色权限、创建嵌套委派链，或替代 PI 科学判断。",
  "成功与失败样态: 成功时返回 agent_id 并由后续 wait_agent 收集结果；失败时返回策略门拒绝、未知角色、模型或工具剖面错误。"
].join("\n");
const SHUD_READ_TOOL_DESCRIPTION = [
  "何时该用: 在 SHUD runtime 中读取调度、审查或执行所需的文件内容，并保持只读边界。",
  "何时不该用: 不用于写入、编辑、删除文件，也不用于读取超出当前任务权限的敏感数据。",
  "成功与失败样态: 成功时返回文件内容和摘要；失败时返回文件缺失、权限或参数错误。"
].join("\n");
const SHUD_WRITE_TOOL_DESCRIPTION = [
  "何时该用: 在 coder worktree 边界内创建或覆盖明确授权的源码、测试或配置文件。",
  "何时不该用: 不用于修改 raw data、baseline、主分支状态或缺少任务授权的路径。",
  "成功与失败样态: 成功时写入目标文件；失败时返回权限、路径、参数或策略门拒绝错误。"
].join("\n");
const SHUD_EDIT_TOOL_DESCRIPTION = [
  "何时该用: 在 coder worktree 边界内对已存在文件做小范围、可审查的编辑。",
  "何时不该用: 不用于批量重写无关文件、修改 raw data，或替代明确的 patch.apply 流程。",
  "成功与失败样态: 成功时应用目标编辑；失败时返回匹配失败、权限、路径或策略门拒绝错误。"
].join("\n");
const SHUD_WAIT_AGENT_DESCRIPTION = [
  "何时该用: 当 coordinator 需要等待已派发子代理完成或进入可观察状态时使用。",
  "何时不该用: 不用于创建新子代理、绕过 spawn 剖面校验，或等待非本会话拥有的 agent id。",
  "成功与失败样态: 成功时返回子代理状态快照；失败时返回 agent control 不可用、超时或未知 agent id。"
].join("\n");

export function createPolicyGateEvaluator(context: PolicyGateContext): PolicyGateEvaluator {
  assertPolicyGateContextGuardClasses(context);
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
const ZOD_PARAMETER_SCHEMA_MAX_DEPTH = 128;
const ZOD_PARAMETER_SCHEMA_MAX_NODES = 20_000;
const ZOD_PARAMETER_SCHEMA_MAX_OWN_KEYS = 512;
const ZOD_PARAMETER_SCHEMA_MAX_PROPERTIES = 50_000;
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
  assertPolicyGatedToolRegistrationLint(tools, {
    role: options.role,
    requireDescriptionSections: true
  });
  const wrappedTools = tools.map((tool) =>
    wrapToolWithPolicyGate(tool, {
      ...options,
      toolId: tool.name
    })
  );
  assertAllToolsPolicyGated(wrappedTools);
  assertPolicyGatedToolRegistrationLint(wrappedTools, {
    role: options.role,
    requireDescriptionSections: true
  });
  return wrappedTools;
}

export function createPolicyGatedToolRegistry(
  tools: readonly BaseTool[],
  options: Omit<PolicyGateWrapperOptions, "toolId">
): ToolRegistry {
  assertPolicyGatedToolRegistrationLint(tools, {
    role: options.role,
    requireDescriptionSections: true
  });
  const registry = new LintEnforcingPolicyGatedToolRegistry(options);
  for (const tool of tools) {
    registry.register(tool);
  }
  assertPolicyGatedToolRegistry(registry, { role: options.role });
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
  const evaluate = createShudPolicyGateEvaluator(options.evaluate);
  let registry: LintEnforcingPolicyGatedToolRegistry;
  registry = new LintEnforcingPolicyGatedToolRegistry({
    role: options.role,
    evaluate,
    normalizeTool: adaptShudRuntimeToolDescription,
    resolveValidateExecutionInput: (tool) =>
      tool.name === "spawn_agent" ? createSpawnAgentToolAvailabilityValidator(registry) : undefined
  });
  let includesSpawnAgent = false;
  const registrations: Array<{
    tool: BaseTool;
  }> = [];

  for (const candidateTool of options.tools ?? []) {
    const tool = unwrapPolicyGatedTool(candidateTool);
    if (tool.name === "spawn_agent") {
      includesSpawnAgent = true;
      continue;
    }

    if (tool.name === "bash" || tool.name === "sandbox.exec") {
      continue;
    }

    registrations.push({ tool: adaptShudRuntimeToolDescription(tool) });
  }

  registrations.push({ tool: createShudSandboxedBashTool(options) });
  registrations.push({ tool: createShudSandboxedBashTool(options, "sandbox.exec") });

  if (includesSpawnAgent) {
    if (!options.modelRouter) {
      throw new Error(
        "SHUD runtime registry cannot reuse a prebuilt spawn_agent; provide modelRouter to rebuild it against the final registry."
      );
    }
    registrations.push({
      tool: new ShudSpawnAgentTool(options.modelRouter, registry, options.metrics)
    });
  }

  assertPolicyGatedToolRegistrationLint(
    registrations.map((registration) => registration.tool),
    {
      role: options.role,
      requireDescriptionSections: true
    }
  );

  for (const registration of registrations) {
    registry.register(registration.tool);
  }

  assertPolicyGatedToolRegistry(registry, { role: options.role });
  return registry;
}

export function assertPolicyGatedToolRegistrationLint(
  tools: readonly BaseTool[],
  options: PolicyGatedToolRegistrationLintOptions = {}
): void {
  assertRoleVisibleToolCountLimit(tools, options.role);
  if (options.requireDescriptionSections) {
    assertToolDescriptionsIncludeRequiredSections(tools);
  }
}

export function assertPolicyGatedToolRegistry(
  registry: ToolRegistry,
  options: PolicyGatedToolRegistryAssertionOptions = {}
): void {
  const tools = registry.list();
  assertAllToolsPolicyGated(tools);
  assertPolicyGatedToolRegistrationLint(tools, {
    role: options.role,
    requireDescriptionSections: true
  });
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

function assertRoleVisibleToolCountLimit(
  tools: readonly BaseTool[],
  role: HarnessRole | undefined
): void {
  const visibleToolCount = new Set(tools.map((tool) => tool.name)).size;
  if (visibleToolCount <= ROLE_VISIBLE_TOOL_COUNT_LIMIT) {
    return;
  }

  const excessCount = visibleToolCount - ROLE_VISIBLE_TOOL_COUNT_LIMIT;
  throw new Error(
    `Policy-gated tool registration lint failed for role ${formatRegistrationLintRole(role)}: visible tool count ${visibleToolCount} exceeds ${ROLE_VISIBLE_TOOL_COUNT_LIMIT}; excess count ${excessCount}.`
  );
}

function assertToolDescriptionsIncludeRequiredSections(tools: readonly BaseTool[]): void {
  const failures: string[] = [];
  for (const tool of tools) {
    const { missingSections, emptySections } = inspectToolDescriptionSections(tool.description);
    const details: string[] = [];
    if (missingSections.length > 0) {
      details.push(`missing ${missingSections.join(", ")}`);
    }
    if (emptySections.length > 0) {
      details.push(`empty ${emptySections.join(", ")}`);
    }
    if (details.length > 0) {
      failures.push(`${tool.name}: ${details.join("; ")}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Policy-gated tool registration lint failed; tool descriptions must include Control_Kernel §5.3 sections: ${failures.join("; ")}.`
    );
  }
}

function formatRegistrationLintRole(role: HarnessRole | undefined): HarnessRole | "unknown-role" {
  return isHarnessRole(role) ? role : "unknown-role";
}

function inspectToolDescriptionSections(description: string): {
  missingSections: string[];
  emptySections: string[];
} {
  const sectionState = new Map<
    (typeof SHUD_TOOL_DESCRIPTION_REQUIRED_SECTIONS)[number],
    { present: boolean; hasBody: boolean }
  >(
    SHUD_TOOL_DESCRIPTION_REQUIRED_SECTIONS.map((section) => [
      section,
      { present: false, hasBody: false }
    ])
  );
  let currentSection: (typeof SHUD_TOOL_DESCRIPTION_REQUIRED_SECTIONS)[number] | undefined;

  for (const line of description.split(/\r?\n/)) {
    const heading = parseToolDescriptionSectionHeading(line);
    if (heading) {
      currentSection = heading.section;
      const state = sectionState.get(currentSection)!;
      state.present = true;
      if (heading.inlineBody.trim() !== "") {
        state.hasBody = true;
      }
      continue;
    }

    if (currentSection && line.trim() !== "") {
      sectionState.get(currentSection)!.hasBody = true;
    }
  }

  const missingSections: string[] = [];
  const emptySections: string[] = [];
  for (const section of SHUD_TOOL_DESCRIPTION_REQUIRED_SECTIONS) {
    const state = sectionState.get(section)!;
    if (!state.present) {
      missingSections.push(section);
    } else if (!state.hasBody) {
      emptySections.push(section);
    }
  }

  return { missingSections, emptySections };
}

function parseToolDescriptionSectionHeading(
  line: string
):
  | {
      section: (typeof SHUD_TOOL_DESCRIPTION_REQUIRED_SECTIONS)[number];
      inlineBody: string;
    }
  | undefined {
  const match = /^\s*(何时该用|何时不该用|成功与失败样态)\s*[:：]\s*(.*)$/u.exec(line);
  if (!match) {
    return undefined;
  }
  return {
    section: match[1] as (typeof SHUD_TOOL_DESCRIPTION_REQUIRED_SECTIONS)[number],
    inlineBody: match[2]
  };
}

function unwrapPolicyGatedTool(tool: BaseTool): BaseTool {
  let current = tool;
  while (isPolicyGatedTool(current)) {
    current = current.innerTool;
  }
  return current;
}

function adaptShudRuntimeToolDescription(tool: BaseTool): BaseTool {
  const description = resolveShudZeroNativeToolDescription(tool);
  if (!description) {
    return tool;
  }
  return new ShudRuntimeToolDescriptionAdapter(tool, description);
}

function resolveShudZeroNativeToolDescription(tool: BaseTool): string | undefined {
  if (tool instanceof ReadTool) {
    return SHUD_READ_TOOL_DESCRIPTION;
  }
  if (tool instanceof WriteTool) {
    return SHUD_WRITE_TOOL_DESCRIPTION;
  }
  if (tool instanceof EditTool) {
    return SHUD_EDIT_TOOL_DESCRIPTION;
  }
  if (tool instanceof WaitAgentTool) {
    return SHUD_WAIT_AGENT_DESCRIPTION;
  }
  return undefined;
}

class ShudSpawnAgentTool extends SpawnAgentTool {
  override description = SHUD_SPAWN_AGENT_DESCRIPTION;
}

class LintEnforcingPolicyGatedToolRegistry extends ToolRegistry {
  #options: LintEnforcingPolicyGatedToolRegistryOptions;
  #tools = new Map<string, PolicyGatedTool>();

  constructor(options: LintEnforcingPolicyGatedToolRegistryOptions) {
    super();
    this.#options = { ...options };
    hardenInheritedZeroToolMap(this);
    Object.preventExtensions(this);
  }

  override register(tool: BaseTool): void {
    const ownedTool = this.wrapWithRegistryAuthority(tool);
    const candidateTools = buildRegistrationCandidateTools(this.list(), ownedTool);
    assertAllToolsPolicyGated(candidateTools);
    assertPolicyGatedToolRegistrationLint(candidateTools, {
      role: this.#options.role,
      requireDescriptionSections: true
    });
    this.#tools.set(ownedTool.name, ownedTool);
  }

  override get(name: string): BaseTool | undefined {
    return this.#tools.get(name);
  }

  override list(): BaseTool[] {
    return Array.from(this.#tools.values());
  }

  override getDefinitions(): ToolDefinition[] {
    return this.list().map((tool) => tool.toDefinition());
  }

  override has(name: string): boolean {
    return this.#tools.has(name);
  }

  private wrapWithRegistryAuthority(tool: BaseTool): PolicyGatedTool {
    const unwrappedTool = unwrapPolicyGatedTool(tool);
    const normalizedTool = this.#options.normalizeTool?.(unwrappedTool) ?? unwrappedTool;
    const validateExecutionInput =
      this.#options.resolveValidateExecutionInput?.(normalizedTool) ??
      this.#options.validateExecutionInput;
    return wrapToolWithPolicyGate(normalizedTool, {
      evaluate: this.#options.evaluate,
      role: this.#options.role,
      toolId: normalizedTool.name,
      validateExecutionInput
    });
  }
}

function hardenInheritedZeroToolMap(registry: ToolRegistry): void {
  const inheritedTools = (registry as unknown as { tools?: unknown }).tools;
  Object.defineProperty(registry, "tools", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: inheritedTools instanceof Map ? inheritedTools : new Map<string, BaseTool>()
  });
}

function buildRegistrationCandidateTools(
  currentTools: readonly BaseTool[],
  tool: BaseTool
): BaseTool[] {
  let replacedExistingTool = false;
  const candidateTools = currentTools.map((currentTool) => {
    if (currentTool.name !== tool.name) {
      return currentTool;
    }

    replacedExistingTool = true;
    return tool;
  });

  if (!replacedExistingTool) {
    candidateTools.push(tool);
  }

  return candidateTools;
}

class ShudRuntimeToolDescriptionAdapter extends BaseTool {
  constructor(
    readonly innerTool: BaseTool,
    private readonly shudDescription: string
  ) {
    super();
    this.kind = innerTool.kind;
    this.requiredModelCapabilities = innerTool.requiredModelCapabilities;
  }

  get name(): string {
    return this.innerTool.name;
  }

  get description(): string {
    return this.shudDescription;
  }

  get parameters(): Record<string, unknown> {
    return this.innerTool.parameters;
  }

  toDefinition(): ToolDefinition {
    return {
      ...this.innerTool.toDefinition(),
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      kind: this.kind
    };
  }

  async run(toolContext: ToolContext, input: unknown): Promise<ToolResult> {
    return this.innerTool.run(toolContext, input);
  }

  protected async execute(): Promise<ToolResult> {
    throw new Error("ShudRuntimeToolDescriptionAdapter delegates through run().");
  }
}

class PolicyGatedBaseToolAdapter extends BaseTool implements PolicyGatedTool {
  #innerTool: BaseTool;
  #policyGateToolId: string;
  #evaluate: PolicyGateEvaluator;
  #role: HarnessRole | undefined;
  #validateExecutionInput: PolicyGateExecutionInputValidator | undefined;
  #nameSnapshot: string;
  #descriptionSnapshot: string;
  #parametersSnapshot: Record<string, unknown>;
  #zodParameterValidatorSnapshot: ToolZodParameterValidator | undefined;

  constructor(innerTool: BaseTool, options: PolicyGateWrapperOptions) {
    super();
    this.#innerTool = innerTool;
    this.#policyGateToolId = options.toolId ?? innerTool.name;
    this.#evaluate = options.evaluate;
    this.#role = options.role;
    this.#validateExecutionInput = options.validateExecutionInput;
    this.#nameSnapshot = innerTool.name;
    this.#descriptionSnapshot = innerTool.description;
    this.#zodParameterValidatorSnapshot = createStableToolZodParameterValidator(innerTool);
    this.#parametersSnapshot = snapshotToolParameters(innerTool.parameters);
    Object.defineProperties(this, {
      name: {
        configurable: false,
        enumerable: true,
        get: () => this.#nameSnapshot
      },
      description: {
        configurable: false,
        enumerable: true,
        get: () => this.#descriptionSnapshot
      },
      parameters: {
        configurable: false,
        enumerable: true,
        get: () => this.#parametersSnapshot
      },
      innerTool: {
        configurable: false,
        enumerable: true,
        get: () => this.#innerTool
      },
      policyGateToolId: {
        configurable: false,
        enumerable: true,
        get: () => this.#policyGateToolId
      },
      kind: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: innerTool.kind
      },
      requiredModelCapabilities: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: Object.freeze([...innerTool.requiredModelCapabilities])
      }
    });
    Object.preventExtensions(this);
  }

  get innerTool(): BaseTool {
    return this.#innerTool;
  }

  get policyGateToolId(): string {
    return this.#policyGateToolId;
  }

  get name(): string {
    return this.#nameSnapshot;
  }

  get description(): string {
    return this.#descriptionSnapshot;
  }

  get parameters(): Record<string, unknown> {
    return this.#parametersSnapshot;
  }

  toDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      kind: this.kind
    };
  }

  async run(toolContext: ToolContext, input: unknown): Promise<ToolResult> {
    const startTime = Date.now();
    const role = this.#role ?? resolveRole(toolContext);
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
        buildPolicyGatePreparationFailedResult(this.#policyGateToolId),
        durationMs
      );
    }
    if (preparedInput.decision === "deny") {
      const durationMs = Date.now() - startTime;
      return this.finalizePolicyGateResult(
        toolContext,
        buildPolicyGateDeniedResult(this.#policyGateToolId, preparedInput),
        durationMs
      );
    }

    if (this.#zodParameterValidatorSnapshot) {
      const parsedInput = parseToolZodParameters(
        this.#policyGateToolId,
        this.#zodParameterValidatorSnapshot,
        preparedInput.executionInput
      );
      if (parsedInput.decision === "deny") {
        const evaluation = await this.evaluatePolicyGateInput(
          toolContext,
          role,
          preparedInput.evaluatorInput
        );
        if (evaluation.status === "decision" && evaluation.decision.decision === "deny") {
          const durationMs = Date.now() - startTime;
          return this.finalizePolicyGateResult(
            toolContext,
            buildPolicyGateDeniedToolResult(this.#policyGateToolId, evaluation.decision),
            durationMs
          );
        }

        const durationMs = Date.now() - startTime;
        return this.finalizePolicyGateResult(
          toolContext,
          buildPolicyGateDeniedResult(this.#policyGateToolId, parsedInput),
          durationMs
        );
      }

      let parsedPreparedInput: {
        executionInput: unknown;
        evaluatorInput: unknown;
      };
      try {
        parsedPreparedInput = prepareGenericPolicyGateInputSnapshots(parsedInput.executionInput);
      } catch {
        const durationMs = Date.now() - startTime;
        return this.finalizePolicyGateResult(
          toolContext,
          buildPolicyGatePreparationFailedResult(this.#policyGateToolId),
          durationMs
        );
      }

      const evaluation = await this.evaluatePolicyGateInput(
        toolContext,
        role,
        parsedPreparedInput.evaluatorInput
      );
      if (evaluation.status === "error") {
        const durationMs = Date.now() - startTime;
        return this.finalizePolicyGateResult(toolContext, evaluation.result, durationMs);
      }
      if (evaluation.decision.decision === "deny") {
        const durationMs = Date.now() - startTime;
        return this.finalizePolicyGateResult(
          toolContext,
          buildPolicyGateDeniedToolResult(this.#policyGateToolId, evaluation.decision),
          durationMs
        );
      }

      const executionValidationDecision = this.#validateExecutionInput?.(
        parsedPreparedInput.executionInput
      );
      if (executionValidationDecision) {
        const durationMs = Date.now() - startTime;
        return this.finalizePolicyGateResult(
          toolContext,
          buildPolicyGateDeniedResult(this.#policyGateToolId, executionValidationDecision),
          durationMs
        );
      }

      return this.#innerTool.run(toolContext, parsedPreparedInput.executionInput);
    }

    const executionValidationDecision = this.#validateExecutionInput?.(
      preparedInput.executionInput
    );
    if (executionValidationDecision) {
      const durationMs = Date.now() - startTime;
      return this.finalizePolicyGateResult(
        toolContext,
        buildPolicyGateDeniedResult(this.#policyGateToolId, executionValidationDecision),
        durationMs
      );
    }

    const evaluation = await this.evaluatePolicyGateInput(
      toolContext,
      role,
      preparedInput.evaluatorInput
    );
    if (evaluation.status === "error") {
      const durationMs = Date.now() - startTime;
      return this.finalizePolicyGateResult(toolContext, evaluation.result, durationMs);
    }
    if (evaluation.decision.decision === "deny") {
      const durationMs = Date.now() - startTime;
      return this.finalizePolicyGateResult(
        toolContext,
        buildPolicyGateDeniedToolResult(this.#policyGateToolId, evaluation.decision),
        durationMs
      );
    }

    return this.#innerTool.run(toolContext, preparedInput.executionInput);
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
    if (this.#policyGateToolId === "spawn_agent") {
      const normalizedInput = normalizeSpawnAgentInput({
        toolId: this.#policyGateToolId,
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

  private async evaluatePolicyGateInput(
    toolContext: ToolContext,
    role: HarnessRole | "unknown",
    evaluatorInput: unknown
  ): Promise<
    | { status: "decision"; decision: PolicyGateDecision }
    | { status: "error"; result: ToolResult }
  > {
    try {
      const candidate = await this.#evaluate(
        {
          toolId: this.#policyGateToolId,
          role,
          input: evaluatorInput,
          workDir: toolContext.workDir
        },
        {
          tool: this,
          toolContext
        }
      );
      return {
        status: "decision",
        decision: validatePolicyGateDecision(this.#policyGateToolId, candidate)
      };
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      return {
        status: "error",
        result: {
          success: false,
          output: errorMessage,
          outputSummary: `Error: ${errorMessage.slice(0, 100)}`
        }
      };
    }
  }
}

function buildPolicyGateDeniedToolResult(
  toolId: string,
  decision: Extract<PolicyGateDecision, { decision: "deny" }>
): ToolResult {
  if (decision.ruleId === RAW_DATA_WRITE_RULE_ID) {
    return buildRawDataRuleMisconfiguredResult(toolId, decision);
  }
  return buildPolicyGateDeniedResult(toolId, decision);
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

type ToolZodParameterSchema = ZodType;

type ToolZodParameterValidator = (input: unknown) => ToolZodSafeParseResult;

type ToolZodSafeParseResult =
  | {
      success: true;
      data: unknown;
    }
  | {
      success: false;
      error: unknown;
    };

type ToolZodIssue = {
  path?: readonly unknown[];
  message?: unknown;
};

type ZodParameterSchemaHardeningState = {
  seen: WeakSet<object>;
  nodes: number;
  properties: number;
};

function parseToolZodParameters(
  toolId: string,
  safeParse: ToolZodParameterValidator,
  input: unknown
):
  | { decision: "allow"; executionInput: unknown }
  | Extract<PolicyGateDecision, { decision: "deny" }> {
  let result: ToolZodSafeParseResult;
  try {
    result = safeParse(input);
  } catch {
    return buildToolParameterSchemaValidationDeny(
      toolId,
      "Zod parameter schema could not validate the prepared input."
    );
  }

  if (result.success) {
    return { decision: "allow", executionInput: result.data };
  }

  return buildToolParameterSchemaValidationDeny(
    toolId,
    summarizeToolZodValidationError(result.error)
  );
}

function createStableToolZodParameterValidator(
  tool: BaseTool
): ToolZodParameterValidator | undefined {
  const schema = resolveToolZodParameterSchema(tool);
  if (!schema) {
    return undefined;
  }

  const hardenedSchema = hardenToolZodParameterSchema(schema);
  return hardenedSchema.safeParse.bind(hardenedSchema);
}

function resolveToolZodParameterSchema(tool: BaseTool): ToolZodParameterSchema | undefined {
  const carrier = tool as BaseTool & ToolZodParameterSchemaCarrier;
  const parameters = tool.parameters as unknown;
  const parameterRecord = isPlainRecord(parameters) ? parameters : undefined;
  const candidates = [
    carrier.parameterSchema,
    carrier.zodParameters,
    carrier.zodSchema,
    parameterRecord?.zodSchema,
    parameterRecord?.parameterSchema,
    parameterRecord?.schema,
    parameters
  ];

  for (const candidate of candidates) {
    if (candidate === undefined) {
      continue;
    }
    if (isToolZodParameterSchema(candidate)) {
      return candidate;
    }
    if (isRejectedToolZodParameterSchemaCandidate(candidate)) {
      throw new Error("Tool Zod parameter schema must be a real Zod v4 schema.");
    }
  }

  return undefined;
}

function snapshotToolParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  return cloneToolParameterMetadata(parameters, new WeakMap<object, unknown>()) as Record<
    string,
    unknown
  >;
}

function cloneToolParameterMetadata(
  value: unknown,
  snapshots: WeakMap<object, unknown>
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (isToolZodParameterSchema(value)) {
    return hardenToolZodParameterSchema(value);
  }

  const objectValue = value as object;
  const existingSnapshot = snapshots.get(objectValue);
  if (existingSnapshot) {
    return existingSnapshot;
  }

  if (Array.isArray(value)) {
    const snapshot: unknown[] = [];
    snapshots.set(objectValue, snapshot);
    for (const item of value) {
      snapshot.push(cloneToolParameterMetadata(item, snapshots));
    }
    return Object.freeze(snapshot);
  }

  const snapshot: Record<string, unknown> = {};
  snapshots.set(objectValue, snapshot);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      continue;
    }
    Object.defineProperty(snapshot, key, {
      value: cloneToolParameterMetadata(descriptor.value, snapshots),
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  return Object.freeze(snapshot);
}

function isToolZodParameterSchema(value: unknown): value is ToolZodParameterSchema {
  return (
    isObjectRecord(value) &&
    !nodeUtilTypes.isProxy(value) &&
    value instanceof ZodType &&
    resolveZodV4SchemaDef(value) !== undefined
  );
}

function isRejectedToolZodParameterSchemaCandidate(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }
  if (nodeUtilTypes.isProxy(value)) {
    return true;
  }
  return "safeParse" in value || "_zod" in value;
}

function hardenToolZodParameterSchema<T extends ToolZodParameterSchema>(schema: T): T {
  // Zod v4 keeps validation authority in mutable def/_def/shape slots; freeze the
  // registration-time graph so retained schema references cannot rewrite it later.
  materializeKnownZodLazyDataProperties(schema, createZodParameterSchemaHardeningState());
  deepFreezeOwnDataPropertyGraph(schema, createZodParameterSchemaHardeningState());
  return schema;
}

function createZodParameterSchemaHardeningState(): ZodParameterSchemaHardeningState {
  return {
    seen: new WeakSet<object>(),
    nodes: 0,
    properties: 0
  };
}

function materializeKnownZodLazyDataProperties(
  value: unknown,
  state: ZodParameterSchemaHardeningState,
  depth = 0
): void {
  if (!reserveZodParameterSchemaHardeningNode(value, state, depth)) {
    return;
  }

  const objectValue = value as object;
  if (objectValue instanceof ZodType) {
    const zodDef = resolveZodV4SchemaDef(objectValue);
    if (zodDef) {
      materializeZodV4ObjectShape(objectValue, zodDef);
    }
  }

  for (const { key, value: childValue } of readZodParameterSchemaOwnDataProperties(objectValue, state)) {
    if (key === "_zod") {
      continue;
    }
    materializeKnownZodLazyDataProperties(childValue, state, depth + 1);
  }
}

function materializeZodV4ObjectShape(schema: object, zodDef: object): void {
  const typeDescriptor = Object.getOwnPropertyDescriptor(zodDef, "type");
  if (!typeDescriptor || !("value" in typeDescriptor) || typeDescriptor.value !== "object") {
    return;
  }

  const defShapeDescriptor = Object.getOwnPropertyDescriptor(zodDef, "shape");
  if (
    defShapeDescriptor &&
    !("value" in defShapeDescriptor) &&
    typeof defShapeDescriptor.get === "function"
  ) {
    void (zodDef as { shape: unknown }).shape;
  }

  const schemaShapeDescriptor = Object.getOwnPropertyDescriptor(schema, "shape");
  if (
    schemaShapeDescriptor &&
    !("value" in schemaShapeDescriptor) &&
    typeof schemaShapeDescriptor.get === "function"
  ) {
    void (schema as { shape: unknown }).shape;
  }
}

function deepFreezeOwnDataPropertyGraph(
  value: unknown,
  state: ZodParameterSchemaHardeningState,
  depth = 0
): void {
  if (!reserveZodParameterSchemaHardeningNode(value, state, depth)) {
    return;
  }

  const objectValue = value as object;
  if (objectValue instanceof ZodType) {
    hardenZodV4RuntimeAuthoritySlots(objectValue);
  }
  for (const { key, value: childValue } of readZodParameterSchemaOwnDataProperties(objectValue, state)) {
    if (key === "_zod") {
      continue;
    }
    deepFreezeOwnDataPropertyGraph(childValue, state, depth + 1);
  }
  Object.freeze(objectValue);
}

function reserveZodParameterSchemaHardeningNode(
  value: unknown,
  state: ZodParameterSchemaHardeningState,
  depth: number
): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }
  if (depth > ZOD_PARAMETER_SCHEMA_MAX_DEPTH) {
    throw new Error("Zod parameter schema exceeds hardening depth budget.");
  }
  if (nodeUtilTypes.isProxy(value)) {
    throw new Error("Zod parameter schema must not contain Proxy-backed objects.");
  }
  if (state.seen.has(value)) {
    return false;
  }

  state.seen.add(value);
  state.nodes += 1;
  if (state.nodes > ZOD_PARAMETER_SCHEMA_MAX_NODES) {
    throw new Error("Zod parameter schema exceeds hardening node budget.");
  }
  return true;
}

function readZodParameterSchemaOwnDataProperties(
  value: object,
  state: ZodParameterSchemaHardeningState
): Array<{ key: PropertyKey; value: unknown }> {
  const keys = Reflect.ownKeys(value);
  if (keys.length > ZOD_PARAMETER_SCHEMA_MAX_OWN_KEYS) {
    throw new Error("Zod parameter schema exceeds hardening property budget.");
  }
  state.properties += keys.length;
  if (state.properties > ZOD_PARAMETER_SCHEMA_MAX_PROPERTIES) {
    throw new Error("Zod parameter schema exceeds hardening property budget.");
  }

  const properties: Array<{ key: PropertyKey; value: unknown }> = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }
    properties.push({ key, value: descriptor.value });
  }
  return properties;
}

function hardenZodV4RuntimeAuthoritySlots(value: object): void {
  const runtimeDescriptor = Object.getOwnPropertyDescriptor(value, "_zod");
  if (
    !runtimeDescriptor ||
    !("value" in runtimeDescriptor) ||
    !isObjectRecord(runtimeDescriptor.value)
  ) {
    return;
  }

  for (const key of ["def", "parse", "run"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(runtimeDescriptor.value, key);
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }
    Object.defineProperty(runtimeDescriptor.value, key, {
      value: descriptor.value,
      enumerable: descriptor.enumerable,
      configurable: false,
      writable: false
    });
  }
}

function resolveZodV4SchemaDef(value: object): object | undefined {
  const runtimeDescriptor = Object.getOwnPropertyDescriptor(value, "_zod");
  if (
    !runtimeDescriptor ||
    !("value" in runtimeDescriptor) ||
    !isObjectRecord(runtimeDescriptor.value)
  ) {
    return undefined;
  }

  const defDescriptor =
    Object.getOwnPropertyDescriptor(value, "def") ?? Object.getOwnPropertyDescriptor(value, "_def");
  if (!defDescriptor || !("value" in defDescriptor) || !isObjectRecord(defDescriptor.value)) {
    return undefined;
  }

  const runtimeDefDescriptor = Object.getOwnPropertyDescriptor(runtimeDescriptor.value, "def");
  if (
    !runtimeDefDescriptor ||
    !("value" in runtimeDefDescriptor) ||
    runtimeDefDescriptor.value !== defDescriptor.value
  ) {
    return undefined;
  }

  return defDescriptor.value;
}

function isObjectRecord(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function summarizeToolZodValidationError(error: unknown): string {
  const issues = readToolZodIssues(error);
  if (issues.length === 0) {
    return "input did not match the Zod parameter schema";
  }

  const summary = issues
    .slice(0, TOOL_PARAMETER_SCHEMA_MAX_ISSUES)
    .map(formatToolZodIssue)
    .join("; ");
  const suffix =
    issues.length > TOOL_PARAMETER_SCHEMA_MAX_ISSUES ? ` (${issues.length} total issues)` : "";
  return truncateToolParameterSchemaIssueSummary(`${summary}${suffix}`);
}

function readToolZodIssues(error: unknown): readonly ToolZodIssue[] {
  if (!isPlainRecord(error) || !Array.isArray(error.issues)) {
    return [];
  }
  return error.issues.filter(isPlainRecord) as ToolZodIssue[];
}

function formatToolZodIssue(issue: ToolZodIssue): string {
  const path = Array.isArray(issue.path) && issue.path.length > 0
    ? issue.path.map(String).join(".")
    : "<root>";
  const message = typeof issue.message === "string" && issue.message.trim() !== ""
    ? issue.message
    : "invalid value";
  return `${path}: ${message}`;
}

function truncateToolParameterSchemaIssueSummary(summary: string): string {
  if (summary.length <= TOOL_PARAMETER_SCHEMA_ISSUE_MAX_CHARS) {
    return summary;
  }
  return `${summary.slice(0, TOOL_PARAMETER_SCHEMA_ISSUE_MAX_CHARS - 3)}...`;
}

function buildToolParameterSchemaValidationDeny(
  toolId: string,
  issueSummary: string
): Extract<PolicyGateDecision, { decision: "deny" }> {
  return {
    decision: "deny",
    ruleId: TOOL_PARAMETER_SCHEMA_RULE_ID,
    reason: `Tool input failed Zod parameter schema validation for ${toolId}: ${issueSummary}.`,
    remediation: {
      next_action: "fix_and_retry",
      hint: `Adjust the tool input to match its Zod parameter schema before retrying; ${issueSummary}.`,
      ref: CONTROL_KERNEL_TOOL_GOVERNANCE_REF
    },
    guardClass: "authority"
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  const guardClass = parsedGuardClass?.success ? parsedGuardClass.data : undefined;
  if (!guardClass) {
    issuePaths.push("guardClass");
  }

  if (
    issuePaths.length > 0 ||
    validRuleId === undefined ||
    validReason === undefined ||
    !remediation ||
    !guardClass
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
    guardClass
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
