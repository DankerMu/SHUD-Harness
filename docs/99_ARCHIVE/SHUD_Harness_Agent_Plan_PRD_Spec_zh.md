# SHUD Harness Agent Runtime Plan（PRD + High-Level Spec）

> 目标读者：Codex / Claude Code / 研究软件工程实现者  
> 文档性质：产品需求 + 架构约束 + 实现方向  
> 重要原则：**Commander Agent 是主控；Harness 不是替代 Agent，而是让 Agent 可靠运行。**

---

## 0. 文档契约

本文件用于指导实现一个**面向 SHUD / rSHUD / AutoSHUD 持续优化**的 Agent Runtime。  
实现时遵循以下优先级：

1. **先保证可控和可验证，再追求自治。**
2. **先保证单 Agent 主控可跑通，再增加 Worker / Critic。**
3. **bash-first，不要过早堆砌 typed tools。**
4. **skills 必须严格遵循官方 SKILL.md 规范。**
5. **memory 必须是证据约束的，不能把 agent 的猜测直接写成事实。**
6. **所有重要工程变更都必须跑验证闭环。**

---

# 1. 产品定义（PRD）

## 1.1 产品名称
**SHUD Harness Agent Runtime**

## 1.2 一句话定义
一个以 **Commander Agent** 为主控、以 **bash sandbox** 为主要动作空间、以 **self-evolving skills** 为程序化能力、以 **evidence-grounded memory** 为长期认知、以 **Critic/Evaluator** 为约束反馈的 SHUD 科研建模与代码优化系统。

## 1.3 目标用户
### 主用户
- 提出 SHUD 科研问题并监督系统运行的研究者 / PI / 工程负责人

### 系统内角色
- **Commander Agent**：主控指挥官
- **Worker Agent**：短期执行者
- **Critic Agent**：审查者
- **Harness Optimizer（后续）**：优化 harness 本身

## 1.4 解决的问题
系统必须解决以下高频难题：

1. 科研问题到实验设计的转化慢  
2. SHUD / rSHUD / AutoSHUD 跨仓库修改成本高  
3. 模型运行失败定位难  
4. 改代码容易脱离科学证据  
5. 团队经验无法稳定沉淀  
6. 长时段任务跨上下文容易丢失状态  

## 1.5 非目标（Non-goals）
当前版本不追求：

- 全自动科研闭环
- 全自动修改物理机制并直接合入主分支
- 重型平台化 UI 优先
- 一开始就做大规模多 Agent swarm
- 对所有外部系统做深度集成

---

# 2. 核心架构决策

## 2.1 Commander Agent 是主控
主控不是固化 workflow，也不是写死 DAG。  
主控必须由 LLM/Commander Agent 承担。

Commander 负责：

- 读取当前研究状态
- 结合记忆与技能决定下一步
- 直接用 bash 工作，或派发 Worker episode
- 请求 Critic 审查
- 必要时请求 human gate
- 决定何时更新 memory / promote skill

## 2.2 Harness 是 Commander 的运行时
Harness 不负责“替 Commander 思考”，而负责：

- context packaging
- sandbox / permission / budget
- trace logging
- evaluation / critic loop
- memory retrieval & write proposal
- skill discovery & promotion
- artifact capture

## 2.3 bash-first
主要动作空间是 `bash`。  
不要在 MVP 阶段构造大量 typed tools 来代替 shell。

允许的系统级能力只保留：

- `bash`
- `delegate_worker`
- `read_memory`
- `propose_memory_update`
- `request_human_gate`
- `finish_episode`

其余能力尽量通过 bash 中的脚本/脚手架实现。

## 2.4 科研流程是宪法，不是硬编排
系统不使用固定流程 DAG 主控。  
但 Commander 必须遵守 **Research Constitution**。

### Research Constitution（必须内置）
1. 不允许没有问题意识的代码修改。  
2. 不允许没有 baseline 的实验结论。  
3. 不允许没有 validation 的工程变更。  
4. 不允许把单一案例提升直接宣称为“模型普适改进”。  
5. 不允许绕过水量平衡、数值稳定性和旧案例回归。  
6. 物理机制、默认参数、I/O 契约改动必须经过 human gate。  

---

# 3. 角色设计

## 3.1 Commander Agent（长期）
### 职责
- 维护当前 Research Change Set（RCS）
- 决定下一步动作
- 检索相关 memory / skills
- 直接 bash 操作或 spawn Worker
- 触发 Critic / human gate
- 根据结果更新研究路线

### 不负责
- 长时间重复执行细粒度 bash 修修补补
- 替代 human 做最终科学判断

---

## 3.2 Worker Agent（短期）
### 职责
面向单一 episode 的执行者，例如：

- 运行实验
- 修复 SHUD build 失败
- 读取/扩展 rSHUD 输出
- 实现 AutoSHUD stage
- 写脚手架
- 产出 patch 和报告

### 输入
- `goal`
- `context_pack`
- `allowed_workspace`
- `budget`
- `success_criteria`

### 输出
- 结果摘要
- 变更文件
- 运行日志
- 失败原因或待办项
- memory/skill update proposals

---

## 3.3 Critic Agent
### 职责
- 检查实验设计是否能支持主张
- 检查代码变更是否越界
- 检查 benchmark / compatibility / validation 是否充分
- 要求补实验、补测试、补兼容性说明

### 输出
- critique report
- accept / revise / reject recommendation

---

## 3.4 Harness Optimizer（Phase 3）
### 职责
- 分析 episode traces
- 发现 recurring failure modes
- 改进 skills / prompts / context packaging / evaluation prompts
- 用固定 benchmark 验证 harness 改进是否真的有效

---

# 4. 主循环（Commander Loop）

```text
observe current state
→ retrieve memory
→ retrieve relevant skills
→ decide next move
→ execute (bash or worker)
→ evaluate result
→ reflect
→ propose memory/skill updates
→ continue or stop
```

### Pseudocode

```python
while not commander.decides_done():
    state = harness.build_state_briefing()
    memories = memory.retrieve(state)
    skills = skill_registry.retrieve(state)

    decision = commander.decide(
        state=state,
        memories=memories,
        skills=skills,
        constitution=research_constitution,
        action_space=["bash", "delegate_worker", "read_memory",
                      "propose_memory_update", "request_human_gate", "finish_episode"],
    )

    result = harness.execute(decision)
    evaluation = evaluator.evaluate(result)

    commander.reflect(result, evaluation)
    harness.store_trace(decision, result, evaluation)

    if result.contains_memory_proposal:
        memory.queue_proposal(result.memory_proposal)

    if result.contains_skill_proposal:
        skills.queue_proposal(result.skill_proposal)
```

---

# 5. 工作区与代码库布局

## 5.1 Runtime workspace

```text
shud-harness/
  README.md
  AGENTS.md
  CLAUDE.md

  constitution/
    research_constitution.md

  runtime/
    commander/
    critic/
    worker/
    evaluator/
    sandbox/

  traces/
    episodes/
    runs/

  memory/
    working/
    episodic/
    semantic/
    epistemic/
    meta/
    proposals/

  skills-src/
    <skill-name>/
      SKILL.md
      scripts/
      references/
      assets/
      eval/

  agents-src/
    commander.system.md
    worker.system.md
    critic.system.md

  vendor/
    codex/
      .agents/skills/
      .codex/agents/
    claude/
      .claude/skills/
      .claude/agents/

  repos/
    SHUD/
    rSHUD/
    AutoSHUD/

  benchmarks/
    tiny/
    event/
    regression/

  reports/
```

---

## 5.2 建议的“单一事实源（source of truth）”
为避免 Codex 与 Claude Code 的目录规范不同，推荐：

- **skills 的单一事实源**：`skills-src/`
- **agent prompts 的单一事实源**：`agents-src/`

然后通过同步/渲染脚本投影到 vendor-specific 目录：

- Codex skills → `.agents/skills/`
- Claude Code skills → `.claude/skills/`
- Codex custom agents → `.codex/agents/*.toml`
- Claude Code subagents → `.claude/agents/*.md`

### 说明
- **技能（skills）可高度共用**
- **agents / subagents 不可完全共用**，因为 Codex 与 Claude Code 的自定义 agent 格式不同  
  因此应采用“**统一源 prompt + vendor wrapper**”策略

---

# 6. bash sandbox 规范

## 6.1 原则
- bash 是主要动作空间
- 环境必须受控
- 重要动作必须可追踪、可回放、可审计

## 6.2 必须实现
- 独立工作目录
- repo worktree 或隔离 clone
- 原始数据只读
- 命令超时
- 命令日志
- 文件 diff 跟踪
- 资源上限（CPU / memory / runtime）
- 失败命令摘要化返回

## 6.3 episode 目录结构

```text
episodes/EP-0001/
  workspace/
  worktrees/
    SHUD/
    rSHUD/
    AutoSHUD/
  scratch/
  traces/
    commands.jsonl
    observations.jsonl
  artifacts/
  final_report.md
```

## 6.4 默认禁止
- 覆盖 raw data
- 直接改 benchmark baseline
- 未审批修改默认物理参数
- 未审批改 I/O 契约
- 无限制地启动大规模 HPC 作业
- 删除 version-controlled files outside allowed workspace

---

# 7. Skills 规范（严格版）

> 本节是**规范性要求**。实现时不要自由发挥格式。

## 7.1 Skill 的统一定义
**Skill = 可复用的程序化能力单元。**

它必须符合官方 Skill 基本形态：

- 目录形式
- 必须有 `SKILL.md`
- `SKILL.md` 顶部必须有 YAML frontmatter
- `name` 与 `description` 是最重要的路由元数据
- 可选 `scripts/`, `references/`, `assets/`

---

## 7.2 我们采用的“跨 Codex / Claude 的最小公共子集”
为了最大化跨平台兼容性，**canonical skill source 必须使用以下 frontmatter 最小集**：

```yaml
---
name: <lowercase-hyphenated-name>
description: <what it does + when to use it>
---
```

### 约束
- `name`：只允许小写字母、数字、连字符
- 建议最长不超过 64 字符
- 不使用平台保留词
- `description`：非空，必须同时说明 **做什么** 与 **何时使用**
- description 不要空泛，不要只写 “run tests” 这种无法路由的描述

---

## 7.3 Canonical SKILL.md 模板（必须遵循）

```md
---
name: your-skill-name
description: Explain exactly what this skill does and when to use it.
---

# your-skill-name

## Purpose
一句话说明目标。

## When to use
- 触发条件 1
- 触发条件 2
- 不该触发的情况

## Inputs
- 输入 1
- 输入 2

## Steps
1. 第一步
2. 第二步
3. 第三步

## Outputs
- 产物 1
- 产物 2

## Definition of done
- 验收条件 1
- 验收条件 2

## Failure handling
- 常见失败模式
- 遇到失败后的处理策略

## Related files
- scripts/...
- references/...
- assets/...
```

> 说明：  
> 官方规范只硬要求 frontmatter + markdown body。  
> 这里额外规定 body 的固定章节顺序，是为了**降低模型负担、提高触发与执行稳定性**。

---

## 7.4 Skill 目录模板（必须遵循）

```text
<skill-name>/
  SKILL.md
  scripts/
    ...
  references/
    ...
  assets/
    ...
  eval/
    smoke.sh
    expected.md
```

### 设计原则
- `scripts/`：只放确定性、重复性的机械动作
- `references/`：只放真正需要的补充文档
- `assets/`：模板、示例、小型资源
- `eval/`：必须有最小 smoke 测试

---

## 7.5 初始 Skill 列表（MVP）
仅做 5 个：

1. `run-shud-tiny-case`
2. `diagnose-shud-run-failure`
3. `rshud-roundtrip-test`
4. `add-output-diagnostics-cross-repo`
5. `benchmark-before-after`

---

## 7.6 Skill 示例（可直接落库）

```md
---
name: run-shud-tiny-case
description: Run the SHUD tiny benchmark and report build, runtime, metrics, and mass-balance status. Use after substantive changes to SHUD, rSHUD, AutoSHUD, benchmark definitions, or validation scripts.
---

# run-shud-tiny-case

## Purpose
快速验证当前代码栈是否能稳定完成 tiny benchmark。

## When to use
- 修改 SHUD / rSHUD / AutoSHUD 后
- 修改 benchmark 或验证脚本后
- 需要快速确认系统是否回归时

## Inputs
- current workspace
- current stack
- benchmark case: tiny

## Steps
1. 准备或刷新 worktree。
2. 构建 SHUD。
3. 运行 tiny case。
4. 解析输出。
5. 汇总 build status、runtime、核心指标和水量平衡结果。
6. 生成一段可供 Critic 和人类阅读的摘要。

## Outputs
- build log
- run log
- metrics summary
- mass balance summary
- tiny benchmark report

## Definition of done
- SHUD build 成功
- tiny case 跑完
- 核心指标可读
- 水量平衡状态已汇总
- 报告写入 artifacts 或 report 目录

## Failure handling
- 若 build 失败，先停止 benchmark 流程并输出失败摘要
- 若运行失败，优先归类为数据/代码/solver/环境问题之一
- 若输出缺失，标记为 validation failed
```

---

# 8. Codex / Claude 的技能与 agent 映射

## 8.1 Codex：skills
### 路径
- repo-scoped: `.agents/skills/<skill-name>/SKILL.md`
- user-scoped: `$HOME/.agents/skills/<skill-name>/SKILL.md`

### 约定
- 使用 canonical source → sync 到 `.agents/skills/`
- 优先 instructions-only skill
- 只有机械、确定性任务才下沉到 `scripts/`

---

## 8.2 Claude Code：skills
### 路径
- project-scoped: `.claude/skills/<skill-name>/SKILL.md`
- user-scoped: `~/.claude/skills/<skill-name>/SKILL.md`

### Claude 可选扩展字段
Claude Code 的 skill frontmatter 可额外包含：

- `when_to_use`
- `argument-hint`
- `allowed-tools`
- `disable-model-invocation`

### 约定
- canonical source 只保留 `name` + `description`
- 如果需要 Claude 专属优化，在 vendor wrapper 中追加可选字段，不污染 canonical source

---

## 8.3 Claude Code：subagents
### 路径
- `.claude/agents/*.md`

### 文件形态
Markdown 文件 + YAML frontmatter + markdown body prompt

### 适合用途
- `shud-critic`
- `shud-worker`
- `shud-research-reviewer`

---

## 8.4 Codex：custom agents / subagents
### 路径
- `.codex/agents/*.toml`

### 形态
Codex 自定义 agent 使用 TOML 配置，必须至少定义：

- `name`
- `description`
- `developer_instructions`

### 约定
- 以 `agents-src/*.md` 为单一 prompt 源
- 渲染成 `.codex/agents/*.toml`
- 不手工双写 prompt

---

# 9. Memory 规范

## 9.1 Memory 分层
必须至少实现 6 层：

1. **working memory**：当前 episode 的短期状态  
2. **episodic memory**：历史 episode 经验  
3. **semantic memory**：领域知识与模型/代码地图  
4. **procedural memory**：skills 与脚手架  
5. **epistemic memory**：主张、证据、反证、决策  
6. **meta memory**：harness 自我改进经验  

---

## 9.2 各层定义

### working memory
- 生命周期：一个 episode
- 存储：`episode_context.json`, `scratchpad.md`, `trace.jsonl`

### episodic memory
- 生命周期：长期
- 保存“做过什么、失败在哪里、学到了什么”

### semantic memory
- 变量、参数、文件格式、模块地图、benchmark 说明

### procedural memory
- 实质上就是稳定的 skills 与经过验证的 scaffolds

### epistemic memory
- claim / evidence / counter-evidence / uncertainty / decision
- 这是科研 agent 必须具备、普通 coding agent 没有的层

### meta memory
- 记录 harness 为什么改、怎么改、改后效果如何

---

## 9.3 Memory 写入门槛（必须）
长期 memory 不允许由 agent 直接写入。  
必须走 proposal 流程：

```text
agent proposes
→ critic checks
→ evidence linked
→ commander approves
→ memory store promotes
```

### Proposal 状态
- `raw`
- `proposed`
- `validated`
- `canonical`
- `deprecated`

### 示例

```yaml
memory_id: MP-0007
type: episodic
status: proposed
claim: "Old-output compatibility was broken because the new diagnostics reader assumed new files always exist."
evidence:
  - validation_report_2026_004.md
  - failing_fixture_old_output/
confidence: high
reviewer: critic
```

---

# 10. Evidence / Evaluation 规范

## 10.1 不允许 agent 自宣成功
每个重要任务都必须经过评价。

### 三层评价
1. **software evaluation**
   - build
   - tests
   - lint / R CMD check
   - compatibility

2. **model evaluation**
   - NSE / KGE / PBIAS
   - water balance
   - solver stability
   - runtime / regression

3. **scientific evaluation**
   - 结论是否由证据支持
   - 是否考虑不确定性
   - 是否存在反例
   - 是否仅在单案例上成立

---

## 10.2 基本验证矩阵（MVP）
任何跨仓库改动至少通过：

- SHUD build
- rSHUD check
- tiny benchmark
- mass-balance audit
- old-output compatibility
- benchmark before/after summary

---

# 11. 功能列表（MVP → V1）

## F1. Commander Loop
### Must-have
- state briefing
- memory retrieval
- skill retrieval
- decision
- bash execution
- trace logging
- stop conditions

## F2. Worker Delegation
### Must-have
- commander 能 spawn worker
- worker 有独立 sandbox
- worker 结果能回收给 commander

## F3. Critic Review
### Must-have
- Critic 能读取 diff / report / benchmark
- Critic 能输出 revise / accept / reject

## F4. Skill Runtime
### Must-have
- skills-src canonical source
- vendor sync for Codex / Claude
- smoke eval for each promoted skill

## F5. Memory Runtime
### Must-have
- proposal-based writes
- retrieval by state briefing
- episodic / semantic / procedural / epistemic 区分

## F6. Benchmark Runtime
### Must-have
- tiny case
- one event case
- before/after comparison

## F7. Cross-repo Engineering Runtime
### Must-have
- worktree
- patch bundle
- validation report

---

# 12. 验收标准（Definition of Done）

## 12.1 系统级 DoD
系统达到“可用”的标准是：

1. Commander 能围绕一个真实 SHUD 问题连续工作多个 episode  
2. Worker 能在 sandbox 中完成一次跨仓库小改动  
3. Critic 能审查这次改动并给出可执行反馈  
4. skill 可以被自动检索并实际触发  
5. memory proposal 能进入长期 memory  
6. tiny benchmark 能稳定跑完并生成 before/after 报告  

---

## 12.2 第一阶段目标案例
建议第一阶段围绕**event diagnostics 补全**做闭环：

### 目标
给 SHUD 增加 event-scale diagnostics，并同步到 rSHUD / AutoSHUD。

### 为什么选它
- 风险中等，不必一开始就改物理方程
- 能覆盖跨仓库协同
- 能验证 Commander → Worker → Critic → memory/skill promotion 的完整链路

### 完成标准
- SHUD 新增 structured diagnostics
- rSHUD 能读取新 diagnostics
- AutoSHUD 能在 report 中展示 diagnostics
- old-output compatibility 不破坏
- tiny/event benchmark 通过
- 产出 evidence packet + validation report + patch bundle

---

# 13. 实施顺序

## Phase 0：repo bootstrapping
- 创建 `AGENTS.md`
- 创建 `CLAUDE.md`
- 创建 `constitution/`
- 创建 `skills-src/`, `agents-src/`, `memory/`, `benchmarks/`
- 建立 vendor sync 脚本

## Phase 1：Commander + bash sandbox
- Commander system prompt
- episode schema
- isolated workspace
- trace logger
- stop rules
- tiny benchmark smoke path

## Phase 2：skills + memory
- 5 个 MVP skills
- memory proposal pipeline
- retrieval strategy
- skill smoke evals

## Phase 3：Worker + Critic
- worker spawning
- critic review
- patch + validation + benchmark review

## Phase 4：Meta loop
- harness optimizer
- recurring failure mining
- skill promotion / deprecation
- context pack tuning

---

# 14. Human gates（必须实现）

以下动作必须人工审批：

1. 修改控制方程  
2. 修改默认参数  
3. 修改 benchmark 阈值  
4. 修改输入/输出契约  
5. 启动高成本大规模 HPC 作业  
6. 更新主分支 baseline  
7. 发布模型版本  

---

# 15. 开发约束

## 15.1 不要一开始做的事
- 不要先做重型 Web UI
- 不要先做大量 typed tools
- 不要先做多层复杂 orchestrator
- 不要让 Worker 直接拥有无限 shell 权限
- 不要把 memory 当聊天记录堆积

## 15.2 一定要先做的事
- bash sandbox
- skill canonical format
- memory proposal gate
- benchmark & validation loop
- trace capture
- cross-repo tiny closed loop

---

# 16. 规范性参考（实现时必须对齐）

## A. Skills
### OpenAI / Codex
- 技能是一个目录，必须有 `SKILL.md`，可选 `scripts/`, `references/`, `assets/`
- `name` 与 `description` 是路由关键元数据
- repo-scoped skills 使用 `.agents/skills/`

### Claude Code / Claude Skills
- 技能是 `SKILL.md` + YAML frontmatter + Markdown body
- `name` / `description` 是核心字段
- project-scoped skills 使用 `.claude/skills/`

## B. Subagents / Custom agents
### Claude Code
- `.claude/agents/*.md`
- Markdown + YAML frontmatter + body prompt

### Codex
- `.codex/agents/*.toml`
- 至少定义 `name`, `description`, `developer_instructions`

> 结论：  
> **skills 尽量共用；agents 必须用统一 prompt 源 + vendor wrapper。**

---

# 17. 最终实施口号

**Commander decides.  
bash executes.  
Harness constrains.  
Critic challenges.  
Memory accumulates.  
Skills evolve.  
Humans approve.**
