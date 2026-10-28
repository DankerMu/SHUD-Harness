# Spec Delta

## Purpose

定义 SHUD 治理策略门在 dsh `tools/pre-execute` 瀑布上的决策契约：调用角色如何从 Agent 的 preset id 推导，拆分后的 `policy-gate-core` deny 层（`role-tool-surface`）如何先于报告审批求值并映射为宿主决策，EvidenceReport 终态决定点（`report_submit`、`report_decide`）如何在未被角色拒绝时无条件转交 PI 审批卡，宿主 fail-closed 如何约束审批结果，PI comment 如何经对话承载并在二次审批卡上确认，以及决策如何留下审计证据。与 raw-guard 同为 advisory 层：插件只返回 `deny|ask` 或委托下一个监听器，审批本身由宿主 `serviceAsk` 经 `ctx.approval` 完成。

## ADDED Requirements

### Requirement: Global pre-execute mounting
策略门 SHALL 以插件 `@shud-harness/dsh-shud-policy-gate` 作为 bundle patch 中的全局行 `shud-policy-gate` 挂载（与 `shud-raw-guard` 并列），SHALL NOT 挂进任何 agent preset 的 `plugins` 子树；该行与插件、`profile:smoke` 对该行的断言在同一个交付切片中落地，先于 `report_submit`/`report_decide` 工具挂载，使报告终态工具从挂载起就经过审批。`apply` 时 SHALL 经 `ctx.on("tools/pre-execute")` 注册且仅注册一个监听器；插件 SHALL NOT 直接调用 `ctx.approval`，SHALL NOT 改写工具参数。监听器只返回 `{kind: "deny"}`、`{kind: "ask"}` 或 `next()` 的结果，SHALL NOT 返回 `{kind: "allow"}`（它会终止瀑布，使后续 raw-guard 等监听器失效）。监听器内部的求值顺序 SHALL 固定为：先推导调用角色（见「Caller role derivation」），再以规范规则集求值（见「Policy core deny layer」），规则集拒绝即返回 `deny`；未被拒绝时，`report_submit` 与 `report_decide` 返回 `ask`（见「Report terminal tools always ask」），其它工具调用 `next()`。本插件与 `shud-raw-guard`、`auto-review`、hooks 的相对顺序由 K13 spike（O2）核实并记录；两者决策互不依赖，顺序只影响日志归因，不影响决策结果。

#### Scenario: dump-config shows the global row
- **WHEN** 在已执行 `profile:install` 的 `DSH_HOME` 上执行 `dsh --profile shud --dump-config`
- **THEN** 输出含 `id: shud-policy-gate` 且其 `name` 为 `@shud-harness/dsh-shud-policy-gate`，该行位于全局插件列表而不在 `preset-coordinator` 或 `preset-worker` 的 `plugins` 子树内

#### Scenario: missing row fails the smoke
- **WHEN** bundle patch 删除或禁用 `shud-policy-gate` 行后执行 `pnpm run profile:smoke`
- **THEN** 退出码非 0，输出指出 `shud-policy-gate` 行缺失

#### Scenario: listener never terminates the waterfall with allow
- **WHEN** 任一工具调用经本插件监听器处理
- **THEN** 返回值的 `kind` 不是 `allow`

### Requirement: Caller role derivation
策略门 SHALL 从 `tools/pre-execute` 事件携带的执行上下文 `exec.agent`（dsh `Agent`）读取调用 Agent 的 preset id：`exec.agent?.session.header.agentPreset`。该值由宿主在 `agents.create({meta.agentPreset})` 时写入会话 header；Web 会话控制器以 `agent-preset-registry` 的默认 preset 作为主 Agent 的 `meta.agentPreset`，子代理以派发时指定的 preset 创建。映射 SHALL 为：`coordinator` → `"coordinator"`，`worker` → `"worker"`，其它任何值（含 `exec.agent` 缺失、header 缺失、无 preset、未知 preset，以及 M4 角色 `repo_explorer`、`coder`、`reviewer` 的 preset id）→ `"unknown"`。读取 SHALL NOT 抛错，读取路径中任一环节缺失即为 `"unknown"`。K13 spike（O6）SHALL 在运行时核实：(a) 由 `agent-preset-registry.default = coordinator` 创建的 Web 主会话与 (b) 以 preset `worker` 派发的子代理会话都在该 header 中携带对应值，以及会话中途切换 preset 是否改写该 header；不改写时改读 `agent-preset-registry` 的 `agentPreset` 会话投影，映射不变。两条路径都读不到时，本角色推导与 task-cards `task_create` 的 `created_by` 设计 SHALL 重开，不以猜测值代替。

#### Scenario: role derives from the session header preset id
- **WHEN** 同一工具分别由会话 header `agentPreset` 为 `coordinator`、`worker` 的 Agent 与 `exec.agent` 缺失的调用触发
- **THEN** 传给 `evaluatePolicyGate` 的 `role` 依次为 `"coordinator"`、`"worker"`、`"unknown"`

#### Scenario: unknown or M4 preset maps to unknown
- **WHEN** 会话 header `agentPreset` 为 `standard`、`reviewer`，或 header 中没有 `agentPreset`
- **THEN** `role` 为 `"unknown"`，监听器不抛出

### Requirement: Report terminal tools always ask
对 `report_submit` 与 `report_decide`，在规范规则集未返回 `deny`（即调用角色为 `coordinator` 或 `"unknown"`）时，策略门 SHALL 无条件返回 `{kind: "ask", reason, displayReason}`，不论报告状态或参数形态。`reason` 落入 session log 的 `approval/asked`，是审批卡唯一的审计载体：它 SHALL 为插件导出的固定前缀常量加一个空格加经 core `ReportId` 品牌 schema 校验通过的 `report_id`；参数中的 `report_id` 缺失或未通过校验时，SHALL 为该前缀加空格加插件导出的受控标记常量，SHALL NOT 含原始参数文本。`displayReason` SHALL 含非空 `en` 与 `zh`：对 `report_submit`，内容含 `report_id`、报告 `summary` 首行与报告文件路径（`reports/<report_id>.md`，PI 可在卡片决定前打开）；对 `report_decide`，另含 `disposition` 与 `comment` 全文，使 PI 在卡片上确认自己的话被正确转述。`displayReason` 不落 session log（宿主 `approval/asked` 只记 `id/toolName/callId/reason`），SHALL NOT 被当作审计证据。读取报告文件以组装 `displayReason` 时，策略门 SHALL 只从通过 `ReportId` 校验的 id 构造路径，并遵循 task-cards「TaskCard workspace file」的工作区文件安全规则（`reports/` 与目标文件经 `lstat` 确认，符号链接与特殊文件 fail-closed）；参数缺失、类型不符、id 未通过校验或报告文件不可读时 SHALL 仍返回 `ask`，SHALL NOT 抛错，`displayReason` 中不可得的部分以明确的"无法读取"说明代替。工具自身的前置条件校验（如 `status == reviewed`）属于工具，不由策略门放行或拒绝。

#### Scenario: report_submit asks with the report pointers
- **WHEN** coordinator 调用 `report_submit`，`report_id` 指向工作区已有的 `reviewed` 报告
- **THEN** 决策 `kind` 为 `ask`，`reason` 以导出前缀常量开头并含该 `report_id`，`displayReason.en` 与 `displayReason.zh` 均含该 `report_id`、`summary` 首行与 `reports/<report_id>.md` 路径

#### Scenario: report_decide echoes disposition and full comment
- **WHEN** coordinator 调用 `report_decide`，参数为 `report_id`、`disposition: "revision_requested"` 与一段多行 `comment`
- **THEN** 决策 `kind` 为 `ask`，`reason` 含该 `report_id`，`displayReason.en` 与 `displayReason.zh` 均含 `revision_requested` 与 `comment` 全文（不截断）

#### Scenario: odd arguments still ask without throwing
- **WHEN** coordinator 调用 `report_submit`，`arguments` 为 `null`、缺少 `report_id`、`report_id` 为 `../tasks/x` 或不对应任何文件
- **THEN** 不抛出异常，决策 `kind` 仍为 `ask`，`reason` 为前缀加受控标记（或通过校验的 id）且不含 `../tasks/x`，`displayReason` 含"无法读取"说明，`next()` 未被调用，未读取 `reports/` 之外的路径

#### Scenario: worker calling report_submit is denied, not asked
- **WHEN** 会话 header preset 为 `worker` 的 Agent 调用 `report_submit`
- **THEN** 决策 `kind` 为 `deny`（`role-tool-surface`），宿主不发起审批卡，session log 中没有该调用的 `approval/asked`

#### Scenario: unknown caller still asks
- **WHEN** `role` 为 `"unknown"` 的 Agent 调用 `report_submit`
- **THEN** 决策 `kind` 为 `ask`，不因角色变为 `deny` 或委托

### Requirement: Host fail-closed approval outcome
报告终态工具的执行 SHALL 只发生在宿主审批结果为 `allowed-once` 时。无 approval 服务、无 agent、或结果为 `allowed-once` 以外的任何 outcome 时，宿主 SHALL 拒绝执行该工具：工具 `execute` 不被调用，模型看到工具错误（即"PI 未放行"），报告保持 `reviewed`，TaskCard 保持 `reporting`，不写 `decision_history`。这是宿主 `serviceAsk` 的既有 fail-closed 语义；策略门 SHALL NOT 自行补发审批或在拒绝后重试。

#### Scenario: allowed-once executes the tool
- **WHEN** `report_submit` 的审批卡结果为 `allowed-once`
- **THEN** 工具执行，session log 依次出现 `approval/asked{toolName: "report_submit", reason: <前缀常量> <report_id>}`、`approval/decided{outcome: "allowed-once"}` 与该调用的成功 `tool/result`；`decision_history` 新增 `outcome: accepted`、`approval_ref` 为该卡引用、`comment: null`

#### Scenario: no approval service denies
- **WHEN** 宿主没有 approval 服务（如 headless 模板）时调用 `report_submit`
- **THEN** 工具不执行，`tool/result` 为 isError，报告文件 `status` 仍为 `reviewed`，`decision_history` 长度不变

#### Scenario: non-allowed outcome denies
- **WHEN** `report_decide` 的审批卡结果不是 `allowed-once`
- **THEN** 工具不执行，报告状态与 `decision_history` 不变，TaskCard 仍为 `reporting`

### Requirement: Policy core deny layer
对每次工具调用（含 `report_submit`、`report_decide`），策略门 SHALL 构造 `PolicyGateToolCall{ toolId, role, input, workDir }` 并以 core 导出的规范 SHUD 规则集调用 `evaluatePolicyGate`，且 SHALL 在任何报告审批分支之前完成该求值：`toolId` 为工具 id；`role` 为「Caller role derivation」的结果；`input` 为原始 `arguments`（缺失或非对象时原样传入，SHALL NOT 抛错）；`workDir` 为调用的 `workdir` 参数（字符串时）否则 session cwd。core 返回 `deny` 时 SHALL 返回 `{kind: "deny", reason}`（`reason` 为 core 决策的 `reason`）；返回 `allow` 时，`report_submit`/`report_decide` 进入「Report terminal tools always ask」，其它工具 SHALL 调用 `next()` 恰好一次并返回其结果。规范规则集在 M3 只含 `role-tool-surface`（见「Role tool surface rule」）。`evaluatePolicyGate` 抛出异常时策略门 SHALL fail-closed 返回 `{kind: "deny", reason}`（报告终态工具同样如此），`reason` 为导出的受控固定文案，SHALL NOT 含原始异常消息、栈或工具参数，`next()` 不被调用。

#### Scenario: core deny maps to host deny
- **WHEN** 规范规则集对某次调用返回 `{decision: "deny", ruleId, reason}`
- **THEN** 决策为 `{kind: "deny", reason}`，`next()` 未被调用，宿主 `tool/result` 为 isError 且含该 `reason`

#### Scenario: core allow delegates exactly once
- **WHEN** preset `worker` 调用 `shud_collect`，规范规则集返回 `allow`
- **THEN** 不作判定，`next()` 被调用恰好一次，监听器返回其结果

#### Scenario: deny is evaluated before the report ask
- **WHEN** 规范规则集对一次 `report_decide` 调用返回 `deny`
- **THEN** 决策 `kind` 为 `deny`，不返回 `ask`，`next()` 未被调用

#### Scenario: malformed arguments do not throw
- **WHEN** preset `worker` 调用 `shud_collect`，`arguments` 为 `null` 或数组
- **THEN** 不抛出异常，按规范规则集求值并返回 `next()` 的结果

#### Scenario: evaluator failure fails closed
- **WHEN** `evaluatePolicyGate` 对某次调用（含 `report_submit`）抛出异常（如规则返回非法决策快照），异常消息含 `secret-detail`
- **THEN** 决策 `kind` 为 `deny`，`reason` 等于导出的受控文案且不含 `secret-detail`，`next()` 未被调用，监听器本身不抛出

### Requirement: Role tool surface rule
core SHALL 提供规则 `role-tool-surface`（`guardClass: "authority"`，其 id 列入 `RESERVED_AUTHORITY_POLICY_RULE_IDS`）并作为规范 SHUD 规则集的唯一规则：`role` 为 `coordinator` 或 `worker` 且 `toolId` 不在该角色 `role-tool-map` 条目的 `global ∪ preset` 内时返回 `deny`，`reason` 指明该角色与工具 id（不含工具参数）；`role` 为 `"unknown"` 时规则不适用，返回 `allow`；`toolId` 在 `global ∪ preset` 内时返回 `allow`。`role-tool-map` 每个角色条目 SHALL 含两份集合（见 agent-presets「Role tool map uses mounted names」）：`global` 为全局 bundle 行挂载的工具（shud 工具），`preset` 为该角色 preset 子树自身行挂载的工具；preset 内的 `shud-role-restrict` 只把 `global` 传给 `restrict`（宿主 `restrict` 对未知名立即抛错，而 preset 子树自身注册的工具既不能被点名也不受作用域内过滤），本规则按 `global ∪ preset` 判定——同一份数据两个消费者，SHALL NOT 另存副本。K13 spike 肯定 O3 时，`restrict` 与本规则双层执行；否定 O3 时按 agent-presets「Role tool surface restriction」的备选挂载，角色契约（两份集合）不变。

#### Scenario: off-role tool is denied
- **WHEN** preset `worker` 调用 `report_generate` 或 `subagent`，或 preset `coordinator` 调用 `shud_run`
- **THEN** 决策 `kind` 为 `deny`，`reason` 分别含 `worker` 与 `report_generate`、`worker` 与 `subagent`、`coordinator` 与 `shud_run`

#### Scenario: on-role tool passes through
- **WHEN** preset `worker` 调用 `shud_run` 或 `job_output`，或 preset `coordinator` 调用 `task_create` 或 `subagent`
- **THEN** 不作判定，返回 `next()` 的结果

#### Scenario: removed read tool is denied for known roles
- **WHEN** preset `coordinator` 或 `worker` 调用名为 `read` 的工具
- **THEN** 决策 `kind` 为 `deny`（两个角色的集合都不含该工具）

#### Scenario: unknown role is not judged
- **WHEN** `role: "unknown"` 的 Agent 调用 `bash`
- **THEN** 本规则返回 `allow`，策略门返回 `next()` 的结果

#### Scenario: single source with restrict
- **WHEN** 比较 `role-tool-surface` 对每个角色放行的工具 id 集合与 `shud-role-restrict` 对同一角色传给 `restrict` 的 `allow`
- **THEN** 前者等于该角色 `getRoleToolIds(role)` 返回的 `global ∪ preset`，后者等于其 `global`，二者取自同一个 `ROLE_TOOL_MAP` 条目

### Requirement: Policy core split and spawn rule removal
`packages/dsh-shud-core/src/governance/policy-gate-core.ts` SHALL 按规则族拆分到 `governance/policy-gate/{types,role-tool-surface,parameter-schema,evaluate}.ts`，每个文件（含拆分后的测试文件）≤1000 行并通过 `pnpm run lint` 的 `max-lines`；`tool-parameter-schema-validation` 框架与保留 id `raw-data-write` SHALL 保持现状、不新增规则实现；拆分后对既有保留内容——参数 schema 校验框架、`raw-data-write` 保留 id——以及评估器契约（首个 deny 胜出、相同 `(call, context)` 得相同决策、ruleId 裁剪与重复拒绝、保留 id 不得降级为 `capability`、保留 id 前缀冒充拒绝、决策快照拒绝 proxy/accessor/可枚举 `toJSON`）SHALL 与拆分前给出相同决策，既有非 spawn 测试的期望值不变。规范 SHUD 规则集由三条 spawn 规则改为仅 `role-tool-surface`。core SHALL 删除 `spawn-profile-subset`、`spawn-depth-limit`、`spawn-concurrency-limit` 三条规则及其专属常量、求值与输入规范化函数，`PolicyGateToolCall` SHALL NOT 再含 `spawnDepth`/`activeSubagentCount`；`RESERVED_AUTHORITY_POLICY_RULE_IDS` SHALL 精确为 `["raw-data-write", "tool-parameter-schema-validation", "role-tool-surface"]`；别名 `isReservedAuthorityPolicyEvidenceId` SHALL 删除（`isReservedAuthorityPolicyErrorId` 保留）。

**Reason**：子代理深度、并发与 preset 工具子集已由 dsh 原生 `maxDepth`（默认 1）、`maxActiveSubagents` 与 preset 子集语义执行，core 中的三条 spawn 规则是同一逻辑的第二实现（Code Canonicality）；别名是同一谓词的重复导出。
**Migration**：消费者：无（`policy-gate-core` 在 M3 前零消费者，仅 core `index.ts` 再导出与其自身测试引用）；保留 id 列表按上式更新，三条 spawn 规则的测试随规则删除；需要深度/并发限制的配置改在 dsh 设置与 preset 行表达。

#### Scenario: retained rule decisions are unchanged
- **WHEN** 以拆分前测试中的 `raw-data-write` 拒绝规则上下文与同一调用分别求值拆分前后的 `evaluatePolicyGate`
- **THEN** 两者返回相同的 `{decision: "deny", ruleId: "raw-data-write", reason, remediation, guardClass: "authority"}`

#### Scenario: reserved authority ids no longer include spawn rules
- **WHEN** 读取 core 导出的 `RESERVED_AUTHORITY_POLICY_RULE_IDS` 与 core 公开导出名
- **THEN** 列表精确为 `raw-data-write`、`tool-parameter-schema-validation` 与 `role-tool-surface`，`isReservedAuthorityPolicyRuleId("role-tool-surface")` 为 `true`；导出中不含 `SPAWN_PROFILE_SUBSET_RULE_ID`、`SPAWN_DEPTH_LIMIT_RULE_ID`、`SPAWN_CONCURRENCY_LIMIT_RULE_ID`、`MAX_SPAWN_DEPTH`、`MAX_CONCURRENT_SUBAGENTS` 与 `isReservedAuthorityPolicyEvidenceId`

#### Scenario: reserved id downgrade is still rejected
- **WHEN** 以 `ruleId` 为 `tool-parameter-schema-validation` 或 `role-tool-surface`、`guardClass: "capability"` 的规则分别调用 `assertPolicyGateContextGuardClasses`
- **THEN** 两次都抛出含 `known authority rule cannot be classified as capability` 的错误；规范 SHUD 规则集中的 `role-tool-surface` 以 `guardClass: "authority"` 通过该检查

#### Scenario: oversized split file fails lint
- **WHEN** 拆分后任一 `governance/policy-gate/*.ts` 超过 1000 行
- **THEN** `pnpm run lint` 报 `max-lines` 错误，`pnpm run check` 失败

### Requirement: PI comment conversation carrier
审批卡只承载放行/拒绝，没有 comment 字段；PI comment SHALL 经对话承载（候选 (a)，决策记录 `docs/adr/proposed/0011-pi-comment-conversation-carrier.md`）。`report_submit` 未获放行后，coordinator SHALL 在下一轮对话向 PI 索要 comment 与明确的处置（`rejected` 或 `revision_requested`），在取得非空 comment 与 PI 明确说明的处置之前 SHALL NOT 调用 `report_decide`（GR-003）；PI 未说明处置时 SHALL NOT 默认任何一种，须再次询问。随后 coordinator 调 `report_decide(report_id, disposition, comment)`，其审批卡回显 `disposition` 与 `comment` 全文（见「Report terminal tools always ask」）；只有该卡 `allowed-once` 才写入 PiGateDecision（comment 非空由 schema 强制）与报告终态，TaskCard 按状态机转换（`revision_requested` → `planned`，`rejected` → `cancelled`）。PiGateDecision 的 `approval_ref` SHALL 为授权本次写入的那张卡的 `approval/asked.id`（`report_decide` 为其自身的卡，`accepted` 为 `report_submit` 的卡）；若 K13 spike 否定 O5（执行上下文取不到该 id），改记该次调用的 `callId`，审计关联经 session log 的 `callId` 完成。先前被拒的 `report_submit` 卡 SHALL NOT 由模型以参数传入或写进 PiGateDecision（审批 id 只在 session log 中，模型无来源）；其审计关联 SHALL 经 session log 完成：同一会话中 `approval/asked{toolName: "report_submit"}` 的 `reason` 含该 `report_id`，其后同一审批 id 的 `approval/decided{outcome}` 不是 `allowed-once`；`report_decide` 卡的 `reason` 同样含该 `report_id`，二者以 `report_id` 相连。两张卡都以 `approval/asked|decided` 进入 session log。

#### Scenario: reject then comment then decide
- **WHEN** `report_submit` 卡被拒，coordinator 在下一轮取得 PI comment 与处置 `revision_requested`，调用 `report_decide` 且其卡为 `allowed-once`
- **THEN** session log 依次含 `reason` 含该 `report_id` 的 `report_submit` `approval/asked` 与其非 `allowed-once` 的 `approval/decided`，以及 `reason` 含同一 `report_id` 的 `report_decide` `approval/asked` 与 `approval/decided{outcome: "allowed-once"}`；报告 `decision_history` 新增一条 `outcome: revision_requested`、`comment` 等于 PI 原文、`approval_ref` 为 `report_decide` 卡的引用，且该条不含被拒提交卡的字段；TaskCard 为 `planned`

#### Scenario: no comment does not close the gate
- **WHEN** coordinator 以空串或缺失的 `comment` 调用 `report_decide`（无论参数校验先于还是后于审批卡发生、卡结果为何）
- **THEN** 不写入终态与 `decision_history`，报告仍为 `reviewed`，TaskCard 仍为 `reporting`，模型看到工具错误

#### Scenario: missing disposition is asked again
- **WHEN** `report_submit` 卡被拒后 PI 在对话中只给出 comment、未说明 `rejected` 或 `revision_requested`
- **THEN** coordinator 再次询问处置，在 PI 明确回答前 session log 中不出现 `report_decide` 的 `tool/call` 或 `approval/asked`

#### Scenario: PI rejects the relayed comment card
- **WHEN** `report_decide` 卡回显的 comment 与 PI 原话不符，PI 在卡上拒绝
- **THEN** 工具不执行，`decision_history` 不变，coordinator 须重新索要并再次调用 `report_decide`

### Requirement: Policy decision audit
每条 `deny` 或 `ask` 决策 SHALL 经 `ctx.logger("shud-policy-gate")` 输出一行 `<decision> <tool id> <reason code>`（deny 的 reason code 为 core `ruleId`，求值异常时为受控错误码；ask 为报告审批常量对应的码）；SHALL NOT 使用 `console.*`；SHALL NOT 包含工具参数、路径、`report_id`、报告摘要、comment 文本或环境变量值。插件 dispose 时 SHALL 输出累计决策计数（deny/ask 各一）。决策的 session log 证据为 dsh 既有事件：deny → `tool/result` isError 含 `reason`；ask → `approval/asked{toolName, reason}` + `approval/decided{outcome}`。与 raw-guard 相同，在钉版 dsh-v0.2.1-rc.2 的默认成功启动路径中 logger 行仅为埋点、没有运维可读出口（#378），SHALL NOT 将 logger 收到记录或内存 buffer 视为可读、持久审计证据。

#### Scenario: ask is audited without the comment
- **WHEN** 一次 `report_decide` 被转为 `ask`，其 `comment` 为 `please rerun with 60 days`
- **THEN** logger 收到一行以 `ask report_decide` 开头的记录，记录中不含该 comment 文本与 `report_id`

#### Scenario: delegation is not audited
- **WHEN** preset `worker` 的一次 `shud_collect` 调用被委托给 `next()`
- **THEN** logger 不收到本插件的决策行

#### Scenario: dispose reports counts
- **WHEN** 发生 1 次 deny、2 次 ask 后触发 dispose
- **THEN** logger 收到含 `deny=1` 与 `ask=2` 的一行
