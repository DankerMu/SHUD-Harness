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
| `coder` | worktree 内 write/edit + patch 工具；禁直接改 baseline 与主分支 | ChangeRequest、patch bundle |
| `reviewer` | 只读 + 调用确定性 validator；禁改写任何原始输出 | review note、检查结果 |

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

> **修订注（2026-07-16，例外批次 7）**：上列「选择是否直接 bash」已被 ADR-0002 开工三决②取代——
> coordinator **无直接 bash**；其可用工具面以 tool-registry-governance 的 role→tool_id canonical
> 映射表为唯一权威（该 spec 已显式声明优先级）。本句保留仅作历史记录。

Coordinator 不负责：

```text
- 自主定义科学问题；
- 自主设计关键实验并推进多轮科研路线；
- 断言假设被证伪或验证；
- 决定模型结构是否正确；
- 自动合并高风险代码变更。
```

## 4. Repo Explorer Agent

Repo Explorer 是 Zero Explorer 角色在 SHUD-Harness 中的受限映射。它不是科研探索者，而是当前仓库、文档和调用链的只读调查员。

Repo Explorer 负责：

```text
- 回答“相关代码在哪里、入口是什么、调用链如何走”；
- 识别跨 SHUD / rSHUD / AutoSHUD / Zero 的接口影响面；
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

Coder 是代码变更的唯一执行者，工作范围限定在 task worktree 内。

Coder 负责：

```text
- 在 worktree 中修改 SHUD / rSHUD / AutoSHUD / Harness 代码；
- 生成 patch bundle 和 diff 摘要；
- 编写或更新配套测试；
- 把变更落入 ChangeRequest（含 semantic_level 与 interface_impact）。
```

Coder 不负责：

```text
- 直接修改 baseline、主分支或默认参数（必须走 ChangeRequest + gate）；
- 决定变更是否被接受；
- 在 implementation_mapping 起草前修改高风险科学语义代码（见 Agent_Architecture §4.4a）。
```

**semantic_level 声明不是自由填空**：Coder 填写的级别只是声明值，harness 按
`max(声明值, path floor)` 求 effective_level（见 [Scientific_Change_Gating_Spec](../03_SPEC/Scientific_Change_Gating_Spec.md) §1.1），
Reviewer validator 交叉核对 files_changed。Coder 无降级权，降级豁免仅 PI/工程师可做。

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
