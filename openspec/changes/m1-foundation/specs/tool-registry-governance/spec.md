# tool-registry-governance

工具面治理：role→tool_id canonical 映射表、注册期 lint、guard_class 标注、spawn depth/并发硬校验——与中央策略门同一横切点。权威源：[Roles_and_Boundaries §0](../../../../../docs/02_ARCHITECTURE/Roles_and_Boundaries.md)（权限类别）、[Control_Kernel §5/§5.2/§5.3](../../../../../docs/02_ARCHITECTURE/Control_Kernel.md)（spawn 硬校验、guard_class 与工具面治理约定）、[Zero_Reuse_Matrix §10](../../../../../docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md)（工具注册命名空间）、[ADR-0002](../../../../../docs/adr/0002-mvp-reality-anchoring.md)（M1 开工三决②工具面定案）。

## ADDED Requirements

### Requirement: role→tool_id canonical 映射表

`packages/core` SHALL 提供常量形式的 role→tool_id 映射表：canonical 角色枚举（coordinator | repo_explorer | worker | coder | reviewer）每个角色映射到具体工具 id 集合（zero 原生 + 领域工具，id 以注册名为准）。本表是 Roles_and_Boundaries §0 权限类别散文的唯一具象化落点，也是 policy-gate-spike 条 3 子集校验的比对基准。各角色工具面已经 M1 grill PI 确认（[GRILL-2] 定案 2026-07-03）。

映射表的可比较字段 MUST 只包含 exact `toolIds`。说明性能力边界（例如 `harness.memory.propose` 只能 draft/proposal-only、artifact 写入只限 workspace、git/search 只读）记录在 `permissionNotes`，MUST NOT 作为 tool id 参与 spawn `allowed_tools` 子集比较。基准如下（工具 id 以注册名为准：zero 原生工具用 zero 当前注册名，领域/SHUD-Harness 工具用点分注册名；后续里程碑才交付的领域工具以注册名预先入表）：

| 角色 | `toolIds`（exact、排序后快照） | `permissionNotes` | 明确排除 |
|---|---|---|---|
| coordinator | `harness.job.collect`, `harness.job.submit`, `harness.memory.propose`, `harness.report.generate`, `read`, `spawn_agent`, `wait_agent` | `harness.memory.propose` 仅 draft/proposal-only；`read` 仅用于调度所需上下文读取；raw Zero `memory` 不授权 | `bash`, `write`, `edit`, `patch.apply`, `memory` |
| repo_explorer | `git.inspect`, `read`, `repo.glob`, `repo.grep`, `repo.search` | git/search/glob/grep 均为只读诊断 | 一切写、spawn/job |
| worker | `artifact.write`, `harness.memory.propose`, `read`, `rshud.compute_metrics`, `rshud.read_output`, `sandbox.exec`, `shud.build`, `shud.run` | `artifact.write` 仅限 `workspaces/artifacts/runs`；`harness.memory.propose` 仅 draft/proposal-only；`sandbox.exec` 是 sandbox bash，不是仓库源码编辑；raw Zero `memory` 不授权 | 仓库源码写、`memory` |
| coder | `bash`, `edit`, `harness.memory.propose`, `patch.apply`, `read`, `write` | `bash`/`write`/`edit`/`patch.apply` 仅限 worktree；`harness.memory.propose` 仅 draft/proposal-only；raw Zero `memory` 不授权 | baseline/主分支写、spawn/job、`memory` |
| reviewer | `harness.memory.propose`, `read`, `validator.run` | `validator.run` 为确定性只读 validator；`harness.memory.propose` 仅 draft/proposal-only；raw Zero `memory` 不授权 | 一切写、`memory` |

工具 id 命名裁决：zero 当前原生工具以 zero 注册名为准（本 issue 用到的 exact ids：`spawn_agent`, `wait_agent`, `read`, `write`, `edit`, `bash`）。SHUD-Harness 领域/治理工具 id 一律用点分注册名：`harness.job.submit`, `harness.job.collect`, `harness.memory.propose`, `harness.report.generate`, `git.inspect`, `repo.search`, `repo.glob`, `repo.grep`, `artifact.write`, `sandbox.exec`, `shud.build`, `shud.run`, `rshud.read_output`, `rshud.compute_metrics`, `patch.apply`, `validator.run`。Zero_Reuse_Matrix §4 与 Repository_Layout §1 的连字符写法（`shud-build.ts` 等）是实现文件名，不是工具注册名。`harness.memory.propose` 是 M4 记忆封装前预留的未来 adapter 注册 id / proposal-only 占位，不是 raw Zero `memory`。raw Zero `memory` 在 M1 可比较 `toolIds` 中显式排除，直到 M4 通过 wrapper/adapter 收窄 create/update/delete/status 语义后再重新评估。

快照 oracle MUST 为以下精确排序数组（实现可保留 `permissionNotes`，但快照至少覆盖 `toolIds`）：

```json
{
  "coordinator": ["harness.job.collect", "harness.job.submit", "harness.memory.propose", "harness.report.generate", "read", "spawn_agent", "wait_agent"],
  "repo_explorer": ["git.inspect", "read", "repo.glob", "repo.grep", "repo.search"],
  "worker": ["artifact.write", "harness.memory.propose", "read", "rshud.compute_metrics", "rshud.read_output", "sandbox.exec", "shud.build", "shud.run"],
  "coder": ["bash", "edit", "harness.memory.propose", "patch.apply", "read", "write"],
  "reviewer": ["harness.memory.propose", "read", "validator.run"]
}
```

冻结冲突裁决（本 change 显式记录）：[Roles_and_Boundaries §3](../../../../../docs/02_ARCHITECTURE/Roles_and_Boundaries.md) 散文「选择是否直接 bash、提交 RunJob、派 Worker」中的「直接 bash」已被 [ADR-0002](../../../../../docs/adr/0002-mvp-reality-anchoring.md) M1 开工三决②定案取代（2026-07-03 grill：coordinator 调度面含 file_read **无 bash**）——coordinator 的短命令执行一律经 spawn worker / 提交 RunJob。优先级：Roles_and_Boundaries §0 权限剖面 + ADR-0002 定案 + 本映射表 > §3 散文；§3 修订注按账本冻结例外流程另行补记（同 Config_Secrets §4 批次 4 做法，待办已列 proposal Impact），本 change 不改冻结正文。

#### Scenario: 五角色全覆盖

- **WHEN** 加载映射表常量
- **THEN** 恰好包含 canonical 枚举的 5 个角色，无缺失、无额外角色

### Requirement: 映射表语义不变式

映射表 SHALL 满足并以单测断言以下不变式：repo_explorer 与 reviewer 的集合不含任何写类工具 id（`write`, `edit`, `patch.apply`, `artifact.write`, `sandbox.exec`, `bash`）；worker 的集合不含仓库源码编辑工具（`write`, `edit`, `patch.apply`）；仅 coordinator 含 spawn/wait 类调度工具（`spawn_agent`, `wait_agent`）；coordinator 的集合不含 `bash`, `write`, `edit`, `patch.apply`（ADR-0002 开工三决②）；coder 是唯一含 worktree 编辑与 patch 工具的角色（`write`, `edit`, `patch.apply`）。`harness.memory.propose` 在 M1 仅代表未来 proposal-only draft 记忆 adapter 占位，不计入写类工具 id；raw Zero `memory` MUST NOT 出现在任一角色可比较 `toolIds` 中。

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
