# Spec Delta

## MODIFIED Requirements

### Requirement: Role tool surface rule
core SHALL 提供 authority 规则 `role-tool-surface`，其 id 列入 `RESERVED_AUTHORITY_POLICY_RULE_IDS`，作为规范 SHUD 规则集唯一规则。coordinator、worker、coder、reviewer 调用不在各自 `inherited ∪ local` 内的工具时 deny，reason 仅含角色与工具 id、不含参数；集合内或 unknown 角色返回 allow。四个角色的两集合由 agent-presets「Role tool map uses mounted names」唯一规定；restrict 消费 inherited，本规则消费并集，不另存清单副本。preset-owned 工具（`job_*`、`read`、`edit`、`bash`）属 Agent 的 inherited；agent-owned 委派工具（`subagent`、`subagent_coder`、`subagent_reviewer`）属 local。新增模型工具 `change_create`、`change_submit`、`shud_build`、`verification_run` 同样只在其所属角色的集合内放行。M5 新增模型工具 `analysis_create` 只属于 coordinator 的集合，worker、coder、reviewer 调用即 deny；`shud_run` 新增的 `analysis_plan_id`/`parameter_set_id` 参数不改变工具 id，worker 的集合不变。

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

#### Scenario: off-role analysis_create is denied
- **WHEN** preset `worker`、`coder` 或 `reviewer` 调用 `analysis_create`
- **THEN** 三次决策 `kind` 均为 `deny`（`role-tool-surface`），`reason` 分别含对应角色与 `analysis_create`，`next()` 未被调用，宿主不发起审批卡；`input_dir` 位于 raw 内时适用下一场景的已知例外

#### Scenario: off-role call with raw input_dir asks before the role deny (known exception)
- **WHEN** 在实际瀑布顺序（raw-guard 先于 policy-gate，role-restrict 挂载）下，preset `worker`、`coder` 或 `reviewer` 以 raw 内 `input_dir` 调用 `analysis_create`，或 preset `coordinator` 以 raw 内 `input_dir` 调用 `shud_run`
- **THEN** raw-guard 先返回 provenance `ask`，策略门不运行（无 `role-tool-surface` 审计行），宿主恰好发起一次审批卡；审批为 `allowed-once` 时结果为错误码 `UNKNOWN_TOOL`（role-restrict 隐藏该工具），否则为对应拒绝错误；两种情况下工具主体都不执行，raw 字节不变。这是 #713 登记的已知例外（PI 2026-11-09 裁定先固定现状）；角色拒绝先于 raw ask 的变更须经 `docs/adr/proposed/` 中 PI 接受的决策记录后另行实施

#### Scenario: coordinator analysis_create passes the surface
- **WHEN** preset `coordinator` 调用 `analysis_create`
- **THEN** 本规则返回 `allow`，策略门返回 `next()` 的结果

#### Scenario: plan-bound shud_run keeps the worker surface
- **WHEN** preset `worker` 以 `analysis_plan_id` 与 `parameter_set_id` 调用 `shud_run`；preset `coordinator` 以同样参数调用 `shud_run`
- **THEN** 前者本规则返回 `allow`；后者决策 `kind` 为 `deny`，`reason` 含 `coordinator` 与 `shud_run`

## ADDED Requirements

### Requirement: Sensitivity tools do not ask
策略门 SHALL NOT 为 M5 敏感性编排新增任何审批点：`analysis_create`（任何参数形态）与绑定 plan 的 `shud_run` 在规范规则集未返回 `deny` 时，SHALL 调用 `next()` 恰好一次并返回其结果，SHALL NOT 返回 `ask`，不读取 `analyses/`、`tasks/` 或输入目录。理由：M5 只对运行副本施加已登记 calib 键的倍率（Gating §1.2 已登记 calib 键的 floor 为 none），不修改默认参数文件，K12"改默认参数需 PI"不受影响；敏感性任务中 PI 的唯一审批点是既有的 `report_submit`/`report_decide`（「Report terminal tools always ask」）。规范规则集仍只含 `role-tool-surface`，本要求不新增规则 id。`shud_run` 的输入位于 raw 时的 provenance 读审批由 raw-data-guard 产生，不属于本插件的审批点，本要求不改变它。

#### Scenario: analysis_create delegates without approval
- **WHEN** preset `coordinator` 以合法参数调用 `analysis_create`，或以 `arguments: null` 调用
- **THEN** 策略门不抛出，`next()` 被调用恰好一次，监听器返回其结果；session log 中没有该调用的 `approval/asked`

#### Scenario: plan-bound shud_run delegates without approval
- **WHEN** preset `worker` 以 `task_id`、`analysis_plan_id` 与 `parameter_set_id` 调用 `shud_run`，`input_dir` 不在 raw 内
- **THEN** 策略门返回 `next()` 的结果，不返回 `ask`，session log 中没有该调用的 `approval/asked`

#### Scenario: unknown caller is not asked
- **WHEN** `role: "unknown"` 的 Agent 调用 `analysis_create`
- **THEN** `role-tool-surface` 返回 `allow`，策略门返回 `next()` 的结果，不返回 `ask`

#### Scenario: sensitivity task has exactly one PI card
- **WHEN** 一次 sensitivity 任务依次调用 `task_create`、`analysis_create`、四次绑定 plan 的 `shud_run`、`shud_collect`、`report_generate`、`report_validate` 与 `report_submit`，输入均不在 raw 内
- **THEN** session log 中策略门产生的 `approval/asked` 恰好一次，其 `toolName` 为 `report_submit`
