# Agent 架构

**状态：** P0 设计规范  
**适用范围：** Coordinator、Repo Explorer、Worker、Coder、Reviewer、PI gate、Zero AgentLoop 扩展
**目标：** 将 v0.8 的“PI-led scientific research engineering assistant”落实为可实现的 Agent 实例模型和通信规则。

## 1. 架构原则

SHUD-Harness 的 Agent 架构不是开放式多 Agent 自主系统，而是受 TaskCard 状态机约束的科研工程协作系统。核心原则如下：

1. **Coordinator 单点编排。** 同一 TaskCard 在同一时刻只有一个 Coordinator 拥有调度权。
2. **Repo Explorer 只读探索。** Repo Explorer 可以读取源码、文档、git 历史和运行只读诊断命令，为 Coordinator/Coder 提供上下文，不修改文件、不提交 RunJob。
3. **Worker 不做科学裁决。** Worker 可以运行命令、解析日志、计算指标和生成 artifact，但不能判断某个水文假设是否成立。
4. **Coder 只处理代码变更。** Coder 的输出必须落入 ChangeRequest、patch bundle 或 diff review，不允许直接修改 baseline。
5. **Reviewer 审查完整性，不替代 PI。** Reviewer 检查复盘链、报告语言、schema、artifact 和风险标注，不批准科学结论。
6. **PI gate 是硬边界。** 物理方程、默认参数、benchmark baseline、validated 状态和破坏性数据操作必须等待 PI 或授权用户确认。

## 2. Agent 角色

| 角色 | 主要职责 | 不允许做的事 |
|---|---|---|
| Coordinator | 解析 brief，创建计划，选择工具和子角色，决定 park/resume，生成 PI 问题 | 伪造证据，跳过审批，自动宣称科学结论 |
| Repo Explorer | 探索当前仓库、定位入口/调用链/测试命令/影响面，生成 RepoContextBrief | 写文件，改代码，提交 RunJob，裁定科学结论，写入 verified memory |
| Execution Worker | 编译、运行、监控作业、收集日志、生成 RunRecord | 修改模型源码，改变科学假设 |
| Analysis Worker | 调用 rSHUD/脚本计算指标，生成 deterministic figures 和 summary tables | 把 calibration 改进解释成模型结构验证 |
| Coder | 生成 patch、接口迁移、测试、diff 摘要 | 未审批直接改 baseline 或默认参数 |
| Reviewer | 审查 RunRecord、EvidenceReport、ChangeRequest 是否完整 | 替 PI 接受结论或覆盖 benchmark |
| Memory Curator | 将可保存的信息转为 memory candidate | 自动把 evidence 标记为 verified |

## 3. Agent 实例模型

每个 Agent 实例应至少包含以下上下文：

```yaml
agent_instance:
  id: agent_01J...
  role: coordinator | repo_explorer | execution_worker | analysis_worker | coder | reviewer | memory_curator
  task_id: TASK-...
  session_id: SESSION-...
  workspace_id: WS-...
  parent_agent_id: null
  status: idle | running | waiting_tool | parked | completed | failed
  created_at: 2026-04-24T00:00:00-04:00
  last_active_at: 2026-04-24T00:05:00-04:00
```

Agent 实例不是长期人格，也不是可跨项目自由迁移的实体。长期知识必须通过 ResearchContext、StackLock、DataProvenance、RunRecord、EvidenceReport 和 Memory Candidate 进入系统。

## 4. Coordinator 决策流

Coordinator 的运行分为六个阶段：

```text
Brief
→ Classify
→ Explore (optional)
→ Plan
→ Dispatch
→ Collect/Review
→ Report/Ask PI
```

### 4.1 Brief

输入：用户消息、TaskCard、当前 ResearchContext、可用 StackLock、DataProvenance、最近 RunRecord、PI notes。  
输出：归一化任务摘要、缺失信息列表、风险标签。

### 4.2 Classify

任务类型建议使用：

```text
engineering
science_assist
ops
code_change
debugging
sensitivity
calibration
benchmark
reporting
```

分类结果只用于选择流程模板，不应作为权限依据。权限仍由 Auth/Permission 规范决定。

### 4.3 Explore (optional)

Coordinator 在以下场景应先派发 Repo Explorer，再进入 Plan 或 Coder：

- 任务涉及跨仓库影响面，尤其是 SHUD/rSHUD/AutoSHUD/Zero 之间的接口变更；
- 任务类型为 `code_change`、`debugging`，且入口文件、调用链或测试命令不明确；
- 最近一次 Worker/Coder 失败原因指向“上下文不足”或“改动范围误判”；
- 需要确认实际代码与 docs/spec 是否一致。

Repo Explorer 的输出必须写入 task artifact，建议路径：

```text
workspace/tasks/TASK-*/artifacts/repo_context/BRIEF-*.yaml
```

最低输出契约：

```yaml
repo_context_brief:
  brief_id: BRIEF-001
  task_id: TASK-001
  repos:
    - SHUD
    - rSHUD
  inspected_refs:
    - path: SHUD/src/...
      reason: "solver entrypoint"
  entrypoints:
    - repo: SHUD
      path: src/...
      symbol: "main"
  impact_surface:
    - repo: rSHUD
      path: R/read_output.R
      risk: "output schema coupling"
  recommended_test_commands:
    - "make shud"
    - "Rscript scripts/rshud-roundtrip.R"
  risks:
    - "binary output format changes require PI gate if breaking"
  unknowns:
    - "tiny fixture acceptance threshold not yet specified"
```

RepoContextBrief 是工程上下文，不是科学证据。EvidenceReport 可以引用它解释“为什么选择这些文件/测试”，但不能把它作为模型结论依据。

### 4.4 Plan

计划必须写入 TaskCard 或 `plan.md`，包含：

- 目标；
- 输入数据和依赖；
- 预计使用的工具；
- 是否需要 SHUD/rSHUD/AutoSHUD/Zero；
- 是否会产生 RunJob；
- 是否可能触发 PI gate；
- 预期 artifact；
- 停止条件。

### 4.5 Dispatch

Coordinator 根据计划派发 Worker。短任务可以同步执行，长任务必须转换成 RunJob 并进入 Park/Resume 流程。

### 4.6 Collect/Review

执行完成后，Coordinator 只读取结构化输出：RunRecord、metrics、logs summary、artifact manifest、patch bundle。不得依赖未记录的终端输出作为证据。

### 4.7 Report/Ask PI

Coordinator 生成 EvidenceReport 草稿，并明确列出：

- 本次运行事实；
- 指标；
- 图表；
- 限制；
- 需要 PI 判断的问题；
- 建议下一步。

## 5. Agent 间通信

Agent 间通信不使用自由文本互相聊天，而使用结构化事件：

```yaml
event:
  type: agent.message
  task_id: TASK-...
  session_id: SESSION-...
  from_role: coordinator
  to_role: execution_worker
  visibility: internal | user_visible
  content:
    summary: "运行 ccw tiny fixture"
    instructions: "编译 SHUD，运行 30 天，收集日志和 water balance。"
    expected_outputs:
      - run_record
      - metrics_yaml
      - log_summary
```

所有用户可见内容应通过 WebSocket 推送到 AgentActivityFeed；内部操作可以记录在 session log 中，但仍需可审计。

## 6. 工具调用规则

工具调用必须绑定 TaskCard 和 workspace：

```yaml
tool_call:
  id: TOOLCALL-...
  task_id: TASK-...
  agent_id: agent_...
  tool_name: sandbox.exec
  cwd: workspace/runs/RUN-...
  command_digest: sha256:...
  started_at: ...
  completed_at: ...
  result_ref: artifacts/toolcalls/TOOLCALL-....json
```

禁止未绑定 workspace 的命令执行。禁止使用绝对路径修改仓库外文件，除非该路径在 workspace policy 中显式允许。

## 7. Closure 判据

TaskCard 不能仅因为 LLM 认为“完成了”而关闭。完成需要满足类型对应的 closure 判据。

| 任务类型 | 最低 closure 条件 |
|---|---|
| engineering | 产生目标 artifact 或明确失败报告；日志和命令可追溯 |
| science_assist | EvidenceReport 包含指标、限制、PI questions |
| debugging | 复现条件、根因候选、修复或下一步排查均已记录 |
| sensitivity | AnalysisPlan 中定义的运行集已完成或失败项已解释 |
| calibration | 参数空间、目标函数、训练/验证窗口和结果限制已记录 |
| benchmark | baseline、candidate、指标、环境、差异摘要完整 |
| code_change | ChangeRequest、patch、测试结果、review note 完整 |

## 8. 并发规则

1. 同一 TaskCard 只能有一个 active Coordinator。
2. Repo Explorer 可以与 Coordinator planning 并行，但只能读 source/runtime repo 和 task artifact。
3. 同一 workspace 可并行多个 RunJob，但不得共享同一 run directory。
4. 代码变更任务必须独占对应 worktree。
5. sensitivity batch 可并发，但每个 parameter set 必须独立 RunRecord。
6. Reviewer 可以并行审查多个已完成 artifact，但不能改写原始输出。

## 9. 失败处理

Agent 失败应转为结构化错误，而不是隐藏在对话中：

```yaml
agent_failure:
  agent_id: agent_...
  role: execution_worker
  task_id: TASK-...
  severity: warn | error | critical
  reason: "SHUD 编译失败"
  evidence_refs:
    - artifacts/logs/build.stderr
  recommended_next_action: "检查 SUNDIALS 版本和 include path"
```

Coordinator 收到 Worker 失败后，可以进行一次低风险重试；若重试需要改变依赖、参数或源码，必须进入 PI gate 或 ChangeRequest。

## 10. 验收标准

- [ ] 每个 Agent 事件都绑定 `task_id` 和 `session_id`。
- [ ] Coordinator 的计划可以从磁盘恢复。
- [ ] 跨仓库 code_change/debugging 任务在进入 Coder 前生成 RepoContextBrief，或在 plan 中说明跳过原因。
- [ ] Worker 输出只能通过 RunRecord、metrics、artifact manifest 或 patch bundle 被报告引用。
- [ ] Reviewer 可以发现缺失 StackLock/DataProvenance/RunRecord 的报告。
- [ ] PI gate 动作不能被 Worker 或 Reviewer 自动批准。
