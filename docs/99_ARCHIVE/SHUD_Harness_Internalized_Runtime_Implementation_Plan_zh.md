# SHUD-Harness 内化式 Agent Runtime 建设与迁移方案

**版本**：v0.2 内化方案初稿  
**日期**：2026-04-20  
**定位**：长期技术路线文档 / Runtime 内化迁移方案 / SHUD-Harness 功能设计 PRD + 高层技术 Spec  
**适用对象**：SHUD-Harness 项目负责人、核心开发者、后续 Commander Agent / Worker Agent / Critic Agent / Harness Optimizer 的实现者  

---

## 0. 结论先行

SHUD-Harness 不应被设计成一个外部项目的插件，也不应被设计成若干固定工作流的自动化集合。它应该被建设为一个 **面向 SHUD 模型持续演化的科研建模 Agent Runtime**。

本方案采用 **内化式迁移**：开发上可以吸收既有 Agent Runtime 原型的工程结构与实现经验，但最终产物应是一个独立的 SHUD-Harness 系统。功能设计、模块命名、数据结构、技能体系、记忆体系、运行目录、控制台、科研对象模型都应围绕 SHUD/rSHUD/AutoSHUD 的长期优化重新定义。

最终系统的核心定义是：

```text
SHUD-Harness
  = Commander Agent 主控
  + Bash-first Sandbox 动作空间
  + Worker / Critic / Harness Optimizer Episode
  + Self-evolving Skill Library
  + Evidence-grounded Memory
  + SHUD Research Change Set
  + SHUD Run / Evidence / Validation / Benchmark Layer
  + Human Gate / Scientific Governance
```

最重要的设计判断是：

```text
Agent 是执行主体；
Harness 是 Agent 的运行时、沙箱、记忆、技能、观测、评价和治理环境；
Bash 是主要动作空间；
Skills 是可执行、可验证、可演化的程序化经验；
Memory 是证据约束的长期科研认知结构；
Human Gate 是科学判断和高风险工程变更的最终责任边界。
```

第一阶段明确不处理外部 AI 编码客户端接口，不改相关目录，不做跨外部编码客户端的 skills 同步。当前阶段只建设 SHUD-Harness 自身的独立 runtime、agent loop、skill governance、memory governance、episode sandbox 和 SHUD 科研闭环。

---

## 1. 建设目标

### 1.1 总目标

建设一个能够长期支持 SHUD 模型开发、实验、验证、诊断、代码演化和科研证据沉淀的 Agent Runtime，使 SHUD 的优化从“人手工组织实验和改代码”逐步演进为：

```text
学者提出问题
  → Commander Agent 建立研究变更集
  → Agent 设计实验与诊断路径
  → Worker Agent 在 bash sandbox 中执行模型、写脚手架、改代码
  → Critic Agent 审查证据和实现风险
  → Harness 记录 trace、artifact、memory、skill、validation
  → Commander Agent 决定下一轮实验、代码修改、人工审批或归档
  → 系统持续积累可复用技能和科研记忆
```

### 1.2 直接目标

第一阶段需要完成以下能力：

```text
1. Commander Agent 能作为主控持续推进 SHUD 研究任务。
2. Worker Agent 能在隔离 workspace 中通过 bash 执行模型运行、数据分析、代码修改和脚手架生成。
3. Critic Agent 能审查实验、代码、指标解释和验证充分性。
4. Harness Optimizer 能基于失败 trace 提出 skill、context、prompt、scaffold 的改进建议。
5. Skills 按严格格式组织，可被检索、加载、执行、验证、提升和废弃。
6. Memory 按工作记忆、情景记忆、语义记忆、程序记忆、证据记忆、元记忆分层治理。
7. 每次研究任务都能落成 Research Change Set，并形成实验、运行、证据、代码变更、验证报告的闭环。
8. 每个 episode 都有可追踪的 bash 命令、文件修改、artifact、评价结果和 memory proposal。
```

### 1.3 长期目标

长期目标不是简单“自动跑模型”，而是形成 SHUD 模型的 **科研演化操作系统**：

```text
- 能不断吸收历史实验经验；
- 能积累稳定的 SHUD 操作技能；
- 能对模型运行失败进行诊断；
- 能提出并实现跨 SHUD/rSHUD/AutoSHUD 的代码变更；
- 能用 benchmark 和水文证据约束模型改动；
- 能阻止 Agent 把单次指标提升误判为科学改进；
- 能在失败中改进自身 harness、skills、memory 和 context pack。
```

---

## 2. 设计原则

### 2.1 Commander-first

主控应是 Commander Agent，而不是一组固化工作流。科研建模过程中，实验设计、数据诊断、代码修改、验证、反思之间会频繁跳转，不能依赖预先写死的 DAG。

固定的是 agent loop，而不是具体步骤：

```text
Observe
  → Decide
  → Act
  → Observe Result
  → Evaluate
  → Reflect
  → Update Memory / Skills
  → Decide Next
```

Commander Agent 必须遵守科研宪法和高风险审批规则，但下一步行动由 Commander 根据当前状态、历史记忆、技能库、评价结果和用户目标自主决定。

### 2.2 Bash-first

工具层不应膨胀为几十个 typed tools。对于科研代码项目，bash + 代码编辑 + 脚手架生成已经覆盖大部分行动空间。

因此第一原则是：

```text
给 Agent 一个受控 bash sandbox，而不是一堆过度设计的工具 API。
```

Harness 的职责是：

```text
- 限制 bash 的权限；
- 记录 bash 的 trace；
- 捕获 bash 产生的 artifact；
- 归一化关键 observation；
- 阻止危险动作；
- 评价 bash 执行结果。
```

Agent 可以自己在 workspace 中生成脚手架，例如：

```text
.harness/scaffolds/run_tiny_case.sh
.harness/scaffolds/parse_solver_log.py
.harness/scaffolds/check_mass_balance.R
.harness/scaffolds/compare_hydrograph.py
```

如果某个脚手架多次有效，可以被提升为正式 skill。

### 2.3 Skills as Procedural Memory

Skill 不是普通提示词，而是 Agent 通过长期实践沉淀出来的程序化能力。它必须有严格格式、明确触发边界、明确输入输出、可选脚本、示例、验证方式和生命周期。

Skill 的生命周期：

```text
candidate scaffold
  → tested scaffold
  → promoted skill
  → canonical skill
  → deprecated skill
```

### 2.4 Memory as Evidence-grounded Cognition

Memory 不是聊天记录，也不是 Agent 可以随手写入的偏好文件。SHUD-Harness 的 memory 必须服务科研判断和模型演化。

长期 memory 必须分层：

```text
working memory      当前 episode 状态
episodic memory     历史 episode 和经验
semantic memory     SHUD 领域知识和代码地图
procedural memory   skills 和脚手架经验
epistemic memory    claim / evidence / counter-evidence / uncertainty / decision
meta memory         harness 自我改进经验
```

重要科研结论不得由 Agent 直接写成 verified。必须经过 evidence link、Critic 审查和 Commander/Human 审批。

### 2.5 Evidence before Model Change

任何模型结构、物理过程、默认参数、输入输出契约、benchmark 阈值的变更，必须先有证据包和工程设计说明。

不允许：

```text
- 没有 baseline 的性能声明；
- 没有水量平衡检查的模型改进声明；
- 单一流域指标提升直接泛化为模型改进；
- Agent 直接修改控制方程；
- Agent 直接覆盖 benchmark baseline；
- Agent 直接修改默认参数并提交为正式版本。
```

### 2.6 Runtime Ownership

开发可以吸收已有原型经验，但最终系统应由 SHUD-Harness 自身拥有以下核心能力：

```text
- Agent loop
- episode sandbox
- tool trace
- memory store
- skill registry
- sub-agent runtime
- observability
- scheduler
- supervisor
- Web console
- SHUD domain layer
- evidence layer
- validation layer
```

不把 SHUD-Harness 设计成外部 runtime 的临时插件。

---

## 3. 总体架构

### 3.1 高层结构

```text
Scholar / Researcher
        ↓
Commander Agent
        ↓
Research Constitution + State Briefing + Memory + Skills
        ↓
Decision
        ├── bash directly
        ├── spawn Worker episode
        ├── ask Critic episode
        ├── trigger Harness Optimizer
        └── request Human Gate
                ↓
Bash-first Sandbox
        ↓
SHUD / rSHUD / AutoSHUD / Data / Code / Scaffolds
        ↓
Observations + Traces + Artifacts
        ↓
Evaluators
        ↓
Memory Proposals + Skill Proposals + Evidence Updates
        ↓
Commander Next Decision
```

### 3.2 运行时分层

```text
apps/
  server/                 # Runtime API、session、episode、WebSocket、operator console backend
  web/                    # Operator console
  supervisor/             # Runtime 守护进程、heartbeat、restart

packages/
  runtime-core/           # Agent loop、episode、context、tool routing、policy、state
  runtime-tools/          # bash、read、write、edit、spawn、memory、schedule 等通用工具
  runtime-model/          # 模型 provider、router、fallback、model policy
  runtime-memory/         # 通用 memory store、retrieval、index
  runtime-observe/        # logs、metrics、trace、session state、episode state
  runtime-scheduler/      # 定时任务、周期性 benchmark、周期性 memory consolidation
  runtime-supervisor/     # heartbeat、自恢复、运行守护
  runtime-secrets/        # secrets、脱敏、运行时安全

  harness-domain/         # Research Change Set、ExperimentSpec、EvidencePacket、ChangeSpec
  harness-skill/          # skill loader、validator、promotion、deprecation
  harness-memory/         # evidence-gated memory、memory proposal、promotion workflow
  harness-eval/           # software/model/scientific evaluators
  harness-artifact/       # artifact manifest、checksum、provenance、run archive

  shud-domain/            # SHUDStack、Basin、Forcing、Project、RunManifest
  shud-runner/            # SHUD/rSHUD/AutoSHUD bash scaffold templates and adapters
  shud-metrics/           # NSE、KGE、PBIAS、水量平衡、solver health、event metrics
  shud-validation/        # benchmark suites、regression checks、compatibility checks
```

### 3.3 Runtime 状态目录

建议区分运行时状态和科研资产：

```text
.shud-harness/
  config/
  runtime/
    sessions/
    episodes/
    traces/
    heartbeat.json
  memory/
    working/
    episodic/
    semantic/
    procedural/
    epistemic/
    meta/
  skills/
    installed/
    registry.json
  memory-proposals/
  skill-proposals/

shud-workspace/
  repos/
    SHUD/
    rSHUD/
    AutoSHUD/
  data/
    raw/
    processed/
  rcs/
  experiments/
  runs/
  evidence/
  changes/
  artifacts/
  validation/
  warehouse/
```

`.shud-harness/` 面向 runtime，`shud-workspace/` 面向科研资产。前者可包含大量临时状态，后者应服务长期可追溯性。

---

## 4. Agent 设计

### 4.1 Commander Agent

Commander Agent 是主控 agent，负责长期维护一个或多个 Research Change Set。

职责：

```text
- 理解学者提出的科学问题；
- 创建和维护 Research Change Set；
- 选择下一步行动：实验、诊断、代码修改、验证、总结、人工审批；
- 检索 memory 和 skill；
- 分派 Worker episode；
- 调用 Critic episode；
- 根据评价结果反思并更新路线；
- 触发 Harness Optimizer 改进 skill、context、prompt 或 scaffold；
- 生成面向学者的阶段性报告。
```

Commander 的输入：

```text
- 用户目标；
- Research Constitution；
- State Briefing；
- memory retrieval；
- skill registry；
- active RCS；
- tool/action policy；
- latest observations；
- pending human gates。
```

Commander 的输出：

```text
- 下一步行动决策；
- Worker episode spec；
- Critic episode spec；
- bash action；
- memory proposal；
- skill proposal；
- human gate request；
- final report。
```

### 4.2 Worker Agent

Worker Agent 是短期执行 agent，由 Commander 派生。

典型任务：

```text
- 跑 SHUD tiny case；
- 调试一次失败运行；
- 编写或修改 bash scaffold；
- 实现一个跨仓库诊断输出变更；
- 检查 rSHUD round-trip；
- 运行 benchmark before/after；
- 生成 EvidencePacket 草稿。
```

Worker 的边界：

```text
- 不决定科学结论；
- 不直接修改长期 memory；
- 不直接修改 benchmark baseline；
- 不直接越过 human gate；
- 不把临时 scaffold 自动提升为 skill。
```

### 4.3 Critic Agent

Critic Agent 是审查者，负责挑战 Commander 和 Worker。

检查维度：

```text
- 实验设计是否能证伪假设；
- 指标解释是否过度；
- 是否考虑观测不确定性；
- 是否有数据泄漏；
- 是否只在单一流域过拟合；
- 代码修改是否破坏兼容性；
- benchmark 是否覆盖必要案例；
- 结论是否有证据链；
- 是否需要补充反例实验；
- 是否需要 human gate。
```

Critic 输出应是结构化审查：

```yaml
critic_result:
  status: pass | needs_revision | blocked
  major_issues:
    - ...
  minor_issues:
    - ...
  required_next_actions:
    - ...
  risk_level: low | medium | high
```

### 4.4 Harness Optimizer Agent

Harness Optimizer 不直接优化 SHUD 模型，而是优化 Agent 如何优化 SHUD。

输入：

```text
- 失败 episode traces；
- 成功 episode traces；
- skill 使用记录；
- memory retrieval 命中记录；
- Critic 审查结果；
- validation failure pattern；
- repeated human intervention pattern。
```

输出：

```text
- 改进某个 skill；
- 增加 scaffold；
- 修改 State Briefing 模板；
- 修改 Research Constitution 的提示表达；
- 增加新的 Critic checklist；
- 改进 observation summary；
- 提出 memory schema 调整；
- 提出新的 benchmark episode。
```

Harness Optimizer 的改动也必须经过验证，不允许直接改变科学阈值、benchmark 接受标准、默认参数或高风险 policy。

---

## 5. Agent Loop 与 Episode 机制

### 5.1 Commander 主循环

```python
while not commander_finished:
    state = build_state_briefing(active_rcs)
    memory = retrieve_relevant_memory(state)
    skills = retrieve_relevant_skills(state)
    policy = load_policy(active_rcs, current_risk)

    decision = commander.decide(
        state=state,
        memory=memory,
        skills=skills,
        policy=policy,
        constitution=research_constitution,
    )

    result = harness.execute(decision)
    evaluation = evaluator.evaluate(result)

    trace_store.append(decision, result, evaluation)
    memory_store.collect_proposals(result, evaluation)
    skill_store.collect_proposals(result, evaluation)

    if evaluation.requires_critic:
        spawn_critic_episode(...)

    if evaluation.requires_human_gate:
        request_human_gate(...)

    commander.reflect(result, evaluation)
```

固定的是循环协议，而不是具体科研路径。

### 5.2 EpisodeSpec

```yaml
episode_id: EP-2026-00042
agent: worker
linked_rcs: RCS-2026-001
objective: Add event-scale diagnostics for storm event analysis.

context:
  active_experiment: EXP-2026-004
  evidence_packet: EV-2026-004
  code_stack: STACK-2026-003
  relevant_skills:
    - add-shud-output-diagnostics
    - rshud-roundtrip-test
    - benchmark-before-after

workspace:
  root: shud-workspace/episodes/EP-2026-00042
  repos:
    - SHUD
    - rSHUD
    - AutoSHUD
  raw_data_mode: read_only
  scratch_mode: writable

budget:
  max_turns: 80
  max_wall_minutes: 180
  max_patch_files: 40

policy:
  allowed_actions:
    - bash
    - read
    - edit
    - spawn_critic
  human_gate_required:
    - change_physical_equation
    - change_default_parameter
    - change_output_contract
    - update_benchmark_baseline

success_criteria:
  - SHUD builds
  - rSHUD check passes
  - tiny event benchmark passes
  - old output compatibility passes
  - validation report generated
```

### 5.3 Episode 目录

```text
episodes/EP-2026-00042/
  context/
    state_briefing.md
    episode_spec.yaml
    relevant_memory.md
    relevant_skills.md
  worktrees/
    SHUD/
    rSHUD/
    AutoSHUD/
  scratch/
  scaffolds/
  traces/
    tool_calls.jsonl
    bash_commands.jsonl
    observations.jsonl
    file_diffs.jsonl
  artifacts/
  reports/
    worker_final.md
    validation_report.md
  proposals/
    memory_updates/
    skill_updates/
```

---

## 6. Bash-first Sandbox

### 6.1 原则

Bash 是主要动作空间，但不是裸 shell。

```text
Agent sees bash.
Harness governs bash.
```

Harness 必须提供：

```text
- isolated workspace；
- git worktree；
- read-only raw data；
- writable scratch；
- command timeout；
- resource limit；
- destructive command blocklist；
- human gate for dangerous actions；
- command trace；
- stdout/stderr capture；
- file diff capture；
- artifact registration；
- observation summarization。
```

### 6.2 Bash 工具接口

```yaml
tool: bash
input:
  command: string
  cwd: string
  timeout_seconds: number
  purpose: string

output:
  exit_code: number
  stdout_excerpt: string
  stderr_excerpt: string
  created_files:
    - path: string
  modified_files:
    - path: string
  artifacts:
    - artifact_id: string
  observation_summary: string
  risk_flags:
    - string
```

### 6.3 命令治理

禁止或需审批的命令类型：

```text
- 删除原始数据；
- 覆盖 benchmark baseline；
- 修改长期 memory canonical 文件；
- 修改发布版本标签；
- 大规模提交 HPC 任务；
- 修改默认参数；
- 修改物理过程实现；
- 修改输入输出契约。
```

允许的常规动作：

```text
- 查看文件；
- 生成临时脚手架；
- 跑 R/Python/C++ 测试；
- 编译 SHUD；
- 运行 tiny case；
- 解析日志；
- 生成报告；
- 在 episode worktree 中修改代码；
- 生成 patch bundle。
```

---

## 7. Skill 系统

### 7.1 Skill 定义

Skill 是可复用程序化能力，不是普通 prompt。它应被设计为 Agent 可检索、可加载、可执行、可验证、可修订的能力包。

### 7.2 严格格式

每个 skill 是一个目录，入口文件必须是 `SKILL.md`。`SKILL.md` 的 frontmatter 保持最小化，只放路由必需元数据：

```markdown
---
name: diagnose-shud-run-failure
description: Use when a SHUD run fails, stalls, produces solver anomalies, or emits nonphysical diagnostic signals. Do not use for normal benchmark comparison.
---

# Diagnose SHUD Run Failure

## Purpose
...

## When to use
...

## When not to use
...

## Procedure
...

## Expected outputs
...

## Validation
...
```

额外 metadata 不写入 `SKILL.md` frontmatter，而放入独立文件，避免破坏通用 skill loader 的能力边界：

```text
skills-src/diagnose-shud-run-failure/
  SKILL.md
  contract.yaml
  scripts/
    parse_solver_log.py
    inspect_forcing_window.R
  references/
    shud_log_patterns.md
  examples/
    cvode_failure_event_case.md
  tests/
    run_skill_smoke_test.sh
  changelog.md
```

### 7.3 Skill Contract

```yaml
skill_id: diagnose-shud-run-failure
version: 0.1.0

inputs:
  required:
    - shud_log
    - run_manifest
  optional:
    - solver_stats
    - forcing_timeseries
    - baseline_run

outputs:
  required:
    - failure_classification.yaml
    - recommended_next_actions.md

success_criteria:
  - failure_class is identified or explicitly marked unknown
  - evidence artifacts are linked
  - next action is testable

risk:
  level: medium
  human_gate_required_for:
    - changing_solver_tolerance
    - changing_default_parameters
    - modifying_physical_process_code
```

### 7.4 首批 Skills

第一阶段只建设 5 个 canonical skill：

```text
1. run-shud-tiny-case
2. diagnose-shud-run-failure
3. rshud-roundtrip-test
4. add-shud-output-diagnostics
5. benchmark-before-after
```

每个 skill 必须有：

```text
- SKILL.md
- contract.yaml
- scripts/ 可选但推荐
- examples/ 至少一个
- tests/ 至少一个 smoke test
- changelog.md
```

### 7.5 Skill 生命周期

```text
candidate
  → tested
  → promoted
  → canonical
  → deprecated
```

#### candidate

来自 Worker 在 episode 中创建的 scaffold。

#### tested

在至少一个 episode 中成功使用，并产生可追踪 artifact。

#### promoted

由 Commander 或 Harness Optimizer 提出，Critic 审查后进入 `skills-src/`。

#### canonical

经过多个固定 benchmark episode 验证，成为 Commander 默认检索技能。

#### deprecated

被更好的技能替代，或者发现容易诱导 Agent 犯错。

### 7.6 Skill Registry

```yaml
skills:
  - name: run-shud-tiny-case
    status: canonical
    version: 0.1.0
    last_validated: 2026-04-20
    success_rate: 0.92
    failure_modes:
      - missing_test_data
      - r_env_not_ready

  - name: diagnose-shud-run-failure
    status: promoted
    version: 0.1.0
    last_validated: 2026-04-20
    success_rate: null
```

---

## 8. Memory 系统

### 8.1 Memory 分层

```text
working memory
  当前 episode 工作状态，生命周期短。

episodic memory
  历史 episode、失败、修复、实验路径。

semantic memory
  SHUD 领域概念、变量、参数、代码地图、流域知识。

procedural memory
  skills、scaffolds、操作流程、经验化脚本。

epistemic memory
  claim、evidence、counter-evidence、uncertainty、decision。

meta memory
  harness 自我改进经验、context pack 效果、skill 触发质量。
```

### 8.2 Memory 写入机制

Agent 不允许直接写入 canonical memory。所有长期 memory 更新都必须走 proposal：

```text
Agent proposes memory update
  → evidence link required
  → Critic review
  → Commander approval
  → optional Human Gate
  → promoted to validated/canonical memory
```

### 8.3 Memory Proposal

```yaml
memory_proposal_id: MP-2026-00031
proposed_by: worker
linked_episode: EP-2026-00042
memory_type: episodic
status: proposed

claim: rSHUD old-output compatibility failed after adding diagnostics reader.

evidence:
  - artifact: validation_report_00042
  - artifact: old_output_test_log_00042

suggested_memory:
  title: Output diagnostics changes must include old-output fixture tests.
  content: When adding new SHUD diagnostics output, run rSHUD reader against old output fixtures before claiming compatibility.
  tags:
    - rshud
    - output-compatibility
    - diagnostics

critic_review:
  status: pending
```

### 8.4 Epistemic Memory

科研判断必须进入 epistemic memory，而不是普通 note。

```yaml
claim_id: CLM-2026-001
statement: Peak underestimation in semi-arid storm events appears more sensitive to hillslope routing than saturated hydraulic conductivity within tested ranges.
status: provisional

supported_by:
  - EXP-2026-004
  - EV-2026-004

weakened_by:
  - EXP-2026-006

uncertainty:
  discharge_observation: considered
  precipitation_spatial_uncertainty: partial
  parameter_equifinality: not_fully_considered

decision:
  action: add_event_diagnostics_before_physics_change
  approved_by: human_researcher
```

### 8.5 Meta Memory

```yaml
meta_memory_id: HM-2026-012
pattern: Engineering episodes repeatedly forget backward compatibility when extending output diagnostics.
observed_in:
  - EP-2026-0011
  - EP-2026-0027
  - EP-2026-0042
recommended_harness_change:
  - Add old-output compatibility checklist to add-shud-output-diagnostics skill.
  - Include old output fixture in default context pack.
  - Add automatic bash scaffold for rSHUD old-output reader test.
status: validated
```

---

## 9. SHUD 科研对象模型

### 9.1 Research Change Set

Research Change Set 是 SHUD-Harness 的核心科研对象。

```yaml
rcs_id: RCS-2026-001
title: Diagnose semi-arid storm peak underestimation
status: active

research_intent:
  question: Why does SHUD underestimate storm peaks in semi-arid basins while preserving total runoff volume?
  domain:
    - infiltration
    - hillslope routing
    - precipitation heterogeneity
    - river routing

hypotheses:
  - id: H1
    statement: Infiltration is too strong during high-intensity events.
  - id: H2
    statement: Hillslope routing is too slow.
  - id: H3
    statement: Precipitation spatial heterogeneity is underrepresented.

linked_experiments:
  - EXP-2026-004

linked_evidence:
  - EV-2026-004

linked_changes:
  - CHG-2026-003
```

### 9.2 ExperimentSpec

```yaml
experiment_id: EXP-2026-004
linked_rcs: RCS-2026-001
purpose: Test sensitivity of storm peak error to infiltration, hillslope routing, and precipitation resolution.

basins:
  - cache_creek
  - walnut_gulch

events:
  - id: storm_2008_02_14
    start: 2008-02-14T00:00:00
    end: 2008-02-17T00:00:00

treatments:
  - name: baseline
  - name: lower_ksat
    parameters:
      ksat_multiplier: 0.5
  - name: lower_hillslope_roughness
    parameters:
      mannings_n_multiplier: 0.7
  - name: high_resolution_precipitation

metrics:
  - peak_flow_error
  - peak_timing_error
  - event_runoff_coefficient
  - water_balance_residual
  - NSE
  - KGE

decision_rules:
  - Do not claim model improvement if metric delta is within observation uncertainty.
  - Reject infiltration-only explanation if peak error is insensitive to ksat perturbation.
```

### 9.3 SHUDStack

```yaml
stack_id: STACK-2026-003

components:
  shud:
    repo_path: shud-workspace/repos/SHUD
    commit: abc123
    build_profile: release

  rshud:
    repo_path: shud-workspace/repos/rSHUD
    commit: def456

  autoshud:
    repo_path: shud-workspace/repos/AutoSHUD
    commit: ghi789

runtime:
  container_image: shud-harness-runtime:2026-04-20
  os: linux
  r_version: 4.x
  compiler: gcc
```

### 9.4 RunManifest

```yaml
run_id: RUN-2026-004-0007
experiment_id: EXP-2026-004
stack_id: STACK-2026-003
status: success

inputs:
  project_dir: artifacts/project_cache_creek_baseline
  forcing_id: forcing_cache_creek_2008
  parameter_set: baseline

outputs:
  shud_output_dir: runs/RUN-2026-004-0007/output
  diagnostics: runs/RUN-2026-004-0007/diagnostics
  metrics: runs/RUN-2026-004-0007/metrics

numerical_health:
  cvode_failures: 0
  negative_state_count: 0
  water_balance_residual: 0.0008

resources:
  runtime_seconds: 2512
  memory_peak_mb: 1830
```

### 9.5 EvidencePacket

```yaml
evidence_id: EV-2026-004
linked_rcs: RCS-2026-001
linked_experiment: EXP-2026-004
status: provisional

main_findings:
  - Peak error is weakly sensitive to tested ksat perturbation.
  - Peak timing improves under reduced hillslope roughness.
  - High-resolution precipitation improves peak magnitude.

supporting_artifacts:
  - metrics_summary.parquet
  - hydrograph_comparison.png
  - event_water_balance.csv

limitations:
  - Only two semi-arid basins tested.
  - Precipitation uncertainty not fully quantified.
  - Event diagnostics insufficient to separate hillslope inflow from river attenuation.

recommended_next_actions:
  - Add event-scale diagnostics to SHUD output.
  - Add rSHUD reader for diagnostics.
  - Add AutoSHUD event analysis stage.
```

### 9.6 ChangeSpec

```yaml
change_id: CHG-2026-003
linked_evidence: EV-2026-004
intent: Add event-scale diagnostics across SHUD stack.

scope:
  shud:
    - write event flux diagnostics
    - preserve existing discharge output
  rshud:
    - read diagnostics files
    - compute event water balance
  autoshud:
    - add optional event_analysis stage

interface_impact:
  input_contract: unchanged
  output_contract: additive
  backward_compatible: true

validation_required:
  - build_shud
  - check_rshud
  - run_tiny_event_case
  - old_output_compatibility
  - mass_balance_audit
  - benchmark_before_after

human_gate:
  required_for:
    - output_contract_acceptance
```

---

## 10. Observability 与 Artifact 管理

### 10.1 Trace

每个 episode 必须记录：

```text
- agent decision；
- bash command；
- stdout/stderr excerpt；
- exit code；
- modified files；
- created artifacts；
- observations；
- evaluator result；
- memory proposals；
- skill proposals。
```

### 10.2 ArtifactManifest

```yaml
artifact_id: ART-2026-00093
type: shud_metrics
uri: shud-workspace/runs/RUN-2026-004-0007/metrics/metrics.parquet
sha256: ...
created_by:
  episode: EP-2026-00042
  command_id: CMD-2026-00221

inputs:
  - RUN-2026-004-0007
  - STACK-2026-003

provenance:
  command: python scripts/compute_metrics.py --run RUN-2026-004-0007
  cwd: episodes/EP-2026-00042/workspace
  environment_digest: ...
```

### 10.3 指标仓库

建议把结构化指标写入 Parquet/DuckDB 兼容格式：

```text
warehouse/
  run_index.parquet
  metrics.parquet
  water_balance.parquet
  solver_health.parquet
  event_metrics.parquet
  validation_results.parquet
```

Commander 和 Critic 可以通过 bash 写查询脚本，也可以由 scaffolds 生成分析报告。

---

## 11. Evaluation 体系

### 11.1 三层评价

```text
Software Evaluation
  - build
  - tests
  - static checks
  - package checks
  - old-output compatibility
  - schema / contract compatibility

Model Evaluation
  - NSE
  - KGE
  - RMSE
  - PBIAS
  - peak error
  - event runoff coefficient
  - water balance residual
  - solver failures
  - negative state count
  - runtime / memory

Scientific Evaluation
  - hypothesis support / weakening
  - uncertainty consideration
  - cross-basin robustness
  - overfitting risk
  - alternative explanation
  - claim strength
```

### 11.2 ValidationReport

```yaml
validation_id: VAL-2026-003
linked_change: CHG-2026-003
status: needs_revision

software:
  shud_build: pass
  rshud_check: pass
  old_output_compatibility: fail

model:
  tiny_event_case: pass
  mass_balance_audit: pass
  discharge_regression: pass

scientific:
  claim_strength: limited
  missing_checks:
    - runtime overhead
    - Cache Creek event benchmark

required_next_actions:
  - Add old-output fallback to rSHUD diagnostics reader.
  - Run benchmark-before-after on Cache Creek event case.
```

---

## 12. Web Console

Web Console 不是聊天界面，而是 operator console。

第一阶段页面：

```text
1. Commander Dashboard
   - active RCS
   - current state briefing
   - pending decisions
   - pending human gates

2. Episode Trace Viewer
   - bash commands
   - stdout/stderr
   - file diffs
   - artifacts
   - observations

3. Skill Registry
   - canonical skills
   - candidate scaffolds
   - promotion proposals
   - validation history

4. Memory Review
   - memory proposals
   - critic status
   - promote/reject actions

5. Validation Dashboard
   - latest validation reports
   - failed checks
   - benchmark deltas

6. Artifact Browser
   - runs
   - metrics
   - evidence packets
   - patch bundles
```

第二阶段再增加：

```text
- benchmark trend dashboard；
- claim/evidence graph；
- scheduler management；
- harness optimizer recommendations；
- multi-user review workflow。
```

---

## 13. 内化式迁移路线

### Phase 0：代码基线冻结与项目归属

目标：建立 SHUD-Harness 独立代码库和工程边界。

任务：

```text
1. 创建 SHUD-Harness runtime 仓库。
2. 导入基础 Agent Runtime 代码。
3. 固定初始 commit，记录来源、许可证和内部改造目标。
4. 建立新的 README、LICENSE、CONTRIBUTING、ARCHITECTURE。
5. 明确项目命名、包命名和目录边界。
6. 删除或隔离与 SHUD 无关的示例、channel、personal assistant 配置。
```

验收：

```text
- 可以本地安装依赖；
- 可以启动 server/web；
- 可以运行基础 agent loop；
- 可以执行 bash；
- 可以记录 trace；
- 项目名称和目录结构已经独立化。
```

### Phase 1：Runtime Core 重命名与所有权内化

目标：把通用 runtime 组件变成 SHUD-Harness 自有模块。

任务：

```text
1. 重命名核心 packages：runtime-core、runtime-tools、runtime-memory、runtime-observe 等。
2. 统一 TypeScript import path 和 workspace package name。
3. 清理通用 personal assistant 语义。
4. 引入 SHUD-Harness config schema。
5. 建立 runtime state 目录 `.shud-harness/`。
6. 保留 bash、read、write、edit、spawn、observe、memory、scheduler、supervisor 等核心能力。
```

验收：

```text
- bun install / test / typecheck / lint 全部通过；
- server 能启动；
- Web console 能打开；
- bash tool 能在隔离 workspace 执行；
- sub-agent episode 能创建和结束。
```

### Phase 2：Commander Agent Runtime

目标：让 Commander 成为主控，而不是固定 workflow。

任务：

```text
1. 新增 Commander system prompt。
2. 新增 Research Constitution。
3. 新增 State Briefing builder。
4. 新增 EpisodeSpec。
5. 新增 Worker/Critic/Harness Optimizer agent profiles。
6. 增加 commander decision trace。
7. 增加 request_human_gate action。
```

验收：

```text
Commander 能读取 state briefing；
Commander 能通过 bash 执行任务；
Commander 能 spawn Worker；
Commander 能请求 Critic；
Commander 能生成 memory proposal；
Commander 不会绕过高风险 human gate。
```

### Phase 3：Bash Sandbox 科研化

目标：把 bash 从通用 shell 变成科研建模 sandbox。

任务：

```text
1. 创建 episode workspace。
2. 支持 repo worktree。
3. 支持 raw data read-only mount。
4. 支持 scratch writable area。
5. 支持 resource limit 和 timeout。
6. 支持 command trace。
7. 支持 file diff trace。
8. 支持 artifact auto-registration。
9. 支持 destructive command policy。
```

验收：

```text
Worker 可以在 sandbox 中生成 scaffold；
Worker 可以修改 worktree 但不能修改 raw data；
所有 bash 命令被记录；
所有新 artifact 被注册；
危险命令被拦截或进入 human gate。
```

### Phase 4：SHUD Domain Layer

目标：引入 SHUD 科研对象模型。

任务：

```text
1. 实现 ResearchChangeSet。
2. 实现 ExperimentSpec。
3. 实现 SHUDStack。
4. 实现 RunManifest。
5. 实现 EvidencePacket。
6. 实现 ChangeSpec。
7. 实现 ValidationReport。
8. 建立 YAML schema 和 TypeScript type。
9. 增加 CLI/API 读写能力。
```

验收：

```text
Commander 可以创建 RCS；
Worker 可以创建 RunManifest；
Critic 可以读取 EvidencePacket；
ChangeSpec 能连接 evidence、patch 和 validation；
所有对象可 schema validate。
```

### Phase 5：Skills 正规化

目标：建立严格格式的 SHUD skill library。

任务：

```text
1. 创建 skills-src/。
2. 实现 skill validator。
3. 实现 skill registry。
4. 实现 skill lifecycle 状态。
5. 实现 scaffold-to-skill promotion proposal。
6. 编写首批 5 个 canonical skills。
7. 为每个 skill 添加 smoke test。
```

验收：

```text
SKILL.md frontmatter 只包含 name/description；
非法 skill 无法注册；
Commander 能检索相关 skill；
Worker 能使用 skill 中的 scripts；
Harness Optimizer 能提出 skill 改进；
Critic 能审查 skill promotion。
```

### Phase 6：Memory Governance

目标：把通用 memory 改造成 evidence-grounded memory。

任务：

```text
1. 实现 memory proposal。
2. 实现 working / episodic / semantic / procedural / epistemic / meta memory 分层。
3. 实现 memory review workflow。
4. 实现 evidence link requirement。
5. 实现 Commander/Critic promotion。
6. 禁止 agent 直接写 canonical memory。
```

验收：

```text
Agent 只能提出 memory proposal；
Critic 可以审查 proposal；
Commander 可以 promote/reject；
epistemic memory 必须有 evidence link；
技能使用经验能进入 procedural/meta memory。
```

### Phase 7：SHUD Tiny Loop

目标：跑通第一个完整闭环。

任务：

```text
1. 准备 tiny SHUD case fixture。
2. Commander 创建 RCS。
3. Worker 使用 run-shud-tiny-case skill 运行模型。
4. Worker 解析输出并生成 RunManifest。
5. Worker 生成 EvidencePacket 草稿。
6. Critic 审查证据。
7. Commander 生成下一步决策。
8. 生成 memory proposal 和 skill improvement proposal。
```

验收：

```text
完整 episode trace 存在；
RunManifest 存在；
EvidencePacket 存在；
CriticResult 存在；
MemoryProposal 存在；
Commander 能基于结果决定下一步。
```

### Phase 8：跨仓库代码变更闭环

目标：支持 SHUD/rSHUD/AutoSHUD 的代码改造。

任务：

```text
1. 生成 ChangeSpec。
2. 创建 SHUD/rSHUD/AutoSHUD worktree。
3. Worker 修改代码。
4. Worker 运行 build/check/benchmark。
5. 生成 patch bundle。
6. 生成 ValidationReport。
7. Critic 审查 patch 和 validation。
8. Commander 决定 accept/revise/reject/human gate。
```

验收：

```text
Patch bundle 可下载；
ValidationReport 可读；
old-output compatibility 被检查；
benchmark before/after 被记录；
高风险变更进入 human gate。
```

### Phase 9：Harness Optimizer

目标：让系统开始改进自身。

任务：

```text
1. 读取失败 episode traces。
2. 汇总 repeated failure pattern。
3. 提出 skill/context/scaffold 改进。
4. 在固定 benchmark episode 上验证。
5. 生成 HarnessImprovementProposal。
6. Commander/Critic 审查后合并。
```

验收：

```text
Harness Optimizer 至少能发现一种重复失败模式；
能提出可执行改进；
能通过对照 episode 验证改进有效；
不能绕过 human gate 修改高风险规则。
```

---

## 14. 第一阶段交付物

### 14.1 代码交付物

```text
- SHUD-Harness 独立 runtime 仓库
- runtime-core / runtime-tools / runtime-memory / runtime-observe
- Commander / Worker / Critic / Harness Optimizer profiles
- bash sandbox
- episode trace store
- skill validator
- memory proposal workflow
- SHUD domain schemas
- tiny SHUD case fixture
```

### 14.2 文档交付物

```text
- ARCHITECTURE.md
- RUNTIME.md
- COMMANDER_AGENT.md
- SKILL_SPEC.md
- MEMORY_SPEC.md
- SHUD_DOMAIN_SPEC.md
- SANDBOX_POLICY.md
- HUMAN_GATE_POLICY.md
- TINY_LOOP_RUNBOOK.md
```

### 14.3 Demo 交付物

```text
Demo 1: Commander 通过 bash 读取 workspace、创建 RCS、运行 tiny case。
Demo 2: Worker 生成 scaffold，解析 SHUD 输出，形成 RunManifest。
Demo 3: Critic 审查 EvidencePacket 并提出补充验证。
Demo 4: Worker 对 SHUD/rSHUD 做一个小型诊断输出变更，生成 patch bundle。
Demo 5: Harness Optimizer 从失败 trace 提出 skill 改进。
```

---

## 15. 风险与控制

### 15.1 Agent 过度自主风险

风险：Commander 或 Worker 越过科学边界，直接修改模型过程或默认参数。

控制：

```text
- Research Constitution；
- Human Gate；
- bash policy；
- high-risk file path guard；
- Critic review；
- validation matrix。
```

### 15.2 Memory 污染风险

风险：Agent 把错误判断写入长期 memory。

控制：

```text
- proposal-only 写入；
- evidence link；
- Critic review；
- Commander/Human promotion；
- memory status lifecycle。
```

### 15.3 Skill 退化风险

风险：技能格式不规范、触发边界模糊，导致模型误用。

控制：

```text
- 严格 SKILL.md 格式；
- frontmatter 最小化；
- contract.yaml；
- smoke tests；
- promotion/deprecation；
- success rate tracking。
```

### 15.4 Bash 安全风险

风险：bash 权限过大，导致误删数据、污染 baseline、破坏仓库。

控制：

```text
- read-only raw data；
- worktree isolation；
- destructive command blocklist；
- human gate；
- command trace；
- artifact checksum。
```

### 15.5 科学误判风险

风险：Agent 把一次指标提升解释为模型改进。

控制：

```text
- EvidencePacket；
- uncertainty checklist；
- cross-basin validation；
- Critic review；
- claim status: provisional/validated/rejected；
- Human Gate。
```

---

## 16. 12 周实施计划

### 第 1–2 周：Runtime 内化

```text
- 建立独立仓库；
- 重命名 runtime packages；
- 跑通 server/web/bash/sub-agent/trace；
- 建立 `.shud-harness/` runtime state；
- 编写基础架构文档。
```

### 第 3–4 周：Commander 与 Bash Sandbox

```text
- Commander profile；
- Research Constitution；
- EpisodeSpec；
- Worker/Critic profiles；
- bash sandbox；
- command/file/artifact trace；
- human gate 初版。
```

### 第 5–6 周：SHUD Domain Layer

```text
- RCS；
- ExperimentSpec；
- SHUDStack；
- RunManifest；
- EvidencePacket；
- ChangeSpec；
- ValidationReport；
- YAML schema / TS type。
```

### 第 7–8 周：Skills 与 Memory

```text
- skill validator；
- skills-src；
- 首批 5 个 skills；
- memory proposal；
- memory 分层；
- Critic review workflow。
```

### 第 9–10 周：Tiny Loop 与 Evidence Loop

```text
- tiny SHUD case；
- Commander 创建 RCS；
- Worker 运行模型；
- 生成 RunManifest；
- 生成 EvidencePacket；
- Critic 审查；
- Commander 下一步决策。
```

### 第 11–12 周：Code Change Loop 与 Harness Optimizer

```text
- ChangeSpec；
- worktree patch；
- validation report；
- patch bundle；
- Harness Optimizer 读取失败 trace；
- 提出并验证 skill/context/scaffold 改进。
```

---

## 17. 成功标准

第一阶段成功不是看功能菜单多少，而是看是否跑通以下闭环：

```text
Scholar question
  → Commander creates RCS
  → Worker runs SHUD tiny case through bash
  → Artifact and trace recorded
  → EvidencePacket generated
  → Critic reviews evidence
  → Commander decides next action
  → Worker modifies code in sandbox
  → ValidationReport generated
  → MemoryProposal and SkillProposal generated
  → Human Gate catches high-risk decisions
```

定量标准：

```text
- 100% episode 有 trace；
- 100% bash 命令有 exit code 和 stdout/stderr excerpt；
- 100% artifact 有 manifest；
- 100% 长期 memory 写入走 proposal；
- 100% skill 通过格式校验；
- tiny loop 可重复运行；
- 至少完成 1 个跨 SHUD/rSHUD/AutoSHUD 的小型代码变更闭环；
- 至少完成 1 次 Harness Optimizer 改进建议并验证。
```

---

## 18. 当前阶段明确不做

```text
- 不把系统做成固定 workflow 平台；
- 不建设十几个常驻 agent；
- 不把外部编码客户端接口作为第一阶段重点；
- 不做跨外部客户端的 skill 同步；
- 不直接自动修改物理方程；
- 不自动发布模型版本；
- 不让 Agent 直接写入 canonical scientific memory；
- 不把 Web Console 做成普通聊天产品；
- 不先做复杂 HPC 大规模校准平台。
```

---

## 19. 最终定位

SHUD-Harness 的长期价值不是“让 Agent 帮忙跑几个脚本”，而是把 SHUD 模型开发变成一个持续积累的科研智能系统：

```text
它会记得哪些实验做过；
它会记得哪些假设被削弱；
它会记得哪些代码修改导致退化；
它会沉淀可复用的 SHUD 操作技能；
它会把模型运行失败转化为诊断经验；
它会把成功的脚手架提升为正式 skill；
它会把证据、代码、验证和决策连接起来；
它会在一次次 episode 中优化自己的 harness。
```

一句话定义：

> **SHUD-Harness 是一个以 Commander Agent 为主控、以 bash sandbox 为主要动作空间、以严格 skill 和证据记忆为长期能力、以 Critic/Evaluator/Human Gate 为约束的 SHUD 科研建模 Agent Runtime。**

---

## 20. 致谢

本方案的 Agent Runtime 内化建设思路参考并感谢 [V1ki/zero](https://github.com/V1ki/zero) 项目提供的工程原型启发；SHUD-Harness 将在此基础上以内化后的独立系统形态持续演进。
