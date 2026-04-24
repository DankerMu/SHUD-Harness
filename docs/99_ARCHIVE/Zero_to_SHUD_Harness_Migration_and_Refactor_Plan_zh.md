# 基于 V1ki/zero 二次开发 SHUD-Harness 的迁移与改造方案

**版本**：v0.1 初稿  
**日期**：2026-04-19  
**定位**：长期技术路线文档 / 迁移蓝图 / 二次开发 PRD + 架构改造 Spec  
**适用对象**：SHUD-Harness 项目负责人、核心开发者、后续 Commander Agent / Worker Agent / Critic Agent 的实现者  

---

## 0. 结论先行

建议以 [`V1ki/zero`](https://github.com/V1ki/zero) 为原型进行二次开发，但不是把 SHUD-Harness 做成几个 prompt 或几个插件，而是将 Zero fork 成一个 **SHUD 专用科研建模 Agent Runtime**。

目标系统可以暂定名为：

```text
zero-shud
```

它的定位是：

```text
zero-shud
  = Zero OS agent runtime base
  + SHUD Commander Agent
  + bash-first scientific sandbox
  + evidence-grounded memory
  + self-evolving SHUD skill library
  + SHUD run / evidence / validation / benchmark layer
  + Harness Optimizer meta-loop
```

最重要的边界是：

> **第一阶段不改 Claude Code / Codex 接口，不改 `.claude/`、`.codex/` 的集成路径，不做跨 Claude Code / Codex 的 skill 同步。**

本阶段只把 Zero 改造成 SHUD 科研建模 Agent Runtime：主控是 Commander Agent，主要动作空间是 bash，skills 是严格格式化、可验证、可进化的程序化能力，memory 是证据约束的长期科研认知结构。

---

## 1. 背景与设计判断

### 1.1 为什么选择 Zero 作为原型

Zero 当前不是简单聊天 UI，而是一个持久化 agent runtime。其 README 将项目定义为一个 **Bun + TypeScript monorepo**，包含 tools、memory、observability、scheduling、channel adapters、Web control plane 和 optional supervisor。它的核心价值不是 UI，而是运行时能力：模型路由、session 持久化、工具循环、memory 检索、日志指标 trace、子 agent、schedule 和 supervisor。参考 Zero README 中的 Architecture、Request Flow 与 Runtime State 部分。

这与 SHUD-Harness 的方向高度吻合：我们需要的不是普通工作流平台，而是一个让 agent 能够在 SHUD/rSHUD/AutoSHUD 世界中长期行动、观察、反思、改进的 runtime。

Zero 已有的关键能力包括：

```text
- Agent loop
- bash tool
- read/write/edit/fetch tools
- spawn_agent / wait_agent / close_agent / send_input
- memory store / memory retrieval / optional vector index
- observability store / metrics DB / trace
- scheduler
- supervisor heartbeat
- Web control plane
- local runtime state under `.zero/`
```

这些能力正好对应 SHUD-Harness 的底座：

```text
Commander Agent 主循环
Worker / Critic 子 agent episode
bash-first 执行空间
长期 memory
episode trace
运行日志
任务调度
operator console
```

### 1.2 Zero 不能直接承担 SHUD 科研 harness 的原因

Zero 的通用能力很强，但它缺少科研建模系统所需的四类语义层：

```text
1. SHUD domain layer
   ResearchChangeSet、ExperimentSpec、EvidencePacket、ChangeSpec、ValidationReport、SHUDStack 等对象。

2. Scientific evidence layer
   claim / evidence / counter-evidence / uncertainty / decision 的证据链。

3. Evidence-gated memory
   不能让 agent 直接把自己的判断写成 verified memory。

4. SHUD-specific skill lifecycle
   bash scaffold → candidate skill → tested skill → promoted skill → canonical skill → deprecated skill。
```

因此，正确路线不是“使用 Zero 原样运行 SHUD”，而是：

```text
Fork Zero
  → 保留 runtime 主体
  → 抽象掉与 SHUD 不兼容的运行假设
  → 增加 SHUD domain packages
  → 重构 memory 写入机制
  → 重构 skill governance
  → 建立 Commander / Worker / Critic / Harness Optimizer
  → 用 tiny SHUD loop 验证完整闭环
```

---

## 2. 明确边界：本阶段不改 Claude Code / Codex 接口

### 2.1 不做的事情

本阶段明确不做：

```text
- 不修改 `.claude/` 目录结构。
- 不修改 `.codex/` 目录结构。
- 不实现 skills-src 到 `.claude/skills/`、`.agents/skills/` 或 `.codex/` 的同步。
- 不设计 Claude Code subagent 文件规范。
- 不设计 Codex custom agent TOML 文件规范。
- 不把 Zero 的 skills 机制绑定到 Claude Code 或 Codex。
- 不依赖 Claude Code / Codex 作为 SHUD-Harness 的主运行时。
```

### 2.2 保留状态

Zero 仓库现有的 `.claude`、`.codex` 内容先保持只读或原样保留，不纳入第一阶段迁移目标。后续是否集成 Claude Code / Codex，应在 SHUD-Harness runtime 稳定后，单独立项。

### 2.3 本阶段关注点

本阶段只关注：

```text
- Zero runtime 二次开发
- Commander-driven agent loop
- bash-first sandbox
- SHUD domain layer
- SHUD memory layer
- SHUD skills layer
- SHUD evidence / validation / benchmark layer
- Web control plane 的 SHUD 化
```

---

## 3. 目标系统定义

### 3.1 一句话定义

**SHUD-Harness 是一个以 Commander Agent 为主控、以 bash sandbox 为主要动作空间、以严格 skills 为程序化经验、以证据约束 memory 为长期科研认知、以 Critic/Evaluator 为反馈约束的 SHUD 科研建模 Agent Runtime。**

### 3.2 主控模型

主控不是固定 workflow，也不是外部状态机。主控应是：

```text
Commander Agent
```

Commander Agent 的职责：

```text
- 接收学者的科研问题或模型优化目标。
- 建立和维护 Research Change Set。
- 判断下一步应该是实验、数据诊断、代码修改、验证、总结、请求人工审批，还是触发 harness 自我优化。
- 检索 memory 和 skills。
- 分派 Worker episode。
- 请求 Critic episode。
- 根据评价结果修正路线。
- 提出 memory update 和 skill promotion。
```

### 3.3 Harness 的职责

Harness 不替代 Commander 决策。Harness 负责为 Commander 和 Worker 提供运行条件：

```text
- context assembly
- bash sandbox
- file/worktree isolation
- command trace
- tool output filtering
- observation normalization
- policy gate
- memory proposal flow
- skill registry
- artifact capture
- validation/evaluation
- Web operator console
```

简化为一句话：

```text
Agent 决策；Harness 约束；Bash 行动；Environment 反馈；Critic 审查；Human 兜底。
```

---

## 4. Zero 现状分析

### 4.1 Monorepo 技术栈

Zero 是 Bun + TypeScript ESM monorepo。其 `package.json` 显示：

```json
{
  "name": "zero-os",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*", "benchmarks/*"]
}
```

主要脚本包括：

```text
bun run test
bun run test:e2e
bun run check
bun run lint
bun run build:web
bun zero <command>
```

这说明 Zero 适合以 monorepo 方式扩展新的 SHUD packages。

### 4.2 Runtime layers

Zero README 描述的 runtime layers：

```text
packages/shared      系统契约、config types、message schemas、common utilities
packages/secrets     encrypted vault 和 secret filtering
packages/model       provider adapters、auth、model selection
packages/memory      Markdown-backed memory、memo、vector index、retrieval
packages/observe     logs、metrics、traces、session state、schedule state
packages/core        agent loop、tools、sessions、bootstrap context、task orchestration
packages/channel     Web、Telegram、Feishu channels
packages/scheduler   cron-style jobs
packages/supervisor  liveness watch、repair helpers、git-based recovery primitives
apps/*               runnable processes
```

这些层不应被大规模重写。第一阶段应该尽量通过新增 SHUD packages 扩展，而不是侵入式改 core。

### 4.3 Agent loop

Zero 的 `AgentLoop` 已经支持：

```text
- conversation history
- tool loop
- tool_use stop reason
- streaming fallback
- empty response retry
- tool call start/end hooks
- processToolResults hook
- afterToolResults hook
- shouldInterrupt hook
- maxIterations
```

这些 hook 对 SHUD-Harness 很关键。可以用来插入：

```text
- SHUD observation normalizer
- episode budget
- policy gate
- evaluator interrupt
- trace enrichment
- memory proposal hooks
```

### 4.4 Bash tool

Zero 的 `BashTool` 已经实现：

```text
- command input
- optional description
- timeout
- cwd = ctx.workDir
- fuse list check
- stdout/stderr capture
- non-zero exit code structured failure
```

这符合 SHUD-Harness 的 bash-first 方向。第一阶段不需要设计大量 typed tools，应围绕 bash 进行科研 sandbox 增强。

### 4.5 Spawn agent

Zero 的 `spawn_agent` 工具支持创建 sub-agent，并可设置：

```text
- instruction
- label
- mode
- role / agent_type / preset
- agentInstruction
- tools
- model
```

这可以直接映射 SHUD-Harness 的：

```text
Commander → Worker
Commander → Critic
Commander → Harness Optimizer
```

不过 Zero 当前内置角色为 explorer、coder、reviewer，这些角色语义不够 SHUD 化，应新增 SHUD-specific roles，而不是直接套用，（explorer可以保留，worker是coder的升级版？）。

### 4.6 Skills loader

Zero 当前从 `.zero/skills/` 加载 skills。每个 skill 是一个目录，内部包含 `SKILL.md`，并通过 YAML frontmatter 读取：

```text
name
description
allowed-tools
```

这提供了基础，但 SHUD-Harness 需要更严格的 skill 格式约束和生命周期管理。

### 4.7 Memory tool

Zero 当前 memory tool 支持 create/update/delete/list，并在 create 时默认写入：

```text
status: verified
confidence: 0.85
```

这对科研系统不合适。SHUD-Harness 必须改成：

```text
agent 只能提出 memory proposal；
不能直接写 canonical / verified scientific memory。
```

### 4.8 Runtime state

Zero 默认把运行状态放在 `.zero/` 下：

```text
.zero/config.yaml
.zero/secrets.enc
.zero/fuse_list.yaml
.zero/memory/**
.zero/workspace/**
.zero/logs/**
.zero/heartbeat.json
```

SHUD-Harness 应该保留 `.zero/` 作为 agent runtime state，同时新增 `.shud/` 或 `shud-workspace/` 存放科研状态。

---

## 5. 迁移总体原则

### 5.1 Fork-first，而不是插件式补丁

建议 fork Zero 为：

```text
zero-shud
```

原因：

```text
- Zero 是早期项目，接口可能变化。
- SHUD-Harness 需要深度改 memory、skill、sandbox 和角色语义。
- 科研系统需要稳定可控的 runtime，不应依赖上游频繁变化。
```

### 5.2 Runtime 保守改造，SHUD 语义新增 package

原则：

```text
packages/core 尽量少改。
apps/server 尽量少改。
新增 packages/shud-* 承载 SHUD 逻辑。
```

### 5.3 Bash-first，不膨胀 typed tools

第一阶段工具层只保留少量核心动作：

```text
- bash
- read
- write/edit
- memory_search / memory_read
- memory_proposal
- spawn_agent / wait_agent / close_agent / send_input
- request_human_gate
```

其他能力通过 bash scaffold 实现。经过验证的 scaffold 再提升为 skill。

### 5.4 Skills 严格格式化

Skill 不是随意 prompt。每个 skill 必须：

```text
- 单独目录
- 必须包含 SKILL.md
- SKILL.md 必须有 YAML frontmatter
- 必须有 name
- 必须有 description
- description 必须写清触发条件和边界
- 可选 allowed-tools，但不能作为唯一权限来源
- 正文必须包含 Purpose、When to use、When not to use、Procedure、Expected outputs、Validation、Failure modes
```

### 5.5 Memory evidence-gated

任何科研判断、模型结论、经验规则都不能直接写入 verified memory。必须经过：

```text
Agent proposes
  → Critic checks
  → evidence artifacts linked
  → Commander approves
  → optional human promotes
```

### 5.6 `.zero` 与 `.shud` 分离

建议：

```text
.zero/    Zero runtime state，不提交或谨慎提交
.shud/    SHUD-Harness research state，可部分版本化
```

`.zero` 继续保存 runtime config、memory、logs、heartbeat；`.shud` 保存 ResearchChangeSet、ExperimentSpec、EvidencePacket、ChangeSpec、ValidationReport、skill registry metadata 等。

---

## 6. 目标仓库结构

建议迁移后的仓库结构：

```text
zero-shud/
  apps/
    server/
    web/
    supervisor/

  packages/
    shared/
    secrets/
    model/
    memory/
    observe/
    core/
    channel/
    scheduler/
    supervisor/

    shud-domain/
    shud-artifact/
    shud-memory/
    shud-skill/
    shud-eval/
    shud-harness/

  prompts/
    shud/
      commander-system.md
      worker-system.md
      critic-system.md
      harness-optimizer-system.md
      research-constitution.md

  skills-src/
    run-shud-tiny-case/
      SKILL.md
      scripts/
      references/
      examples/
      eval/
    diagnose-shud-run-failure/
      SKILL.md
      scripts/
      references/
      examples/
      eval/
    rshud-roundtrip-test/
      SKILL.md
      scripts/
      references/
      examples/
      eval/
    add-shud-output-diagnostics/
      SKILL.md
      scripts/
      references/
      examples/
      eval/
    benchmark-before-after/
      SKILL.md
      scripts/
      references/
      examples/
      eval/

  shud-workspace-template/
    .shud/
      rcs/
      experiments/
      evidence/
      changes/
      validation/
      memory-proposals/
      skill-proposals/
    repos/
      SHUD/
      rSHUD/
      AutoSHUD/
    data/
      raw/
      processed/
    runs/
    artifacts/
    episodes/

  docs/
    shud-harness/
      migration-plan.md
      runtime-architecture.md
      skill-format.md
      memory-governance.md
      commander-loop.md
```

---

## 7. 新增 packages 设计

### 7.1 `packages/shud-domain`

职责：定义 SHUD-Harness 的领域对象。

核心对象：

```text
ResearchChangeSet
ResearchIntent
Hypothesis
ExperimentSpec
SHUDStack
RunSpec
EvidencePacket
ChangeSpec
ValidationReport
DecisionRecord
HumanGate
```

示例：`ResearchChangeSet`

```ts
export interface ResearchChangeSet {
  id: string;
  title: string;
  status:
    | 'draft'
    | 'scoped'
    | 'experimenting'
    | 'evaluating'
    | 'engineering'
    | 'validating'
    | 'decided'
    | 'archived';
  researchIntent: string;
  hypotheses: Hypothesis[];
  experiments: string[];
  evidence: string[];
  changes: string[];
  decisions: string[];
  createdAt: string;
  updatedAt: string;
}
```

### 7.2 `packages/shud-artifact`

职责：管理 artifact manifest、run manifest、checksum、provenance。

核心对象：

```text
ArtifactManifest
RunManifest
ArtifactStore
ChecksumService
ProvenanceRecord
```

原则：

```text
- 大文件不进 memory。
- artifact 通过路径 / URI / checksum / provenance 引用。
- 每个 SHUD run 都生成 run manifest。
```

### 7.3 `packages/shud-memory`

职责：把 Zero 的通用 memory 扩展为科研 memory。

Memory 类型：

```text
semantic
  SHUD 概念、变量、参数、代码地图、流域背景

episodic
  历史 episode、失败、修复、运行、验证结果

procedural
  skills、scaffolds、validated procedures

epistemic
  claim、evidence、counter-evidence、uncertainty、decision

meta
  harness 改进经验、context pack 改进、skill 评价
```

写入机制：

```text
createMemoryProposal()
reviewMemoryProposal()
promoteMemoryProposal()
deprecateMemory()
```

禁止：

```text
agent 直接写 verified scientific memory。
```

### 7.4 `packages/shud-skill`

职责：skill 校验、安装、提升、降级、索引。

功能：

```text
validateSkillDirectory()
loadSkillMetadata()
installSkillToZeroRuntime()
proposeScaffoldAsSkill()
promoteSkill()
deprecateSkill()
scoreSkillUsage()
```

注意：本阶段只同步到 `.zero/skills/`，不触碰 Claude Code / Codex 目录。

### 7.5 `packages/shud-eval`

职责：评价 SHUD 运行和代码变更。

评价维度：

```text
software:
  build
  tests
  R CMD check
  interface compatibility

hydrology:
  NSE
  KGE
  RMSE
  PBIAS
  event peak error
  peak timing error
  event runoff coefficient

numerical:
  water balance
  solver failure
  negative states
  mass residual
  runtime
  memory

scientific:
  claim support
  uncertainty context
  counter-evidence
  cross-basin generality
```

### 7.6 `packages/shud-harness`

职责：SHUD Commander loop 政策、Research Constitution、state briefing、episode management、meta-harness 优化。

功能：

```text
buildStateBriefing()
assembleCommanderContext()
createWorkerEpisode()
createCriticEpisode()
applyResearchConstitution()
checkHumanGate()
runHarnessOptimizer()
```

---

## 8. Agent 角色设计

### 8.1 Commander Agent

长期主控 agent。

职责：

```text
- 维护 ResearchChangeSet。
- 判断下一步行动。
- 检索 memory 和 skills。
- 通过 bash 或 Worker episode 执行任务。
- 请求 Critic 审查。
- 请求 human gate。
- 提出 memory/skill 更新。
- 触发 harness optimizer。
```

默认工具：

```text
read
bash
memory_search
memory_read
spawn_agent
wait_agent
close_agent
send_input
request_human_gate
```

禁止：

```text
- 直接改默认物理参数。
- 直接宣称模型机制被验证。
- 直接覆盖 benchmark baseline。
- 直接修改原始观测数据。
```

### 8.2 Worker Agent

短期执行 agent。

职责：

```text
- 在给定 episode goal 下执行。
- 使用 bash 创建 scaffolds。
- 修改代码或运行实验。
- 生成 artifact、patch、report。
- 向 Commander 汇报结果。
```

Worker 不维护长期路线，不直接写长期 memory。

### 8.3 Critic Agent

独立审查 agent。

职责：

```text
- 审查实验设计是否能检验假设。
- 审查代码改动是否越界。
- 审查 validation 是否充分。
- 查找过拟合、数据泄漏、指标误读、缺失反例。
- 审查 memory proposal 和 skill proposal。
```

Critic 默认不修改文件。

### 8.4 Harness Optimizer Agent

meta-level agent。

职责：

```text
- 读取成功/失败 episode traces。
- 发现反复失败模式。
- 提出 prompt、context pack、skill、scaffold、observation normalizer 的改进。
- 在固定 benchmark episode 上评估改进。
- 提出 promotion / rollback 建议。
```

禁止：

```text
- 修改科学评价阈值。
- 修改默认模型参数。
- 修改 benchmark acceptance criteria。
- 绕过 human gate。
```

---

## 9. Bash-first sandbox 设计

### 9.1 为什么以 bash 为主

本项目不应预设几十个 typed tools。SHUD 的科研建模和代码改造需要 agent 自主构建脚手架、调试脚本、解析日志、运行 R/C++/Python 程序。bash 是最通用、最灵活的动作空间。

### 9.2 Bash 不等于裸 shell

Zero 当前 BashTool 已有 fuse list 和 timeout。SHUD-Harness 需要增强：

```text
- episode-scoped workspace
- repo worktree isolation
- raw data read-only mount
- writable scratch/runs/artifacts
- command trace
- created/modified file diff tracking
- resource limit
- optional container execution
- SHUD-specific observation summary
```

### 9.3 Episode workspace

每个 episode 创建：

```text
.shud/episodes/EP-YYYY-NNNN/
  briefing.md
  context/
  worktrees/
    SHUD/
    rSHUD/
    AutoSHUD/
  scratch/
  scaffolds/
  runs/
  artifacts/
  traces/
    commands.jsonl
    observations.jsonl
    file_changes.jsonl
  final.md
```

### 9.4 Bash command trace

每次 bash 调用记录：

```yaml
command_id: CMD-000123
episode_id: EP-2026-0042
command: "Rscript scripts/check_roundtrip.R"
cwd: ".shud/episodes/EP-2026-0042/worktrees/rSHUD"
timeout_ms: 120000
exit_code: 0
stdout_path: artifacts/CMD-000123.stdout.txt
stderr_path: artifacts/CMD-000123.stderr.txt
created_files: []
modified_files: []
summary: "rSHUD roundtrip check passed"
```

### 9.5 Observation normalization

不要把所有 stdout/stderr 原样塞给 agent。Harness 应抽取摘要：

```yaml
observation_id: OBS-000123
type: shud_run_failure
status: failed
failure_class: cvode_convergence
signals:
  exit_code: 1
  last_model_time: "2008-02-14T07:30:00"
  cvode_error_count: 14
  negative_state_count: 0
  water_balance_available: false
artifacts:
  log_excerpt: artifacts/log_excerpt.txt
  solver_stats: artifacts/solver_stats.parquet
recommended_next_actions:
  - inspect_solver_stats
  - inspect_forcing_window
  - compare_with_baseline
```

---

## 10. Skill 系统改造

### 10.1 Skill 的定位

Skill 是 **procedural memory**，不是普通提示词。它应包含：

```text
- 何时使用
- 何时不要使用
- 操作步骤
- 可复用脚本
- 输入输出契约
- 验证方式
- 常见失败模式
- 相关 examples / references
```

### 10.2 Skill 目录规范

每个 skill 是一个独立目录：

```text
skills-src/<skill-name>/
  SKILL.md
  scripts/
  references/
  examples/
  eval/
  CHANGELOG.md
```

最小合法 skill：

```text
skills-src/run-shud-tiny-case/
  SKILL.md
```

推荐完整 skill：

```text
skills-src/diagnose-shud-run-failure/
  SKILL.md
  scripts/
    parse_shud_log.py
    summarize_solver_stats.py
  references/
    shud-output-files.md
  examples/
    cvode-failure-example.md
  eval/
    test_skill.sh
    expected_observation.yaml
  CHANGELOG.md
```

### 10.3 `SKILL.md` 强制格式

`SKILL.md` 必须以 YAML frontmatter 开头：

```markdown
---
name: diagnose-shud-run-failure
description: Use when a SHUD run fails, stalls, produces CVODE errors, or reports nonphysical numerical diagnostics. Do not use for normal metric comparison or scientific claim writing.
allowed-tools:
  - bash
  - read
  - edit
---

# Diagnose SHUD Run Failure

## Purpose
...

## When to use
...

## When not to use
...

## Required inputs
...

## Procedure
...

## Expected outputs
...

## Validation
...

## Common failure modes
...

## Notes
...
```

强制字段：

```text
frontmatter.name
frontmatter.description
# H1 title
Purpose
When to use
When not to use
Procedure
Expected outputs
Validation
Common failure modes
```

### 10.4 Skill 生命周期

```text
scaffold
  → candidate skill
  → tested skill
  → promoted skill
  → canonical skill
  → deprecated skill
```

说明：

```text
scaffold:
  Worker 在 episode 内临时写的脚本或流程。

candidate skill:
  Commander 或 Harness Optimizer 认为值得保留，生成 skill proposal。

tested skill:
  通过 eval/ 中的测试或至少两个 episode 验证。

promoted skill:
  安装到 `.zero/skills/`，可被 Commander 正式检索。

canonical skill:
  成为 SHUD-Harness 默认技能。

deprecated skill:
  被替代或证明会误导 agent。
```

### 10.5 第一批 skills

第一阶段只做 5 个 skills：

```text
1. run-shud-tiny-case
2. diagnose-shud-run-failure
3. rshud-roundtrip-test
4. add-shud-output-diagnostics
5. benchmark-before-after
```

不要一次做太多。

---

## 11. Memory 系统改造

### 11.1 Memory 的定位

Memory 不是聊天记录，而是 Commander 的长期科研认知结构。

### 11.2 Memory 类型

```text
semantic memory
  SHUD 概念、参数、变量、代码模块、流域背景、文件格式。

episodic memory
  历史 episode、失败、修复、运行、验证、经验。

procedural memory
  skills、scaffolds、validated procedures。

epistemic memory
  claim、evidence、counter-evidence、uncertainty、decision。

meta memory
  harness 自我改进经验、context pack 改进、skill 使用效果。
```

### 11.3 Memory proposal flow

```text
Agent observes result
  ↓
Agent proposes memory update
  ↓
Critic reviews
  ↓
Evidence links checked
  ↓
Commander approves
  ↓
Memory promoted
```

### 11.4 Memory 状态

```text
raw
proposed
reviewed
validated
canonical
deprecated
```

### 11.5 禁止直接 verified

应修改 Zero 当前 MemoryTool 的默认行为。不得在 create 时默认：

```text
status: verified
confidence: 0.85
```

建议改为：

```text
status: proposed
confidence: null 或 explicit
```

或者更严格：

```text
MemoryTool 只允许创建 memory proposal；
正式 memory promotion 由 Commander/Critic/Human gate 触发。
```

---

## 12. SHUD 科研状态对象

### 12.1 ResearchChangeSet

```yaml
id: RCS-2026-001
title: Diagnose semi-arid storm peak underestimation
status: experimenting
research_intent: >
  SHUD underestimates storm peaks in semi-arid basins while total runoff is acceptable.
hypotheses:
  - H1-infiltration-too-strong
  - H2-hillslope-routing-too-slow
  - H3-precipitation-spatial-heterogeneity
experiments:
  - EXP-2026-001
evidence:
  - EV-2026-001
changes: []
decisions: []
```

### 12.2 ExperimentSpec

```yaml
id: EXP-2026-001
linked_rcs: RCS-2026-001
basins:
  - cache_creek
events:
  - storm_2008_02_14
treatments:
  - baseline
  - lower_ksat
  - lower_hillslope_roughness
metrics:
  - event_peak_error
  - peak_timing_error
  - event_runoff_coefficient
  - water_balance_residual
decision_rules:
  - Do not claim model improvement if metric delta is within observation uncertainty.
  - Do not modify governing equations from this experiment alone.
```

### 12.3 EvidencePacket

```yaml
id: EV-2026-001
linked_experiment: EXP-2026-001
main_findings:
  - H1 weakened by weak peak-flow sensitivity to ksat.
  - H2 remains plausible due to strong timing sensitivity to hillslope roughness.
limitations:
  - only one basin
  - precipitation uncertainty not fully evaluated
claims_supported:
  - CLM-2026-001
claims_weakened:
  - CLM-2026-002
recommended_next_action:
  type: engineering
  summary: Add event-scale diagnostics before changing physical equations.
```

### 12.4 ChangeSpec

```yaml
id: CHG-2026-001
linked_evidence: EV-2026-001
intent: Add event-scale diagnostics across SHUD runtime and rSHUD analysis.
risk_level: medium
affected_repositories:
  - SHUD
  - rSHUD
  - AutoSHUD
interface_impact:
  input_contract: unchanged
  output_contract: additive
  backward_compatible: true
validation_required:
  - build_shud
  - rshud_check
  - old_output_compatibility
  - tiny_event_case
  - water_balance_audit
  - runtime_overhead_check
human_gate_required:
  - output_contract_change
```

---

## 13. Web Control Plane 改造方向

Zero 已有 Web control plane，覆盖 dashboard、sessions、memory、tools、logs、metrics、config、provider status、WebSocket realtime updates。

SHUD-Harness 应在此基础上新增 SHUD 视角，不重写整个 UI。

### 13.1 新增页面

```text
/rcs
  Research Change Sets 列表、状态、当前 Commander 目标。

/rcs/:id
  RCS 详情：假设、实验、证据、代码变更、决策。

/episodes
  Commander / Worker / Critic episode traces。

/evidence
  Evidence packets、claims、counter-evidence、uncertainty。

/skills
  skill registry、status、usage score、promotion proposal。

/memory-proposals
  memory proposal 审查页面。

/validation
  validation reports、benchmark before/after。
```

### 13.2 第一阶段 UI 最小要求

第一阶段不用追求漂亮，只需支持：

```text
- 查看 Commander session。
- 查看 Worker/Critic episode。
- 查看 bash trace。
- 查看 memory proposals。
- 查看 skill registry。
- 查看 RCS 状态。
- 查看 final report / evidence packet。
```

---

## 14. 迁移阶段规划

## Phase 0：准备与基线冻结

周期：2-3 天

目标：建立 fork 和基线，确保后续改造可回滚。

任务：

```text
1. Fork V1ki/zero 到 zero-shud。
2. 标记 upstream baseline tag：upstream-zero-baseline-YYYYMMDD。
3. 跑通 bun install。
4. 跑通 bun run check。
5. 跑通 bun run test。
6. 跑通 bun run build:web。
7. 记录当前失败项。
8. 生成初始 ARCHITECTURE_BASELINE.md。
```

验收：

```text
- 本地可启动 Zero。
- 所有现有测试状态记录清楚。
- baseline tag 可回滚。
```

风险：

```text
- macOS-only secrets 可能影响 Linux 环境。
- 上游测试可能对本机环境有隐含依赖。
```

---

## Phase 1：Linux/HPC 运行前提抽象

周期：1-2 周

目标：不改变 agent 行为的前提下，解除 macOS-only 运行假设。

任务：

```text
1. 抽象 secrets backend。
2. 保留 macOS Keychain backend。
3. 新增 file/env fallback backend。
4. 抽象 supervisor backend。
5. 保留 launchctl 相关能力但不作为默认。
6. 确保 Linux 下能初始化 `.zero`。
7. 确保 Bun runtime、server、web、bash tool 可运行。
```

建议接口：

```ts
interface SecretBackend {
  getMasterKey(): Promise<Buffer>;
  setMasterKey(key: Buffer): Promise<void>;
}

class MacOSKeychainSecretBackend implements SecretBackend {}
class FileSecretBackend implements SecretBackend {}
class EnvSecretBackend implements SecretBackend {}
```

验收：

```text
- macOS 路径不破坏。
- Linux 路径可初始化。
- `.zero/secrets.enc` 可正常加载。
- `bun zero start` 可启动。
```

不做：

```text
- 不改 Claude/Codex 接口。
- 不做 HPC Slurm 调度。
```

---

## Phase 2：SHUD runtime mode 与 workspace

周期：1 周

目标：引入 SHUD-Harness workspace，但不改变 Zero 核心运行方式。

任务：

```text
1. 新增 `.shud/` workspace layout。
2. 新增 shud workspace initializer。
3. 新增 shud mode config。
4. 新增 RCS / Experiment / Evidence / Change / Validation 目录。
5. 新增 episode workspace 创建逻辑。
6. 将 episode traces 与 Zero session trace 关联。
```

目录：

```text
.shud/
  rcs/
  experiments/
  evidence/
  changes/
  validation/
  episodes/
  memory-proposals/
  skill-proposals/
  artifacts/
```

验收：

```text
- `bun zero shud init` 创建 workspace。
- Commander session 可关联 `.shud` workspace。
- Episode workspace 可创建并记录 trace。
```

---

## Phase 3：Commander / Worker / Critic 角色落地

周期：1-2 周

目标：把 Zero 的通用 roles 改造成 SHUD agent roles。

任务：

```text
1. 新增 `.zero/roles/commander.yaml`。
2. 新增 `.zero/roles/worker.yaml`。
3. 新增 `.zero/roles/critic.yaml`。
4. 新增 `.zero/roles/harness-optimizer.yaml`。
5. 编写 research-constitution.md。
6. 修改 session/bootstrap context，使 Commander 自动读取 SHUD state briefing。
7. 验证 Commander 能 spawn Worker 和 Critic。
```

角色文件示例：

```yaml
name: SHUD Commander
promptMode: full
defaultTools:
  - read
  - bash
  - memory_search
  - memory_read
  - spawn_agent
  - wait_agent
  - close_agent
  - send_input
agentInstruction: |
  You are the Commander Agent for SHUD-Harness...
```

验收：

```text
- Commander 能读取 RCS。
- Commander 能创建 Worker episode。
- Critic 能审查 Worker 输出。
- 所有 episode trace 可追踪。
```

---

## Phase 4：Skill 系统正规化

周期：1-2 周

目标：把 Zero 的 `.zero/skills` loader 扩展为严格 skill governance。

任务：

```text
1. 新增 `packages/shud-skill`。
2. 新增 skill validator。
3. 新增 skills-src 目录。
4. 实现 skill install 到 `.zero/skills/`。
5. 实现 skill status metadata。
6. 实现 skill proposal。
7. 实现 scaffold → skill proposal 的流程。
8. 完成第一批 5 个 skills。
```

命令建议：

```bash
bun zero shud skill check
bun zero shud skill install
bun zero shud skill list
bun zero shud skill propose
bun zero shud skill promote
bun zero shud skill deprecate
```

验收：

```text
- 非规范 SKILL.md 会被拒绝。
- Commander 只看到 metadata，使用时再读取完整 skill。
- 至少 5 个 skills 可安装到 `.zero/skills/`。
- 不触碰 `.claude/` 和 `.codex/`。
```

---

## Phase 5：Memory evidence-gated 改造

周期：2 周

目标：把 Zero 通用 memory 改造成科研 memory。

任务：

```text
1. 新增 `packages/shud-memory`。
2. 新增 MemoryProposal 类型。
3. 修改 MemoryTool 默认 create 行为。
4. 增加 memory_proposal 工具或模式。
5. 新增 Critic review memory proposal 流程。
6. 新增 Commander promote memory 流程。
7. 新增 epistemic memory schema。
8. 新增 memory proposals UI。
```

验收：

```text
- Agent 无法直接创建 verified scientific memory。
- memory proposal 必须有 evidence link 或 episode link。
- Critic 可审查 proposal。
- Commander 可 promote / reject。
```

---

## Phase 6：SHUD domain objects 与 evidence layer

周期：2-3 周

目标：建立 SHUD-Harness 的科研对象模型。

任务：

```text
1. 新增 `packages/shud-domain`。
2. 定义 ResearchChangeSet schema。
3. 定义 ExperimentSpec schema。
4. 定义 EvidencePacket schema。
5. 定义 ChangeSpec schema。
6. 定义 ValidationReport schema。
7. 定义 DecisionRecord schema。
8. 增加 YAML/JSON read/write。
9. 增加 schema validation。
10. Commander 自动生成 state briefing。
```

验收：

```text
- RCS 可创建、读取、更新。
- ExperimentSpec 可校验。
- EvidencePacket 可生成。
- ChangeSpec 可作为 Worker episode 输入。
```

---

## Phase 7：SHUD tiny loop 技术验证

周期：2 周

目标：跑通第一个完整闭环。

闭环内容：

```text
1. Commander 接收研究/工程目标。
2. Commander 创建 RCS。
3. Commander 选择 run-shud-tiny-case skill。
4. Worker 通过 bash 运行 tiny case 或 dummy SHUD fixture。
5. Worker 生成 run artifact。
6. Worker 生成 metrics / diagnostics。
7. Commander 生成 EvidencePacket。
8. Critic 审查 EvidencePacket。
9. Commander 生成 memory proposal。
10. Critic 审查 memory proposal。
11. Commander 决定下一步。
```

第一轮可以使用 dummy fixture，不必依赖完整 SHUD 模型数据。

验收：

```text
- 完整 trace 可追踪。
- artifact 可定位。
- memory proposal 可审查。
- skill 被正确调用。
- Critic 能指出至少一个不足。
- Commander 能根据不足提出下一步。
```

---

## Phase 8：代码改造闭环

周期：3-4 周

目标：让 Engineering Worker 能在 worktree 中修改 SHUD/rSHUD/AutoSHUD 并生成 validation report。

任务：

```text
1. episode workspace 中支持 repo worktree。
2. bash 可进入 worktree 编译/检查。
3. 新增 code diff tracking。
4. 新增 patch bundle 输出。
5. 新增 validation report schema。
6. 实现 add-shud-output-diagnostics skill。
7. 实现 rshud-roundtrip-test skill。
8. 实现 benchmark-before-after skill。
```

验收：

```text
- Worker 可修改 worktree。
- diff 可生成。
- patch bundle 可归档。
- validation report 可生成。
- 主仓库不被污染。
```

---

## Phase 9：Harness Optimizer v0

周期：2-3 周

目标：建立轻量 meta-harness loop。

任务：

```text
1. 读取失败 episode traces。
2. 聚类 repeated failure patterns。
3. 提出 skill/context/prompt/scaffold 改进。
4. 生成 harness improvement proposal。
5. 在固定 tiny benchmark episode 上 A/B 验证。
6. Commander 或 human 决定是否 promote。
```

验收：

```text
- 至少能发现一个重复失败模式。
- 能提出一个改进。
- 能在固定 episode 上对比改进前后。
- 不自动修改科学阈值。
```

---

## 15. 风险与缓解

### 15.1 Zero 上游成熟度风险

风险：Zero 是早期项目，接口未稳定。

缓解：

```text
- Fork 后冻结 baseline。
- SHUD 改造以新增 package 为主。
- 上游合并采取人工 cherry-pick。
```

### 15.2 macOS-only 运行假设

风险：Zero 当前默认 secret-management flow 依赖 macOS Keychain，launchctl 集成也偏 macOS。

缓解：

```text
- 第一阶段抽象 SecretBackend。
- Linux 使用 FileSecretBackend 或 EnvSecretBackend。
- launchctl 不作为 SHUD 默认路径。
```

### 15.3 Agent 写入错误 memory

风险：错误科研判断污染长期记忆。

缓解：

```text
- 禁止直接 verified memory。
- 引入 memory proposal。
- Critic review。
- evidence link required。
```

### 15.4 Skills 变成散乱 prompt

风险：skill 格式不严，导致模型理解成本增加，能力不稳定。

缓解：

```text
- 强制 SKILL.md frontmatter。
- 强制必要章节。
- skill checker 拒绝不规范 skill。
- skill lifecycle 管理。
```

### 15.5 Bash 过强导致破坏性操作

风险：bash-first 提高能力，也提高风险。

缓解：

```text
- fuse list。
- read-only raw data。
- episode sandbox。
- worktree isolation。
- destructive command gate。
- command trace。
- file diff audit。
```

### 15.6 固定 workflow 与 Commander 自主性冲突

风险：过度流程化会削弱科研 agent 的自主规划能力。

缓解：

```text
- 不写死科研 DAG。
- 固定的是 observe-decide-act-evaluate-reflect 循环。
- Commander 在 Research Constitution 下自主选择下一步。
```

---

## 16. 第一批交付物清单

### 16.1 代码交付物

```text
- forked zero-shud repository
- packages/shud-domain
- packages/shud-skill
- packages/shud-memory
- packages/shud-harness
- shud workspace initializer
- SHUD roles
- SHUD prompts
- skill validator
- memory proposal flow
```

### 16.2 文档交付物

```text
- docs/shud-harness/runtime-architecture.md
- docs/shud-harness/commander-loop.md
- docs/shud-harness/skill-format.md
- docs/shud-harness/memory-governance.md
- docs/shud-harness/episode-sandbox.md
- docs/shud-harness/tiny-loop-walkthrough.md
```

### 16.3 Skills 交付物

```text
- run-shud-tiny-case
- diagnose-shud-run-failure
- rshud-roundtrip-test
- add-shud-output-diagnostics
- benchmark-before-after
```

### 16.4 Demo 交付物

```text
- 一个 Commander session trace
- 一个 Worker episode trace
- 一个 Critic review
- 一个 EvidencePacket
- 一个 MemoryProposal
- 一个 SkillProposal
- 一个 ValidationReport
```

---

## 17. 90 天路线图

### 0-15 天：Zero runtime 可迁移性验证

```text
- Fork baseline
- Linux secret backend
- SHUD workspace
- Commander / Worker / Critic roles
- bash sandbox 初版
```

### 16-30 天：skills 与 memory 正规化

```text
- skill checker
- first 5 skills
- memory proposal
- critic review
- state briefing
```

### 31-45 天：SHUD domain objects

```text
- RCS
- ExperimentSpec
- EvidencePacket
- ChangeSpec
- ValidationReport
- UI 初版页面
```

### 46-60 天：tiny loop 闭环

```text
- tiny case / dummy fixture
- Commander 自主推进
- Worker bash 执行
- Critic 审查
- evidence + memory + skill proposal
```

### 61-75 天：代码改造闭环

```text
- worktree sandbox
- patch bundle
- SHUD/rSHUD/AutoSHUD 代码修改 episode
- validation report
```

### 76-90 天：Harness Optimizer v0

```text
- trace mining
- repeated failure pattern
- skill/context 改进 proposal
- tiny benchmark A/B test
```

---

## 18. 最小成功标准

90 天后系统至少应能做到：

```text
1. Commander Agent 可以接收一个 SHUD 科研/工程目标。
2. Commander 可以创建 RCS。
3. Commander 可以调用 Worker episode。
4. Worker 可以通过 bash 在 sandbox 中运行 SHUD tiny case 或 fixture。
5. Worker 可以生成 artifacts、metrics、report。
6. Critic 可以审查结果并指出不足。
7. Memory 写入必须经过 proposal。
8. Skill 使用和 promotion 有记录。
9. 一个跨 SHUD/rSHUD/AutoSHUD 的小型代码改造可以生成 patch bundle。
10. validation report 可以作为是否接受改造的依据。
```

---

## 19. 后续暂缓事项

以下事项后续单独立项，不进入当前迁移阶段：

```text
- Claude Code 接口集成
- Codex 接口集成
- `.claude/skills/` 同步
- `.agents/skills/` 同步
- Codex custom agents 文件生成
- 大规模 Slurm/HPC 自动调度
- 完整 Web dashboard 重设计
- 自动论文写作系统
- 自动修改物理方程
```

这些事项不是不重要，而是当前阶段会稀释主线。先把 Zero 改造成 SHUD 专用 Commander Agent Runtime，才有必要讨论对外 agent 工具生态适配。

---

## 20. 推荐的下一步

建议下一步直接做三件事：

```text
1. Fork V1ki/zero，建立 zero-shud baseline。
2. 写 `docs/shud-harness/skill-format.md` 和 skill checker。
3. 跑通 Commander → Worker → bash → trace → Critic 的最小 episode。
```

第一个技术验证不需要完整 SHUD 数据，也不需要接 Claude Code / Codex。只要证明：

```text
Commander 能自主决策；
Worker 能在 bash sandbox 中行动；
Critic 能审查；
skills 能被严格加载；
memory 不能被随意污染；
trace 能支撑 Harness Optimizer。
```

这就是 SHUD-Harness 二次开发的正确起点。

---

## 21. 参考来源

1. V1ki/zero GitHub Repository: https://github.com/V1ki/zero  
2. Zero README: runtime layers、request flow、runtime state、requirements、Web control plane、test coverage。  
3. Zero package.json: https://raw.githubusercontent.com/V1ki/zero/development/package.json  
4. Zero AgentLoop: https://raw.githubusercontent.com/V1ki/zero/development/packages/core/src/agent/agent-loop.ts  
5. Zero BashTool: https://raw.githubusercontent.com/V1ki/zero/development/packages/core/src/tool/bash.ts  
6. Zero SpawnAgentTool: https://raw.githubusercontent.com/V1ki/zero/development/packages/core/src/tool/spawn-agent.ts  
7. Zero Skill Loader: https://raw.githubusercontent.com/V1ki/zero/development/packages/core/src/skill/loader.ts  
8. Zero MemoryTool: https://raw.githubusercontent.com/V1ki/zero/development/packages/core/src/tool/memory.ts  
9. Zero Roles: https://raw.githubusercontent.com/V1ki/zero/development/packages/core/src/agent/roles.ts  
10. Zero server runtime bootstrap: https://raw.githubusercontent.com/V1ki/zero/development/apps/server/src/main.ts  

