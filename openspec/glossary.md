---
status: living
---

# SHUD-Harness 术语表（Glossary）

**状态**：living — 领域 ubiquitous language 唯一来源（CLAUDE.md 项目本地适配所指文件）。
**用途**：语料库为中文叙述 + 英文标识符混写，同一概念的 grep 关键词被劈成两种形态。检索前先查本表，把术语翻成中英两态再搜。
**维护**：由 `grill-with-docs` / `improve-codebase-architecture` 技能维护；新增术语必须带权威出处，出处冲突以 [CANONICAL_CONTRACTS](../docs/00_INDEX/CANONICAL_CONTRACTS.md) 判序。

## 1. 核心对象（8 + 1）

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| 任务卡 | `TaskCard` | 一次研究任务的根对象，聚合目标、预算、状态与产出引用 | [Minimal_Schemas](../docs/03_SPEC/Minimal_Schemas.md) |
| 栈锁 / 版本锁 | `StackLock` | 复现性锁定：SHUD/rSHUD/AutoSHUD/CLI/LLM 版本快照 | 同上（含 `llm` 模型版本锁） |
| 数据溯源 | `DataProvenance` | 输入数据来源、许可与预处理链记录 | 同上 |
| 运行作业 | `RunJob` | 一次 SHUD 执行的提交单元（`backend` 枚举在此定义） | 同上 |
| 运行记录 | `RunRecord` | 作业 collect 后的不可变结果记录（T2 证据载体） | 同上 |
| 分析计划 | `AnalysisPlan` | 敏感性/校准/基准分析的批量执行计划（`mode=sensitivity` 一等公民） | 同上 |
| 证据报告 | `EvidenceReport` | 供 PI 决策的 Markdown 报告对象 | 同上 |
| 变更请求 | `ChangeRequest` | 代码/参数变更的 patch 载体，走科学分级门 | 同上 |
| 记忆笔记 | `MemoryNote` | 轻量记忆条目（普通直写 draft，证据类需 PI review） | 同上 + [Memory_Skills_Lite](../docs/03_SPEC/Memory_Skills_Lite.md) |

## 2. 角色（canonical 枚举）

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| 主研究者 | PI | 唯一科学决策者，Web 审批与证据判断 | [Roles_and_Boundaries](../docs/02_ARCHITECTURE/Roles_and_Boundaries.md) §0 |
| 协调员 | `coordinator` | 建卡、执行计划、监控消耗、生成报告；无科学决策权 | 同上 |
| 仓库探索者 | `repo_explorer` | 只读探索仓库、定位入口/调用链/影响面 | 同上 |
| 执行者 | `worker` | 跑模型、解析日志、写脚本、生成图表 | 同上 |
| 编码者 | `coder` | 在 worktree 改代码、产 patch/ChangeRequest | 同上 |
| 审查者 | `reviewer` | 工程完整性与兼容性检查，不判断科学结论 | 同上 |

## 3. 信任与上下文

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| 信任分级 | T0–T4 | 上下文内容信任层级（T0 系统指令 → T4 不可信外源） | [Context_Trust_And_Injection_Spec](../docs/03_SPEC/Context_Trust_And_Injection_Spec.md) |
| 注入防护 | prompt injection defense | T4 内容降权/剥离规则（含 T1 笔记内嵌 T4 的剥离） | 同上 §2/§5.1 |
| 会话摘要 | session digest | 落盘的对话压缩产物，T3 标记后可重注入 | 同上 + [Park_Resume_Design](../docs/03_SPEC/Park_Resume_Design.md) |
| 上下文压缩 | `context_compression` | Zero 原生会话压缩机制，仅作 digest 载体复用 | [Zero_Reuse_Matrix](../docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md) |
| 上下文预算 | `ContextBudget` | Zero 分节上下文预算机制 | 同上 |
| 上下文组装 | context assembly | 按信任级与预算拼装 agent 输入 | Context_Trust_And_Injection_Spec §5 |

## 4. 执行与恢复

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| 收纳 / 挂起 | park | 长任务提交后 agent 退出、状态落盘 | [Park_Resume_Design](../docs/03_SPEC/Park_Resume_Design.md) |
| 恢复 | resume | 作业完成通知后恢复 agent 上下文续跑 | 同上 |
| 收集 | collect | 作业 terminal 后解析产物、生成 RunRecord（job 级 `collect.lock`） | [Execution_Jobs_Runs](../docs/03_SPEC/Execution_Jobs_Runs.md) |
| 看护进程 | watcher | 监视 RunJob 状态变迁并触发 collect 的进程 | 同上 |
| 后台工具汇 | `BackgroundToolTaskSink` | Zero 原生长工具后台化接缝（park/resume 落点） | Zero_Reuse_Matrix + Park_Resume_Design §4 |
| 发件箱 | outbox | 通知先落盘后发送的事务化模式（防蒸发） | [Notification_Design](../docs/03_SPEC/Notification_Design.md) §8 |
| 去重键 | `dedupe_key` | 通知幂等键：`task_id + trigger + target_id + recipient` | 同上 §5 + [Idempotency_Concurrency_Locking_Spec](../docs/03_SPEC/Idempotency_Concurrency_Locking_Spec.md) §4 |
| 快照 | snapshot | workspace 状态快照（`latest_seq` 必填，事件回放锚点） | [Workspace_Snapshot_And_Recovery_Spec](../docs/03_SPEC/Workspace_Snapshot_And_Recovery_Spec.md) |

## 5. 治理与控制

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| 策略门 | policy gate | 工具注册层自建的集中拦截闸（Zero hooks 仅观测，不能否决） | [Control_Kernel](../docs/02_ARCHITECTURE/Control_Kernel.md) §5 + ADR-0001 |
| 语义级别 | `semantic_level` | 科学变更风险分级（决定是否触发 PI gate） | [Scientific_Change_Gating_Spec](../docs/03_SPEC/Scientific_Change_Gating_Spec.md) |
| 输出语义下限 | output_semantics floor | 特定类别变更的最低语义级别地板 | 同上 |
| PI 门 | PI gate | 高风险动作阻塞等待 PI 显式决策的状态 | 同上 + [PI_Decision_Comments_Spec](../docs/03_SPEC/PI_Decision_Comments_Spec.md) |
| 决策卡 | decision card | *_review 门的结构化选项卡（3 实分支 + 推荐 + 自由输入，仿 AskUserQuestion） | [Theory_To_Code_Governance_Spec](../docs/03_SPEC/Theory_To_Code_Governance_Spec.md) §5.0 |
| 停机条件 | stop conditions | Control Kernel 的确定性终止判据集 | Control_Kernel §5 |
| 无进展判定 | no-progress detector | 停机条件之一：重复无效动作检测 | Control_Kernel §5.1 |
| 新颖失败预算 | novelty-failure budget | 同类新颖失败 ≤3 次即停 | Control_Kernel §5.1 |
| 冻结 | spec freeze | 规格面封版（2026-07-02）：仅收 bug 修正与 ADR 例外 | [Phased_Spec_Activation](../docs/Phased_Spec_Activation.md) 头部 |
| 投影 | projection | 权威源之外的 schema 副本，只读、改动先落权威源 | [CANONICAL_CONTRACTS](../docs/00_INDEX/CANONICAL_CONTRACTS.md) §3 |
| 权威源 | canonical source | 每类工程事实的唯一定义处 | 同上 §1 |
| 推理预算 | `InferenceBudget` | cheap/normal/deep 三档软监控，PI 决定中止 | [Cost_Inference_Budget](../docs/03_SPEC/Cost_Inference_Budget.md) |
| 拒绝即教学 | `remediation` | 拒绝载荷必携机器可行动指引（next_action/hint/ref） | [Support_Schema_Contracts](../docs/03_SPEC/Support_Schema_Contracts.md) §3 + Control_Kernel §5 |
| 权威/能力护栏 | `guard_class: authority \| capability` | 权威护栏永不退役；能力护栏随模型换代减重 | [Control_Kernel](../docs/02_ARCHITECTURE/Control_Kernel.md) §5.2 |
| 减重审查 | slimming review | 模型升级 + eval 达标后对 capability 护栏的退役评估 | [Agent_Behavior_Eval_Spec](../docs/04_IMPLEMENTATION/Agent_Behavior_Eval_Spec.md) §4 |

## 6. Theory-to-Code（T2C）

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| 理论到代码束 | `TheoryToCodeBundle` | 假设→公式→数值方案→实现→验证的治理链对象（8 状态） | [Theory_To_Code_Governance_Spec](../docs/03_SPEC/Theory_To_Code_Governance_Spec.md) |
| 方程规范 | `EquationSpec` | 公式、符号、单位、维度检查与推导记录 | [Equation_And_Derivation_Spec](../docs/03_SPEC/Equation_And_Derivation_Spec.md) |
| 数值方案 | `NumericalSchemeSpec` | 离散化、通量/源汇项、边界条件、守恒预期 | [Numerical_Scheme_Spec](../docs/03_SPEC/Numerical_Scheme_Spec.md) |
| 实现映射 | `ImplementationMapping` | equation_id/symbol_id → 代码文件/函数/变量映射 | [Implementation_Mapping_Spec](../docs/03_SPEC/Implementation_Mapping_Spec.md) |
| 验证用例 | `VerificationCase` | verification/validation/calibration 三界清晰的验证单元 | [Verification_Case_Spec](../docs/03_SPEC/Verification_Case_Spec.md) |
| 准入搜索 | `accepted_for_search` | bundle 状态：允许下游校准/搜索的前置门 | [Controlled_Search_Boundary_Spec](../docs/03_SPEC/Controlled_Search_Boundary_Spec.md) |
| 校准 ≠ 结构验证 | calibration vs structural validation | 校准结果必须标注 calibration，不得表述为模型结构改进 | Verification_Case_Spec + CLAUDE.md Governance Rules |
| 已知答案回放 | known-answer replay | 首任务模式：从兄弟项目 openMP 抽取已完成变更，经 Harness 治理链路重走，用既有 ground truth 评价 Harness 正确性 | [ADR-0002](../docs/adr/0002-mvp-reality-anchoring.md) D3/D4 |

## 7. 记忆与技能

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| 记忆两级 | two-tier memory | 普通笔记直写 draft；证据类需 PI review | [Memory_Skills_Lite](../docs/03_SPEC/Memory_Skills_Lite.md) |
| 记忆状态机 | draft / accepted / retired | 领域侧状态；映射 Zero 原生 draft/verified/archived/conflict | 同上 §2.1 |
| 技能三阶段 | draft → active → retired | Skill 生命周期，不搞 6 级 | 同上 |
| 周期清扫 | gardening / sweep | 周期 job 提名过时笔记/技能的退休候选，PI 批准 | 同上 §9 |
| 清扫半衰期 | cleanup half-life | 退休候选产生→处置的中位时长（清扫有效性指标） | 同上 §9 |

## 8. UI 与交互

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| 工作台 | workbench | 唯一交互主界面（workbench-first 双通道） | [Interaction_Model](../docs/02_ARCHITECTURE/Interaction_Model.md) §7 |
| C 栏 | process column | 过程性、全量执行流（日志/事件） | [UI_Implementation_Spec](../docs/03_SPEC/UI_Implementation_Spec.md) |
| D 栏 | conclusion column | 结论性、精选产出（报告/图表），与 C 栏不重复渲染同图 | 同上 |
| 输入栏 | `PIInputBar` | PI 自然语言输入入口 | 同上 §4 |
| 建议动作 | `NextSuggestedAction` | 建议即草稿：填入输入栏，无隐式执行 | 同上 |
| 决策面板 | `PIDecisionPanel` | 仅 awaiting_pi/pending-gate 渲染决策按钮；running 只给 Pause/Park | 同上 |
| 任务优先导航 | task-first SideNav | 左导航以任务列表为主 + 对象视图 | 同上 §4.1 |

## 9. 水文领域

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| SHUD | — | C++14 FVM 分布式水文模型（SUNDIALS/CVODE 求解） | [SHUD_Codebase_Report](../docs/01_CODEBASE/SHUD_Codebase_Report.md) |
| rSHUD | — | R 前后处理工具包（v2.5.0，228 导出函数） | [rSHUD_Codebase_Report](../docs/01_CODEBASE/rSHUD_Codebase_Report.md) |
| AutoSHUD | — | R 自动化流水线（Step0.1 可选 + Step1–5，配置驱动） | [AutoSHUD_Codebase_Report](../docs/01_CODEBASE/AutoSHUD_Codebase_Report.md) |
| 水量平衡 | water balance | 质量守恒校验，rSHUD `wb.all()` | rSHUD_Codebase_Report |
| 敏感性分析 | sensitivity analysis | AnalysisPlan 一等模式（`mode=sensitivity`） | [Sensitivity_Calibration_Benchmark](../docs/03_SPEC/Sensitivity_Calibration_Benchmark.md) |
| 示例流域 | ccw / heihe / qhh | SHUD 自带示例工程；ccw tiny 为 Phase 3 最小验证床 | SHUD_Codebase_Report |
