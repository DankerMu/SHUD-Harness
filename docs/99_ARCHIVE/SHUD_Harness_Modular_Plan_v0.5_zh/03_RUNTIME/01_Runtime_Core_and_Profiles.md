# R-01 Runtime Core、Agent Profiles 与 Context 装配

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：强参考
- **[R] 已实现可复用**：apps/server, apps/web, apps/supervisor, ToolRegistry, Session/trace, roles loader
- **[M] 需修改后复用**：agent profiles, context builder, state briefing, session semantics
- **[N] 必须新增**：ResearchState, EpisodeSpec, policy-aware context pack

## 1. Runtime Core 的职责
Runtime Core 不是科研判断者。它负责：
- session lifecycle
- episode lifecycle
- context assembly
- tool routing
- policy enforcement
- agent profile resolution
- trace / result collection

## 2. 推荐 package 划分
```text
runtime-core
runtime-tools
runtime-model
runtime-memory
runtime-observe
runtime-scheduler
runtime-supervisor
runtime-secrets

harness-domain
harness-versioning
harness-skill
harness-memory
harness-eval
harness-artifact
harness-executor
harness-benchmark
harness-governance

shud-domain
shud-runner
shud-metrics
shud-validation
shud-provenance
```

## 3. Agent Profiles
### 3.1 Commander
职责：
- 维护 active RCS
- 读取 state briefing
- 检索 memory / skills
- 决策下一步
- 派发 worker / critic
- 请求 gate

默认工具建议：
- read
- bash
- memory_search
- memory_read
- spawn_agent
- wait_agent
- request_human_gate
- submit_job
- watch_job
- collect_job
- commander应该有所有工具的权限是不是更好？

### 3.2 Worker
职责：
- 局部执行
- 代码改动
- 实验运行
- 报告生成
- proposal 草稿生成

默认工具建议：
- read
- write
- edit
- bash
- submit_job
- watch_job
- collect_job

### 3.3 Critic
职责：
- 审查设计与结论
- 审查兼容性与验证充分性
- 不直接做长期路线推进

默认工具建议：
- read
- bash
- memory_read

### 3.4 Harness Optimizer
职责：
- 读取 trace
- 汇总 recurring failure
- 提改 skill/context/observation normalizer
- 不直接动 scientific thresholds

## 4. State Briefing
State Briefing 是 Commander 每轮的统一入口摘要，建议固定包含：

```yaml
state_briefing:
  active_rcs:
  open_questions:
  active_hypotheses:
  latest_runs:
  latest_validation:
  pending_jobs:
  pending_human_gates:
  current_stacklock:
  relevant_datasets:
  unresolved_critic_issues:
  suggested_skills:
  budget_status:
```

## 5. Context Pack 分层
### 5.1 Always-on
- Research Constitution
- policy summary
- active RCS 摘要
- current budget

### 5.2 Dynamic retrieval
- relevant memory
- relevant skills
- recent validation deltas
- job status summary

### 5.3 On-demand attachments
- diff
- logs
- run manifests
- evidence packets
- compatibility reports

## 6. EpisodeSpec
EpisodeSpec 不是子任务标题，而是受控执行合同。  
推荐字段：
- linked_rcs
- objective
- allowed repos
- raw_data_mode
- scratch mode
- success criteria
- budget
- human gate triggers
- expected artifacts
- max jobs

## 7. 与 ZeRo 的映射
### [R] ZeRo 已有
- `apps/server` / `apps/web` / `apps/supervisor`
- ToolRegistry
- roles loader
- session / trace
- spawn / wait agent

### [M] SHUD-Harness 必须改
- `Explorer/Coder/Reviewer` → `Commander/Worker/Critic`
- `.zero/roles` → 可保留加载方式，但角色 prompt 必须重写
- 会话语义从 chat-centric 改为 RCS-centric
- context builder 必须加 state briefing 和 policy/evidence layers

### [N] 必须新增
- EpisodeSpec schema
- ResearchState aggregator
- context pack composer for SHUD scientific graph

## 8. V1 最低要求
- 至少三个 profile：Commander / Worker / Critic
- 每个 episode 都有 spec
- 每轮 Commander 都基于 state briefing 决策
- active RCS 是 session 的主键之一，而不是隐藏聊天上下文
