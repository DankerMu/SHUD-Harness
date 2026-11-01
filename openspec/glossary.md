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
| 任务卡 | `TaskCard` | 研究任务根对象；M3 science_assist 以品牌 TASK id 保存于会话工作区 `tasks/<task_id>/task.json`，聚合运行/报告引用并由确定性状态机推进，不经 ctx.storage | [Minimal_Schemas](../docs/03_SPEC/Minimal_Schemas.md) + [M3 task-cards](specs/task-cards/spec.md) |
| 栈锁 / 版本锁 | `StackLock` | 品牌 StackId 的复现性快照：SHUD/rSHUD/AutoSHUD 修订、dirty_paths 与截断标记，最小 runtime（os/sundials_version/host_version）及 harness.version；llm 恰为 base_url/request_alias/response_model，响应模型只记录且排除出指纹，不再保留旧字段两态 | [Minimal_Schemas §2](../docs/03_SPEC/Minimal_Schemas.md#2-stacklock) + [M3 stack-lock](specs/stack-lock/spec.md) |
| 数据溯源 | `DataProvenance` | 输入数据来源、许可与预处理链记录 | 同上 |
| 运行作业 | `RunJob` | 一次 SHUD 执行的提交单元（`backend` 枚举在此定义） | 同上 |
| 运行记录 | `RunRecord` | 作业 collect 后的不可变结果记录（T2 证据载体） | 同上 |
| 分析计划 | `AnalysisPlan` | 敏感性/校准/基准分析的批量执行计划（`mode=sensitivity` 一等公民） | 同上 |
| 证据报告 | `EvidenceReport` | 供 PI 决策的规范 JSON 对象 `reports/<report_id>.json`（品牌 REPORT id，含 decision_history）；同名 `.md` 为确定性渲染投影 | [M3 evidence-reports](specs/evidence-reports/spec.md) |
| 变更请求 | `ChangeRequest` | 代码/参数变更的 patch 载体，走科学分级门 | [Minimal_Schemas](../docs/03_SPEC/Minimal_Schemas.md) |
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
| 上下文压缩 | `ctx.compaction` | 基座机制，MVP 不自定义（dsh compaction seam，默认后端 `dsh-compaction-basic`，见 dsh `docs/subsystems/compaction.md`）；领域侧唯一允许的 LLM 压缩形态是落盘的 session digest | [Context_Trust_And_Injection_Spec](../docs/03_SPEC/Context_Trust_And_Injection_Spec.md) §5.1 |
| 上下文预算 | context budget | 领域侧分阶段组装预算；基座窗口阈值（dsh `dsh-compaction-basic` 的 `thresholdRatio`/`retainRatio`/`retainTokens`）为基座机制，MVP 不自定义 | Context_Trust_And_Injection_Spec §5 |
| 上下文组装 | context assembly | 按信任级与预算拼装 agent 输入 | Context_Trust_And_Injection_Spec §5 |

## 4. 执行与恢复

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| 收纳 / 挂起 | park | 长任务提交后 agent 退出、状态落盘 | [Park_Resume_Design](../docs/03_SPEC/Park_Resume_Design.md) |
| 恢复 | resume | 作业完成通知后恢复 agent 上下文续跑 | 同上 |
| 收集 | collect | M2：终态后由注册表自动或经 `shud_collect` 走同一收集路径，扫描产物元数据并生成 RunRecord；有效同身份 `run-record.json` 原样返回，生成失败记 `collect-error.json`。排他锁在 `stateDir`、索引修改串行；job 级 `collect.lock` 是后续 TaskCard/job 布局，M2 不使用 | [M2 design D2/D6/D7](changes/archive/2026-10-27-m2-run-chain/design.md) + [Park_Resume §5](../docs/03_SPEC/Park_Resume_Design.md#5-collect-阶段)、[§8](../docs/03_SPEC/Park_Resume_Design.md#8-幂等与锁) |
| 看护进程 | watcher | 两态：M2 由注册表内唯一进程内轮询循环推进结算、收集与通知，不另起 watcher 进程；后续里程碑保留独立看护进程术语（含 Docker/SLURM 方向），不据此推导 M2 实现 | [M2 design D7](changes/archive/2026-10-27-m2-run-chain/design.md) + [Park_Resume §4 Job watcher](../docs/03_SPEC/Park_Resume_Design.md#4-job-watcher) |
| 作业注册表 | `JobRegistry` / `ctx.jobs` | dsh 后台作业 seam；SHUD 自写 durable backend（detach + pid 对账）替换 `jobs-local` | [ADR-0004](../docs/adr/implemented/0004-dsh-kernel.md) K8 + 上游 `docs/subsystems/jobs.md` |
| 退出类别 | `exit_class` | RunRecord 对退出证据的九类归因：数值退出码确定分类，缺码时显式 cancelled/lost；仅 ok 对应 succeeded | [RunRecord 契约](specs/run-records/spec.md#requirement-runrecord-record) + [Minimal_Schemas §5](../docs/03_SPEC/Minimal_Schemas.md#5-runrecord) |
| 运行目录 | `run_dir` | RunJob 的绝对运行目录，取代 cwd；提交时位于 `<session cwd>/runs/<run_id>`，保存输入副本与运行记录 | [Minimal_Schemas §4](../docs/03_SPEC/Minimal_Schemas.md#4-runjob) |
| 宿主登记作业 ID | `dsh_job_id` | 当前宿主进程中的 `shud-` + 16 位十六进制登记标识，供 job_output/job_kill 使用；重启接管可变化，不等同持久 job_id/run_id，历次值存入 dsh_job_ids | [运行标识符契约](specs/run-records/spec.md#requirement-run-identifiers) + [Minimal_Schemas §4](../docs/03_SPEC/Minimal_Schemas.md#4-runjob) |
| 发件箱 | outbox | 通知先落盘后发送的事务化模式（防蒸发） | [Notification_Design](../docs/03_SPEC/Notification_Design.md) §8 |
| 去重键 | `dedupe_key` | 通知幂等键：`task_id + trigger + target_id + recipient` | 同上 §5 + [Idempotency_Concurrency_Locking_Spec](../docs/03_SPEC/Idempotency_Concurrency_Locking_Spec.md) §4 |
| 快照 | snapshot | workspace 状态快照（`latest_seq` 必填，事件回放锚点） | Workspace_Snapshot_And_Recovery_Spec（已删，见 tag archive/zero-v0.8.3） |

## 5. 治理与控制

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| 策略门 | policy gate | `tools/pre-execute` waterfall 监听器返回 `deny`/`ask`/`allow`；`ctx.tools.guard()` 作单调终局拒绝 | [ADR-0004](../docs/adr/implemented/0004-dsh-kernel.md) + 上游 `docs/tool-execution-pipeline.md` |
| 语义级别 | `semantic_level` | 科学变更风险分级（决定是否触发 PI gate） | [Scientific_Change_Gating_Spec](../docs/03_SPEC/Scientific_Change_Gating_Spec.md) |
| 输出语义下限 | output_semantics floor | 特定类别变更的最低语义级别地板 | 同上 |
| PI 门 | PI gate | 高风险动作阻塞等待 PI 显式决策的状态 | 同上 + [PI_Decision_Comments_Spec](../docs/03_SPEC/PI_Decision_Comments_Spec.md) |
| PI 门决定 | `PiGateDecision` | M3 报告 decision_history 条目：decision_id/report_id/approval_ref/outcome/comment/decided_at；只在工具获 allowed-once 后记录，approval_ref 为本次 callId，经 session log 关联审批；accepted 的 comment 为 null，其余非空 | [M3 evidence-reports](specs/evidence-reports/spec.md#requirement-pigatedecision-record) |
| 决策卡 | decision card | *_review 门的结构化选项卡（3 实分支 + 推荐 + 自由输入，仿 AskUserQuestion） | [Theory_To_Code_Governance_Spec](../docs/03_SPEC/Theory_To_Code_Governance_Spec.md) §5.0 |
| 停机条件 | stop conditions | Control Kernel 的确定性终止判据集 | Control_Kernel §5 |
| 无进展判定 | no-progress detector | 停机条件之一：重复无效动作检测 | Control_Kernel §5.1 |
| 新颖失败预算 | novelty-failure budget | 同类新颖失败 ≤3 次即停 | Control_Kernel §5.1 |
| 冻结 | spec freeze | 规格面封版（2026-07-02）：仅收 bug 修正与 ADR 例外 | Phased_Spec_Activation 头部（已删，见 tag archive/zero-v0.8.3） |
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
| 已知答案回放 | known-answer replay | 首任务模式：从兄弟项目 openMP 抽取已完成变更，经 Harness 治理链路重走，用既有 ground truth 评价 Harness 正确性 | [ADR-0002](../docs/adr/implemented/0002-mvp-reality-anchoring.md) D3/D4 |

## 7. 记忆与技能

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| 记忆两级 | two-tier memory | 普通笔记直写 draft；证据类需 PI review | [Memory_Skills_Lite](../docs/03_SPEC/Memory_Skills_Lite.md) |
| 记忆状态机 | draft / accepted / retired | 领域侧状态；agent 不可自提 accepted | 同上 §2 |
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

## 10. dsh 运行时（内核术语）

| 中文 | 标识符 | 定义 | 权威出处 |
|---|---|---|---|
| 内核 | dsh / DeepSeek Harness | Cordis 插件树上的 agent 运行时，钉 tag `dsh-v0.2.1-rc.2` | [ADR-0004](../docs/adr/implemented/0004-dsh-kernel.md) K1 |
| 配置档 | profile | `$DSH_HOME/profiles/<name>` 下按序叠加的 bundle + 用户 patch 组合；本项目 = `shud` | 上游 `docs/architecture.md` Profiles and bundles |
| 包束 | bundle | 携带 Cordis 配置行与代码的分发单元，`package.json` 的 `dsh.bundle` 指向 patch 文件 | 同上 |
| 覆盖 | patch / overlay | `cordis.patch.yml` 或 `--patch` 文件：按 id 整体替换某行 config 或 `insert` 新行 | 同上 |
| 接缝 | seam | 可替换能力的三角：Service Definition + Provider + Consumer；新行为只挂文档化 seam | 上游 `docs/architecture.md` Capability seams |
| 瀑布事件 | waterfall | 监听器必须调用 `next()` 才向下传递的事件（`agent/pre-step`、`tools/pre-execute` 等） | 上游 `docs/cordis-primer.md` |
| 代理预设 | agent preset | 给一个 session 不同能力集的组合（角色落点：coordinator/worker/coder/reviewer） | 上游 `docs/subsystems/subagent.md` |
| 审批接缝 | `ctx.approval` | fail-closed 的一次性审批：`ask` → `approval/asked` → `approval/decided`；Web 卡片现成 | 上游 `docs/subsystems/approval.md` |
| 沙箱模式 | `read-only` / `workspace-write` / `danger-full-access` | 每次调用解析的文件效应策略；macOS Seatbelt 后端；`data/raw` 置于 root 之外即只读 | 上游 `docs/subsystems/sandbox.md` |
| 会话日志 | session log（`session.v4.jsonl`） | append-only 事实源，模型可见即已记录；回放 fixture 来源 | 上游 `docs/architecture.md` Session log |
| 会话日志上报 | `session-log-deepseek` | 把会话日志作为 `dsh_session_log` 随 official-route 请求发往端点；本项目关闭 | ADR-0004 K9 |

