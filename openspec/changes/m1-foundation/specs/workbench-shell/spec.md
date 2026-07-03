# workbench-shell

React 四栏壳与两页两组件（占位深度，数据接线随后续里程碑）。权威源：[Repository_Layout §1](../../../../../docs/04_IMPLEMENTATION/Repository_Layout.md)（组件清单）、[Phased_Plan M1](../../../../../docs/04_IMPLEMENTATION/Phased_Plan.md)（切分参考）、UI_Implementation 系列（账本 Phase 1 激活）。

## ADDED Requirements

### Requirement: WorkbenchLayout 四栏容器

frontend SHALL 提供 WorkbenchLayout 布局容器，呈现四栏：SideNav（左导航）、AgentFeed（活动流）、Experiment（实验详情）、Results（结果面板）；四栏子组件本里程碑为占位实现。占位深度取舍（本 change 显式记录）：SideNav 任务列表与 Dashboard→Workbench 携带任务上下文的导航接线 deferred M2（Phased_Plan M2 前端行首个 SideNav 数据接线点）；Test_Plan W1 UI/E2E 的「进入 Workbench」「SideNav 显示任务」两条细目在 M1 验收按 tasks 9.1 显式清单标 N/A-M1，M1 的「浏览器四栏打开」由本 requirement 场景覆盖（直接打开 Workbench 页）。

#### Scenario: 四栏可见

- **WHEN** 浏览器打开 Workbench 页
- **THEN** 四栏容器同时渲染，无控制台错误

### Requirement: Dashboard 任务列表与建卡入口

Dashboard 页 SHALL 通过 `GET /api/tasks` 展示 TaskCard 列表，并提供建卡入口（表单 → `POST /api/tasks`）。

#### Scenario: 建卡即列表可见

- **WHEN** 通过 Dashboard 建卡成功
- **THEN** 列表出现新 TaskCard 且状态为 created

#### Scenario: 刷新后恢复

- **WHEN** 建卡后刷新浏览器
- **THEN** 列表仍包含该 TaskCard（读取后端 snapshot，非前端内存态）

### Requirement: ExperimentHeader 与 StatusBar 占位组件

frontend SHALL 提供 ExperimentHeader（展示 task id 与 status）与 StatusBar（全局状态条挂载点）两个占位组件，接受 task 上下文 props；软监控指标（模型调用数、费用）等数据接线在后续里程碑。

#### Scenario: 选中任务后头部展示

- **WHEN** 在 UI 中选中一个 TaskCard
- **THEN** ExperimentHeader 显示其 id 与 status
