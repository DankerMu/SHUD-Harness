# 分阶段 Spec 激活与对齐

**原则：** 代码跟着 spec 走，spec 是权威源。67 份 spec 不同时激活——每个阶段只激活该阶段代码直接依赖的文档。阶段切换时，基于实现经验对齐下一阶段的 spec。

**依据：** 本文档基于全部 67 份文档的交叉引用和依赖链深度分析生成，不基于文件名猜测。

---

## 全程基座（始终激活）

无论处于哪个阶段，以下文档始终是 source of truth：

| 文件 | 角色 |
|------|------|
| `CLAUDE.md` | 项目定位 + 10 项设计决策 |
| `SPEC_v0.8_Final.md` | 自包含阅读基准 |
| `CANONICAL_CONTRACTS.md` | 唯一事实源索引 |
| `Minimal_Schemas.md` | 8 核心对象字段定义（所有 spec 的依赖根） |
| `Support_Schema_Contracts.md` | 18 个 support schema 定义（被 10+ 份 spec 引用） |
| `Repository_Layout.md` | Monorepo 目录结构 |
| `Schemas_APIs_CLIs.md` | API 端点注册表（随阶段增长） |

### 渐进文档（每阶段追加相关部分）

以下文档跨越多个阶段，每阶段只关注当前相关章节：

| 文件 | 说明 |
|------|------|
| `Testing_Strategy.md` | 每阶段激活对应测试类别（schema → execution → fixture → report → E2E） |
| `Error_Handling_Spec.md` | Phase 2 起激活，错误分类覆盖 sandbox/runner/parser/numerical 各层 |
| `Config_Secrets_And_Environment_Spec.md` | Phase 1 起激活，环境变量/secret/redaction 贯穿全程 |

---

## Phase 1：骨架可运行

**目标：** Monorepo 初始化、核心 Zod schema 落地、workspace 目录生成、基础 CRUD API、四栏前端壳。

**交付标志：** 浏览器打开四栏布局，POST /api/tasks 可创建 TaskCard，workspace 文件树自动生成。

**激活 Spec：**

| 文件 | 本阶段关注点 | 依赖理由 |
|------|-------------|---------|
| `Workspace_Conventions.md` | 路径体系、目录结构、Git 策略 | 几乎所有执行和存储操作的路径基础 |
| `Data_Storage_Provenance.md` | 存储分层（raw/processed/runs/artifacts）、DataProvenance schema | 定义 workspace 文件层级，Artifact 目录结构的前提 |
| `Control_Kernel.md` | TaskCard 状态机、runtime_phase、Brief→Plan→Execute→Report 流程 | 定义 TaskCard.status 的全部合法转换，Phase 1 就要实现状态机 |
| `Interaction_Model.md` | 四栏布局定义（SideNav + AgentFeed + Experiment + Results）| 四栏壳的架构依据 |
| `UI_Implementation_Spec.md` | 设计 tokens、组件基础规范、WorkbenchLayout | 四栏壳的视觉实现依据 |
| `API_Error_And_Idempotency_Contracts.md` | 错误响应 envelope（仅结构，不含 idempotency header） | 第一个 API 端点就需要统一错误格式 |
| `MVP_Implementation_Readiness_Checklist.md` | P0 检查项 | 开工门禁 |

### Phase 1 → 2 对齐检查点

- [ ] Workspace_Conventions 中定义的路径体系与实际生成的目录是否一致？
- [ ] TaskCard 状态机的 Zod schema 是否与 Control_Kernel + Minimal_Schemas 一致？
- [ ] 四栏布局的实际 grid 比例是否与 Interaction_Model 一致？
- [ ] API error envelope 字段在实际使用中是否够用？
- [ ] Data_Storage_Provenance 的存储分层在 workspace init 中是否完整建立？
- [ ] **预读 Phase 2 spec**：Execution_Jobs_Runs 的 RunJob 状态机是否能接上当前 TaskCard 状态机？WebSocket 的 Session 认证需要怎样的 User/Session 基础？

---

## Phase 2：执行闭环

**目标：** RunJob 可提交、sandbox 可执行、WebSocket 可推流、dummy job 可走完 submit → run → collect → RunRecord 全流程，Park/Resume 可工作。

**交付标志：** dummy job submit → WebSocket 实时推流日志 → collect 生成 RunRecord → 服务重启后 watcher 可恢复。

**激活 Spec：**

| 文件 | 本阶段关注点 | 依赖理由 |
|------|-------------|---------|
| `Execution_Jobs_Runs.md` | RunJob 状态机、执行模式、collect 流程、失败恢复 | 执行层核心，依赖 Runner_Adapter + Sandbox + Park_Resume |
| `Sandbox_and_Executor.md` | 命令审计、路径策略、风险分级 | Execution_Jobs_Runs 的命令执行通过 Sandbox |
| `Runner_Adapter_Contracts.md` | submit/status/cancel/collect 统一接口 | Execution_Jobs_Runs 引用，RunJob.status 从 runner 映射 |
| `Park_Resume_Design.md` | ParkedState、job watcher、collect 阶段、resume 上下文 | 长任务核心，依赖 Execution + Runner + Idempotency |
| `Idempotency_Concurrency_Locking_Spec.md` | collect 幂等、lock 文件、状态单调性 | Park_Resume 的 collect.lock，防止重复 RunRecord |
| `Workspace_Snapshot_And_Recovery_Spec.md` | TaskSnapshot、service restart recovery、event replay | 服务重启后恢复 parked job，依赖 Park_Resume + Idempotency |
| `WebSocket_Protocol.md` | 事件 envelope、20+ 消息类型、seq 单调、断线重连 | 实时推流的协议定义，依赖 Snapshot 做 replay gap 处理 |
| `Auth_Permission_Design.md` | 基础角色定义、Session 管理、WebSocket 认证 | WebSocket 建连绑定 Session，API 需要 auth middleware |
| `User_Session_And_Audit_Schema.md` | User / Session schema（基础部分） | Auth 的 schema 基础，WebSocket session 绑定 |
| `Frontend_State_Design.md` | WebSocket reducer、entity cache、seq 去重 | 前端消费 WebSocket 事件的状态管理 |
| `Roles_and_Boundaries.md` | 角色边界（PI/Coordinator/Worker/Reviewer） | 多角色消息流中的角色区分 |
| `Agent_Architecture.md` | Agent 角色定义、Coordinator 决策流、agent 间通信 | AgentActivityFeed 展示多角色消息需要理解 agent 架构 |

### Phase 2 → 3 对齐检查点

- [ ] RunJob 状态机的实际转换是否与 Execution_Jobs_Runs 一致？有没有 spec 没覆盖的状态？
- [ ] Runner adapter 的 RunnerCollectResult 是否需要额外字段？
- [ ] WebSocket 事件类型是否够用？payload 是否与 spec 吻合？
- [ ] idempotency key 拼接规则实际可行吗？
- [ ] Park/Resume 的 parked_state.yaml 结构需要调整吗？
- [ ] Session 认证在 WebSocket 上的实际表现是否足够？
- [ ] Frontend reducer 的 seq 去重逻辑是否稳定？
- [ ] **预读 Phase 3 spec**：SHUD_Output_Variables 的变量 ID 和单位需要什么格式？Artifact_Registry 的 metadata 字段能否容纳 SHUD 产出？

---

## Phase 3：科学运行

**目标：** 真实 SHUD tiny case 可编译运行、StackLock/DataProvenance 绑定、RunRecord 包含 numerical_health、Artifact 登记完整、HydrographChart 可展示、第一个 Skill 可运行。

**交付标志：** ccw tiny case 编译+运行 exit_code=0，water_balance_residual < 阈值，前端 HydrographChart 展示 rivqdown 过程线，run-shud-tiny-case skill 可执行。

**激活 Spec：**

| 文件 | 本阶段关注点 | 依赖理由 |
|------|-------------|---------|
| `SHUD_Output_Variables.md` | 变量注册表（34 个变量）、单位、NumericalHealth 指标 | 无外部依赖，RunRecord.numerical_health 和 Visualization 的数据基础 |
| `Artifact_Registry_Spec.md` | Artifact 类型、metadata、evidence_usable 规则、manifest | 依赖 Support_Schema_Contracts 的 Artifact schema，SHUD 产出的登记机制 |
| `Visualization_Data_Spec.md` | HydrographChart、ResultsOverview、canonical data API、单位策略 | 依赖 Artifact_Registry + SHUD_Output_Variables，不含 heatmap（Phase 4） |
| `Memory_Skills_Lite.md` | MemoryNote schema、Skill 生命周期（draft→active→retired）、MVP 5 个 skill | 第一个 skill（run-shud-tiny-case）在本阶段运行；MemoryNote 绑定 RunRecord |
| `Cost_Inference_Budget.md` | 三档预算、CostRecord、cost.updated 事件 | 真实 SHUD 运行开始消耗算力，需要预算追踪 |
| `Research_Constitution.md` | 科研治理规则、禁止表述、PI 审批边界 | 真实科学运行开始，治理规则必须生效 |

**激活参考：**

| 文件 | 用途 |
|------|------|
| `SHUD_Codebase_Report.md` | SHUD 编译/运行/输入输出格式 |
| `rSHUD_Codebase_Report.md` | read_output() / wb.all() 调用方式 |
| `AutoSHUD_Codebase_Report.md` | 自动化流水线参考 |

### Phase 3 → 4 对齐检查点

- [ ] Artifact 的 type 枚举是否覆盖了 SHUD 所有产出类型？
- [ ] SHUD_Output_Variables 中列出的变量 ID 与 rSHUD read_output() 实际返回是否一致？
- [ ] visualization dataset 的 envelope 字段在真实数据上是否够用？
- [ ] numerical_health 的四个指标在实际 tiny run 上的值域是否合理？阈值是否需要调？
- [ ] Skill 的 SKILL.md 格式是否易于编写和维护？
- [ ] MemoryNote 的 pi_decision 类型在没有 PI gate 的情况下是否需要调整？
- [ ] **预读 Phase 4 spec**：ParameterSet 映射和 batch_policy 与当前 RunJob/Artifact 的结构是否兼容？Visualization_Data_Spec 的 heatmap/ParameterSetTable 部分是否需要基于 Phase 3 的实际数据格式调整？

---

## Phase 4：分析引擎

**目标：** AnalysisPlan(mode=sensitivity) 可创建、batch parameter runner 可并发执行多组参数、heatmap/参数表/对比图可展示、ChangeRequest + diff 可工作。

**交付标志：** PI 指定 ksat × roughness 参数空间 → batch 自动运行 → 前端展示参数表 + 热力图 + 对比过程线，失败 cell 可见。

**激活 Spec：**

| 文件 | 本阶段关注点 | 依赖理由 |
|------|-------------|---------|
| `Sensitivity_Calibration_Benchmark.md` | 三种分析模式边界、指标解读规则、AnalysisPlan 概念模型 | 无外部依赖，分析层的概念基础 |
| `Sensitivity_Calibration_Benchmark_Addendum.md` | 扩展 AnalysisPlan schema、batch 运行设计、BatchProgressGrid、stop_condition | 依赖上文 + Parameter_Set_Mapping |
| `Parameter_Set_And_Analysis_Run_Mapping.md` | ParameterSet schema、PSET↔RunJob↔RunRecord 映射、并发策略 | 依赖 Addendum 提供的 batch 上下文 |
| `Batch_Progress_View_Spec.md` | BatchProgressGrid 数据结构与前端规格 | 依赖 Frontend_State_Design + Addendum |
| `Visualization_Data_Spec.md` | **追加激活：** SensitivityHeatmap、ParameterSetTable、HydrographComparison | Phase 3 已激活 hydrograph 部分，本阶段追加分析可视化 |
| `Research_Object_Model.md` | AnalysisPlan 在 8 对象模型中的位置和关系 | 理解 AnalysisPlan 与 TaskCard/RunJob 的关联 |

### Phase 4 → 5 对齐检查点

- [ ] AnalysisPlan 的 parameter_sets 和 batch_policy 字段在实际 batch 中是否足够？
- [ ] ParameterSet.status 从 RunJob 派生的逻辑是否稳定？
- [ ] 并发 batch 的目录隔离策略实际表现如何？
- [ ] heatmap excluded cells 的记录方式是否可行？
- [ ] stop_condition 的三种模式实际是否都需要？
- [ ] BatchProgressGrid 的 WebSocket event 推送频率是否合理？
- [ ] **预读 Phase 5 spec**：Report_Generation 需要从 AnalysisPlan 拉取哪些数据？Evidence_Lineage 的 assertion 分类对 sensitivity 报告是否合适？PI_Decision_Comments 的 comment_required 矩阵是否与当前 PI gate 实现对接？

---

## Phase 5：报告与治理

**目标：** EvidenceReport 可生成（deterministic 模板 + LLM narrative）、Reviewer 检查链可工作、PI gate 审批可工作（含 comment）、报告可导出 HTML、通知可发、审计链完整。

**交付标志：** RunRecord → 生成 report → Reviewer 检查 → PI 审批（含 comment）→ accepted report 可导出 HTML，通知邮件可发，审计链完整可查。

**激活 Spec：**

| 文件 | 本阶段关注点 | 依赖理由 |
|------|-------------|---------|
| `Report_Generation_Spec.md` | 报告模板、language guard、evidence level、生成流程、status flow | 依赖 TaskCard + StackLock + DataProvenance + RunRecord + Artifact（全部已实现） |
| `Report_Review_And_Evidence_Lineage_Spec.md` | ReportAssertion 分类、lineage guard、reviewer checklist | 扩展 Report_Generation，依赖 Artifact + PiGateDecision |
| `Report_Export_Spec.md` | standalone HTML 模板、draft watermark、export manifest | 依赖 Report_Generation + Artifact manifest |
| `PI_Decision_Comments_Spec.md` | PiGateDecision schema、comment 必填规则、pi_decision MemoryNote | 依赖 Auth（PI 角色）+ User_Session_And_Audit（AuditEvent）+ Memory（MemoryNote） |
| `Notification_Design.md` | 触发规则、dedupe_key、SMTP/SendGrid、recipient 解析 | report_draft_created / analysis_completed 触发通知，依赖 Report + Auth |
| `Operational_UX_Addendum.md` | 4 个运维功能的综合设计框架 | 协调 PI comments + export + batch progress + notification |
| `Operational_UX_API_Contracts.md` | report export / PI gate / analysis progress / notifications 的 API 详情 | Operational_UX_Addendum 的 API 落地 |

### Phase 5 → 6 对齐检查点

- [ ] ReportAssertion 的 7 种 assertion_type 是否都在实际 report 中出现？需要合并或增减吗？
- [ ] evidence_level 的 5 个级别是否实用？
- [ ] language guard 禁止词表的误报率如何？
- [ ] PI gate 的 comment_required 规则是否需要调整？
- [ ] 通知的 dedupe_key 拼接规则是否有效防重？
- [ ] SMTP/SendGrid 的 secret 管理是否与 Config_Secrets spec 一致？
- [ ] **预读 Phase 6 spec**：Multiuser 并发 session 与当前 Session 实现的兼容性？i18n 对当前 UI 组件的影响范围？CI/CD 需要哪些额外检查？

---

## Phase 6：集成打磨与交付

**目标：** 多用户并发可用、i18n 完成、三个 Playbook 端到端通过、CI/CD 完整、数据包/保留策略上线、UX 打磨、可部署。

**交付标志：** 三个 Playbook（engineering / science-assist / ops）端到端可走通，PI 在浏览器中自然语言驱动全流程，CI 绿灯，可部署。

**激活 Spec：**

| 文件 | 本阶段关注点 | 依赖理由 |
|------|-------------|---------|
| `Multiuser_Harness_Versioning.md` | 多用户并发 session、task lock、StackLock harness 版本 | 依赖 User/Session + TaskCard + StackLock |
| `Data_Package_And_Retention_Spec.md` | evidence/debug/benchmark 打包、retention 策略、cleanup guard | 依赖 Artifact_Registry + Data_Storage_Provenance |
| `UX_Design_Spec.md` | 用户旅程、反馈模式、注意力管理、NextSuggestedAction | UX 打磨基于所有功能已就位 |
| `Internationalization_Localization.md` | i18n 规范、术语表 | 依赖 UI 组件全部稳定 |
| `Task_Playbooks.md` | 三个 Playbook 决策树、端到端验证 | 依赖所有子系统可工作 |

**激活 Impl：**

| 文件 | 本阶段关注点 | 依赖理由 |
|------|-------------|---------|
| `CICD_Release.md` | 完整 CI pipeline、submodule 检查、schema drift 强制检查 | 依赖 Schema_Generation + Testing + Deployment |
| `Deployment_Architecture.md` | 部署模式（local/Docker/HPC）、服务组合 | 依赖所有服务实现完成 |
| `DOD_and_Risks.md` | 9 项完成定义、失败条件、成功指标 | MVP 验收标准 |
| `Schema_Generation_And_Drift_Control.md` | Zod → JSON Schema → Markdown 自动化、CI drift check | 依赖所有 schema 稳定 |
| `Operational_UX_Testing_Addendum.md` | 运维体验测试矩阵 | 依赖所有运维功能实现 |

---

## 未绑定阶段的文档

以下文档为背景参考或历史记录，按需查阅：

| 文件 | 性质 |
|------|------|
| `Zero_Codebase_Report.md` | Zero 代码库参考，扩展时查阅 |
| `Zero_Reuse_Matrix.md` | Zero 复用决策参考 |
| `Architecture_Decisions.md` | 架构决策记录，onboarding 时读 |
| `Module_Status_Matrix.md` | 模块状态矩阵，追踪进度时查 |
| `GAP_ANALYSIS.md` | v0.8 差距分析（历史） |
| `Spec_Gap_Audit_v0_8_1.md` | v0.8.1 规格缺口审查（历史） |
| `Phased_Plan.md` | 8 周计划（时间维度参考，阶段激活不依赖它） |

---

## 对齐检查点操作流程

每个阶段完成后、下一阶段开始前，执行以下操作：

### 1. 回顾（Diff）

逐份检查本阶段激活的 spec：
- 字段名/类型/枚举值是否与 Zod schema 一致
- API 端点的 path/method/payload 是否与 Schemas_APIs_CLIs 一致
- 状态机的转换路径是否与 spec 一致
- 有没有 spec 没覆盖但代码里加了的东西

### 2. 修正（Fix Forward）

- 代码有充分理由偏离 spec → **更新 spec**（记录原因）
- 代码是偷懒或遗漏 → **修复代码**
- 涉及核心对象 → 同步更新 Minimal_Schemas.md + CANONICAL_CONTRACTS.md
- 涉及 support schema → 同步更新 Support_Schema_Contracts.md

### 3. 预读（Preview）

读下一阶段的所有激活 spec，标注：
- 依赖当前阶段输出的字段/接口是否存在
- 假设的数据结构是否与实际吻合
- 有没有"spec 写的时候还没写代码，现在发现不对"的地方

### 4. 调整（Adjust）

- 修改下一阶段 spec 中与实现不符的部分
- **先改 spec，再写代码**——保持 spec 是权威源
- 在 spec 文件头部记录修改版本和原因

---

## 文档分布统计

| 阶段 | 新激活 | 累计激活 | 含义 |
|------|------:|-------:|------|
| 基座（全程） | 10 | 10 | 7 永久 + 3 渐进 |
| Phase 1 骨架 | 7 | 17 | + 架构/前端/存储基础 |
| Phase 2 执行 | 12 | 29 | + 执行/WebSocket/Auth/Agent 全栈 |
| Phase 3 科学 | 6 | 35 | + SHUD/Artifact/Skill/Cost/治理 |
| Phase 4 分析 | 6 | 41 | + 分析/batch/heatmap |
| Phase 5 治理 | 7 | 48 | + 报告/PI gate/通知/运维 |
| Phase 6 交付 | 10 | 58 | + 多用户/i18n/CI/部署/Playbook |
| 未绑定 | 7 | — | 背景参考 |
| **合计** | **65** | — | 覆盖全部活跃文档 |

---

## 关键依赖链（影响分阶段的核心约束）

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
```
