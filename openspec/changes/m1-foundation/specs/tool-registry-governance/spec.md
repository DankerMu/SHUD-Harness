# tool-registry-governance

工具面治理：role→tool_id canonical 映射表、注册期 lint、guard_class 标注、spawn depth/并发硬校验——与中央策略门同一横切点。权威源：[Roles_and_Boundaries §0](../../../../../docs/02_ARCHITECTURE/Roles_and_Boundaries.md)（权限类别）、[Control_Kernel §5/§5.2/§5.3](../../../../../docs/02_ARCHITECTURE/Control_Kernel.md)（spawn 硬校验、guard_class 与工具面治理约定）、[Zero_Reuse_Matrix §10](../../../../../docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md)（工具注册命名空间）、[ADR-0002](../../../../../docs/adr/0002-mvp-reality-anchoring.md)（M1 开工三决②工具面定案）。

## ADDED Requirements

### Requirement: role→tool_id canonical 映射表

`packages/core` SHALL 提供常量形式的 role→tool_id 映射表：canonical 角色枚举（coordinator | repo_explorer | worker | coder | reviewer）每个角色映射到具体工具 id 集合（zero 原生 + 领域工具，id 以注册名为准）。本表是 Roles_and_Boundaries §0 权限类别散文的唯一具象化落点，也是 policy-gate-spike 条 3 子集校验的比对基准。各角色工具面已经 M1 grill PI 确认（[GRILL-2] 定案 2026-07-03），基准如下（工具 id 以注册名为准：zero 原生工具用 zero 注册名，领域工具用 Zero_Reuse_Matrix §10 点分注册名——后续里程碑才交付的领域工具以注册名预先入表）：

| 角色 | 工具面 | 明确排除 |
|---|---|---|
| coordinator | spawn/wait（zero 原生）、harness.job.submit、harness.job.collect、harness.report.generate、memory(draft)、file_read | bash、write/edit |
| repo_explorer | file_read、search/glob/grep、git 只读诊断 | 一切写、spawn、job |
| worker | sandbox.exec（sandbox bash）、artifact 写（workspaces/artifacts/runs）、file_read、shud.build、shud.run、rshud.read_output、rshud.compute_metrics、memory(draft) | 仓库源码写 |
| coder | worktree 内 read/write/edit、patch 工具、worktree 内 bash（构建/自测）、memory(draft) | baseline/主分支写、spawn、job |
| reviewer | file_read、确定性 validator、memory(draft) | 一切写 |

工具 id 命名裁决：zero 原生工具（spawn/wait、file_read、search/glob/grep、write/edit、bash）以 zero 注册名为准；领域工具 id 一律以 [Zero_Reuse_Matrix §10](../../../../../docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md) 点分命名空间为唯一注册名（早期占位 `shud-build/run` → `shud.build`/`shud.run`，`rshud-parse` → `rshud.read_output`，`water-balance` → `rshud.compute_metrics`，`sandbox bash` → `sandbox.exec`）。Zero_Reuse_Matrix §4 与 Repository_Layout §1 的连字符写法（`shud-build.ts` 等）是实现文件名，不是工具注册名。memory(draft) 的注册名随 M4 memory 交付定，表内暂记权限类别。

冻结冲突裁决（本 change 显式记录）：[Roles_and_Boundaries §3](../../../../../docs/02_ARCHITECTURE/Roles_and_Boundaries.md) 散文「选择是否直接 bash、提交 RunJob、派 Worker」中的「直接 bash」已被 [ADR-0002](../../../../../docs/adr/0002-mvp-reality-anchoring.md) M1 开工三决②定案取代（2026-07-03 grill：coordinator 调度面含 file_read **无 bash**）——coordinator 的短命令执行一律经 spawn worker / 提交 RunJob。优先级：Roles_and_Boundaries §0 权限剖面 + ADR-0002 定案 + 本映射表 > §3 散文；§3 修订注按账本冻结例外流程另行补记（同 Config_Secrets §4 批次 4 做法，待办已列 proposal Impact），本 change 不改冻结正文。

#### Scenario: 五角色全覆盖

- **WHEN** 加载映射表常量
- **THEN** 恰好包含 canonical 枚举的 5 个角色，无缺失、无额外角色

### Requirement: 映射表语义不变式

映射表 SHALL 满足并以单测断言以下不变式：repo_explorer 与 reviewer 的集合不含任何写类工具 id（write/edit/patch）；worker 的集合不含仓库源码编辑工具；仅 coordinator 含 spawn/wait 类调度工具；coordinator 的集合不含 bash 与 write/edit 类工具 id（ADR-0002 开工三决②）；coder 是唯一含 worktree 编辑与 patch 工具的角色。

#### Scenario: 只读角色无写工具

- **WHEN** 运行映射表不变式单测
- **THEN** repo_explorer / reviewer 集合与写类工具 id 集合的交集为空

#### Scenario: spawn 权唯一

- **WHEN** 运行映射表不变式单测
- **THEN** 含 spawn/wait 工具 id 的角色仅 coordinator（与 max_spawn_depth=1 结构一致）

#### Scenario: coordinator 无 bash

- **WHEN** 运行映射表不变式单测
- **THEN** coordinator 集合与 bash/write/edit 类工具 id 集合的交集为空

### Requirement: 映射表快照测试

映射表 SHALL 有快照测试：任何映射变更 MUST 显式更新快照才能通过 CI——防止工具面静默漂移。

#### Scenario: 静默漂移被拦截

- **WHEN** 修改某角色工具集合但未更新快照
- **THEN** 快照测试失败

### Requirement: 注册期 lint

工具注册层 SHALL 在注册期强制 lint（Control_Kernel §5.3）：单角色可见工具 ≤ 20；每个工具描述包含"何时该用 / 何时不该用 / 成功与失败样态"；参数 schema 为 Zod 且校验失败按拒绝载荷约定回吐（不静默吞掉）。lint MUST 有负例测试。

#### Scenario: 超量注册被拒

- **WHEN** 某角色可见工具注册至第 21 个
- **THEN** 注册期 lint 失败并指出该角色与超出数量

#### Scenario: 描述不完整被拒

- **WHEN** 注册的工具描述缺少"何时不该用"节
- **THEN** 注册期 lint 失败并指出缺失节

### Requirement: 硬护栏 guard_class 标注

M1 落地的每条硬护栏——路径写禁区（policy-gate-spike 条 2'，执行层沙箱护栏与其 advisory 层均须标注）、spawn 剖面子集校验（policy-gate-spike 条 3）、spawn depth 上限与并发上限（本 spec「spawn depth 与并发上限硬校验」requirement）——SHALL 标注 `guard_class ∈ {authority, capability}`（Control_Kernel §5.2 分类），为换代减重审查留数据基础；存在未标注护栏时装配或 lint MUST 失败。

#### Scenario: 未标注护栏被拦截

- **WHEN** 注册一条未标注 guard_class 的硬护栏规则
- **THEN** 装配（或 lint）失败并指出该护栏

### Requirement: spawn depth 与并发上限硬校验

Control_Kernel §5 的 spawn 三项 kernel 硬校验中，depth 与并发两项 SHALL 在 M1 与剖面子集校验（policy-gate-spike 条 3）实现于同一校验注入点、同为策略门纯函数判定：spawn 成链深度 >1（max_spawn_depth=1）时 MUST 拒绝且拒绝体含 `remediation{next_action, hint, ref}`；活跃子代理数已达 3（max_concurrent_subagents=3）时的新 spawn MUST NOT 得到 allow 判定（Control_Kernel「超出排队执行」语义——M1 纯函数层断言非 allow 即可，真实排队调度随 M3 spawn 接线）。两项 MUST 有负例单测并按上一 requirement 标注 guard_class。

#### Scenario: 深度越权 spawn 被拒

- **WHEN** 判定上下文为 depth=1 的子代理再发起 spawn（成链深度 2）
- **THEN** 判定为 deny，拒绝体含 remediation 三字段，ref 指向 Control_Kernel §5

#### Scenario: 第 4 个并发 spawn 不放行

- **WHEN** 判定上下文活跃子代理数 = 3 时请求新 spawn
- **THEN** 判定结果非 allow（拒绝或排队语义），不产生第 4 个并发执行放行
