---
status: frozen
canonical_for: [agent-role-enum]
---

# 角色边界：PI 主导，Agent 协调执行

> **本文件是 Agent 角色集合的唯一权威定义（canonical source）。**
> 其他文档（CLAUDE.md、SPEC_v0.8_Final、Agent_Architecture、User_Session_And_Audit_Schema、Interaction_Model 等）出现的角色列表若与本文件冲突，以本文件为准。进入实现后，Zod/TS 的 role 枚举必须与 §0 一一对应。

## 0. Canonical Agent Role Registry

**角色成立判据：一个 Agent 角色成立，当且仅当它的工具/写权限剖面与其他角色不同。**
只是 prompt 措辞不同而权限相同的，是同一角色的任务画像（profile），不是新角色。

Agent 角色枚举：

```text
coordinator | repo_explorer | worker | coder | reviewer
```

| 角色 | 权限剖面 | 产出对象 |
|---|---|---|
| `coordinator` | 调度工具（spawn/wait agent、job submit、report build）；不直接改仓库源码 | TaskCard 计划、EvidenceReport 草稿 |
| `repo_explorer` | 只读：file read/search、git inspect、只读诊断命令；禁 write/edit、禁提交 RunJob | RepoContextBrief |
| `worker` | sandbox 命令执行 + artifact 写入（workspaces/artifacts/runs）；禁改仓库源码 | RunRecord、metrics、图表 |
| `coder` | scratch workspace 内 `repos/SHUD` 本地 clone 的 write/edit 与受控变更/构建工具；禁直接改 baseline 与主分支 | ChangeRequest、`patches/<change_id>.patch`、BuildRecord（M4 契约） |
| `reviewer` | 只读检查 + 确定性 verification_run；禁改写任何原始输出 | VerificationCase 的工程判定与 reviewer 字段（M4 契约） |

人类角色（不进 Agent 枚举）：**PI/Researcher**（科学判断）、**Data Support**（数据与 benchmark 维护）。

子代理工具剖面在 spawn 时**冻结**（对标 hermes-agent 吸收）：spawn 参数只能在角色 canonical
剖面基础上**删减**工具、不能增补；spawn 深度、并发上限与**剖面子集关系**（allowed_tools ⊆ canonical 剖面）
三项均由 kernel 硬校验（见 [Control_Kernel §5](Control_Kernel.md)，对抗审查 A03-4 补第三项）。
repo_explorer/reviewer 的"只读"由沙箱按角色执行模式强制（[Execution_Jobs_Runs §9.2.1](../03_SPEC/Execution_Jobs_Runs.md)），非 prompt 约定。

**明确不设的角色**（判据不满足，防止角色膨胀）：

- *Execution Worker / Analysis Worker*：两者权限剖面相同（sandbox 执行），是 `worker` 的两种任务画像，用 prompt profile 区分，不拆角色。
- *Memory Curator*：memory 写入对所有角色一律 proposal-only（draft），无独立权限剖面。整理 memory candidate 是 `coordinator` 的收尾职责。
- *Commander / Critic / Harness Optimizer*：v0.6 起已废弃。

## 1. 角色总览

| 角色 | 定位 | 是否做科学判断 |
|---|---|---|
| PI / Researcher | 科学负责人 | 是 |
| Coordinator Agent | 执行协调员 | 否 |
| Repo Explorer Agent | 仓库上下文探索者 | 否 |
| Worker Agent | 具体执行者（运行/解析/图表） | 否 |
| Coder Agent | 代码变更执行者（patch/ChangeRequest） | 否 |
| Reviewer Agent | 工程/证据完整性检查者 | 否 |
| Data Support | 数据与 benchmark 维护者 | 部分，限数据质量 |

## 2. PI / Researcher

PI 负责：

```text
- 提出科学问题；
- 设定假设或任务目标；
- 决定是否需要校准、敏感性分析、补数据或改代码；
- 判断 evidence report 是否足以支持某个科学结论；
- 批准高风险变更：物理过程、默认参数、I/O 破坏性变化、benchmark baseline。
```

PI 不需要每天盯 dashboard。系统应通过报告和明确的下一步选项服务 PI。

## 3. Coordinator Agent

v0.6 建议把 “Commander Agent” 在文档中改称 **Coordinator Agent**，避免暗示它拥有科研指挥权。

Coordinator 负责：

```text
- 根据 PI 输入创建 TaskCard；
- 把任务拆成可执行步骤；
- 选择是否直接 bash、提交 RunJob、派 Worker；
- 管理任务预算和状态；
- 收集产物，生成报告；
- 提出“建议下一步”，但不做最终科学判断。
```

> Coordinator 无直接 bash；角色工具清单的唯一代码来源为 [core role-tool-map](../../packages/dsh-shud-core/src/governance/role-tool-map.ts)。M3 清单与 inherited/local 分类见 [agent-presets 契约](../../openspec/specs/agent-presets/spec.md#requirement-role-tool-map-uses-mounted-names)：coordinator 派 worker 调用 shud_run，不直接提交运行；restrict 与 policy-gate 共用该清单。其余角色的后续画像不代表 M3 已挂载对应 preset。

Coordinator 不负责：

```text
- 自主定义科学问题；
- 自主设计关键实验并推进多轮科研路线；
- 断言假设被证伪或验证；
- 决定模型结构是否正确；
- 自动合并高风险代码变更。
```

## 4. Repo Explorer Agent

Repo Explorer 不是科研探索者，而是当前仓库、文档和调用链的只读调查员。

Repo Explorer 负责：

```text
- 回答“相关代码在哪里、入口是什么、调用链如何走”；
- 识别跨 SHUD / rSHUD / AutoSHUD 的接口影响面；
- 给出需要读取的文件、可能受影响的测试和推荐只读诊断命令；
- 将发现写成 RepoContextBrief，供 Coordinator、Coder、Reviewer 使用；
- 明确未知项，避免 Coordinator/Coder 基于猜测行动。
```

Repo Explorer 不负责：

```text
- 写文件或修改代码；
- 提交 RunJob 或执行长时间科学计算；
- 生成 patch、应用 patch 或更新 baseline；
- 判断水文假设是否成立；
- 将发现直接写为 verified memory。
```

推荐触发点：

```text
PI: 提出跨仓库/调试/代码变更任务
Coordinator: 分类为 code_change/debugging/cross_repo
Repo Explorer: 生成 RepoContextBrief
Coordinator: 基于 Brief 形成计划
Coder/Worker: 执行具体修改或运行
Reviewer: 检查输出是否覆盖 Brief 中的影响面
```

## 5. Worker Agent

Worker 是短期执行者，通常只活在一个 task 或 episode 内。

Worker 负责：

```text
- 运行 tiny case；
- 解析日志；
- 写脚本；
- 生成图表；
- 汇报失败原因。
```

Worker 不直接写长期 memory，不决定科学结论。代码修改与 patch 生成归 Coder（见 §6），Worker 无仓库源码写权限。

## 6. Coder Agent

Coder 是代码变更执行者，一般职责包括在任务隔离且独占的 runtime 工作副本中修改代码、编写或更新配套测试，不直接修改 source reference 或主分支。M4 工作范围具体限定在 scratch workspace 内 `repos/SHUD` 的独立本地 clone；不得用 `git worktree add` 写根 submodule 元数据，也不直接修改根 submodule。以下是已交付的 [M4 agent-presets](../../openspec/specs/agent-presets/spec.md) 实现契约（D15(4)/(8)，M4 范围裁剪、非放宽 baseline）。回放的五文件切片与 VerificationCase 不替代其它代码任务的配套测试职责。

M4 Coder 负责：

```text
- 先在干净、钉定 HEAD 的 repos/SHUD 上调用 shud_build 生成 base，再修改已跟踪源码；
- 调用 change_create：由工具观测 diff，写 patches/<change_id>.patch 与确定性分级的 ChangeRequest；
- 调用 change_submit，等待 PI 卡放行；未获放行停止回报，不自行重试或改写批准状态；
- 获批后调用 shud_build(change_id, rhs_openmp: true)，交由 worker 运行，coder 不运行 SHUD。
```

Coder 不负责：

```text
- 直接修改 baseline、主分支或默认参数（必须走 ChangeRequest + gate）；
- 决定变更是否被接受；
- 改写 tasks/stacks/provenance/reports/runs/changes/patches/verifications/builds/analyses 十个治理根；
- git commit 改变钉定 HEAD，或把未跟踪新文件、删除、重命名纳入本次切片；
- 在 M4 之外跳过高风险 implementation_mapping/bundle 路由；M4 的特定替代门见 Agent_Architecture §4.4a。
```

**semantic_level 声明不是自由填空**：Coder 的级别只是声明值，工具按 `max(声明值, 全部匹配的 path floor)` 派生；未匹配路径下限为 numerical_implementation，floor_categories 保留全部命中类别。M4 不采集 interface_impact，不生成 patch bundle 对象；Reviewer 调用 verification_run 把 reviewer_notes、reviewed_by、compatibility_verdict 写入 VerificationCase，不另建 review note。完整规则见 [Scientific_Change_Gating_Spec §1.1](../03_SPEC/Scientific_Change_Gating_Spec.md#11-分类的确定性下限semantic-level-floor)；agent 无降级权。

治理目录必须经对应领域工具写入，raw-guard 对模型 edit/write/shell 写治理根 deny；此 shell 保护是启发式而非沙箱强隔离，其局限与摘要复核见 [Workspace 约定](../03_SPEC/Workspace_Conventions.md#9-路径安全)。

### 6.1 Delegated coder 审批与运维边界

`shud-coder-approval` 按 [ADR-0013](../adr/implemented/0013-delegated-coder-approval.md) 的 PI 授权，仅在新 child 的 awaited 创建边界初始化一次：必须是 fresh/unseeded、当前 coder、精确 live parent 所拥有、无历史 turn，且唯一 child-owned policy 为 delegation-origin never。最终同步边界的 parent override/config 必须明确为 ask；缺服务、未知来源或 parent never 不推断为授权。此初始化不是 grant，不扩大 sandbox 或工具面；只有实际 answerer 的 allowed-once 才能放行一次操作，没有 answerer 或 rejected/cancelled/unavailable 均 fail closed。

初始化通知以 `shud-coder-approval` 标明 child policy sequence 与 live parent 的 ask 观察，不冒充 PI 点击或用户切换。恢复、clear/compact、角色切换、插件重载都不重新授权；已有持久 ask 保留，后来显式 never 优先。移除插件只停止未来初始化，不迁移或重写历史策略；运维要关闭既有会话审批，应使用宿主现有的显式 policy 控制，而不是手改 canonical log。

审批请求属于 coder child 会话；需要在相应 child 视图处理，不能以 root 视图没有卡片推断没有请求。工程 WebSocket owner answerer 与 canonical asked/decided/result 关联只证明传输和工程决定，不证明浏览器展示、真人点击、科学正确性或 #549 的 PI 功能验收。按 PI 的[第二次上下文归属决定](https://github.com/DankerMu/SHUD-Harness/issues/614#issuecomment-6649912974)，SHUD 仅提供政策无关的固定委派/sandbox 说明：宿主政策允许请求时，才需要实际 answerer 与 allowed-once；不重复声明当前 ask/never 或当前角色。宿主 `approval:policy` 独占当前值，并在模型准入时刷新；已完成的同一 assembly 即使跨插件卸载/重载也保留真实的静态边界，不依赖 SHUD 动态 provider、原文缓存或取消在途准备。never 仍实际拒绝，sandbox 限制与业务写入规则不变。

Presets 的 host-only projection schema 单独钉 `zod` 4.4.3，以匹配钉版公开 `dsh-session-projection` 的 schema 类型；root/core/domain schemas 仍为 4.6.7，没有领域 schema 降级或 host 升级。安装沿用锁文件和 `autoInstallPeers: false`；既有 host peer-closure 缺口不是静默安装 peer 或放宽依赖检查的授权。完整工程闸与 PI 验收状态由关联 issue/PR 记录，本节不宣称全部检查或 PI 已通过。


## 7. Reviewer Agent

Reviewer 不是 “科学 Critic”。v0.6 中它只做两类检查：

### A. 工程检查

```text
- 是否跑了指定 benchmark；
- patch 是否越界；
- 是否破坏旧输出；
- 日志和产物是否完整；
- 是否遗漏 StackLock / DataProvenance。
```

### B. 报告完整性检查

```text
- 是否明确 baseline；
- 是否列出 uncertainty；
- 是否把“观察”误写成“结论”；
- 是否有让 PI 判断的开放问题。
```

Reviewer 不判断”水文机制是否成立”。

### C. Derivation Reviewer responsibility

Reviewer 可检查：
- symbol/unit/dimension 是否完整；
- derivation steps 是否跳步；
- numerical scheme 是否列出 conservation/stability expectation；
- implementation mapping 是否覆盖 equation_id 和 code target；
- verification cases 是否覆盖关键风险；
- verification case 的 expected_result_source 与 pass_criteria 可求值性（见 [Verification_Case_Spec §4.1](../03_SPEC/Verification_Case_Spec.md)）。

Reviewer 不替代 PI 判断科学假设是否成立。

**数学正确性职权声明（AGA-P1-2）**：Reviewer 对推导做**形式与合理性检查**（量纲一致、步骤连贯、可疑步骤标注），
但 `reviewed` 状态**不构成推导数学/物理正确的担保**——LLM Reviewer 与推导生成者共享同类盲区。
推导正确性的最终担保人是 PI：高风险 bundle 的 PI gate 即包含对推导链的人工审查，
报告中引用推导结论时 evidence_level 最高标注为 `llm_summary`，直至 PI 确认后才可升为 `pi_confirmed`。

### D. Agent restrictions

Agent 不得：
- 将自己生成的 TheoryToCodeBundle 标记为 accepted；
- 将 calibration improvement 写成 theory validation；
- 修改 physical equation 后绕过 PI gate；
- 删除失败 verification 证据。

## 8. 人机协作闭环

推荐闭环：

```text
PI: 提出任务 / 选择路线
Coordinator: 建 TaskCard + 执行计划
Repo Explorer: 补齐仓库上下文和影响面（按需）
Worker/Coder/Job: 跑模型 / 改代码 / 产出报告
Reviewer: 检查工程和报告完整性
PI: 接受、修改、继续、终止
```

这比 “LLM Commander 自主科研” 更可信，也更符合小团队使用方式。
