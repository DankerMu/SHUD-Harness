# research-context-binding

TaskCard stack/data 绑定校验与前端研究上下文展示：ResearchContext SideNav 卡、ArtifactRef、ExperimentHeader 完整化。权威源：[Minimal_Schemas §1](../../../../../docs/03_SPEC/Minimal_Schemas.md)（TaskCard 已含 stack_id/data_id）、[Frontend_State_Design §1](../../../../../docs/03_SPEC/Frontend_State_Design.md)（SideNav REST snapshot）、[UI_Implementation_Spec](../../../../../docs/03_SPEC/UI_Implementation_Spec.md)（ResearchContext 折叠组样式）、[Phase_By_Phase_Test_Plan W2](../../../../../docs/04_IMPLEMENTATION/Phase_By_Phase_Test_Plan.md)（UI/E2E 三条 + exit gate）。

## ADDED Requirements

### Requirement: TaskCard 绑定校验

`POST /api/tasks` SHALL 接受可选 `stack_id`/`data_id`（canonical TaskCard 既有字段，不动 frozen 字段集）；提供时 MUST 校验对应 StackLock/DataProvenance 记录存在，不存在 → 422 canonical envelope（引用完整性）。绝不静默接受悬空引用。幂等交互显式裁决：幂等适用清单不变（仍仅既有条目），但 `stack_id`/`data_id` MUST 纳入 keyed 幂等的请求体 canonical digest（`taskCreateRequestDigest`，含 digest bounds 复核）——同一 `Idempotency-Key` 而 stack_id/data_id 不同的请求 MUST 422 digest mismatch，不得被错误去重返回首个 TaskCard。

#### Scenario: 绑定存在的 stack/data 成功（exit gate）

- **WHEN** 先 lock 一个 stack、register 一个 data，再以两 id 建卡
- **THEN** 建卡成功，`GET /api/tasks/:id` 返回含 stack_id/data_id 的 TaskCard

#### Scenario: 悬空引用被拒

- **WHEN** 以不存在的 stack_id 建卡
- **THEN** 422 canonical envelope，无 TaskCard 创建

#### Scenario: 同 key 不同绑定不被错误去重

- **WHEN** 以同一 `Idempotency-Key` 先后提交 stack_id 不同的两次建卡请求
- **THEN** 第二次 422（digest mismatch），不返回首个 TaskCard

### Requirement: ResearchContext SideNav 卡

前端 SHALL 在 SideNav 提供 ResearchContext 折叠组（随 activeTask 切换）：经 `GET /api/stacks/:stackId` 展示 StackLock 摘要（四 repo commit 短哈希、llm provider/model_id/**base_url**、fingerprint 短串），经 `GET /api/data/:dataId` 展示 DataProvenance 摘要（basin、event_window、来源计数与 sha256 短串）。全部读取请求 MUST 经统一鉴权 fetch wrapper 附带 Bearer token（local-auth「浏览器客户端 token bootstrap」requirement，任务 1.2）。task 未绑定时显示明确的空态文案。

#### Scenario: 展示完整版本链（W2 UI + exit gate）

- **WHEN** activeTask 绑定了 stack_id 与 data_id
- **THEN** SideNav 显示 StackLock 卡（含 llm base_url）与 DataProvenance 卡

#### Scenario: 未绑定空态

- **WHEN** activeTask 无 stack_id/data_id
- **THEN** ResearchContext 显示空态提示，不发起读取请求

### Requirement: ArtifactRef 组件

前端 SHALL 提供 ArtifactRef 组件：展示 artifact_id + 类型 + 相对路径，路径可点击复制（W2 UI 细目"可点击/复制路径"），evidence_usable=false 的产物有非证据视觉标记。**M2 数据来源契约（design D7）**：ArtifactRef 为纯展示组件，props（artifact_id/type/path/evidence_usable）由调用方传入——M2 交付面不含任何返回 artifact 元数据的读取端点，W2 UI 细目经组件测试行使；真实调用场景（RunRecord/报告视图接线）随该视图所在里程碑（M3+）落地，届时如需 metadata HTTP 端点按批次 6 同款流程补登记。

#### Scenario: 路径可复制

- **WHEN** 点击 ArtifactRef 的复制交互
- **THEN** 剪贴板得到 workspace 相对路径（不含绝对路径前缀）

#### Scenario: 纯展示组件经 props 行使

- **WHEN** 组件测试以完整 props（artifact_id/type/path/evidence_usable=false）挂载 ArtifactRef
- **THEN** 组件不发起任何网络请求，渲染 id/类型/路径与非证据视觉标记

### Requirement: ExperimentHeader 完整化

ExperimentHeader SHALL 从 M1 占位升级为展示 activeTask 的 title、status、stack_id/data_id 绑定徽标（有绑定时）；无 activeTask 时维持 M1 占位行为。

#### Scenario: 绑定徽标随任务切换

- **WHEN** activeTask 切换到已绑定 stack/data 的任务
- **THEN** header 显示两个绑定徽标；切到未绑定任务则徽标消失
