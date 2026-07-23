# Stage 执行细则（Stage 1 → 5.5）

> 本文件是各 Stage 的完整执行契约，从 SKILL.md 下沉。SKILL.md 只保留路由、不可协商项索引与启动入口；**执行任何 Stage 前必须读本文件对应节**。漏读的机械兜底：`full-pipeline.workflow.js` 对 grill 凭证缺失/格式错拒绝启动，回环由 workflow 脚本硬编码，Stage 4.5 ack 凭据缺失即视为门被跳过。

## Stage 1: 上下文收集

**目标**：确定目标阶段，收集必读文档清单。

**澄清门禁**：如果目标阶段、范围、验收标准、必读文档或阶段完成定义不清，先调用 `clarify`。如果问题不是澄清而是方向选择，先交给 `brainstorming` 或 `future-aware-architecture`，不要直接创建 OpenSpec change。

**步骤**：

1. 查找实施计划文档。按优先级搜索：`IMPLEMENTATION_PLAN.md`、`implementation_plan.md`、`docs/**/implementation*`、`docs/**/roadmap*`、`**/PLAN.md`。如果找到，读取目标阶段的任务包和必读文档列表。
2. 如果没有实施计划文档，从用户描述中提取阶段目标，然后搜索项目中的设计文档（用 `find . -name "*.md" -path "*/docs/*" | head -30` 发现文档结构，不假设固定路径）。
3. 并行读取目标阶段涉及的核心设计文档（通常 3-6 个文件），记录关键实体：表名、API 端点、ENUM 值、ID 规范等。
4. 输出一份简要的阶段上下文摘要，确认后进入 Stage 2。

**盲区侦察（陌生领域时，压测门禁之前）**：目标阶段涉及不熟悉的模块、外部系统或团队约定，且设计文档覆盖不足时，先跑 `blind-spot-pass` 产出带证据的盲区清单，其决策点作为下方 `grill-me` 压测的输入；熟悉领域可直接跳过，无需留痕。

**压测门禁（EITHER/OR，必须留痕）**：进入 Stage 2 之前，对设计压测做出显式决策，二选一：

- **跑**：用 `grill-me` 沿决策树逐分支压测（多轮、一次一问），把未言明假设、隐藏依赖和模糊边界逼清，再创建 OpenSpec change。**收敛判据与单独使用 grill-me 完全一致**：每个关键分支要么用户拍板、要么显式列为开放项，且用户明确确认共同理解（grill-me 铁律 7）——压测轮数由决策树的分支数决定，不由管道推进压力决定，"问了几个问题"不是 passed 的判据。启动 `full-pipeline.workflow.js` 时传逐分支凭证：`grillGate: { status: "passed", branches: [{ branch, decision, decidedBy: "user"|"fact-check" }], openItems: [...], userConfirmed: true }`。
- **跳过**：阶段计划确实简单清晰时可以跳过，但必须写明理由，传 `grillGate: "skipped:<理由>"`。

`full-pipeline.workflow.js` 校验该参数：缺失、格式不符或裸 `"passed"` 字符串**直接拒绝启动**——声明不是证据，逐分支清单才是；"忘了"和"敷衍跑两问"都不再是合法状态。注意时序：grill-me 的多轮盘问只能发生在主会话（Workflow 子代理无法与用户交互），必须在启动脚本之前完成，脚本内无法补跑。该决策以 `passed:branches=<n>,open=<n>` 或 `skipped:<理由>` 形态随 `logEntry.grill_gate` 落入 `docs/stage-pipeline-log.jsonl`，跳过率与压测深度均可审计。

**判断切入点**：如果 `openspec/changes/<name>/` 已存在且 `openspec status` 显示 artifacts complete，跳到 Stage 3。

---

## Stage 2: OpenSpec Change 创建

**目标**：生成 proposal → design → specs → tasks 四个 artifact。

**Grill 清单是强制输入**（Stage 1 压测跑过时）：每个已拍板分支的结论必须落入对应 artifact——设计决策进 design.md 的技术决策，范围/边界类结论进 proposal 的 What Changes 或 Non-goals；每个开放项要么在 Stage 2 被解决，要么显式写成 proposal/design 的 open question 或 non-goal。压测结论不靠对话记忆传导：`full-pipeline` 会把 `grillGate` 凭证里的逐分支清单注入 Stage 3 审核 prompt，逐条核对——漂移、矛盾或开放项静默消失都是 finding。凭证以**启动时点**的最终共识为准：Stage 2 期间经用户确认的决策变更，先更新凭证里对应分支再启动——ledger 核对的是最终共识，不是 grill 时点的快照。

**前置**：确认 `openspec` CLI 可用（`which openspec`），项目已初始化（`openspec/` 目录存在，否则执行 `openspec init --tools claude`）。

**不可协商项**：按依赖顺序生成 proposal → design/specs → tasks，每个 artifact 撰写前先取 `openspec instructions <artifact> --change "<name>" --json`；design.md 必须含 **Sketch seams under test** 清单（自动、不设交互停点——优先已有 seam、用最高的 seam、越少越好，每个 seam 附一行理由；Stage 3 与下游 fixture review 检查它，清单随 fixture 流入 `subagent-workflow` 的 `Seams under test` 字段，实现期只消费不再谈判）；收尾 `openspec status --change "<name>"` 确认 4/4 complete。

逐 artifact 写法、命令骨架与支撑 skill 挂点（`future-aware-architecture`、`grill-with-docs`、`implementation-planning`）见 [stage-2-artifacts.md](stage-2-artifacts.md)。

---

## Stage 3: 并行 Subagent 审核

**目标**：从 3 个独立视角审核 change 质量，发现错项和漏项。

**关键约束**：通过编排器的原生并行 subagent 机制（Claude Code Task subagents 或 Codex subagents）同时发起 3 个审核任务，不能串行。每个 `reviewer` subagent 必须返回完整审核文本而非摘要。

**审核契约**：使用 `risk-adaptive-cross-review` 的 OpenSpec Review 模式作为审查语义参考：三路审核分别对应 Design Consistency、Spec Completeness、Tasks Executability;P0/P1 问题必须包含失败类型、证据、影响、修复方向和需要回归检查的相邻 artifact。失败类型从 `finding-contract.md` 的 Failure-Class Vocabulary（含 `design-consistency`/`spec-completeness`/`task-executability` 等 spec 类）取一个标签;含糊、无锚点、纯风格的条目按 Reject 精度门直接拒收，不进入 finding 列表（既不作 P0/P1，也不留作 note）。

**步骤**：

1. 构建 3 个审核 brief（各 200-400 字）：审核范围与检查项、change 文件与设计文档的具体路径、期望输出格式（候选 finding 列表，含失败类型/证据/影响/修复方向）。

2. 三路审核的标准分工：

   | 审核 | 视角 | 核心检查项 |
   |---|---|---|
   | Review 1: 设计一致性 | change 文件 vs 设计文档 | 表名/字段/ENUM 拼写一致性、API 端点覆盖完整性、ID 规范合规、manifest 字段对齐 |
   | Review 2: Spec 完整性 | 各 spec 之间 + 对照实施计划 | Requirement-Scenario 完备性、WHEN/THEN 可测试性、边界条件覆盖、跨 spec 一致性、功能点遗漏 |
   | Review 3: Tasks 可执行性 | tasks.md vs design + specs | 任务粒度、依赖顺序、spec 覆盖率、多余任务、验证方法明确性、技术决策落地；Stage 5 契约新字段的可信度——`Suggested fixture level` 与风险面相称（不因重要就抬档）、`Minimal mergeable slice` 声明的首刀真能独立合并保绿（`atomic` 声明有具体理由，不是省事默认） |

3. 并行 spawn 3 个 `reviewer` subagent（每路一个 brief），互不通信；每个都是只读 leaf——只审核、不改 change 文件、不嵌套发起本流水线。建议 task id：`review-design-consistency` / `review-spec-completeness` / `review-tasks-executability`。

4. 三路全部返回完整审核文本后提取候选 finding，去重后按 P0（必须修复）/ P1（建议改进）分类。

---

## Stage 4: 审核修复

**目标**：根据审核意见修改 change 文件，解决所有 P0 和 P1 问题——两者均为阻塞带。每轮带着 Stage 4.5 验证门反馈的未解决/回归 finding 进入；首轮直接消费 Stage 3 的去重 finding。

> **执行方式**：Stage 3→4→4.5 回环由 `review-loop.workflow.js` 的 `while` 循环硬编码执行，不依赖编排器自觉遵守散文回环指令。

**步骤**：从本轮 P0 + P1 清单识别共性问题（命名不一致、字段遗漏、计数矛盾等），按文件分组修改（改动文件 >3 时并行 agent 分批、互不交叉）；修复后验证 `openspec status --change "<name>"` 仍 4/4 complete；记录本轮改动文件清单和**每条 finding 的修复证据**（文件 + 行/片段），交 Stage 4.5 核销。不得在 Stage 4 自行宣告"已修复"——结论由独立验证门给出。

---

## Stage 4.5: 独立验证门（有界回环）

**目标**：由不参与修复的独立视角确认 Stage 4 真正解决了 P0/P1，且修复没有引入新的不一致；未达标则带证据回到 Stage 4，最多 3 轮。

**关键约束**：
- 验证者必须是**不参与本轮修复**的独立 subagent（只读 leaf：只核销、不改 change 文件，也不再嵌套发起本流水线）。建议 task id：`verify-review-fixes`。
- 对抗式判定：每条 finding **默认"未解决"**，必须有修复证据才判 `resolved`。证据不足、含糊或对不上即判 `unresolved`。
- **Oracle 完整性**：源设计文档、实施计划、Stage 1 的阶段目标与验收标准是不可篡改的 oracle——是判定 finding 的标准，不是为了让 change 过审而拧的旋钮。只修 change 文件，不改判定它的东西；确需改源设计的，按"方向选择"回 `brainstorming`/`future-aware-architecture`，并显式记录,不得静默改写来消 finding。

**触发与确认（不可跳过）**：
- 禁止从 Stage 4 直接跳到 Stage 5——每完成一轮 Stage 4 修复，必须经过本验证门。
- 每轮进入验证门时编排器显式输出 ack：`Stage 4.5 round <N>: started`；退出时输出 `round <N> verdict: <resolved>/<total> resolved, residual P0=<n> P1=<n>`。这两行是该轮验证门确实运行的可审计凭据，缺失即视为门被跳过，不得进入 Stage 5。
- **可靠性限制（诚实声明）**：本 skill 是可移植的文档方法论，无法替消费项目安装 pre-commit/pre-PR hook，因此触发可靠性依赖上述 ack 凭据 + 编排器纪律。若消费仓库存在可挂载的硬动作（如 PR 创建前钩子），应把本门锚定其上。各项目真实 skip-rate 为开放实测项，需在使用中审计，不可假设"写了就一定会跑"。

**核销方式**：spawn 一个 `verifier`（输入：本轮 P0/P1 清单 + Stage 4 改动文件列表 + 各 finding 修复证据），逐条标 `resolved` / `unresolved` / `regressed` 并附文件 + 行/片段证据；再做 delta 一致性扫描——只复查**被改文件触及**的跨 artifact 关系（命名、计数、覆盖、ID 规范），不重跑全量三路审核，仅当修复改动了实体名、表/ENUM 计数等全局扩散项时升级为 Stage 3 三路全审。汇总残留（`unresolved`）与新增（`regressed`）的 P0/P1。

**回环判定**：

**band 划分**：P0 和 P1 均为 **blocking 带**——两者都驱动回环，必须全部修到 `resolved` 才放行。回环逻辑由 `review-loop.workflow.js` 的 `while (activeFindings.length > 0 && round < MAX_ROUNDS)` 硬编码执行，编排器无法跳过。

- **退出（进 Stage 5）**：P0 + P1 全部 `resolved` **且** `openspec status` 4/4 complete **且** 验证门本轮无回归 **且** 完成自审通过——对照 Stage 1 收集的阶段目标与验收标准逐条核对，每个要求都有对应的 spec requirement + task 覆盖、无遗漏的设计目标或边界、change 内部无相互矛盾的修复;任一要求未覆盖则回 Stage 4，不靠"看起来修完了"放行。
- **继续**：仍有 `unresolved`/`regressed` 的 P0 或 P1 **且** 已完成轮次 < 3 → workflow 脚本自动带验证门证据回 Stage 4 再修，轮次 +1。
- **触顶（已完成 3 轮）**：把残留 P0/P1 如实写入对应 issue 正文并标 `needs-followup`，不假装干净；残留 P0 必须在 Epic 中显著标注阻塞风险。
- **收敛停止（提前退出）**：若某轮净新增 finding 不再下降，可在 3 轮内提前停，按"触顶"方式记录残留，避免空转。

---

## Stage 5: GitHub Issue 创建

**目标**：将 change 的 tasks 细粒度拆分为 GitHub Issue（Epic + 子任务），使每个子 issue 预期对应一个小而可审阅的实现 PR。

**前置**：`gh auth status` 确认已认证。

**规划门禁**：如果 tasks 无法自然映射到小 PR issue，或存在跨模块依赖链，先用 `implementation-planning` 明确分阶段交付、依赖顺序、验证和回滚；不要为了减少 issue 数量合并模块边界。

**实现就绪契约**：Stage 5 创建的每个子 issue 都必须可被 `subagent-workflow` 自动执行，不得把需求澄清留到实现阶段。每个子 issue 必须具备：

- `Implementation Ready: yes`
- 单一模块或 ownership 范围
- 明确的 In Scope / Out of Scope
- 可执行任务清单
- 可验证验收标准
- 必读文档和 OpenSpec change 引用
- 依赖 issue 列表
- 预期 PR 边界
- `Suggested fixture level`：`none|compact|expanded` 之一 + 一行理由。词表以下游 `subagent-workflow` 的 `issue-risk-contract.md` 为单一事实源（指针引用，不镜像）；下游 Phase 0.5 从该建议起判，双向偏离都须记录理由——字段存在的意义是让分级偏离成为可见决策。
- `Minimal mergeable slice`：首刀声明——若本 issue 需要拆分，最小可独立合并保绿的子集是什么（模块/文件级 + 一行为何它能独立保绿）；确实原子不可拆时写 `atomic: <理由>`，宽改造 expand–contract 各批次天然满足。下游 gate 的拆分默认与 `Split rebuttal` 以此为锚：反驳的对象是这一刀为什么现在不能独立合并，不是泛泛散文。
- 不需要实现阶段再做产品决策、范围判断或需求澄清

**分组硬规则**：每个子 issue 单一模块/ownership 边界、1-3 个紧密相关 tasks、预期对应一个小 PR；跨模块能力拆多个 issue 用逐行 `Depends on #<dep>` 串联；单一机械宽改造走 **expand–contract** 三段拆分例外；issue 排序按决策密度前置。

分组原则全文、创建步骤（标签/Epic/子 issue 正文模板/回填）见 [stage-5-issues.md](stage-5-issues.md)。

---

## Stage 5.5: Issue-Change 对齐审核

**目标**：验证创建的 GitHub Issue 与 OpenSpec change 完全对齐——覆盖完整、边界正确、依赖一致、内容不漂移。

> **执行方式**：由 `issue-alignment.workflow.js` 的 `while` 循环硬编码执行，最多 2 轮。调用方式：`Workflow({ scriptPath: "<path>/issue-alignment.workflow.js", args: { changeName: "<name>", epicNumber: <N> } })`

**流程**：审核 agent 沿六个维度（missing-coverage / wrong-boundary / wrong-dependency / scope-mismatch / missing-reference / content-drift）逐条比对 change artifact 与已创建 issue，输出结构化对齐缺口（P0/P1）→ 修复 agent 用 `gh issue edit` / `gh issue create` 修复 → 独立验证 agent 确认。P0 + P1 均阻塞，未清则继续，最多 2 轮；残留如实记录到 Epic。维度定义表见 [stage-5-issues.md](stage-5-issues.md)。

---

## 消费仓库锚定指引（触发可靠性）

> workflow 脚本解决了"回环内部不可跳过"，本节解决"workflow 本身会不会忘记调用"。

- 如果仓库有 CI 或 pre-PR hook 可挂载：在 PR 创建前检查 `docs/stage-pipeline-log.jsonl` 最新条目是否覆盖本 change（change name + 日期），缺失则阻塞 PR。这把触发从"编排器记得调"变成"不调就过不了 CI"。
- 如果没有可挂载的硬动作：依赖 SKILL.md 指令 + 单次调用 `full-pipeline` 模式；定期审计 skip-rate（检查哪些 change 有 openspec 产物但 `stage-pipeline-log.jsonl` 无对应条目）。
- **诚实声明**：同 Stage 4.5 的可靠性限制——本 skill 无法替消费仓库安装 hook，per-project skip-rate 需在使用中实测审计。
