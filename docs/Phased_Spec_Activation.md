---
status: living
---

# 分阶段开发路线图

**原则：** 代码跟着 spec 走，spec 是权威源。近百份文档不同时激活——每个阶段只激活该阶段代码直接依赖的文档。阶段切换时，基于实现经验对齐下一阶段的 spec。

**Spec 冻结（2026-07-02）**：规格体系冻结于本轮体检修复后的状态。此后仅接受
① bug 级修正（错误事实、自相矛盾）；② ADR 级例外（新增能力先立 ADR 说明为何必须先写 spec）。
其余设计演进跟着代码走——实现期的决策直接改 canonical 规范并在 PR 中说明，不再开新文档。
下一个制品是 M1 代码（含 ADR-0001 的策略门 spike，验收标准见 Phased_Plan M1）。
**例外批次 1（2026-07-02，PI 授权）**：吸收觉察流 harness 工程评审 G2–G7——拒绝即教学 remediation
契约（Support_Schema_Contracts §3 / Preflight §2 / Control_Kernel §5）、Reviewer 植入缺陷校准
（Behavior_Eval EVAL-REV-* + 漂移度量）、记忆/技能周期清扫（Memory_Skills_Lite §9）、护栏
authority/capability 分类与换代减重（Control_Kernel §5.2 + ADR-0001 触发器 6）、工具面治理约定
（Control_Kernel §5.3）、模型路由演进备注（Minimal_Schemas）。G1（时间节省度量）PI 裁定不采纳：
反事实基线（人工研究耗时）不可得。
**例外批次 2（2026-07-02，PI 授权）**：grill-me 方案压测 9 项决策沉淀，全文见
[ADR-0002](adr/0002-mvp-reality-anchoring.md)。MVP 范围随之调整（约束实施记录重建，不改各 spec 正文）：
① Phase 3 主链 = ChangeRequest **已知答案回放**（openMP RHS 切片，正确性门，不做性能复现）；
② 敏感性压缩为最小 OAT（3–5 run）随 Phase 4；③ Controlled_Search/校准边界 MVP 仅 schema 占位；
④ `Multiuser_Harness_Versioning` 停用（单用户，Auth 缩为单账号 + localhost）；⑤ 邮件通知保留 MVP
（机器常开）；⑥ slurm/HPC 适配器不实现（全本机）；⑦ 运行时模型 GLM 5.2，StackLock.llm 增 `base_url`；
⑧ 里程碑制（M1..Mn 弹性门）取代日历周，Phased_Plan 周序降为依赖参考。旧 openspec changes（4 月
产物 9 个 bundle）因漂移于同日清理，实施记录按本批次决策重建。
**例外批次 3（2026-07-02，PI 指令）**：Phased_Plan 由"8 周日历版"整体重写为里程碑制（M1–M9）
**实施唯一真相源**（排期/交付/验收门/每里程碑必读），吸收五路对齐审查修复（敏感性压缩、回放主链、
patch diff 端点方法、备胎表述随 ADR-0001 修订、新机制落点）；本账 Phase 3 T2C 追加激活清单与并入表
统一，Preflight 归位 Phase 2（审查 B-1 修正）。配套测试文档沿用 W0–W8 标签，经 Phased_Plan §0 映射表解析。
**例外批次 4（2026-07-03，M1 grill 定案）**：七项议程全部定案（ADR-0002 四开放项 + M1 开工三决），
记录见 [ADR-0002 开放项处置节](adr/0002-mvp-reality-anchoring.md)；实施记录 `openspec/changes/m1-foundation`
同步固化。spec 正文唯一改动：Config_Secrets §4 推荐环境变量表补 `GLM_API_KEY` 一行（D9 运行时模型
key 变量，走 ADR 例外通道）；InferenceBudget 三档 USD 按定案流程待 M7 实测校准后写回，本批不改 spec。
**例外批次 5（2026-07-04，ADR-0001 revisit 裁决）**：M1 策略门 spike 首轮判定条 2 不绿——pre-exec 静态
命令串扫描原理性不可行（六类逃逸 + 读误拒，证据 `openspec/changes/m1-foundation/policy-gate-spike-verdict.md`）。
裁决 = 边界重划而非换基座：bash 写禁区 authority 下沉执行层 OS 沙箱（macOS seatbelt，子进程继承），
pre-exec 静态检查降级 advisory——与 Preflight_And_Mutation_Boundary_Spec"preflight 是 submit 前的门，
不是运行期防线"（A03-5）既有分工一致。spec 正文唯一改动：Phased_Plan M1 spike 条 2 行机制修订（真相源
条文与裁决对齐）；其余落实施记录 `m1-foundation` 与 [ADR-0001 revisit 记录](adr/0001-agent-runtime-and-topology.md)。
**2026-07-04 PR #48 post-gate 延伸**：条 2' 首实现经六路 review + verifier 确认 4 条 merge-blocking finding，
均为同一堵墙换位（wrapper 从命令文本 + 进程采样反推运行期真相），且**无一击穿 raw 字节完整性**。裁决补充 =
保证分层：byte authority（seatbelt 守 raw 字节，不变）留验收核，denial telemetry 收窄为可观测（advisory +
经进程结果外显的 OS 拒绝），隐藏拒绝完整遥测 + 任意后代进程生命周期所有权移出 M1 归后续 executor/audit 后端。
spec 正文改动仍限 Phased_Plan M1 条 2 行（追加可观测边界注）；其余落 `m1-foundation` 与 ADR-0001 裁决补充。
四条 finding 按 acceptance-boundary 修正处置（非实现漏项，cand-04 随 process-creation preflight 收窄修复）。

**依据：** 本文档基于全部文档的交叉引用和依赖链深度分析生成。

**配套文档：**
- [Phased_Plan.md](04_IMPLEMENTATION/Phased_Plan.md) — 里程碑实施计划 M1–M9（排期/交付/验收门/必读的唯一真相源）
- [Phase_By_Phase_Test_Plan.md](04_IMPLEMENTATION/Phase_By_Phase_Test_Plan.md) — 每阶段 Test ID + 场景 + Pass Criterion
- [Test_Fixtures_And_Command_Matrix.md](04_IMPLEMENTATION/Test_Fixtures_And_Command_Matrix.md) — Fixture 层级与命令
- [Traceability_Matrix.md](04_IMPLEMENTATION/Traceability_Matrix.md) — 需求 → 文档 → 代码 → 测试追踪

---

## Theory-to-Code 卫星账并入（2026-07-02）

原 `Theory_To_Code_Phase_Activation.md` 独立登记的 T2C 文档并入本账（卫星文档降为细节附录，一个系统一本激活账）：

| Phase | 激活 T2C 文档 |
|---|---|
| Phase 1 | Theory_To_Code_Support_Schemas（schema placeholder，不强制 UI） |
| Phase 3 | Theory_To_Code_Governance_Spec · Verification_Case_Spec · Theory_To_Code_API_Contracts · Theory_To_Code_Test_Plan |
| Phase 4 | Controlled_Search_Boundary_Spec（accepted_for_search 前置检查） |
| Phase 5 | Theory_To_Code_Traceability_Addendum + Report lineage 的 T2C 章节 |
| Phase 6 | Scientific_Change_Playbooks（完整 playbook + PI gate drill） |

## 全程基座（始终激活）

| 文件 | 角色 |
|------|------|
| [CLAUDE.md](../CLAUDE.md) | 项目定位 + 10 项设计决策 |
| [SPEC_v0.8_Final.md](SPEC_v0.8_Final.md) | 自包含阅读基准 |
| [CANONICAL_CONTRACTS.md](00_INDEX/CANONICAL_CONTRACTS.md) | 唯一事实源索引 |
| [Minimal_Schemas.md](03_SPEC/Minimal_Schemas.md) | 8 核心对象字段定义（所有 spec 的依赖根） |
| [Support_Schema_Contracts.md](03_SPEC/Support_Schema_Contracts.md) | 24 个 support schema 定义（含 v0.8.2 新增 6 个） |
| [Requirements_Catalog.md](00_INDEX/Requirements_Catalog.md) | 正式需求目录（US/FR/NFR/DR/GR/IR/TR） |
| [Requirements_Numbering_Conventions.md](00_INDEX/Requirements_Numbering_Conventions.md) | 需求编号规则与 traceability |
| [Dependency_Versioning_Policy.md](04_IMPLEMENTATION/Dependency_Versioning_Policy.md) | 依赖锁定与更新策略（W0 起） |
| [Repository_Layout.md](04_IMPLEMENTATION/Repository_Layout.md) | Monorepo 目录结构 |
| [Schemas_APIs_CLIs.md](04_IMPLEMENTATION/Schemas_APIs_CLIs.md) | API 端点注册表（随阶段增长） |

### 渐进文档（每阶段追加相关章节）

| 文件 | 说明 |
|------|------|
| [Testing_Strategy.md](04_IMPLEMENTATION/Testing_Strategy.md) | 每阶段激活对应测试类别 |
| [Error_Handling_Spec.md](03_SPEC/Error_Handling_Spec.md) | Phase 2 起激活，错误分类覆盖全层 |
| [Config_Secrets_And_Environment_Spec.md](03_SPEC/Config_Secrets_And_Environment_Spec.md) | Phase 1 起激活，env/secret/redaction 贯穿全程 |
| [Performance_NFR_Spec.md](03_SPEC/Performance_NFR_Spec.md) | Phase 1 起激活，性能 NFR 贯穿全程 |
| [Observability_Monitoring_Spec.md](03_SPEC/Observability_Monitoring_Spec.md) | Phase 1 起激活，健康检查/指标 贯穿全程 |

---

## Phase 1：骨架可运行

> Monorepo + Zod schema + workspace 目录 + CRUD API + 四栏前端壳

### 激活 Spec

| 文件 | 关注点 |
|------|--------|
| [Workspace_Conventions.md](03_SPEC/Workspace_Conventions.md) | 路径体系、目录结构、Git 策略 |
| [Data_Storage_Provenance.md](03_SPEC/Data_Storage_Provenance.md) | 存储分层、DataProvenance schema |
| [Control_Kernel.md](02_ARCHITECTURE/Control_Kernel.md) | TaskCard 状态机、runtime_phase |
| [Interaction_Model.md](02_ARCHITECTURE/Interaction_Model.md) | 四栏布局定义 |
| [UI_Implementation_Spec.md](03_SPEC/UI_Implementation_Spec.md) | 设计 tokens、组件基础 |
| [API_Error_And_Idempotency_Contracts.md](04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md) | 错误响应 envelope |
| [MVP_Implementation_Readiness_Checklist.md](04_IMPLEMENTATION/MVP_Implementation_Readiness_Checklist.md) | P0 开工门禁 |
| [Performance_Test_Plan.md](04_IMPLEMENTATION/Performance_Test_Plan.md) | 性能测试计划（W1 起） |
| [Observability_Test_Plan.md](04_IMPLEMENTATION/Observability_Test_Plan.md) | 可观测性测试计划（W1 起） |

### 交付摘要

```
后端: Bun monorepo, Zod schema (TaskCard/Artifact/ErrorRecord), Hono POST/GET /api/tasks, workspace init, task snapshot
前端: Dashboard, WorkbenchLayout 四栏, SideNav, ExperimentHeader, StatusBar
测试: schema valid/invalid, API create/get, snapshot reload, UI smoke, docs link check
```

### 出口标准

```
浏览器打开四栏布局，可创建任务，SideNav 展示任务列表，刷新后 snapshot 恢复状态。
T0(schema) + T1(API) + UI smoke 全部通过。
```

### → Phase 2 对齐检查点

- [ ] Workspace_Conventions 路径体系与实际目录一致？
- [ ] TaskCard 状态机 Zod schema 与 Control_Kernel + Minimal_Schemas 一致？
- [ ] 四栏布局 grid 比例与 Interaction_Model 一致？
- [ ] API error envelope 字段够用？
- [ ] 预读 Phase 2：RunJob 状态机能接上 TaskCard？WebSocket Session 认证需要什么？

---

## Phase 2：执行闭环

> RunJob submit → sandbox 执行 → WebSocket 推流 → collect → RunRecord → Park/Resume → 服务重启恢复

**风险优先级：** Park/Resume 恢复语义是全系统技术风险最高点（见 [DOD_and_Risks.md](04_IMPLEMENTATION/DOD_and_Risks.md) §6）。
Phase 2 第一个里程碑必须是 dummy job 的 park→collect→resume→按 plan_cursor 接续 端到端原型，先于 WebSocket 细节打磨。

### 激活 Spec

| 文件 | 关注点 |
|------|--------|
| [Execution_Jobs_Runs.md](03_SPEC/Execution_Jobs_Runs.md) | RunJob 状态机、执行模式、collect、失败恢复 |
| [Sandbox_and_Executor.md](03_SPEC/Sandbox_and_Executor.md) | 命令审计、路径策略、风险分级 |
| [Runner_Adapter_Contracts.md](03_SPEC/Runner_Adapter_Contracts.md) | submit/status/cancel/collect 统一接口 |
| [Park_Resume_Design.md](03_SPEC/Park_Resume_Design.md) | ParkedState、job watcher、resume 上下文 |
| [Idempotency_Concurrency_Locking_Spec.md](03_SPEC/Idempotency_Concurrency_Locking_Spec.md) | collect 幂等、lock、状态单调性 |
| [Workspace_Snapshot_And_Recovery_Spec.md](03_SPEC/Workspace_Snapshot_And_Recovery_Spec.md) | TaskSnapshot、service restart recovery |
| [WebSocket_Protocol.md](03_SPEC/WebSocket_Protocol.md) | 事件 envelope、消息类型、seq 单调、断线重连 |
| [Auth_Permission_Design.md](03_SPEC/Auth_Permission_Design.md) | 基础角色、Session 管理、WebSocket 认证 |
| [User_Session_And_Audit_Schema.md](03_SPEC/User_Session_And_Audit_Schema.md) | User / Session schema |
| [Frontend_State_Design.md](03_SPEC/Frontend_State_Design.md) | WebSocket reducer、entity cache、seq 去重 |
| [Roles_and_Boundaries.md](02_ARCHITECTURE/Roles_and_Boundaries.md) | 角色边界 |
| [Agent_Architecture.md](02_ARCHITECTURE/Agent_Architecture.md) | Agent 角色、Coordinator 决策流 |
| [Context_Trust_And_Injection_Spec.md](03_SPEC/Context_Trust_And_Injection_Spec.md) | Context 信任分级、注入防护（Repo Explorer 上线即注入面打开） |
| [Agent_Behavior_Eval_Spec.md](04_IMPLEMENTATION/Agent_Behavior_Eval_Spec.md) | 行为 eval 管道空跑 + golden 场景积累（Phase 6 真实 LLM 接入前必须全量可运行） |
| [Preflight_And_Mutation_Boundary_Spec.md](03_SPEC/Preflight_And_Mutation_Boundary_Spec.md) | runner preflight 初版 + PreflightCheck.remediation（T2C 完整 preflight 随 Phase 3–4 长成；2026-07-02 自 Phase 3 归位） |

### 交付摘要

```
后端: Sandbox path policy, local_direct/local_job runner, POST/GET /api/jobs, POST /api/jobs/:id/collect, WebSocket server, command trace, Repo Explorer read-only policy, RepoContextBrief artifact, service startup recovery
前端: AgentActivityFeed, RepoContextBrief card, RuntimeTerminal, WebSocket reconnect, job status badge, error banner
测试: dummy job submit/log/collect, collect idempotency, WebSocket seq/reconnect, sandbox path escape, Repo Explorer write denial, service restart recovery, secret redaction
```

### 出口标准

```
dummy job submit → 实时日志推流 → collect 生成 RunRecord → UI 展示。
code_change/debugging 任务可生成 RepoContextBrief，且 Explorer 写操作被拒绝。
服务重启后 uncollected terminal job 自动恢复。
T0 + T1 + T2(WebSocket) + T3(UI dummy) 全部通过。
```

### → Phase 3 对齐检查点

- [ ] RunJob 状态机实际转换与 spec 一致？
- [ ] Runner collect result 需要额外字段？
- [ ] WebSocket 事件类型和 payload 够用？
- [ ] idempotency key 拼接规则可行？
- [ ] Session 认证在 WebSocket 上的表现足够？
- [ ] 预读 Phase 3：SHUD_Output_Variables 变量格式？Artifact_Registry metadata 能容纳 SHUD 产出？

---

## Phase 3：科学运行

> 真实 SHUD tiny case → StackLock/DataProvenance 绑定 → Artifact 登记 → HydrographChart → 第一个 Skill

### 激活 Spec

| 文件 | 关注点 |
|------|--------|
| [SHUD_Output_Variables.md](03_SPEC/SHUD_Output_Variables.md) | 34 个变量注册表、单位、NumericalHealth |
| [Artifact_Registry_Spec.md](03_SPEC/Artifact_Registry_Spec.md) | Artifact 类型、metadata、evidence_usable、manifest |
| [Visualization_Data_Spec.md](03_SPEC/Visualization_Data_Spec.md) | HydrographChart、ResultsOverview（不含 heatmap） |
| [Memory_Skills_Lite.md](03_SPEC/Memory_Skills_Lite.md) | MemoryNote、Skill 生命周期、run-shud-tiny-case |
| [Cost_Inference_Budget.md](03_SPEC/Cost_Inference_Budget.md) | 三档预算、CostRecord |
| [Research_Constitution.md](02_ARCHITECTURE/Research_Constitution.md) | 科研治理规则、禁止表述 |
| [Domain_CLI_Spec.md](03_SPEC/Domain_CLI_Spec.md) | 本阶段交付的 "SHUD build/run wrapper + metrics artifact" 即此 CLI 的 shud/metrics 组；autoshud 组随首个数据准备任务启用 |

**参考：** [SHUD_Codebase_Report.md](01_CODEBASE/SHUD_Codebase_Report.md) · [rSHUD_Codebase_Report.md](01_CODEBASE/rSHUD_Codebase_Report.md) · [AutoSHUD_Codebase_Report.md](01_CODEBASE/AutoSHUD_Codebase_Report.md)

### 交付摘要

```
后端: SHUD build/run wrapper, ccw tiny 30-day, output scan, metrics/hydrograph artifact, RunRecord numerical_health, GET /api/runs/:id/series
前端: HydrographChart, ResultsOverview, variable selector
测试: build exit_code=0, run exit_code=0, water_balance_residual < threshold, rivqdown series loads, missing output → ErrorRecord
```

### 出口标准

```
ccw tiny 编译+运行成功，water_balance_residual < 阈值，前端展示 rivqdown 过程线 + 指标卡。
T0 + T1 + T4(fixture ccw tiny) 通过。
```

### Phase 3 追加激活（Theory-to-Code）

- Theory_To_Code_Governance_Spec.md
- Verification_Case_Spec.md
- Theory_To_Code_API_Contracts.md
- Theory_To_Code_Test_Plan.md

（与卫星账并入表一致；Preflight_And_Mutation_Boundary_Spec 已归位 Phase 2 激活表——2026-07-02 对齐审查 B-1 修正）

### → Phase 4 对齐检查点

- [ ] Artifact type 枚举覆盖 SHUD 所有产出？
- [ ] SHUD_Output_Variables 与 rSHUD read_output() 实际返回一致？
- [ ] numerical_health 阈值合理？
- [ ] Skill SKILL.md 格式易于维护？
- [ ] 预读 Phase 4：ParameterSet 映射与当前 RunJob/Artifact 兼容？

---

## Phase 4：分析引擎

> AnalysisPlan sensitivity → batch 并发 → heatmap/参数表/对比图 → ChangeRequest

### 激活 Spec

| 文件 | 关注点 |
|------|--------|
| [Sensitivity_Calibration_Benchmark.md](03_SPEC/Sensitivity_Calibration_Benchmark.md) | 三种分析模式边界 |
| [Sensitivity_Calibration_Benchmark_Addendum.md](03_SPEC/Sensitivity_Calibration_Benchmark_Addendum.md) | batch 设计、BatchProgressGrid、stop_condition |
| [Parameter_Set_And_Analysis_Run_Mapping.md](03_SPEC/Parameter_Set_And_Analysis_Run_Mapping.md) | PSET↔RunJob↔RunRecord 映射 |
| [Batch_Progress_View_Spec.md](03_SPEC/Batch_Progress_View_Spec.md) | BatchProgressGrid 前端规格 |
| [Visualization_Data_Spec.md](03_SPEC/Visualization_Data_Spec.md) | **追加：** SensitivityHeatmap、ParameterSetTable、HydrographComparison |
| [Research_Object_Model.md](03_SPEC/Research_Object_Model.md) | AnalysisPlan 在对象模型中的位置 |

### 交付摘要

```
后端: AnalysisPlan parameter_sets, batch runner, progress aggregate, DuckDB/Parquet, GET /api/analysis/:id/progress, GET /api/analysis/:id/heatmap
前端: ParameterSetTable, BatchProgressGrid, BatchCellDetailPanel, SensitivityHeatmap, failed cell retain
测试: progress total=paramsets count, failed cell visible, heatmap metric aggregation, retry creates new attempt
```

### 出口标准

```
PI 指定参数空间 → batch 运行 → 前端展示参数表 + 热力图 + 对比过程线，失败 cell 可见。
T0 + T1 + T3(UI batch) 通过。
```

### Phase 4 追加激活（Theory-to-Code）

- Controlled_Search_Boundary_Spec.md
- Equation_And_Derivation_Spec.md
- Numerical_Scheme_Spec.md
- Implementation_Mapping_Spec.md

Phase 4 出口标准补充：

```text
search/calibration cannot run downstream of high-risk change unless bundle is accepted_for_search.
```

### → Phase 5 对齐检查点

- [ ] AnalysisPlan parameter_sets/batch_policy 实际够用？
- [ ] ParameterSet.status 派生逻辑稳定？
- [ ] 并发目录隔离策略表现如何？
- [ ] 预读 Phase 5：Report_Generation 需要从 AnalysisPlan 拉什么？Evidence_Lineage 的 assertion 分类合适？

---

## Phase 5：报告与治理

> EvidenceReport 生成 → Reviewer 检查 → PI gate 审批 → HTML 导出 → 通知 → 审计链

### 激活 Spec

| 文件 | 关注点 |
|------|--------|
| [Report_Generation_Spec.md](03_SPEC/Report_Generation_Spec.md) | 报告模板、language guard、evidence level |
| [Report_Review_And_Evidence_Lineage_Spec.md](03_SPEC/Report_Review_And_Evidence_Lineage_Spec.md) | assertion 分类、lineage guard |
| [Report_Export_Spec.md](03_SPEC/Report_Export_Spec.md) | standalone HTML、watermark、manifest |
| [PI_Decision_Comments_Spec.md](03_SPEC/PI_Decision_Comments_Spec.md) | comment 必填规则、pi_decision MemoryNote |
| [Notification_Design.md](03_SPEC/Notification_Design.md) | 触发规则、dedupe、SMTP/SendGrid |
| [Operational_UX_Addendum.md](03_SPEC/Operational_UX_Addendum.md) | 4 个运维功能综合框架 |
| [Operational_UX_API_Contracts.md](04_IMPLEMENTATION/Operational_UX_API_Contracts.md) | 运维 API 详情 |

### 交付摘要

```
后端: EvidenceReport template, language guard, PiGate/PiGateDecision, POST /api/pi-gates/:id/decision, MemoryNote(pi_decision), audit log, HTML/MD export, notification provider mock
前端: MarkdownRenderer, PIDecisionPanel, ReportExportButton, CostMonitor, NextSuggestedAction, NotificationStatus
测试: language guard negative, missing artifact → limitation, reject/revision without comment → 400, agent → 403, draft HTML watermark, notification dedupe
```

### 出口标准

```
RunRecord → report → Reviewer 检查 → PI 审批(含 comment) → HTML 导出，审计链可查，通知可发。
T0 + T1 + T3(UI report) + 语言检查负例测试通过。
```

### Phase 5 追加激活（Theory-to-Code）

- Scientific_Change_Gating_Spec.md
- Theory_To_Code_Report_Lineage_Spec.md
- Scientific_Change_Playbooks.md

### Theory-to-Code Phased Activation 验收标准

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。

### → Phase 6 对齐检查点

- [ ] assertion_type 7 种是否都出现？需合并？
- [ ] language guard 误报率？
- [ ] PI gate comment_required 规则需调整？
- [ ] 预读 Phase 6：Multiuser 与当前 Session 兼容？i18n 对 UI 影响范围？

---

## Phase 6：集成打磨与交付

> 多用户 + i18n + Playbook E2E + Zero/LLM 集成 + CI/CD + 部署

### 激活 Spec

| 文件 | 关注点 |
|------|--------|
| [Multiuser_Harness_Versioning.md](03_SPEC/Multiuser_Harness_Versioning.md) | 并发 session、task lock |
| [Data_Package_And_Retention_Spec.md](03_SPEC/Data_Package_And_Retention_Spec.md) | 打包、retention、cleanup guard |
| [UX_Design_Spec.md](03_SPEC/UX_Design_Spec.md) | 用户旅程、反馈模式 |
| [Internationalization_Localization.md](03_SPEC/Internationalization_Localization.md) | i18n 规范 |
| [Task_Playbooks.md](04_IMPLEMENTATION/Task_Playbooks.md) | 三个 Playbook E2E 验证 |

### 激活 Impl

| 文件 | 关注点 |
|------|--------|
| [CICD_Release.md](04_IMPLEMENTATION/CICD_Release.md) | 完整 CI、schema drift 强制检查 |
| [Deployment_Architecture.md](04_IMPLEMENTATION/Deployment_Architecture.md) | 部署拓扑 |
| [Operations_Runbook.md](04_IMPLEMENTATION/Operations_Runbook.md) | 运维手册（Phase 6 正式激活，但 Phase 2 起可参考） |
| [Alerting_Thresholds_Spec.md](03_SPEC/Alerting_Thresholds_Spec.md) | 告警阈值与升级策略 |
| [Log_Aggregation_Spec.md](03_SPEC/Log_Aggregation_Spec.md) | 结构化日志与聚合 |
| [DOD_and_Risks.md](04_IMPLEMENTATION/DOD_and_Risks.md) | 9 项完成定义 |
| [Schema_Generation_And_Drift_Control.md](04_IMPLEMENTATION/Schema_Generation_And_Drift_Control.md) | Zod → JSON Schema → Markdown |
| [Operational_UX_Testing_Addendum.md](04_IMPLEMENTATION/Operational_UX_Testing_Addendum.md) | 运维体验测试 |

### 交付摘要

```
后端: Zero AgentLoop adapter, tool call wrapper, LLM streaming, memory override, closure classifier
前端: PIInput, StreamingText, agent role rendering, toolcall expand/collapse
测试: Zero adapter, LLM stream reconnect, memory not default verified, natural language → task → dummy job → report E2E, engineering + science_assist demo
```

### 出口标准

```
三个 Playbook E2E 通过，PI 自然语言驱动全流程，CI 绿灯，可部署。
T0-T5 全部通过，release regression 通过。
```

---

## 对齐检查点操作流程

每个阶段完成后、下一阶段开始前：

**1. 回顾** — 逐份检查本阶段 spec：字段/枚举/状态机/API 与代码是否一致？有没有代码加了但 spec 没覆盖的？

**2. 修正** — 代码有理由偏离 → 更新 spec（记录原因）；代码偷懒 → 修复代码。涉及核心对象同步 [Minimal_Schemas](03_SPEC/Minimal_Schemas.md) + [CANONICAL_CONTRACTS](00_INDEX/CANONICAL_CONTRACTS.md)。

**3. 预读** — 读下一阶段所有 spec，标注依赖当前输出的字段/接口是否存在。

**4. 调整** — 先改 spec，再写代码。在 spec 文件头部记录修改版本和原因。

---

## 文档分布统计

| 阶段 | 新激活 | 累计 |
|------|------:|-----:|
| 基座 | 14 | 14 |
| Phase 1 骨架 | 9 | 23 |
| Phase 2 执行 | 14 | 37 |
| Phase 3 科学 | 7 | 44 |
| Phase 4 分析 | 6 | 50 |
| Phase 5 治理 | 7 | 57 |
| Phase 6 交付 | 13 | 70 |

> 计数为并账前量级参考；归属以各 Phase 激活表为准（2026-07-02 起 Preflight 归位 Phase 2、T2C API/Test 契约入 Phase 3）。

---

## 关键依赖链

```
Chain 1: Schema → Execution → Recovery
Minimal_Schemas → Execution_Jobs_Runs → Runner_Adapter → Park_Resume → Idempotency → Snapshot_Recovery

Chain 2: Auth → WebSocket → Frontend State
User_Session_And_Audit → Auth_Permission → WebSocket_Protocol → Frontend_State_Design

Chain 3: Data → Artifact → Visualization
Data_Storage_Provenance → Artifact_Registry → SHUD_Output_Variables → Visualization_Data_Spec

Chain 4: Analysis → Batch → Report
Sensitivity_Calibration → Addendum → Parameter_Set_Mapping → Batch_Progress → Report_Generation

Chain 5: Report → Evidence → PI Gate → Notification
Report_Generation → Evidence_Lineage → PI_Decision_Comments → Notification_Design

Chain 6: Governance (全程约束)
Research_Constitution → Roles_and_Boundaries → Agent_Architecture → Task_Playbooks

Chain 7: Observability → Operations
Observability_Monitoring_Spec → Alerting_Thresholds → Log_Aggregation → Operations_Runbook → Performance_NFR

Chain 8: Requirements → Traceability
Requirements_Catalog → Requirements_Numbering → Traceability_Matrix → Dependency_Versioning_Policy
```

---

## 未绑定阶段的文档

| 文件 | 性质 |
|------|------|
| [Zero_Codebase_Report.md](01_CODEBASE/Zero_Codebase_Report.md) | Zero 扩展时查阅 |
| [Zero_Reuse_Matrix.md](02_ARCHITECTURE/Zero_Reuse_Matrix.md) | Zero 复用决策 |
| [Architecture_Decisions.md](02_ARCHITECTURE/Architecture_Decisions.md) | onboarding 时读 |
| [Module_Status_Matrix.md](02_ARCHITECTURE/Module_Status_Matrix.md) | 进度追踪 |
| [GAP_ANALYSIS.md](00_INDEX/GAP_ANALYSIS.md) | 历史 |
| [Spec_Gap_Audit_v0_8_1.md](00_INDEX/Spec_Gap_Audit_v0_8_1.md) | 历史 |
| [PRD_Spec_Gap_Audit_v0_8_2.md](00_INDEX/PRD_Spec_Gap_Audit_v0_8_2.md) | v0.8.2 缺口审查 |
| [PRD_Spec_Merge_Map.md](00_INDEX/PRD_Spec_Merge_Map.md) | 合并地图 |
