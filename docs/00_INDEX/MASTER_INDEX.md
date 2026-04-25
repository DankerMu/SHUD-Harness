# SHUD-Harness 文档主索引

> **版本**: v0.8.2 (2026-04-25)
> **技术栈**: TypeScript 全栈 (Bun + Hono + React)，基于 Zero Agent Runtime 扩展
> **交互模式**: Web-first，实时对话 + 日志流 + PI 审批 + 报告阅读
> **文档总量**: 4 个目录，80 份规范文档

---

## 核心文件

开始开发前只需读这四份：

| 文件 | 用途 |
|------|------|
| [`../../CLAUDE.md`](../../CLAUDE.md) | 项目定义 + 仓库布局 + 设计决策速查 |
| [`../SPEC_v0.8_Final.md`](../SPEC_v0.8_Final.md) | 自包含实施规格书（阅读基准） |
| [`CANONICAL_CONTRACTS.md`](CANONICAL_CONTRACTS.md) | Schema / API / Event / Path / Artifact / Lock 的唯一事实源索引 |
| [`../Phased_Spec_Activation.md`](../Phased_Spec_Activation.md) | **开发路线图** — 6 阶段 Spec 激活 + 交付摘要 + 测试出口 + 对齐检查点 |

---

## 00_INDEX/ -- 索引与导航

| 文件 | 用途 |
|------|------|
| [`MASTER_INDEX.md`](MASTER_INDEX.md) | 本文件 |
| [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md) | v0.8 设计差距分析 |
| [`CANONICAL_CONTRACTS.md`](CANONICAL_CONTRACTS.md) | Canonical contract 索引 |
| [`Spec_Gap_Audit_v0_8_1.md`](Spec_Gap_Audit_v0_8_1.md) | v0.8.1 规格缺口审查 |
| [`PRD_Spec_Gap_Audit_v0_8_2.md`](PRD_Spec_Gap_Audit_v0_8_2.md) | v0.8.2 PRD/Spec 缺口审查 |
| [`PRD_Spec_Merge_Map.md`](PRD_Spec_Merge_Map.md) | v0.8.2 补充文档合并地图 |
| [`Requirements_Catalog.md`](Requirements_Catalog.md) | 正式需求目录（US/FR/NFR/DR/GR/IR/TR 编号体系） |
| [`Requirements_Numbering_Conventions.md`](Requirements_Numbering_Conventions.md) | 需求编号、状态、优先级和 traceability 规则 |

---

## 01_CODEBASE/ -- 代码库现实报告

| 文件 | 用途 |
|------|------|
| [`SHUD_Codebase_Report.md`](../01_CODEBASE/SHUD_Codebase_Report.md) | SHUD C++ 求解器代码报告 |
| [`rSHUD_Codebase_Report.md`](../01_CODEBASE/rSHUD_Codebase_Report.md) | rSHUD R 工具包代码报告 |
| [`AutoSHUD_Codebase_Report.md`](../01_CODEBASE/AutoSHUD_Codebase_Report.md) | AutoSHUD R 脚本代码报告 |
| [`Zero_Codebase_Report.md`](../01_CODEBASE/Zero_Codebase_Report.md) | Zero Agent Runtime 代码报告 |

---

## 02_ARCHITECTURE/ -- 架构与治理

| 文件 | 用途 |
|------|------|
| [`Architecture_Decisions.md`](../02_ARCHITECTURE/Architecture_Decisions.md) | 架构决策记录 |
| [`Agent_Architecture.md`](../02_ARCHITECTURE/Agent_Architecture.md) | Agent 架构 |
| [`Control_Kernel.md`](../02_ARCHITECTURE/Control_Kernel.md) | 控制内核 |
| [`Interaction_Model.md`](../02_ARCHITECTURE/Interaction_Model.md) | 交互模型 |
| [`Roles_and_Boundaries.md`](../02_ARCHITECTURE/Roles_and_Boundaries.md) | 角色与边界 |
| [`Research_Constitution.md`](../02_ARCHITECTURE/Research_Constitution.md) | 研究宪章 |
| [`Module_Status_Matrix.md`](../02_ARCHITECTURE/Module_Status_Matrix.md) | 模块状态矩阵 |
| [`Zero_Reuse_Matrix.md`](../02_ARCHITECTURE/Zero_Reuse_Matrix.md) | Zero 复用矩阵 |

---

## 03_SPEC/ -- 规范

### 核心对象与 Schema

| 文件 | 用途 |
|------|------|
| [`Minimal_Schemas.md`](../03_SPEC/Minimal_Schemas.md) | 8 个核心对象 + MemoryNote 权威定义 |
| [`Support_Schema_Contracts.md`](../03_SPEC/Support_Schema_Contracts.md) | Support schema 统一定义（Artifact、ErrorRecord、PiGate 等） |
| [`Research_Object_Model.md`](../03_SPEC/Research_Object_Model.md) | 研究对象模型 |

### 执行与运行

| 文件 | 用途 |
|------|------|
| [`Execution_Jobs_Runs.md`](../03_SPEC/Execution_Jobs_Runs.md) | 执行、长任务、RunRecord 与恢复 |
| [`Runner_Adapter_Contracts.md`](../03_SPEC/Runner_Adapter_Contracts.md) | Runner 统一 adapter 接口（local/docker/slurm） |
| [`Sandbox_and_Executor.md`](../03_SPEC/Sandbox_and_Executor.md) | 沙箱与执行器 |
| [`Park_Resume_Design.md`](../03_SPEC/Park_Resume_Design.md) | Park/Resume 长任务设计 |
| [`Idempotency_Concurrency_Locking_Spec.md`](../03_SPEC/Idempotency_Concurrency_Locking_Spec.md) | 幂等、并发与锁 |

### 数据与存储

| 文件 | 用途 |
|------|------|
| [`Data_Storage_Provenance.md`](../03_SPEC/Data_Storage_Provenance.md) | 数据存储与溯源 |
| [`Artifact_Registry_Spec.md`](../03_SPEC/Artifact_Registry_Spec.md) | Artifact 注册、manifest、证据性 |
| [`Workspace_Conventions.md`](../03_SPEC/Workspace_Conventions.md) | Workspace 路径与文件生命周期 |
| [`Workspace_Snapshot_And_Recovery_Spec.md`](../03_SPEC/Workspace_Snapshot_And_Recovery_Spec.md) | Snapshot 与恢复 |
| [`Data_Package_And_Retention_Spec.md`](../03_SPEC/Data_Package_And_Retention_Spec.md) | 数据包与保留策略 |
| [`Config_Secrets_And_Environment_Spec.md`](../03_SPEC/Config_Secrets_And_Environment_Spec.md) | 配置、密钥与环境变量 |

### 分析与校准

| 文件 | 用途 |
|------|------|
| [`Sensitivity_Calibration_Benchmark.md`](../03_SPEC/Sensitivity_Calibration_Benchmark.md) | 敏感性/校准/基准分析 |
| [`Sensitivity_Calibration_Benchmark_Addendum.md`](../03_SPEC/Sensitivity_Calibration_Benchmark_Addendum.md) | 分析补充规范 |
| [`Parameter_Set_And_Analysis_Run_Mapping.md`](../03_SPEC/Parameter_Set_And_Analysis_Run_Mapping.md) | ParameterSet 与运行映射 |

### 报告与证据

| 文件 | 用途 |
|------|------|
| [`Report_Generation_Spec.md`](../03_SPEC/Report_Generation_Spec.md) | EvidenceReport 生成规范 |
| [`Report_Review_And_Evidence_Lineage_Spec.md`](../03_SPEC/Report_Review_And_Evidence_Lineage_Spec.md) | 报告审查与证据链 |
| [`Report_Export_Spec.md`](../03_SPEC/Report_Export_Spec.md) | 报告导出规范 |

### 权限与审计

| 文件 | 用途 |
|------|------|
| [`Auth_Permission_Design.md`](../03_SPEC/Auth_Permission_Design.md) | 认证与权限设计 |
| [`User_Session_And_Audit_Schema.md`](../03_SPEC/User_Session_And_Audit_Schema.md) | User/Session/Audit schema |

### 交互与前端

| 文件 | 用途 |
|------|------|
| [`WebSocket_Protocol.md`](../03_SPEC/WebSocket_Protocol.md) | WebSocket 实时协议 |
| [`Visualization_Data_Spec.md`](../03_SPEC/Visualization_Data_Spec.md) | 可视化数据规范 |
| [`UI_Implementation_Spec.md`](../03_SPEC/UI_Implementation_Spec.md) | UI 实施规范 |
| [`UX_Design_Spec.md`](../03_SPEC/UX_Design_Spec.md) | UX 设计规范 |
| [`Frontend_State_Design.md`](../03_SPEC/Frontend_State_Design.md) | 前端状态设计 |
| [`Batch_Progress_View_Spec.md`](../03_SPEC/Batch_Progress_View_Spec.md) | 批量进度视图规范 |
| [`PI_Decision_Comments_Spec.md`](../03_SPEC/PI_Decision_Comments_Spec.md) | PI 决策批注规范 |
| [`Notification_Design.md`](../03_SPEC/Notification_Design.md) | 通知设计 |
| [`Operational_UX_Addendum.md`](../03_SPEC/Operational_UX_Addendum.md) | 运维体验补充 |

### 监控与性能 NFR

| 文件 | 用途 |
|------|------|
| [`Observability_Monitoring_Spec.md`](../03_SPEC/Observability_Monitoring_Spec.md) | 可观测性、健康检查、指标与 Ops Dashboard |
| [`Alerting_Thresholds_Spec.md`](../03_SPEC/Alerting_Thresholds_Spec.md) | 告警阈值、严重性、dedupe 与升级策略 |
| [`Log_Aggregation_Spec.md`](../03_SPEC/Log_Aggregation_Spec.md) | 结构化日志、聚合、保留与 redaction |
| [`Performance_NFR_Spec.md`](../03_SPEC/Performance_NFR_Spec.md) | REST、WebSocket、report、batch、并发性能 NFR |

### 运行时

| 文件 | 用途 |
|------|------|
| [`Memory_Skills_Lite.md`](../03_SPEC/Memory_Skills_Lite.md) | 轻量记忆与技能 |
| [`Cost_Inference_Budget.md`](../03_SPEC/Cost_Inference_Budget.md) | 推理预算 |
| [`Error_Handling_Spec.md`](../03_SPEC/Error_Handling_Spec.md) | 错误处理规范 |
| [`Multiuser_Harness_Versioning.md`](../03_SPEC/Multiuser_Harness_Versioning.md) | 多用户与版本管理 |
| [`Internationalization_Localization.md`](../03_SPEC/Internationalization_Localization.md) | 国际化 |
| [`SHUD_Output_Variables.md`](../03_SPEC/SHUD_Output_Variables.md) | SHUD 输出变量 |

---

## 04_IMPLEMENTATION/ -- 实施

| 文件 | 用途 |
|------|------|
| [`Phased_Plan.md`](../04_IMPLEMENTATION/Phased_Plan.md) | 8 周分阶段实施计划 |
| [`MVP_Implementation_Readiness_Checklist.md`](../04_IMPLEMENTATION/MVP_Implementation_Readiness_Checklist.md) | 开工前 readiness 检查清单 |
| [`Repository_Layout.md`](../04_IMPLEMENTATION/Repository_Layout.md) | 仓库目录与 monorepo 结构 |
| [`Schemas_APIs_CLIs.md`](../04_IMPLEMENTATION/Schemas_APIs_CLIs.md) | API 端点与 schema 验证 |
| [`API_Error_And_Idempotency_Contracts.md`](../04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md) | API 错误响应与幂等请求契约 |
| [`Schema_Generation_And_Drift_Control.md`](../04_IMPLEMENTATION/Schema_Generation_And_Drift_Control.md) | Schema 生成与 drift 控制 |
| [`Testing_Strategy.md`](../04_IMPLEMENTATION/Testing_Strategy.md) | 测试策略 |
| [`Phase_By_Phase_Test_Plan.md`](../04_IMPLEMENTATION/Phase_By_Phase_Test_Plan.md) | W0-W8 阶段测试矩阵（Test ID + 场景 + Pass Criterion） |
| [`Test_Fixtures_And_Command_Matrix.md`](../04_IMPLEMENTATION/Test_Fixtures_And_Command_Matrix.md) | 测试 Fixture 层级与命令矩阵 |
| [`Traceability_Matrix.md`](../04_IMPLEMENTATION/Traceability_Matrix.md) | 需求 → 文档 → 代码 → 测试 → Release 追踪矩阵 |
| [`CICD_Release.md`](../04_IMPLEMENTATION/CICD_Release.md) | CI/CD 与发布 |
| [`Deployment_Architecture.md`](../04_IMPLEMENTATION/Deployment_Architecture.md) | 部署架构 |
| [`DOD_and_Risks.md`](../04_IMPLEMENTATION/DOD_and_Risks.md) | 完成定义与风险 |
| [`Task_Playbooks.md`](../04_IMPLEMENTATION/Task_Playbooks.md) | 任务 Playbook |
| [`Operational_UX_API_Contracts.md`](../04_IMPLEMENTATION/Operational_UX_API_Contracts.md) | 运维体验 API 契约 |
| [`Operational_UX_Testing_Addendum.md`](../04_IMPLEMENTATION/Operational_UX_Testing_Addendum.md) | 运维体验测试补充 |
| [`Operations_Runbook.md`](../04_IMPLEMENTATION/Operations_Runbook.md) | 磁盘满、Job 卡死、DuckDB 损坏、SMTP 故障、OOM、密钥泄露运维手册 |
| [`Dependency_Versioning_Policy.md`](../04_IMPLEMENTATION/Dependency_Versioning_Policy.md) | Bun/npm/TypeScript/Zod/React/DuckDB 依赖锁定与更新策略 |
| [`Performance_Test_Plan.md`](../04_IMPLEMENTATION/Performance_Test_Plan.md) | 性能 NFR 测试计划 |
| [`Observability_Test_Plan.md`](../04_IMPLEMENTATION/Observability_Test_Plan.md) | 健康检查、日志、指标、告警和 runbook drill 测试计划 |

---

## 99_ARCHIVE/ -- 已归档

历史版本文档（v0.1--v0.6）及设计补充包（v0.8 design addendum、operational UX addendum）均已归档于此目录，仅供追溯参考。当前规范以上述各目录中的正式文档为准。

---

## 文档阅读顺序建议

1. **[`../../CLAUDE.md`](../../CLAUDE.md)** -- 了解项目定位、仓库布局和 10 项设计决策
2. **[`../SPEC_v0.8_Final.md`](../SPEC_v0.8_Final.md)** -- 通读自包含规格书，建立全局认知
3. **[`CANONICAL_CONTRACTS.md`](CANONICAL_CONTRACTS.md)** -- 掌握所有 canonical contract 的索引位置
4. **[`../03_SPEC/Minimal_Schemas.md`](../03_SPEC/Minimal_Schemas.md)** -- 熟悉 8 个核心对象字段定义
5. **按需深入** -- 根据当前工作领域选读：
   - 后端开发：Execution_Jobs_Runs -> Park_Resume_Design -> Runner_Adapter_Contracts -> Sandbox_and_Executor
   - 前端开发：Interaction_Model -> Frontend_State_Design -> WebSocket_Protocol -> UI_Implementation_Spec -> UX_Design_Spec
   - 数据层：Data_Storage_Provenance -> Workspace_Conventions -> Artifact_Registry_Spec
   - 分析校准：Sensitivity_Calibration_Benchmark -> Parameter_Set_And_Analysis_Run_Mapping
   - 部署运维：Deployment_Architecture -> CICD_Release -> Testing_Strategy -> Operations_Runbook -> Dependency_Versioning_Policy
   - 监控性能：Observability_Monitoring_Spec -> Alerting_Thresholds_Spec -> Log_Aggregation_Spec -> Performance_NFR_Spec
   - 需求追踪：Requirements_Catalog -> Requirements_Numbering_Conventions -> Traceability_Matrix
   - 实施计划：Phased_Plan -> Repository_Layout -> DOD_and_Risks
