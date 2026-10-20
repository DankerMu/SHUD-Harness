---
status: approved（PI 2026-10-20）
---

# docs/ 文档处置表（Zero → dsh 内核切换）

- **日期**：2026-10-20 · 范围：`docs/**/*.md` 共 343 份；`docs/99_ARCHIVE/` 225 份已归档、不动、不逐条列出；根目录 `AGENTS.md`/`CLAUDE.md` 不在范围。本表逐条处置其余 **118 份**。
- **留**：定义/被引用于 8 核心对象及其 schema、治理规则（Research_Constitution / 角色边界 / PI gate / 敏感性语义 / 科学不变量）、三仓库现实报告、ADR、运行时无关的测试策略、MVP 首任务定义——内容与运行时无关，dsh 下直接复用。
- **删**：绑定 Zero（Reuse_Matrix / 扩展图 / adapter / Zero hooks）、绑定 Hono/React/WebSocket 传输与框架层、绑定已放弃的 M2 capability-observer spike、被新计划取代的日历/里程碑计划、所指对象已删的索引。
- **删-记**：文件本身无未来用途，但含 1–2 条值得写进 ADR-0004 的决定/数字/治理细节，Notes 列给出待搬运的一行，末节「删-记 汇总」已分组，供 ADR-0004 附录/「后果」节吸收。

**计数**：留 69 · 删 27 · 删-记 22 （合计 118）。另附 `openspec/changes/` 与根目录构建残留两节（不计入 118）。

**判定依据补充（ADR-0004 `adr/0004-dsh-kernel.md`，accepted 2026-10-20）**：
1. **K2/K7：自建 Hono 后端与 React 前端退场，MVP 零自定义 UI**（用 dsh 自带聊天/审批卡/作业卡 + Markdown 报告文件）→ 工作台/图表/前端状态/REST/WS 等所有界面与传输层 spec 判删，只把其中的治理细节以 删-记 搬运。**例外**：PI 已在 grill 中给出 post-MVP UI 意图（设置页 / 聊天卡片 / 右侧栏面板 / 可折叠 terminal，见 ADR-0004 开放项），因此 `UX_Design_Spec` / `Interaction_Model` / `UI_Implementation_Spec` 三份改判 **留**，作 post-MVP UI 设计输入，只剪 Hono/React/WS 实现段；`Visualization_Data_Spec` 维持 删-记，因其 §1 报告图纪律属 M3 EvidenceReport 范围、与 UI 无关，已搬运。
2. **K10：插件 = TypeScript + Zod**（pnpm workspace + tsc）→ Zod schema、`generated/schema`、`Schema_Generation_And_Drift_Control` 直接复用；但 Bun/React/Hono/DuckDB 相关依赖策略作废。
3. **K5：首任务 = ccw 运行 → RunRecord → EvidenceReport（无代码改动），openMP RHS 回放为第二任务** → ccw tiny 定义（`Test_Fixtures_And_Command_Matrix §4` + `SHUD_Output_Variables §13`）必留；ChangeRequest / VerificationCase 规范留但后移。K11 MVP 不做记忆 → `Memory_Skills_Lite` 留作 post-MVP 设计；K6 单用户维持 → Auth 相关只留 PI gate 语义。
4. **基线与并行写入**：本表基线 = 盘点时刻 `docs/` 343 份。盘点后工作区新增 3 份 dsh 时代文件不在基线、不处置：`adr/0004-dsh-kernel.md`、`Migration_Plan_dsh.md`、`04_IMPLEMENTATION/Port_List.md`；另 `04_IMPLEMENTATION/Phased_Plan.md` 与 `Repository_Layout.md` 已在工作区被就地重写为 dsh 版（未提交），其行的处置针对 HEAD 版 Zero 内容，路径本身保留。
5. M2 capability-observer spike（git-status-capability / descriptor mediation / fd authority / dirty-state observer）相关关键词在 `docs/` 内 **零命中**——这些材料在 `openspec/`，不在本表范围；仅 ADR-0001 revisit 记录涉及 M1 policy-gate spike，按 ADR 保留。

---

## 00_INDEX/

| 文件 | 处置 | 一句理由 | Notes |
|---|---|---|---|
| 00_INDEX/Adversarial_Design_Review_v0_8_3.md | 删-记 | 审查快照，发现已全部处置 | 搬运：①门禁不得消费 LLM 自报字段（floor 输入须来自 diff/CLI 等确定性来源）；②每个"强制"声明必须标注 enforcement point，标不出的降为"约定 + eval 兜底" |
| 00_INDEX/Agent_System_Audit_v0_8_3.md | 删-记 | 审计快照，P0 已落 spec | 搬运：审计透镜"治理了 agent 的手脚、未治理大脑"——LLM 模型（含 base_url）进 StackLock、semantic_level 不得自分类、PI 中途介入语义、注入威胁模型（T0–T4）、行为 eval ≠ 测试；五项均已成 canonical spec |
| 00_INDEX/CANONICAL_CONTRACTS.md | 留 | canonical 源优先级规则仍适用 | 需剪掉 §4 API registry、§5 WebSocket registry、§11–14 运维段（Hono/WS/ops 所指已删）；§1 源顺序改写为"代码 schema → 生成文档 → 手写语义" |
| 00_INDEX/GAP_ANALYSIS.md | 删 | v0.5 历史快照，已被 01_CODEBASE 取代 | 文内已自标过时；§3.1/3.2 结论已落 Test_Fixtures §4 与 SHUD_Output_Variables |
| 00_INDEX/MASTER_INDEX.md | 删 | 索引所指过半被删，需重建 | 重置后按新目录重生成；勿保留旧 107 份清单 |
| 00_INDEX/PRD_Spec_Gap_Audit_v0_8_2.md | 删 | v0.8.2 缺口审查，产物已入库 | 其催生的 ops/NFR 文档本表多数判删 |
| 00_INDEX/PRD_Spec_Merge_Map.md | 删 | 一次性合并地图，已执行 | — |
| 00_INDEX/Requirements_Catalog.md | 留 | 需求目录含 GR/DR/TR 治理需求 | 需剪掉 Web/API/健康检查类 FR 与 NFR-OBS/PERF 行；IR-001 去掉 Zero submodule；§6 T2C 需求保留 |
| 00_INDEX/Requirements_Numbering_Conventions.md | 留 | 编号体系与运行时无关 | §1 IR 示例去掉 Zero |
| 00_INDEX/Spec_Gap_Audit_v0_8_1.md | 删-记 | 审查快照，缺口已补 | 搬运 §2 五条"不再推翻"：8 对象不扩张；support object 不升核心；实时通道非证据存储；batch progress 从 AnalysisPlan+RunJob+RunRecord 派生不引 workflow engine；PI comment 是决策记录非科学事实、默认 generalization_allowed=false |
| 00_INDEX/Theory_To_Code_Merge_Map.md | 删 | 一次性合并地图，已执行 | — |
| 00_INDEX/Theory_To_Code_Rationale.md | 留 | T2C 治理层设计理由，科学不变量 | status 虽为 snapshot，§2 风险表 + §3 五条规则是"搜索后置"原则唯一完整论证；可移入 02_ARCHITECTURE |
| 00_INDEX/Theory_To_Code_Requirements_Addendum.md | 删 | 已并入 Requirements_Catalog §6 | 已核验：FR-TC-001 等编号在 Catalog 中存在 |

## 01_CODEBASE/

| 文件 | 处置 | 一句理由 | Notes |
|---|---|---|---|
| 01_CODEBASE/AutoSHUD_Codebase_Report.md | 留 | AutoSHUD 代码现实报告 | 基线 f421445；§8 与 Domain_CLI 交叉校验保留 |
| 01_CODEBASE/rSHUD_Codebase_Report.md | 留 | rSHUD 代码现实报告 | 基线 2b7742e v2.5.0 |
| 01_CODEBASE/SHUD_Codebase_Report.md | 留 | SHUD 代码现实报告 | 基线 3aec657；§7 Harness 接口 + §8 Domain_CLI 校验保留 |
| 01_CODEBASE/Zero_Codebase_Report.md | 删 | Zero 基座报告，基座已弃 | 2026-04-24 快照（af44a7c 时代），连 13e25c1 事实都已过时 |

## 02_ARCHITECTURE/

| 文件 | 处置 | 一句理由 | Notes |
|---|---|---|---|
| 02_ARCHITECTURE/Agent_Architecture.md | 留 | 角色协作与 closure 判据，运行时无关 | 需剪掉 :9 适用范围"Zero AgentLoop 扩展"、:97/:146 影响面列表中的 Zero、:228 "沿用 Zero task-closure"改为通用表述（分类器仅 advisory 的规则本身保留） |
| 02_ARCHITECTURE/Architecture_Decisions.md | 留 | Lite MVP 定位、三类任务、非目标 | 无运行时绑定 |
| 02_ARCHITECTURE/Control_Kernel.md | 留 | 状态机、no-progress 判定、guard_class | 需剪掉 §5 :122–126 "ZeroHarnessAdapter.beforeToolCall / ToolBase.beforeExecute 注入点"段，改为"工具注册层横切点"抽象表述；:191 "Zero 原生 + 领域工具"改"基座原生 + 领域工具"；§5.1/§5.2/§5.3 全部保留 |
| 02_ARCHITECTURE/Interaction_Model.md | 留 | post-MVP UI 设计输入（PI 已给四项意图）；§7.1 介入语义 M3 即用 | 需剪掉 Hono API / WS 段，四栏布局改标"post-MVP 参考"；§7.1 PI 介入三级语义：append（入队、下一轮前注入）/ interrupt（当前工具调用完成后重规划）/ abort（取消任务并 cancel 运行中 job）；"agent 在思考 / job 在跑 / 任务已 parked"三态必须对 PI 可见，parked 期间输入保存并在 resume 时注入 |
| 02_ARCHITECTURE/Module_Status_Matrix.md | 删 | [E]/[O]/[N] 全部相对 Zero 标注 | §4 不做清单已由 Phased_Plan Post-MVP 搬运行覆盖 |
| 02_ARCHITECTURE/Research_Constitution.md | 留 | 科研宪法，核心治理 | 头部"权威规格见 SPEC_v0.8_Final §3"指针需改向本文自身或 Scientific_Change_Gating |
| 02_ARCHITECTURE/Roles_and_Boundaries.md | 留 | 角色枚举唯一权威源 | 需剪掉 :100 "Zero Explorer 角色的受限映射"、:106 影响面中的 Zero |
| 02_ARCHITECTURE/Zero_Reuse_Matrix.md | 删-记 | Zero 复用/扩展/adapter 决策 | 搬运 §9 "必须覆盖的基座默认行为"（对 dsh 同样成立）：memory 创建不得自动 verified；LLM closure 分类器仅 advisory、不作状态迁移依据、不可覆盖 validator 拒绝；bash 工具无内置安全、沙箱约束全由 harness 侧施加 |

## 03_SPEC/

| 文件 | 处置 | 一句理由 | Notes |
|---|---|---|---|
| 03_SPEC/Alerting_Thresholds_Spec.md | 删-记 | 告警面绑定 dashboard/DuckDB/WS/API | 搬运通用阈值：job 无日志更新 5 min warning / 20 min stale error；磁盘 <10% warn、<5% 或 <5GB 阻新 job；单 task LLM 成本 >3× advisory 仅标黄不中断；日 LLM cap 超限暂停新任务、不杀运行中；生成物检出 secret 模式 → 隔离 artifact + incident |
| 03_SPEC/Artifact_Registry_Spec.md | 留 | evidence_usable 与不可变性规则 | 需剪掉 §7 Artifact API（REST）；§4/§6 是 EvidenceReport 证据链地基 |
| 03_SPEC/Auth_Permission_Design.md | 留 | PI gate 权限语义与 agent 权限 | ADR-0002 D6 单用户：需剪掉 §5 Session/§6 API key 与 small_team 模式；保留 §3 权限矩阵、§4 PI gate、§7 Agent 权限、§8 审计 |
| 03_SPEC/Batch_Progress_View_Spec.md | 删 | 批进度 UI 组件（K7），敏感性亦后移 | AnalysisProgressPayload 字段源在 Support_Schema_Contracts §9（留） |
| 03_SPEC/Config_Secrets_And_Environment_Spec.md | 留 | 配置层级/SecretRef/脱敏/StackLock 环境 | 需剪掉 §7 Observability 环境变量、§8 Dependency config；§4 `GLM_API_KEY` 行 → `DMXAPI_KEY`（K3）；§5 redaction 与 §6 StackLock 环境关联是不变量 |
| 03_SPEC/Context_Trust_And_Injection_Spec.md | 留 | T0–T4 信任分级，agent 安全核心 | 需剪掉 :133–135 "实现载体 zero@13e25c1 context_compression" 段 |
| 03_SPEC/Controlled_Search_Boundary_Spec.md | 留 | 搜索后置治理，baseline-first | ADR-0002 D5：MVP 仅 schema 占位，但规则本身保留 |
| 03_SPEC/Cost_Inference_Budget.md | 留 | 软预算哲学（设计决策 6） | 需剪掉 §6 状态栏/§9 WebSocket 成本事件的传输细节；三档 USD 待实测校准（账本例外批次 4） |
| 03_SPEC/Data_Package_And_Retention_Spec.md | 留 | 证据包/retention/清理护栏 | 无运行时绑定 |
| 03_SPEC/Data_Storage_Provenance.md | 留 | DataProvenance + raw 不可变（§7） | 核心对象 + 科学不变量 |
| 03_SPEC/Domain_CLI_Spec.md | 留 | T2 证据唯一生产通道，三仓库版本治理 | 完全运行时无关，dsh 下价值最高的 spec 之一 |
| 03_SPEC/Equation_And_Derivation_Spec.md | 留 | T2C 公式/符号/单位/推导 | — |
| 03_SPEC/Error_Handling_Spec.md | 留 | 错误分类、RunJob 失败规则、LLM 降级 | 需剪掉 §9 WebSocket 错误事件、§10 Ops 错误规则中的 dashboard 部分；canonical_for llm-error-degradation 保留 |
| 03_SPEC/Execution_Jobs_Runs.md | 留 | RunJob 状态机、Park/Resume、RunRecord | 核心对象语义 |
| 03_SPEC/Frontend_State_Design.md | 删 | React store + WebSocket reducer | 框架层（K2/K7） |
| 03_SPEC/Idempotency_Concurrency_Locking_Spec.md | 留 | 幂等键、锁、状态单调性 | generated/schema 有 lock-record / idempotency-record 投影 |
| 03_SPEC/Implementation_Mapping_Spec.md | 留 | equation_id → code_target 映射 | T2C 核心 |
| 03_SPEC/Internationalization_Localization.md | 删-记 | i18n 全量已列 Post-MVP | 搬运：代码/schema/文件名/API 英文；UI 文案与报告正文中文；单位不翻译只解释；变量注册表双语显示名 |
| 03_SPEC/Log_Aggregation_Spec.md | 删-记 | 绑定 DuckDB 聚合与 WS 事件 | 搬运：结构化日志必带 request_id/task_id/job_id/run_id 关联键并经 redaction |
| 03_SPEC/Memory_Skills_Lite.md | 留 | 两级记忆、三阶段 skill；K11 后移 | 需剪掉 §2.1 "Zero 上游状态机映射" 与 :171 "Zero 默认 verified 行为"措辞（规则保留：evidence_note 不得自动 accepted） |
| 03_SPEC/Minimal_Schemas.md | 留 | 8 核心对象字段唯一权威源 | 需剪掉 :71 StackLock.repos.zero 条目、:93 "Zero 原生支持"模型路由备注；spec 更新债：StackLock.llm 按 K4 改为三字段（base_url + 请求别名 + 响应 model），RunRecord 记录响应 model |
| 03_SPEC/Multiuser_Harness_Versioning.md | 删-记 | ADR-0002 D6 已停用 | 搬运 §4–5：Harness 自身版本（runtime/prompt_pack/skills/policy/report_template）进 StackLock.harness；prompt/skill 更新后须跑 tiny smoke |
| 03_SPEC/Notification_Design.md | 留 | ADR-0002 D7 邮件通知未被 K 列推翻 | 触发点/dedupe/outbox 设计运行时无关；若 K8 的 dsh 完成通知足够则可降为删-记 |
| 03_SPEC/Numerical_Scheme_Spec.md | 留 | T2C 数值离散规范 | — |
| 03_SPEC/Observability_Monitoring_Spec.md | 删 | 健康端点/WS 事件/ops dashboard/DuckDB | 原则 §1.2 "运维指标不能替代 RunRecord" 已在 Runbook 搬运行覆盖 |
| 03_SPEC/Operational_UX_Addendum.md | 删 | 四项 ops-UX 的伞形导读 | 四项各有专属 spec |
| 03_SPEC/Parameter_Set_And_Analysis_Run_Mapping.md | 留 | AnalysisPlan↔RunJob/RunRecord 映射 | 敏感性语义 |
| 03_SPEC/Park_Resume_Design.md | 留 | 长任务 Park/Resume（决策 4） | 需剪掉 :142–144 "实现缝 zero BackgroundToolTaskSink" 段 |
| 03_SPEC/Performance_NFR_Spec.md | 删 | REST P95 / WS SLA / 前端性能 | tiny run < 2 min 已随 SPEC §7 搬运行保留 |
| 03_SPEC/PI_Decision_Comments_Spec.md | 留 | PI gate 决策动词与批注规则 | 需剪掉 §2 canonical endpoint、§7 UI（改为 dsh 审批卡字段）；canonical_for pi-decision-verbs 保留 |
| 03_SPEC/Preflight_And_Mutation_Boundary_Spec.md | 留 | 变更边界、preflight 是 submit 前的门 | ADR-0001 裁决引用其 A03-5 分工 |
| 03_SPEC/Report_Export_Spec.md | 删-记 | standalone HTML 导出 UI 功能（K7） | 搬运 §4：报告文件必须按状态带可见水印（draft/reviewed/awaiting_pi → "DRAFT — not accepted by PI"；revision_requested / rejected / archived 各自标注，archived 按归档前终态），水印为正文一部分不可仅靠样式隐藏；导出只含 evidence_usable artifact |
| 03_SPEC/Report_Generation_Spec.md | 留 | 语言护栏、证据等级、Reviewer 清单 | canonical_for language-guard |
| 03_SPEC/Report_Review_And_Evidence_Lineage_Spec.md | 留 | 报告陈述 → 证据来源追溯 | — |
| 03_SPEC/Research_Object_Model.md | 删-记 | 已降级非 canonical | 搬运 §3 v0.5→v0.6 对象合并表：EnvLock/HarnessLock→StackLock；DatasetManifest/ObservationManifest/PreprocessRecipe→DataProvenance；CalibrationSpec/HoldoutPolicy/BenchmarkPolicy→AnalysisPlan；JobSpec→RunJob；RunManifest/ArtifactManifest→RunRecord；EvidencePacket/ValidationReport→EvidenceReport；ChangeSpec/OutputContract/CompatibilitySuite/HumanGate/ReleaseGate→ChangeRequest |
| 03_SPEC/Runner_Adapter_Contracts.md | 留 | 执行后端统一接口，非 Zero adapter | 注意：criteria 的"adapter 设计"指 ZeroHarnessAdapter，本文是 local/docker/slurm runner 契约，Park/Resume 依赖 |
| 03_SPEC/Sandbox_and_Executor.md | 留 | 沙箱原则、trace、回滚 | ADR-0001 裁决（OS 沙箱层 byte authority）落点 |
| 03_SPEC/Scientific_Change_Gating_Spec.md | 留 | 语义分级 + gate matrix + floor | 治理核心 |
| 03_SPEC/Sensitivity_Calibration_Benchmark.md | 留 | 敏感性一等公民（决策 9） | — |
| 03_SPEC/Sensitivity_Calibration_Benchmark_Addendum.md | 留 | 三类分析边界与报告语言 | 需剪掉 §6.1 batch progress view 的 UI 细节（指向 Batch_Progress_View_Spec 即可） |
| 03_SPEC/SHUD_Output_Variables.md | 留 | 输出变量注册表 + §13 阈值 | 需剪掉 §8 前端默认展示；§13 water_balance_residual ≤0.01 / cvode_failures=0 是 ccw tiny 验收数值的 canonical 位置 |
| 03_SPEC/Support_Schema_Contracts.md | 留 | support schema 唯一权威源 | 需剪掉 §13–17 运维 schema（HealthStatus/MetricSample/AlertRule/OpsIncident/DependencyLock）；§18 T2C schema 保留 |
| 03_SPEC/Theory_To_Code_Governance_Spec.md | 留 | T2C 主链与 bundle 状态机 | — |
| 03_SPEC/Theory_To_Code_Report_Lineage_Spec.md | 留 | 报告 T2C 证据章与语言护栏 | — |
| 03_SPEC/Theory_To_Code_Support_Schemas.md | 删 | 自称投影附录，字段源在 Support §18 | 已核验 TheoryToCodeBundle 在 Support_Schema_Contracts 中定义 |
| 03_SPEC/UI_Implementation_Spec.md | 留 | post-MVP UI 设计输入（组件清单 / tokens） | 需剪掉 React 19 实现与构建段；日后 client 插件按 ADR-0004 开放项走手写 JS 路线，本文只作组件语义参考；效果图地位裁决（视觉稿非 canonical）保留 |
| 03_SPEC/User_Session_And_Audit_Schema.md | 删-记 | User/Session 随 D6 单用户缩减 | 搬运 §5：Agent 身份不得持 pi 角色；repo_explorer allowed_tools 只读；AuditEvent 必须区分 human actor 与 agent identity（字段源 Support §10 已留） |
| 03_SPEC/UX_Design_Spec.md | 留 | post-MVP UI 设计输入（设置页 / 卡片 / 右侧栏 / terminal 对应章节） | 652 行；需剪掉 Hono/React/WS 实现段，加 post-MVP 状态标注 |
| 03_SPEC/Verification_Case_Spec.md | 留 | verification ≠ validation ≠ calibration | 科学不变量 + M9 正确性门载体 |
| 03_SPEC/Visualization_Data_Spec.md | 删-记 | 前端图表组件数据契约（K7）；§1 报告图纪律属 M3 范围，已搬运 | 搬运 §1 对报告内图的纪律：图只展示 artifact 化数据、不直接读任意输出文件；每个数据集记录 RunRecord/变量/单位/聚合/时间轴；标题与 tooltip 必显单位；缺失变量显示 not_available、不得静默补 0 |
| 03_SPEC/WebSocket_Protocol.md | 删-记 | WS envelope/传输协议（K2） | 搬运：任务事件需单调 seq 并持久化到 events.ndjson，重连/重启按 since_seq 重放（与 K8 durable JobRegistry 的 job/settled 落盘同一精神） |
| 03_SPEC/Workspace_Conventions.md | 留 | 路径体系 canonical | 需剪掉 :25/:40/:59 的 `zero/` submodule 行 |
| 03_SPEC/Workspace_Snapshot_And_Recovery_Spec.md | 删-记 | 绑定 WS reconnect / event replay | 搬运 §5 服务启动恢复：以文件系统为事实源扫描 parked_state/job.yaml/locks/events；running→重 attach；terminal 未 collect→collect；collected 无 report→reporting；lock 过期→recovery+audit；状态冲突→blocked+ErrorRecord |

## 04_IMPLEMENTATION/

| 文件 | 处置 | 一句理由 | Notes |
|---|---|---|---|
| 04_IMPLEMENTATION/Agent_Behavior_Eval_Spec.md | 留 | 行为 eval 体系，运行时无关 | §4 护栏减重审查与 Control_Kernel §5.2 配套 |
| 04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md | 删 | Hono REST 错误 envelope | 幂等键规则已在 Idempotency_Concurrency_Locking_Spec（留） |
| 04_IMPLEMENTATION/CICD_Release.md | 删-记 | 流水线绑定 Bun/Zero release 标签 | 搬运 §8：PR CI 不跑真实 SHUD / LLM / SMTP / Docker / SLURM / 全量 batch，归 nightly 或 manual；schema drift + submodule pin + 文档链接检查 PR 必跑 |
| 04_IMPLEMENTATION/Dependency_Versioning_Policy.md | 删-记 | Bun/React/Hono/DuckDB 具体行全作废 | 搬运：package manager 版本 + lockfile 进 StackLock dependency summary；使用 deprecated 依赖必须标 temporary 并附 migration plan |
| 04_IMPLEMENTATION/Deployment_Architecture.md | 删 | Bun/Hono 服务组成；HPC 不在 MVP | ADR-0002 D1 全本机已覆盖部署形态 |
| 04_IMPLEMENTATION/DOD_and_Risks.md | 删-记 | DoD 绑定旧周/Phase 排期 | 搬运 §1 核心 DoD（每 run 有 RunRecord/logs/metrics/artifacts；tiny benchmark 可重复；sensitivity 出表与图）；§2 v0.6 删除项（Commander 定位、Critic 角色、memory 四级审批、skill 六级生命周期、Harness Optimizer）；§7 成功 = 省时非自治 |
| 04_IMPLEMENTATION/MVP_Implementation_Readiness_Checklist.md | 删 | 绑定 Zero 的 M1 开工前门 | criteria 明示 |
| 04_IMPLEMENTATION/Observability_Test_Plan.md | 删 | 测 health/alert/dashboard | 所测 spec 已删 |
| 04_IMPLEMENTATION/Operational_UX_API_Contracts.md | 删 | REST + WS 契约 | 传输层 |
| 04_IMPLEMENTATION/Operational_UX_Testing_Addendum.md | 删 | 测 WS/UI/E2E 的 ops-UX 四项 | 单元层（dedupe key、水印）可在新测试计划重写 |
| 04_IMPLEMENTATION/Operations_Runbook.md | 删-记 | 事故手册绑定 DuckDB/SMTP/WS 服务 | 搬运 §0 总则：先保留证据后恢复服务；不伪造成功状态（失败 RunJob 保留 FailureRecord/最小 RunRecord）；运维恢复 ≠ 接受科学结论 |
| 04_IMPLEMENTATION/Performance_Test_Plan.md | 删 | REST/WS 性能测试，W 周绑定 | — |
| 04_IMPLEMENTATION/Phase_By_Phase_Test_Plan.md | 删 | W0–W8 周测试矩阵，含 W8 Zero | criteria 明示；W4 ccw tiny 条目由 Test_Fixtures §4 覆盖 |
| 04_IMPLEMENTATION/Phased_Plan.md | 删-记 | HEAD 版 M1–M9 计划，被新计划取代 | **路径已在工作区就地重写为 dsh v2（未提交），无需删文件**；本行针对 HEAD 版 Zero 内容。搬运 M9：MVP 验收 = openMP RHS 已知答案回放，治理链路无人工绕过；正确性门须含一次故意注入错误 patch 被 VerificationCase 拦下的负例；EvidenceReport 可导出、lineage 可追溯；不做性能复现。Post-MVP 排除：heatmap/DuckDB、Controlled_Search/校准引擎本体、多用户、slurm、heihe 级性能、Harness Optimizer、multi-agent loop、3D 可视化、notebook、i18n 全量 |
| 04_IMPLEMENTATION/Repository_Layout.md | 删 | HEAD 版 Zero monorepo 目录 | **路径已在工作区就地重写为 dsh 版（未提交），无需删文件**；本行针对 HEAD 版内容，旧内容无需搬运 |
| 04_IMPLEMENTATION/Schema_Generation_And_Drift_Control.md | 留 | Zod 事实源 + 生成 + drift 检查策略 | K10 保留 TS+Zod，策略原样复用；`packages/core/...` 路径按新 pnpm workspace 改 |
| 04_IMPLEMENTATION/Schemas_APIs_CLIs.md | 删 | Hono REST 端点注册表（K2） | "PI 审批仅走唯一通道"已由 Spec_Gap_Audit 搬运行与 PI_Decision_Comments（留）覆盖 |
| 04_IMPLEMENTATION/Scientific_Change_Playbooks.md | 留 | 科学变更操作手册，M9 必读 | — |
| 04_IMPLEMENTATION/Task_Playbooks.md | 留 | 三类任务 agent 行为流程 | 需剪掉步骤中的 `POST /api/...` 与前端组件写法，改为 dsh 工具/动作描述 |
| 04_IMPLEMENTATION/Test_Fixtures_And_Command_Matrix.md | 留 | fixture 分层 + ccw tiny 定义 | 需剪掉 W 周标签与 :51 "W8 Zero tool adapter"；§4 ccw tiny（END=30、预期产物、验收）是 MVP 首任务在留存文件中的定义位置——其验收项 "HydrographChart 可加载 rivqdown" 随 K7 剪掉，改为 "rivqdown 序列进入 metrics/figure artifact" |
| 04_IMPLEMENTATION/Testing_Strategy.md | 留 | 分层测试策略 | 需剪掉 §3 WebSocket、§7 UI、§8–10 ops/perf/dependency 段与 :35 W8 Zero 行 |
| 04_IMPLEMENTATION/Theory_To_Code_API_Contracts.md | 删 | T2C REST 端点 | bundle 状态机在 Governance_Spec §3（留） |
| 04_IMPLEMENTATION/Theory_To_Code_Phase_Activation.md | 删 | 自称已并入主账 | demoted |
| 04_IMPLEMENTATION/Theory_To_Code_Test_Plan.md | 留 | T2C gate/schema/verification 测试 | 运行时无关 |
| 04_IMPLEMENTATION/Theory_To_Code_Traceability_Addendum.md | 删 | 已并入 Traceability_Matrix §3.1 | 已核验 |
| 04_IMPLEMENTATION/Traceability_Matrix.md | 删-记 | 模块列为 Zero 时代路径，W 周绑定 | 搬运：需求→canonical doc→实现模块→测试→release gate 五列追踪链 + §5 PI 治理追踪行，在 dsh 实现期按新模块重建 |

## 05_PROPOSAL/

| 文件 | 处置 | 一句理由 | Notes |
|---|---|---|---|
| 05_PROPOSAL/SHUD-Harness_汇报.md | 留 | 面向 PI 的价值与治理汇报 | 需剪掉 §2.1/§7 "TypeScript 全栈 Bun+Hono+React、基于 Zero" 表述及 Zero 行，§6.1 六阶段建设与 §9 进展/启动计划按 ADR-0004 重写，工作台效果图说明改为 dsh 聊天形态；`assets/*.png` 非 md 不在本表，随文件保留 |

## adr/

| 文件 | 处置 | 一句理由 | Notes |
|---|---|---|---|
| adr/0001-agent-runtime-and-topology.md | 留 | ADR 账本，须标 superseded | 加 "superseded by ADR-0004（基座部分）" 标记；以下与 Zero 无关、**仍有效**，ADR-0004 勿重议：单 Coordinator 星型拓扑 + spawn 深度 1；任务驱动 + park/resume 弃长循环；替代方案否决表（mesh / Claude Agent SDK / LangGraph / 全自研）；2026-07-04 裁决——raw data 写保护 authority 归 OS 沙箱层（seatbelt/landlock）、pre-exec 字符串扫描仅 advisory、raw 字节完整性为验收不变量、预存 hardlink 兜底 |
| adr/0002-mvp-reality-anchoring.md | 留 | MVP 现实锚定 D1–D9，部分被 K 列取代 | 加 superseded 标注：D3/D5 → K5（首任务改 ccw 运行）、D9 → K3（GLM 5.2 → DeepSeek Flash via DMXAPI）；D1/D2/D4/D6/D7/D8 沿用 |
| adr/0003-keep-risk-adaptive-review-lens-rotation.md | 留 | 评审流程决策，与运行时无关 | — |

## generated/

| 文件 | 处置 | 一句理由 | Notes |
|---|---|---|---|
| generated/schema/artifact-manifest.md | 留 | support schema 已实现字段投影 | 由 `packages/core/src/domain/schemas/*.ts` 生成；源码若随重置删除，本文件是唯一已验收字段记录 |
| generated/schema/artifact.md | 留 | support schema 已实现字段投影 | 同上 |
| generated/schema/data-provenance.md | 留 | 核心对象 DataProvenance 投影 | 同上 |
| generated/schema/error-record.md | 留 | support schema 已实现字段投影 | 同上 |
| generated/schema/idempotency-record.md | 留 | support schema 已实现字段投影 | 同上 |
| generated/schema/lock-record.md | 留 | support schema 已实现字段投影 | 同上 |
| generated/schema/stack-lock.md | 留 | 核心对象 StackLock 投影 | 同上；重生成时去掉 `repos.zero` |
| generated/schema/task-card.md | 留 | 核心对象 TaskCard 投影 | 同上 |

`generated/json-schema/*.json`（8 份，非 md）：与上表一一对应，随其保留；K10 保留 Zod，JSON Schema 作为跨工具载体。Zod 源按 `04_IMPLEMENTATION/Port_List.md` 移植到 `packages/dsh-shud-core/src/schemas/`，生成器路径随之改。

## 根目录散文件

| 文件 | 处置 | 一句理由 | Notes |
|---|---|---|---|
| Phased_Spec_Activation.md | 删-记 | 六阶段激活账本，被新计划取代 | 搬运：①G1 "时间节省度量" PI 裁定不采纳——反事实基线（人工研究耗时）不可得（CLAUDE.md 仍以省时为成功标准，需注意口径）；②对齐检查点仪式：回顾→修正→预读→调整，先改 spec 再写代码；③Spec 冻结规则：冻结后仅收 bug 修正 + ADR 例外 |
| SPEC_v0.8_Final.md | 删-记 | 已降级为非规范快照，含 Zero 章 | 搬运 §7 ccw tiny fixture：Cache Creek 1147 单元/103 河段，END=30 天（原 1827），serial < 2 分钟；验收 exit_code=0、water_balance_residual < 0.01、cvode_failures = 0、RunRecord 含 stack_id/data_id/artifacts/metrics/numerical_health；关键变量 eleygw/rivqdown |

## 99_ARCHIVE/

225 份，已归档（v0.1–v0.5 旧文档 + 图片），本轮不动、不逐条列出。

---

## openspec/changes/（不计入 118）

| 目录 | 处置 | 一句理由 | Notes |
|---|---|---|---|
| openspec/changes/m1-foundation/ | 删 | Zero 时代 M1 实施记录 | 历史在 tag `archive/zero-v0.8.3` |
| openspec/changes/m1-failure-occurrence-ledger/ | 删 | 同上 | — |
| openspec/changes/m1-generation-bound-recovery/ | 删 | 同上 | — |
| openspec/changes/m1-policy-gate-non-spawn-input-bounds/ | 删 | 同上 | — |
| openspec/changes/m1-transition-artifact-exact-retry/ | 删 | 同上 | — |
| openspec/changes/m2-capability-observer-spike/ | 删 | 停摆的 meta-spike 记录（ADR-0004 背景） | 结论已由 ADR-0004 K13 作用域规则吸收 |
| openspec/changes/m2-research-context/ | 删 | 同上 | — |
| openspec/changes/archive/ | 留 | 已归档 change | 不动 |

## 根目录构建残留（不计入 118，随 K15 一并清理）

| 路径 | 处置 | 一句理由 |
|---|---|---|
| `bun.lock`、`bunfig.toml`、`tsconfig.json`、`tsconfig.base.json`、`package.json` | 删 / 重写 | Bun 工作区根配置；Phase 4.5 按 Repository_Layout v2 重写为 pnpm 根 |
| `dependency-lock.initial.json`、`scripts/dependency-lock/` | 删 | Zero 时代依赖锁与检查脚本（Dependency_Versioning_Policy 已判 删-记） |
| `config/providers/`、`scripts/glm-provider/` | 删 | GLM provider 配置与 smoke（Port_List 不搬） |
| `scripts/local-auth/`、`scripts/perf/`、`scripts/readiness/` | 删 | 绑定 Hono 后端 / 性能测试 / M1 就绪门（对应 spec 已判删） |
| `scripts/docs/`、`scripts/schema/` | 留，改路径 | 文档链接检查与 schema 生成（Schema_Generation_And_Drift_Control 留） |

## 删-记 汇总（供 ADR-0004 附录 / 「后果」节吸收）

### A. 治理与不变量

- **门禁输入真值化**（Adversarial_Design_Review）：gate / semantic floor 不得消费 LLM 自报字段（如 ChangeRequest.files_changed），输入须来自 diff、Domain CLI 等确定性来源；每个"强制"声明必须标注 enforcement point（API / 沙箱 / kernel / validator），标不出的降为"约定 + eval 兜底"。
- **治理大脑而非只治理手脚**（Agent_System_Audit）：LLM 模型（含 base_url）进 StackLock；semantic_level 不得自分类；PI 中途介入语义（append/interrupt/abort）须定义；prompt 注入威胁模型用 T0–T4 信任分级；行为 eval ≠ 确定性测试。
- **五条不再推翻**（Spec_Gap_Audit_v0_8_1 §2）：8 核心对象不扩张；support object 不升核心；实时通道非证据存储（RunRecord/artifact 才是）；batch progress 从 AnalysisPlan+RunJob+RunRecord 派生、不引入 workflow engine；PI comment 是决策记录非科学事实，默认 generalization_allowed=false。
- **任何基座必须覆盖的默认行为**（Zero_Reuse_Matrix §9）：memory 创建不得自动 verified（evidence_note 需 PI review）；LLM closure 分类器仅 advisory、不作状态迁移依据、不可覆盖 validator 拒绝；bash 工具无内置安全，沙箱约束全由 harness 侧施加。
- **Agent 身份**（User_Session_And_Audit_Schema §5）：agent 不得持 pi 角色；repo_explorer allowed_tools 只读；AuditEvent 区分 human actor 与 agent identity。
- **Harness 自身版本进 StackLock**（Multiuser_Harness_Versioning §4–5）：runtime / prompt_pack / skills / policy / report_template 版本随 StackLock.harness 锁定；prompt/skill 更新后须跑 tiny smoke。
- **运维三总则**（Operations_Runbook §0）：先保留证据后恢复服务；不伪造成功状态（失败 RunJob 保留 FailureRecord/最小 RunRecord）；运维恢复 ≠ 接受科学结论。
- **i18n 边界**（Internationalization_Localization）：代码/schema/文件名/API 英文；UI 文案与报告正文中文；单位不翻译只解释；变量注册表双语显示名。

### B. 对象与架构沿革

- **v0.5 → v0.6 对象合并表**（Research_Object_Model §3）：EnvLock/HarnessLock→StackLock；DatasetManifest/ObservationManifest/PreprocessRecipe→DataProvenance；CalibrationSpec/HoldoutPolicy/BenchmarkPolicy→AnalysisPlan；JobSpec→RunJob；RunManifest/ArtifactManifest→RunRecord；EvidencePacket/ValidationReport→EvidenceReport；ChangeSpec/OutputContract/CompatibilitySuite/HumanGate/ReleaseGate→ChangeRequest。
- **v0.6 删除项**（DOD_and_Risks §2）：Commander 科研主控定位、Critic 科学判断角色、memory 四级审批、skill 六级生命周期、Harness Optimizer MVP；§7 成功 = 节省 PI/工程师时间，不是自治程度。
- **PI 中途介入三级语义**（Interaction_Model §7.1）：append（入队、下一轮推理前注入）/ interrupt（当前工具调用完成后重规划）/ abort（取消任务并 cancel 运行中 job）；"agent 在思考 / job 在跑 / 任务已 parked"三态必须对 PI 可见，parked 期间输入保存并在 resume 时注入。
- **任务事件持久化**（WebSocket_Protocol）：事件带单调 seq 并落 events.ndjson，重连/重启按 since_seq 重放——与 K8 durable JobRegistry 的 job/settled 落盘同一精神。
- **报告水印**（Report_Export_Spec §4）：报告文件按状态带可见水印（draft/reviewed/awaiting_pi → "DRAFT — not accepted by PI"；revision_requested / rejected / archived 各自标注，archived 按归档前终态），水印为正文一部分、不可仅靠样式隐藏；导出只含 evidence_usable artifact。
- **报告内图纪律**（Visualization_Data_Spec §1）：图只展示 artifact 化数据、不直接读任意输出文件；每个数据集记录 RunRecord/变量/单位/聚合/时间轴；标题必显单位；缺失变量显示 not_available、不得静默补 0。

### C. 执行、恢复与运维阈值

- **服务启动恢复**（Workspace_Snapshot_And_Recovery §5）：以文件系统为事实源扫描 parked_state / job.yaml / locks / events；running→重 attach watcher；terminal 未 collect→collect；collected 无 report→reporting；lock 过期→recovery + audit；状态冲突→blocked + ErrorRecord。
- **通用告警阈值**（Alerting_Thresholds §2）：job 无日志更新 5 min warning / 20 min stale error；磁盘 <10% warn、<5% 或 <5GB 阻新 job；单 task LLM 成本 >3× advisory 仅标黄不中断；日 LLM cap 超限暂停新任务、不杀运行中；生成物检出 secret 模式 → 隔离 artifact + incident。
- **日志关联键**（Log_Aggregation）：结构化日志必带 request_id / task_id / job_id / run_id 并经 redaction。
- **依赖锁**（Dependency_Versioning_Policy）：package manager 版本 + lockfile 进 StackLock dependency summary；使用 deprecated 依赖必须标 temporary 并附 migration plan。

### D. 测试与验收

- **ccw tiny fixture**（SPEC_v0.8_Final §7）：Cache Creek 1147 单元 / 103 河段，END=30 天（原 1827），serial < 2 分钟；验收 exit_code=0、water_balance_residual < 0.01、cvode_failures = 0、RunRecord 含 stack_id/data_id/artifacts/metrics/numerical_health；关键变量 eleygw / rivqdown。
- **MVP 验收 = openMP RHS 已知答案回放**（Phased_Plan M9）：治理链路无人工绕过；正确性门须含一次故意注入错误 patch 被 VerificationCase 拦下的负例；EvidenceReport 可导出、lineage 可追溯；不做性能复现。Post-MVP 排除：heatmap/DuckDB、Controlled_Search/校准引擎本体、多用户、slurm、heihe 级性能、Harness Optimizer、multi-agent loop、3D 可视化、notebook、i18n 全量。
- **核心 DoD**（DOD_and_Risks §1）：每 run 有 RunRecord / logs / metrics / artifacts；tiny benchmark 可重复运行；sensitivity 可出表与图。
- **CI 分层**（CICD_Release §8）：PR CI 不跑真实 SHUD / LLM / SMTP / Docker / SLURM / 全量 batch（归 nightly 或 manual）；schema drift + submodule pin + 文档链接检查 PR 必跑。
- **追踪链结构**（Traceability_Matrix）：需求 → canonical doc → 实现模块 → 测试 → release gate 五列 + PI 治理追踪行，在 dsh 实现期按新模块重建。

### E. 度量与流程

- **G1 时间节省度量不采纳**（Phased_Spec_Activation 例外批次 1）：PI 裁定——反事实基线（人工研究耗时）不可得；CLAUDE.md 仍以"时间节省"为成功标准，属定性口径而非度量指标。
- **对齐检查点仪式**（Phased_Spec_Activation）：每阶段切换执行 回顾 → 修正 → 预读 → 调整；先改 spec 再写代码。
- **Spec 冻结规则**（Phased_Spec_Activation）：冻结后仅收 bug 级修正与 ADR 级例外，设计演进跟代码走、在 PR 中说明。
