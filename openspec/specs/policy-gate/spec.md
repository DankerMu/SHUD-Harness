# policy-gate Specification

## Purpose
定义 SHUD 治理策略门在 dsh `tools/pre-execute` 瀑布上的决策契约：调用角色如何从 Agent 的 preset id 推导，拆分后的 `policy-gate-core` deny 层（`role-tool-surface`）如何先于报告审批求值并映射为宿主决策，EvidenceReport 终态决定点（`report_submit`、`report_decide`）如何在未被角色拒绝时无条件转交 PI 审批卡，宿主 fail-closed 如何约束审批结果，PI comment 如何经对话承载并在二次审批卡上确认，以及决策如何留下审计证据。与 raw-guard 同为 advisory 层：插件只返回 `deny|ask` 或委托下一个监听器，审批本身由宿主 `serviceAsk` 经 `ctx.approval` 完成。

## Requirements

### Requirement: Global pre-execute mounting
策略门 SHALL 以插件 `@shud-harness/dsh-shud-policy-gate` 作为 bundle patch 中的全局行 `shud-policy-gate` 挂载（与 `shud-raw-guard` 并列），SHALL NOT 挂进任何 agent preset 的 `plugins` 子树；该行与插件、`profile:smoke` 对该行的断言在同一个交付切片中落地，先于 `report_submit`/`report_decide` 工具挂载，使报告终态工具从挂载起就经过审批；`change_submit` 的 ask 规则 SHALL 与 `change_submit` 工具在同一切片落地（规则先于或同时于工具挂载），不存在未经审批的 `change_submit` 窗口。`apply` 时 SHALL 经 `ctx.on("tools/pre-execute")` 注册且仅注册一个监听器；插件 SHALL NOT 直接调用 `ctx.approval`，SHALL NOT 改写工具参数。监听器只返回 `{kind: "deny"}`、`{kind: "ask"}` 或 `next()` 的结果，SHALL NOT 返回 `{kind: "allow"}`（它会终止瀑布，使后续监听器失效）。监听器内部 SHALL 先推导当前调用角色，再以规范规则集求值；拒绝即返回 deny，否则 report_submit/report_decide 与高风险 change_submit 返回 ask（后者规则见「change_submit asks for high-risk change requests」），其它工具调用 next。O2 实测组合中 raw-guard 先于策略形态监听器，产品组合 SHALL 保持此顺序；组合未挂 auto-review/hooks，不声称已验证其顺序或短路优先级。

#### Scenario: dump-config shows the global row
- **WHEN** 在已执行 `profile:install` 的 `DSH_HOME` 上执行 `dsh --profile shud --dump-config`
- **THEN** 输出含 `id: shud-policy-gate` 且其 `name` 为 `@shud-harness/dsh-shud-policy-gate`，该行位于全局插件列表而不在 `preset-coordinator`、`preset-worker`、`preset-coder` 或 `preset-reviewer` 的 `plugins` 子树内

#### Scenario: missing row fails the smoke
- **WHEN** bundle patch 删除或禁用 `shud-policy-gate` 行后执行 `pnpm run profile:smoke`
- **THEN** 退出码非 0，输出指出 `shud-policy-gate` 行缺失

#### Scenario: listener never terminates the waterfall with allow
- **WHEN** 任一工具调用（含 `change_submit`，不论其 CR 的 `semantic_level`）经本插件监听器处理
- **THEN** 返回值的 `kind` 不是 `allow`

#### Scenario: change_submit is never mounted without its ask rule
- **WHEN** 检查交付 `change_submit` 工具的切片及其之后任一提交的 bundle 与策略门插件
- **THEN** 只要 `change_submit` 已挂载，策略门就含「change_submit asks for high-risk change requests」规则；不存在 `change_submit` 已挂载而高风险 CR 调用返回 `next()` 的提交

### Requirement: Caller role derivation
策略门、TaskCard attribution 与工具限制 SHALL 共用 core 的唯一 `readCallerPresetId(agent)`：从公开 `agent.ctx` 的 `sessionProjections` 服务读取当前 `agentPreset` 会话投影，非空字符串原样返回；缺 Agent、会话、服务、投影或非空值时返回 unknown，不以 creation header 冒充当前身份。映射为 coordinator、worker、coder、reviewer 自身，其它值（含 standard 与 repo_explorer；M4 不建 repo_explorer preset）为 unknown。读取缺失路径不得抛错。K13 O6 已证明 header 为冻结的创建事实，空白会话切换后不改写；committed `agent-preset/selected` 后投影才代表新角色。

#### Scenario: role derives from current preset projection
- **WHEN** 同一工具分别由当前投影为 coordinator、worker、coder、reviewer 的 Agent 与缺 Agent 的调用触发
- **THEN** 传给 `evaluatePolicyGate` 的 `role` 依次为 `"coordinator"`、`"worker"`、`"coder"`、`"reviewer"`、`"unknown"`

#### Scenario: unknown or M4 preset maps to unknown
- **WHEN** 当前投影为 standard、repo_explorer，或调用没有当前 preset 投影
- **THEN** `role` 为 `"unknown"`，监听器不抛出

#### Scenario: preset switch overrides the creation header
- **WHEN** 空白会话 header 为 coordinator，但已提交的当前 preset 投影为 worker
- **THEN** 唯一身份读取函数返回 worker，执行门按 worker 判定并拒绝 task_create，不返回 header 的 coordinator 或创建卡片

#### Scenario: coder projection is not read from the header
- **WHEN** 空白会话 header 为 coordinator，已提交的当前 preset 投影为 coder，Agent 调用 `change_create`
- **THEN** 唯一身份读取函数返回 coder，执行门按 coder 判定并放行（返回 `next()` 的结果），不按 header 的 coordinator 拒绝

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
- **WHEN** 当前 committed preset 投影为 `worker` 的 Agent 调用 `report_submit`，即使其创建 header 仍为 `coordinator`
- **THEN** 决策 `kind` 为 `deny`（`role-tool-surface`），宿主不发起审批卡，session log 中没有该调用的 `approval/asked`

#### Scenario: unknown caller still asks
- **WHEN** `role` 为 `"unknown"` 的 Agent 调用 `report_submit`
- **THEN** 决策 `kind` 为 `ask`，不因角色变为 `deny` 或委托

### Requirement: Host fail-closed approval outcome
报告终态工具（`report_submit`、`report_decide`）与 `change_submit` 的执行，凡经策略门转为 `ask`，SHALL 只发生在宿主审批结果为 `allowed-once` 时。无 approval 服务、无 agent、或结果为 `allowed-once` 以外的任何 outcome（含 rejected、cancelled、unavailable）时，宿主 SHALL 拒绝执行该工具：工具 `execute` 不被调用，模型看到工具错误（即"PI 未放行"）。对报告终态工具，报告保持 `reviewed`，TaskCard 保持 `reporting`，不写 `decision_history`；对 `change_submit`，`changes/<change_id>.json` 字节不变（CR 保持 `proposed`、`approval_ref` 为 `null`），审计只有 `approval/asked|decided`。这是宿主 `serviceAsk` 的既有 fail-closed 语义；策略门 SHALL NOT 自行补发审批或在拒绝后重试。会话文件权限模式（read-only、workspace-write、danger-full-access）SHALL NOT 改变这些工具的审批：按 shud-profile「SHUD filesystem permission presets preserve explicit PI approval」（#511，文件权限与业务审批分离），danger-full-access 会话中经策略门转为 `ask` 的 `change_submit` 与报告终态工具同样发卡并等待 PI 的实际结果，不被自动放行或以 never 策略拒绝。

#### Scenario: allowed-once executes the tool
- **WHEN** `report_submit` 的审批卡结果为 `allowed-once`
- **THEN** 工具执行，session log 依次出现 `approval/asked{toolName: "report_submit", reason: <前缀常量> <report_id>}`、`approval/decided{outcome: "allowed-once"}` 与该调用的成功 `tool/result`；`decision_history` 新增 `outcome: accepted`、`approval_ref` 等于本次 `exec.callId`（对应 asked.callId，不是 asked.id）、`comment: null`

#### Scenario: no approval service denies
- **WHEN** 宿主没有 approval 服务（如 headless 模板）时调用 `report_submit`
- **THEN** 工具不执行，`tool/result` 为 isError，报告文件 `status` 仍为 `reviewed`，`decision_history` 长度不变

#### Scenario: non-allowed outcome denies
- **WHEN** `report_decide` 的审批卡结果不是 `allowed-once`
- **THEN** 工具不执行，报告状态与 `decision_history` 不变，TaskCard 仍为 `reporting`

#### Scenario: allowed-once approves the change request
- **WHEN** 高风险 CR 的 `change_submit` 审批卡结果为 `allowed-once`
- **THEN** 工具执行，session log 依次出现 `approval/asked{toolName: "change_submit", reason: <前缀常量> <change_id>}`、`approval/decided{outcome: "allowed-once"}` 与该调用的成功 `tool/result`；CR `status` 为 `approved`，`approval_ref` 等于本次 `exec.callId`（对应 asked.callId）

#### Scenario: non-allowed change approval leaves the CR bytes unchanged
- **WHEN** 高风险 CR 的 `change_submit` 审批卡结果为 rejected、cancelled 或 unavailable，或宿主没有 approval 服务（如 headless 模板）
- **THEN** 工具不执行，`tool/result` 为 isError；`changes/<change_id>.json` 的 sha256 与调用前相同（`status` 仍为 `proposed`、`approval_ref` 仍为 `null`）；策略门不再次发起审批；后续 `shud_build(change_id)` 因 CR 未 `approved` 而失败

#### Scenario: full file access still asks for change approval
- **WHEN** SHUD Web 会话的文件权限模式为 danger-full-access，coder 对 patch sha256 与记录一致、`semantic_level: numerical_implementation` 的 `proposed` CR 调用 `change_submit`
- **THEN** 策略门决策仍为 `ask`，session log 出现 `approval/asked{toolName: "change_submit"}`，卡片等待 PI 实际作答；作答前工具不执行、CR 字节不变；只有 `approval/decided{outcome: "allowed-once"}` 之后工具才执行

### Requirement: Policy core deny layer
对每次工具调用（含 `report_submit`、`report_decide`、`change_submit`），策略门 SHALL 构造 `PolicyGateToolCall{ toolId, role, input, workDir }` 并以 core 导出的规范 SHUD 规则集调用 `evaluatePolicyGate`，且 SHALL 在任何审批分支之前完成该求值：`toolId` 为工具 id；`role` 为「Caller role derivation」的结果；`input` 为原始 `arguments`（缺失或非对象时原样传入，SHALL NOT 抛错）；`workDir` 为调用的 `workdir` 参数（字符串时）否则 session cwd。core 返回 `deny` 时 SHALL 返回 `{kind: "deny", reason}`（`reason` 为 core 决策的 `reason`）；返回 `allow` 时，`report_submit`/`report_decide` 进入「Report terminal tools always ask」，`change_submit` 进入「change_submit asks for high-risk change requests」，除这三个 ask 工具外的其它工具 SHALL 调用 `next()` 恰好一次并返回其结果。规范规则集在 M3 只含 `role-tool-surface`（见「Role tool surface rule」）。策略门的 `deny` 来源恰为三类：core 规范规则集的 `deny`；`evaluatePolicyGate` 抛出时的受控 fail-closed `deny`；以及 core 返回 `allow` 之后「change_submit asks for high-risk change requests」中 patch 校验不符的 `deny`（code `change-patch-mismatch`，`reason` 为插件导出的受控常量）。第三类只在 core 求值完成且未拒绝之后发生，不进入 core 规则集，也不改变其它工具的委托语义。`evaluatePolicyGate` 抛出异常时策略门 SHALL fail-closed 返回 `{kind: "deny", reason}`（报告终态工具与 `change_submit` 同样如此），`reason` 为导出的受控固定文案，SHALL NOT 含原始异常消息、栈或工具参数，`next()` 不被调用。

#### Scenario: core deny maps to host deny
- **WHEN** 规范规则集对某次调用返回 `{decision: "deny", ruleId, reason}`
- **THEN** 决策为 `{kind: "deny", reason}`，`next()` 未被调用，宿主 `tool/result` 为 isError 且含该 `reason`

#### Scenario: core allow delegates exactly once
- **WHEN** preset `worker` 调用 `shud_collect`，规范规则集返回 `allow`
- **THEN** 不作判定，`next()` 被调用恰好一次，监听器返回其结果

#### Scenario: deny is evaluated before the report ask
- **WHEN** 规范规则集对一次 `report_decide` 调用返回 `deny`
- **THEN** 决策 `kind` 为 `deny`，不返回 `ask`，`next()` 未被调用

#### Scenario: deny is evaluated before the change ask
- **WHEN** 规范规则集对一次 `change_submit` 调用（如 preset `reviewer` 调用）返回 `deny`
- **THEN** 决策 `kind` 为 `deny`，不读取 `changes/` 与 `patches/`、不返回 `ask`，`next()` 未被调用

#### Scenario: patch mismatch is a deny source after core allow
- **WHEN** 规范规则集对 coder 的一次 `change_submit` 返回 `allow`，`changes/<change_id>.json` 通过 schema 校验，`patches/<change_id>.patch` 为可读普通文件但其 sha256 与 CR 的 `patch_sha256` 不同
- **THEN** 决策为 `{kind: "deny", reason}`，`reason` 等于插件导出的 patch 不符受控常量；不返回 `ask`，宿主不发起审批卡，`next()` 未被调用，`tool/result` 为 isError 且含该 `reason`

#### Scenario: malformed arguments do not throw
- **WHEN** preset `worker` 调用 `shud_collect`，`arguments` 为 `null` 或数组
- **THEN** 不抛出异常，按规范规则集求值并返回 `next()` 的结果

#### Scenario: evaluator failure fails closed
- **WHEN** `evaluatePolicyGate` 对某次调用（含 `report_submit` 或 `change_submit`）抛出异常（如规则返回非法决策快照），异常消息含 `secret-detail`
- **THEN** 决策 `kind` 为 `deny`，`reason` 等于导出的受控文案且不含 `secret-detail`，`next()` 未被调用，监听器本身不抛出

### Requirement: Role tool surface rule
core SHALL 提供 authority 规则 `role-tool-surface`，其 id 列入 `RESERVED_AUTHORITY_POLICY_RULE_IDS`，作为规范 SHUD 规则集唯一规则。coordinator、worker、coder、reviewer 调用不在各自 `inherited ∪ local` 内的工具时 deny，reason 仅含角色与工具 id、不含参数；集合内或 unknown 角色返回 allow。四个角色的两集合由 agent-presets「Role tool map uses mounted names」唯一规定；restrict 消费 inherited，本规则消费并集，不另存清单副本。preset-owned 工具（`job_*`、`read`、`edit`、`bash`）属 Agent 的 inherited；agent-owned 委派工具（`subagent`、`subagent_coder`、`subagent_reviewer`）属 local。新增模型工具 `change_create`、`change_submit`、`shud_build`、`verification_run` 同样只在其所属角色的集合内放行。

#### Scenario: off-role tool is denied
- **WHEN** preset `worker` 调用 `report_generate` 或 `subagent`，或 preset `coordinator` 调用 `shud_run`
- **THEN** 决策 `kind` 为 `deny`，`reason` 分别含 `worker` 与 `report_generate`、`worker` 与 `subagent`、`coordinator` 与 `shud_run`

#### Scenario: off-role M4 tools are denied
- **WHEN** preset `worker` 调用 `change_create`，preset `coder` 调用 `shud_run`，preset `reviewer` 调用 `shud_build`，preset `coordinator` 调用 `shud_build`
- **THEN** 四次决策 `kind` 均为 `deny`，`reason` 分别含 `worker` 与 `change_create`、`coder` 与 `shud_run`、`reviewer` 与 `shud_build`、`coordinator` 与 `shud_build`，`next()` 未被调用，宿主不发起审批卡

#### Scenario: coder and reviewer cannot delegate or exceed their surface
- **WHEN** preset `coder` 调用 `subagent` 或 `job_kill`，preset `reviewer` 调用 `edit`、`bash`、`change_submit` 或 `job_kill`
- **THEN** 每次决策 `kind` 均为 `deny`，`reason` 含对应角色与工具 id

#### Scenario: on-role tool passes through
- **WHEN** preset `worker` 调用 `shud_run` 或 `job_output`，或 preset `coordinator` 调用 `task_create`、`subagent`、`subagent_coder` 或 `subagent_reviewer`
- **THEN** 不作判定，返回 `next()` 的结果

#### Scenario: on-role M4 tool passes through
- **WHEN** preset `coder` 调用 `bash`、`read`、`edit`、`change_create` 或 `shud_build`，或 preset `reviewer` 调用 `read`、`verification_run`、`shud_collect` 或 `job_output`
- **THEN** 本规则返回 `allow`；除 `change_submit` 另按「change_submit asks for high-risk change requests」求值外，策略门返回 `next()` 的结果

#### Scenario: removed read tool is denied for known roles
- **WHEN** preset `coordinator` 或 `worker` 调用名为 `read` 的工具
- **THEN** 决策 `kind` 为 `deny`（两个角色的集合都不含该工具）；本场景只约束 coordinator 与 worker，coder 与 reviewer 的集合含 `read`，见「on-role M4 tool passes through」

#### Scenario: unknown role is not judged
- **WHEN** `role: "unknown"` 的 Agent 调用 `bash` 或 `shud_build`
- **THEN** 本规则返回 `allow`，策略门返回 `next()` 的结果

#### Scenario: single source with restrict
- **WHEN** 比较 `role-tool-surface` 对 coordinator、worker、coder、reviewer 各自放行的工具 id 集合与 `shud-role-restrict` 对同一角色传给 `restrict` 的 `allow`
- **THEN** 前者等于 `inherited ∪ local`，后者等于 `inherited`，二者取自同一 `ROLE_TOOL_MAP` 条目

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
审批卡没有 comment 字段，PI comment SHALL 经对话承载（ADR-0011）。submit 未获放行后 coordinator 必须索要非空 comment 与明确 rejected/revision_requested；任一缺失不调用 decide、不默认处置。decide 二次卡回显全文，allowed-once 后才写 PiGateDecision 与终态，并按状态机推进 TaskCard。approval_ref SHALL 为本次工具执行的 callId（submit accepted 或 decide 的各自 callId）；O5 已证明工具没有 approval id，审计通过 asked.callId → asked.id → decided.id，不另造日志订阅取 id。先前被拒 submit 卡不得作为模型参数或写入决定对象；两张卡 reason 携带同一 report_id，在同一 session log 关联拒绝 submit 与后续 decide。两张卡均记录 asked/decided。

#### Scenario: reject then comment then decide
- **WHEN** `report_submit` 卡被拒，coordinator 在下一轮取得 PI comment 与处置 `revision_requested`，调用 `report_decide` 且其卡为 `allowed-once`
- **THEN** session log 依次含 `reason` 含该 `report_id` 的 `report_submit` `approval/asked` 与其非 `allowed-once` 的 `approval/decided`，以及 `reason` 含同一 `report_id` 的 `report_decide` `approval/asked` 与 `approval/decided{outcome: "allowed-once"}`；报告 `decision_history` 新增一条 `outcome: revision_requested`、`comment` 等于 PI 原文、`approval_ref` 为本次 report_decide 的 exec.callId，且该条不含被拒提交卡的字段；TaskCard 为 `planned`

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
每条 `deny` 或 `ask` 决策 SHALL 经 `ctx.logger("shud-policy-gate")` 输出一行 `<decision> <tool id> <reason code>`（deny 的 reason code 为 core `ruleId`，求值异常时为受控错误码，`change_submit` 的 patch 校验不符为插件新导出的常量 `change-patch-mismatch`，即一行 `deny change_submit change-patch-mismatch`；报告终态工具的 ask 为报告审批常量对应的码；`change_submit` 的 ask 为插件新导出的常量 `change-approval`）；SHALL NOT 使用 `console.*`。除下述 `change_submit` 例外，记录 SHALL NOT 包含工具参数、路径、`report_id`、报告摘要、comment 文本或环境变量值。`change_submit` 的 ask 记录允许在 reason code 之后附带经 core `ChangeId` 品牌校验通过的 `change_id` 与经 ChangeRequest schema 校验读得的 `semantic_level`（未通过校验的值不写入）；`deny change_submit change-patch-mismatch` 记录只允许附带经品牌校验通过的 `change_id`；两者 SHALL NOT 含 `files_changed`、`floor_categories`、`description`、patch 内容、sha256 值、路径或原始参数文本——这些只出现在 `displayReason`（deny 没有 `displayReason`），不落日志。插件 dispose 时 SHALL 输出累计决策计数（deny/ask 各一）。决策的 session log 证据为 dsh 既有事件：deny → `tool/result` isError 含 `reason`；ask → `approval/asked{toolName, reason}` + `approval/decided{outcome}`。与 raw-guard 相同，在钉版 dsh-v0.2.1-rc.2 的默认成功启动路径中 logger 行仅为埋点、没有运维可读出口（#378），SHALL NOT 将 logger 收到记录或内存 buffer 视为可读、持久审计证据。

#### Scenario: ask is audited without the comment
- **WHEN** 一次 `report_decide` 被转为 `ask`，其 `comment` 为 `please rerun with 60 days`
- **THEN** logger 收到一行以 `ask report_decide` 开头的记录，记录中不含该 comment 文本与 `report_id`

#### Scenario: change ask is audited with id and level only
- **WHEN** 一次 `change_submit` 对 `semantic_level: numerical_implementation`、`files_changed` 含 `src/Model/MD_rhs_core.cpp`、`description` 为 `rederive strict omp slice` 的 CR 转为 `ask`
- **THEN** logger 收到一行以 `ask change_submit change-approval` 开头的记录，可含该 `change_id` 与 `numerical_implementation`，不含 `src/Model/MD_rhs_core.cpp`、`rederive strict omp slice`、patch 文本或原始参数 JSON

#### Scenario: invalid change id is not logged
- **WHEN** 一次 `change_submit` 的 `change_id` 为 `../tasks/x` 而被转为 `ask`
- **THEN** logger 记录以 `ask change_submit change-approval` 开头且不含 `../tasks/x`

#### Scenario: patch mismatch deny is audited with id only
- **WHEN** 一次 `change_submit` 因 `patches/<change_id>.patch` 的 sha256 与 CR 的 `patch_sha256` 不同而被 deny
- **THEN** logger 收到一行以 `deny change_submit change-patch-mismatch` 开头的记录，可含该 `change_id`，不含任一 sha256 值、`patches/` 路径、`files_changed` 或 patch 文本；dispose 计数中该次计为 deny

#### Scenario: delegation is not audited
- **WHEN** preset `worker` 的一次 `shud_collect` 调用被委托给 `next()`
- **THEN** logger 不收到本插件的决策行

#### Scenario: dispose reports counts
- **WHEN** 发生 1 次 deny、2 次 ask 后触发 dispose
- **THEN** logger 收到含 `deny=1` 与 `ask=2` 的一行

### Requirement: change_submit asks for high-risk change requests
对 `change_submit`，在「Role tool surface rule」未返回 `deny`（即调用角色为 `coder` 或 `"unknown"`）之后，策略门 SHALL 按以下固定顺序求值，每步命中即终止：(1) 读取工作区 `changes/<change_id>.json` 并经 core ChangeRequest schema 校验；CR 不可得（见下文读取规则）时返回 `ask`，不读取 patch。(2) CR 可得时另读取 `patches/<change_id>.patch`（路径只由通过 `ChangeId` 校验的 id 构造，只读 `patches/` 之内；`patches/` 目录与 patch 文件均先 `lstat`，须分别为真实目录与普通文件，符号链接与特殊文件视为不可读），计算其字节的 sha256 与 CR 的 `patch_sha256` 比较。(3) CR 与 patch 均可读而 sha256 不等时 SHALL 返回 `{kind: "deny", reason}`，`reason` 为插件新导出的受控常量（reason code `change-patch-mismatch`，文案说明 patch 已在 `change_create` 之后被改动、须重新 `change_create`，不含路径、sha256 值或参数文本），SHALL NOT 返回 `ask`，SHALL NOT 调用 `next()`；该检查与 `semantic_level` 无关，低风险 CR 的 patch 不符同样 deny。(4) patch 缺失、不可读或不是普通文件时 SHALL 返回 `ask`（不论 `semantic_level`，fail-closed：PI 可拒），`displayReason` 含"patch 无法读取"说明。(5) patch sha256 与记录一致时按 CR 的 `semantic_level` 决策：∈ {`output_semantics`、`numerical_implementation`、`parameter_default`、`physical_equation`、`model_assumption`} 时 SHALL 返回 `{kind: "ask", reason, displayReason}`；为 `pure_engineering` 或 `io_format` 时 SHALL 调用 `next()` 恰好一次并返回其结果（不 ask）。本规则是「Policy core deny layer」所列三个 ask 工具之一的分支，也是该 requirement 所列第三类 deny 来源；其它工具的委托语义不变。策略门的 patch 校验是审批前的展示一致性检查，工具执行时 change-requests「change_submit」另行复核，二者不互相替代。

`reason` 落入 session log 的 `approval/asked`，是该审批卡唯一的审计载体：它 SHALL 为插件导出的固定前缀常量加一个空格加经 core `ChangeId` 品牌 schema 校验通过的 `change_id`；参数中的 `change_id` 缺失或未通过校验时，SHALL 为该前缀加空格加插件导出的受控标记常量，SHALL NOT 含原始参数文本。`displayReason` SHALL 含非空 `en` 与 `zh`，内容含 `change_id`、`semantic_level`、`semantic_floor`、`floor_categories`（全部条目）、`risk`、`files_changed` 全列表（不截断）、patch 路径 `patches/<change_id>.patch` 与 CR 的 `description`，使 PI 可在卡片决定前打开 patch。`displayReason` 不落 session log，SHALL NOT 被当作审计证据。

读取 CR 时策略门 SHALL 只从通过 `ChangeId` 校验的 id 构造路径，只读 `changes/` 之内，并遵循 task-cards「TaskCard workspace file」的工作区文件安全规则（`changes/` 与目标文件经 `lstat` 确认，符号链接与特殊文件 fail-closed）；SHALL NOT 读取 `changes/` 与 `patches/<change_id>.patch` 之外的路径。参数缺失、类型不符、id 未通过校验、CR 文件缺失、不可读、JSON 损坏或未通过 schema 校验时 SHALL 仍返回 `ask`（fail-closed：不因读不到而放行或委托），SHALL NOT 抛错，`displayReason` 中不可得的部分以明确的"无法读取"说明代替。读取 patch 的任何失败同样 SHALL NOT 抛错。

执行结果按「Host fail-closed approval outcome」：仅 `allowed-once` 时工具执行，其它任何 outcome 由宿主拒绝执行且 CR 文件字节不变。工具自身的前置条件校验（如 CR 须为 `proposed`、所属卡须为 `running`）属于工具，不由策略门放行或拒绝。

#### Scenario: high-risk change asks with the change pointers
- **WHEN** coder 调用 `change_submit`，`change_id` 指向工作区中 `semantic_level: numerical_implementation`、`floor_categories: ["output_semantics", "numerical_implementation"]`、`status: proposed` 的 CR，`patches/<change_id>.patch` 的 sha256 等于其 `patch_sha256`
- **THEN** 决策 `kind` 为 `ask`，`reason` 以导出前缀常量开头并含该 `change_id`；`displayReason.en` 与 `displayReason.zh` 均含该 `change_id`、`numerical_implementation`、CR 的 `semantic_floor`、`floor_categories` 的两项与 `risk`、全部 `files_changed`、`patches/<change_id>.patch` 与 `description`；`next()` 未被调用

#### Scenario: every high-risk level asks
- **WHEN** coder 依次对 `semantic_level` 为 `output_semantics`、`numerical_implementation`、`parameter_default`、`physical_equation`、`model_assumption` 的五个 CR（patch sha256 均与记录一致）调用 `change_submit`
- **THEN** 五次决策 `kind` 均为 `ask`

#### Scenario: low-risk change delegates without a card
- **WHEN** coder 对 `semantic_level` 为 `pure_engineering` 或 `io_format`、patch sha256 与记录一致的 CR 调用 `change_submit`
- **THEN** 不作判定，`next()` 被调用恰好一次，监听器返回其结果；session log 中该调用没有 `approval/asked`

#### Scenario: tampered patch is denied before the card
- **WHEN** `change_create` 之后 `patches/<change_id>.patch` 被改动一个字节，coder 分别对 `semantic_level: numerical_implementation` 与 `semantic_level: pure_engineering` 的此类 CR 调用 `change_submit`
- **THEN** 两次决策均为 `{kind: "deny", reason}`，`reason` 等于导出的 patch 不符受控常量且不含 sha256 值或路径；宿主不发起审批卡，session log 中没有该调用的 `approval/asked`，`next()` 未被调用，CR 字节不变；logger 收到 `deny change_submit change-patch-mismatch` 开头的一行

#### Scenario: unreadable patch still asks
- **WHEN** CR 可读且通过 schema 校验，而 `patches/<change_id>.patch` 不存在、是符号链接、是目录，或 `patches` 是符号链接；CR 的 `semantic_level` 分别为 `numerical_implementation` 与 `io_format`
- **THEN** 不抛出异常，决策 `kind` 均为 `ask`（低风险 CR 也不委托），`displayReason.en` 与 `displayReason.zh` 含"patch 无法读取"说明（`en` 为对应英文），`next()` 未被调用，未跟随链接、未读取 `patches/<change_id>.patch` 之外的路径

#### Scenario: unreadable change request still asks
- **WHEN** coder 调用 `change_submit`，`arguments` 为 `null`、缺少 `change_id`、`change_id` 为 `../tasks/x`，或 `change_id` 合法但对应文件不存在、不是合法 JSON、未通过 ChangeRequest schema 校验，或 `changes/<change_id>.json` 是符号链接
- **THEN** 不抛出异常，决策 `kind` 仍为 `ask`；`reason` 为前缀加受控标记（或通过校验的 id）且不含 `../tasks/x`；`displayReason` 含"无法读取"说明；`next()` 未被调用；未读取 `changes/` 之外的路径，也未读取 `patches/`

#### Scenario: worker or reviewer calling change_submit is denied, not asked
- **WHEN** 当前 committed preset 投影为 `worker` 或 `reviewer` 的 Agent 调用 `change_submit`，即使其创建 header 为 `coder`
- **THEN** 决策 `kind` 为 `deny`（`role-tool-surface`），宿主不发起审批卡，session log 中没有该调用的 `approval/asked`，未读取 `changes/` 与 `patches/`

#### Scenario: unknown caller still asks
- **WHEN** `role` 为 `"unknown"` 的 Agent 对 `semantic_level: numerical_implementation` 的 CR 调用 `change_submit`
- **THEN** 决策 `kind` 为 `ask`，不因角色变为 `deny` 或委托

### Requirement: M4 approval comment deviation
对 `change_submit` 的审批卡，M4 SHALL 以宿主结果 `allowed-once` 作为 PI 对该 ChangeRequest 的批准，SHALL NOT 要求或采集 PI comment（偏离 `Scientific_Change_Gating_Spec.md` §5 的高风险批准须附 comment，登记于该规范 §5 与本 change 的 design D15，不写 `docs/adr/proposed/`）。系统 SHALL NOT 新增 `change_decide` 或其它针对 ChangeRequest 的决定工具；ChangeRequest 没有 `rejected` 持久状态，未获放行的 CR 保持 `proposed`。PI 的拒绝理由 SHALL 经对话由 coordinator 转述给 coder（ADR-0011 的对话承载），SHALL NOT 写入 ChangeRequest、TaskCard、patch 或其它工作区文件。本偏离仅适用于 `change_submit`；报告终态的 comment 规则仍按「PI comment conversation carrier」。

#### Scenario: allowed-once approves without a comment
- **WHEN** 高风险 CR 的 `change_submit` 卡结果为 `allowed-once`，PI 未在对话中给出任何 comment
- **THEN** CR 为 `approved`，CR 文件不含 comment 字段，工作区没有为该批准写入的其它决定对象

#### Scenario: no decide tool exists for change requests
- **WHEN** 检查四个角色的 `ROLE_TOOL_MAP` 条目与 Web 会话中各角色的模型可见工具
- **THEN** 均不含 `change_decide` 或其它以 ChangeRequest 为对象的决定工具

#### Scenario: rejection reason travels through the conversation only
- **WHEN** `change_submit` 卡被拒，PI 在对话中说明拒绝理由，coordinator 随后派发 coder 修改
- **THEN** 原 CR 文件 `status` 仍为 `proposed` 且字节不变，工作区任何文件都不含 PI 的拒绝理由文本；coder 修改后以新的 `change_id` 再次 `change_create`

#### Scenario: report decisions still require a comment
- **WHEN** 同一会话中 `report_submit` 卡被拒，coordinator 以空 `comment` 调用 `report_decide`
- **THEN** 按「PI comment conversation carrier」不写入终态与 `decision_history`，本偏离不放宽报告 comment 要求
