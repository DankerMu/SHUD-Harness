# policy-gate-spike

中央策略门五条 spike——ADR-0001 触发器 1 的判定标准，五条全绿才过。权威源：[Phased_Plan M1](../../../../../docs/04_IMPLEMENTATION/Phased_Plan.md)（五条原文）、[Control_Kernel §5](../../../../../docs/02_ARCHITECTURE/Control_Kernel.md)（校验注入点与拒绝载荷）、[Zero_Reuse_Matrix §8](../../../../../docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md)、[ADR-0001](../../../../../docs/adr/0001-agent-runtime-and-topology.md)、[WebSocket_Protocol §3](../../../../../docs/03_SPEC/WebSocket_Protocol.md)（事件唯一注册表）、[Workspace_Conventions](../../../../../docs/03_SPEC/Workspace_Conventions.md)（audit 落盘布局）。

## ADDED Requirements

### Requirement: 中央策略门覆盖全部工具调用（spike 条 1）

工具注册层 SHALL 以横切包装实现中央策略门（`ToolBase.beforeExecute` 包装或注册期统一 wrap execute），对**全部**注册工具（含 spawn/bash/edit）生效；拦截即返回工具错误，MUST NOT 修改 Zero 内核。注册流程 MUST 强制包装——存在未包装工具即装配失败。

#### Scenario: bash 调用先过策略门

- **WHEN** 任一角色发起 bash 工具调用
- **THEN** 策略门在命令真实执行前完成求值，deny 时命令不执行

#### Scenario: 未包装工具被装配拦截

- **WHEN** 向注册层注册一个绕过策略门包装的工具
- **THEN** 装配（或注册期检查）失败，指出未包装工具 id

### Requirement: 一条治理规则端到端穿透（spike 条 2）

路径写禁区规则（`data/raw/**`）SHALL 在 bash 工具真实执行前拒绝写入；拒绝错误体 MUST 含 `remediation{next_action, hint, ref}`。拒绝事件 MUST 经 WebSocket 推出，事件类型复用 WebSocket_Protocol §3 注册表既有的 `tool.failed`（冻结注册表内无 policy-denial 类事件，本 change 不新增事件类型），payload 携带含 remediation 的 ErrorRecord，skeleton 深度：envelope 含 seq/event_id。同时 MUST 落 audit 最小行：字段至少含 `event`、`tool_id`、`rule`、`decision`、`ts`；落盘遵 Workspace_Conventions `tasks/<task_id>/audit/` 布局，spike 的 bash 拒绝发生在无 TaskCard 上下文时固定使用 fixture 任务目录 `workspace/tasks/TASK-M1-SPIKE/audit/`；完整 AuditEvent schema（User_Session_And_Audit_Schema §4）与完整协议随 M3 对齐。

#### Scenario: 写禁区被拒且可导航

- **WHEN** agent 通过 bash 尝试写入 `data/raw/` 下任意路径
- **THEN** 命令未执行、返回含 remediation 三字段的工具错误、WebSocket 收到 `tool.failed` 事件（envelope 含 seq/event_id，payload 携带 remediation）、audit 最小行落盘于约定路径（无任务上下文时为 `workspace/tasks/TASK-M1-SPIKE/audit/`）且含 event/tool_id/rule/decision/ts 五字段

### Requirement: spawn 剖面超集拒绝（spike 条 3）

spawn 调用传入的 `allowed_tools` 超出该角色 canonical 剖面（比对基准 = tool-registry-governance 交付的 role→tool_id 映射表）时 SHALL 被拒，且拒绝体 MUST 断言 `remediation.next_action = adjust_scope`。

#### Scenario: 超集 spawn 负例

- **WHEN** 以 worker 角色 spawn 且 `allowed_tools` 含 worker 剖面外的工具 id（如 edit 类）
- **THEN** spawn 被拒，`remediation.next_action = adjust_scope`，hint 指出超集工具 id，ref 指向 Roles_and_Boundaries §0

### Requirement: 策略门纯函数与独立单测（spike 条 4）

策略门核心判定 SHALL 为纯函数（输入 ToolCall 与策略上下文，输出 `allow | deny` + reason + remediation），无 IO 副作用，具备独立单测（正例放行、负例拒绝、remediation 载荷断言）。

#### Scenario: 纯函数可独立测试

- **WHEN** 以相同 ToolCall 输入重复调用判定函数
- **THEN** 输出恒等，测试不需要启动 Zero runtime 或网络

### Requirement: Zero 源码零改动（spike 条 5）

上述全部 SHALL 在 zero@13e25c1 上以 adapter/包装实现；spike 完成时 zero 子仓 MUST 无任何源码改动。

#### Scenario: diff 为零

- **WHEN** spike 五条实现完成后检查 zero 子仓
- **THEN** `git -C zero diff --quiet` 为真且 HEAD 仍为 13e25c1

### Requirement: spike 判定与退路

spike SHALL 产出判定记录：五条全绿 → Zero 基座由 Trial 转正（记入 ADR-0001 状态）；任一条 2 人周内不绿 → 触发 ADR-0001 revisit，按 2026-07-02 修订注顺序（① 自建薄工具注册层 ② Claude Agent SDK 迁移）产出评估备忘，MUST NOT 带病继续后续策略门任务。

#### Scenario: 全绿转正

- **WHEN** 五条 spike 验收全部通过
- **THEN** 判定记录落盘（结论 + 证据链接），M1 后续策略门相关任务解除阻塞

#### Scenario: 不绿触发 revisit

- **WHEN** 任一条在 2 人周内无法通过
- **THEN** 停止后续策略门任务，产出 ADR-0001 revisit 评估备忘（按修订注备选顺序）
