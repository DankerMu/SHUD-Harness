# policy-gate-spike

中央策略门五条 spike——ADR-0001 触发器 1 的判定标准，五条全绿才过。权威源：[Phased_Plan M1](../../../../../docs/04_IMPLEMENTATION/Phased_Plan.md)（五条原文，条 2 经 2026-07-04 ADR 例外修订为执行层 enforcement）、[Control_Kernel §5](../../../../../docs/02_ARCHITECTURE/Control_Kernel.md)（校验注入点与拒绝载荷）、[Zero_Reuse_Matrix §8](../../../../../docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md)、[ADR-0001](../../../../../docs/adr/0001-agent-runtime-and-topology.md)（2026-07-04 revisit 裁决：边界重划）、[Preflight_And_Mutation_Boundary_Spec](../../../../../docs/03_SPEC/Preflight_And_Mutation_Boundary_Spec.md)（"preflight 是 submit 前的门，不是运行期防线"——两层分工依据）、[Sandbox_and_Executor §1](../../../../../docs/03_SPEC/Sandbox_and_Executor.md)（执行层允许/禁止写清单）、[WebSocket_Protocol §3](../../../../../docs/03_SPEC/WebSocket_Protocol.md)（事件唯一注册表）、[Workspace_Conventions](../../../../../docs/03_SPEC/Workspace_Conventions.md)（audit 落盘布局）；首轮判定证据：[policy-gate-spike-verdict](../../policy-gate-spike-verdict.md)。

## ADDED Requirements

### Requirement: 中央策略门覆盖全部工具调用（spike 条 1）

工具注册层 SHALL 以横切包装实现中央策略门（`ToolBase.beforeExecute` 包装或注册期统一 wrap execute），对**全部**注册工具（含 spawn/bash/edit）生效；拦截即返回工具错误，MUST NOT 修改 Zero 内核。注册流程 MUST 强制包装——存在未包装工具即装配失败。

#### Scenario: bash 调用先过策略门

- **WHEN** 任一角色发起 bash 工具调用
- **THEN** 策略门在命令真实执行前完成求值，deny 时命令不执行

#### Scenario: 未包装工具被装配拦截

- **WHEN** 向注册层注册一个绕过策略门包装的工具
- **THEN** 装配（或注册期检查）失败，指出未包装工具 id

### Requirement: 一条治理规则端到端穿透（spike 条 2'，执行层 enforcement）

路径写禁区规则（`data/raw/**`）的 authority SHALL 位于执行层 OS 沙箱：bash 工具 spawn 命令时施加沙箱 profile（macOS = `sandbox-exec`/seatbelt：`deny file-write*` subpath `data/raw`，其余默认放行），写入在 syscall 层按解析后真实目标路径被拒，子进程 MUST 继承约束；合法 `data/raw` 读取与 workspace 允许目录写入 MUST 不受影响。pre-exec 静态检查降级为 advisory 提示层（fail-open）：MAY 对可静态识别的明显违规在执行前拒绝并给出 remediation，MUST NOT 作为唯一 authority，MUST NOT 因不确定而误拒合法读取。

拒绝面（advisory 提前拒与 OS 层运行期拒同一错误形态）MUST 产出含 `remediation{next_action, hint, ref}` 的工具错误；拒绝事件 MUST 经 WebSocket 推出，事件类型复用 WebSocket_Protocol §3 注册表既有的 `tool.failed`（冻结注册表内无 policy-denial 类事件，本 change 不新增事件类型），payload 携带含 remediation 的 ErrorRecord，skeleton 深度：envelope 含 seq/event_id。同时 MUST 落 audit 最小行：字段至少含 `event`、`tool_id`、`rule`、`decision`、`ts`，施加了沙箱 profile 的每次 bash 调用 audit 行 MUST 含 profile 标识（运行期拒 decision 记 `denied_by_sandbox`）；落盘遵 Workspace_Conventions `tasks/<task_id>/audit/` 布局，spike 的 bash 拒绝发生在无 TaskCard 上下文时固定使用 fixture 任务目录 `workspace/tasks/TASK-M1-SPIKE/audit/`；完整 AuditEvent schema（User_Session_And_Audit_Schema §4）与完整协议随 M3 对齐。

重定背景（2026-07-04）：首轮条 2 以 pre-exec 静态命令串扫描作为唯一 authority 判 Not green——静态扫描无法同时满足"任意 bash 写入拒绝 / 合法 raw 读兼容 / 不实现 full shell parser"，六类逃逸 + 读误拒证据见 [policy-gate-spike-verdict](../../policy-gate-spike-verdict.md)（PR #46 留作 spike 证据）；按 ADR-0001 revisit 裁决与冻结 spec 既有分工重定为执行层 enforcement。

#### Scenario: 六类逃逸负例在 OS 层被拒

- **WHEN** agent 通过 bash 以下列任一形态尝试写入 `data/raw/`：解释器 payload（如 perl/python open 写）、pipeline/stdin 数据流（如 tee）、动态构造写目标（变量拼路径）、shell 动态状态（cd 后相对路径、子/孙进程）、别名路径（symlink 指入、`../` 穿越）、rename/unlink
- **THEN** 写入无一落盘（syscall 层拒绝）、返回含 remediation 三字段的工具错误、WebSocket 收到 `tool.failed` 事件（envelope 含 seq/event_id，payload 携带 remediation）、audit 最小行落盘于约定路径且含 event/tool_id/rule/decision/ts + profile 标识

#### Scenario: 合法读取与 workspace 写不受影响

- **WHEN** agent 通过 bash 读取 `data/raw/` 下文件，或写入 workspace 允许目录
- **THEN** 命令在沙箱 profile 下成功执行，无误拒

#### Scenario: 预存 hardlink 残留有兜底

- **WHEN** `data/raw/` 内文件在 enforcement 生效前已存在指向 raw 外的 hardlink 别名，且通过该别名写入
- **THEN** 写入不被 profile 拦截（已知原理性残留，spike 证据 MUST 如实记录）；`nlink>1` 扫描 MUST 能检出该别名并报告（兜底接线归 ingest/readiness 面，长期由 DataProvenance 校验和交叉验证）

#### Scenario: advisory 提前拒可导航

- **WHEN** pre-exec advisory 层识别出明显的 raw 写入意图
- **THEN** 可在执行前拒绝并返回与 OS 层拒绝同形态的 remediation 错误；advisory 漏判不构成放行风险（OS 层兜底），advisory 误判 MUST NOT 拦截合法读取

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

首轮判定（2026-07-04）已按本条款执行：条 1/4/5 绿、条 2（pre-exec 静态扫描形态）不绿 → revisit 触发并同日裁决完成（[verdict](../../policy-gate-spike-verdict.md)、[ADR-0001 revisit 记录](../../../../../docs/adr/0001-agent-runtime-and-topology.md)）：两备胎均不启用（对 shell 语义不可静态判定这一失败类同样无效），条 2 重定为条 2'（执行层 enforcement，见上一 requirement），冻结解除——条 3 与其余 3.x/5.x 任务按原依赖图恢复；Trial → 转正复判在条 2' 绿后基于五条重出。

#### Scenario: 全绿转正

- **WHEN** 五条 spike 验收全部通过
- **THEN** 判定记录落盘（结论 + 证据链接），M1 后续策略门相关任务解除阻塞

#### Scenario: 不绿触发 revisit

- **WHEN** 任一条在 2 人周内无法通过
- **THEN** 停止后续策略门任务，产出 ADR-0001 revisit 评估备忘（按修订注备选顺序）
