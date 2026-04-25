# v0.8.1 规格补充合并地图

本文件标明每个新增文档或补丁应合并到仓库中哪个文档、哪个部分。

## 1. 新增文档

| 新增文档 | 放置路径 | 目的 | 应在索引中放到哪里 |
|---|---|---|---|
| `CANONICAL_CONTRACTS.md` | `docs/00_INDEX/` | 汇总唯一事实源 | `00_INDEX` 表格，紧跟 `MASTER_INDEX.md` |
| `Support_Schema_Contracts.md` | `docs/03_SPEC/` | support schema 权威定义 | `03_SPEC` 中紧跟 `Minimal_Schemas.md` |
| `Artifact_Registry_Spec.md` | `docs/03_SPEC/` | Artifact 对象、manifest、证据性 | `Data_Storage_Provenance.md` 后 |
| `Report_Review_And_Evidence_Lineage_Spec.md` | `docs/03_SPEC/` | 报告 assertion-level evidence | `Report_Generation_Spec.md` 后 |
| `Idempotency_Concurrency_Locking_Spec.md` | `docs/03_SPEC/` | 幂等、锁、并发 | `Park_Resume_Design.md` 后 |
| `Workspace_Snapshot_And_Recovery_Spec.md` | `docs/03_SPEC/` | snapshot/replay/recovery | `WebSocket_Protocol.md` 后 |
| `User_Session_And_Audit_Schema.md` | `docs/03_SPEC/` | User/Session/Audit schema | `Auth_Permission_Design.md` 后 |
| `Config_Secrets_And_Environment_Spec.md` | `docs/03_SPEC/` | env/config/secret/redaction | `Auth_Permission_Design.md` 后 |
| `Runner_Adapter_Contracts.md` | `docs/03_SPEC/` | runner I/O contract | `Execution_Jobs_Runs.md` 后 |
| `Data_Package_And_Retention_Spec.md` | `docs/03_SPEC/` | export/data package/retention | `Data_Storage_Provenance.md` 后 |
| `Parameter_Set_And_Analysis_Run_Mapping.md` | `docs/03_SPEC/` | PSET ↔ RunJob ↔ RunRecord | `Sensitivity_Calibration_Benchmark_Addendum.md` 后 |
| `API_Error_And_Idempotency_Contracts.md` | `docs/04_IMPLEMENTATION/` | REST error + idempotency | `Schemas_APIs_CLIs.md` 后 |
| `Schema_Generation_And_Drift_Control.md` | `docs/04_IMPLEMENTATION/` | schema 生成与 drift 检查 | `CICD_Release.md` 前或后 |
| `MVP_Implementation_Readiness_Checklist.md` | `docs/04_IMPLEMENTATION/` | 开工前检查清单 | `Phased_Plan.md` 后 |

## 2. 对现有文档的补充点

| 补丁文件 | 目标文档 | 插入位置 | 合并动作 |
|---|---|---|---|
| `.gitmodules__format_check.md` | `.gitmodules` | 整个文件 | 检查并必要时改为多行 git-config 格式 |
| `MASTER_INDEX__additions.md` | `docs/00_INDEX/MASTER_INDEX.md` | 文档清单和核心文件区域 | 修正路径，加入新增文档 |
| `SPEC_v0.8_Final__canonical_sync.md` | `docs/SPEC_v0.8_Final.md` | 对象模型、状态机、EvidenceReport、运行时、API 摘要 | 用 canonical schema 替换旧字段 |
| `Minimal_Schemas__additions.md` | `docs/03_SPEC/Minimal_Schemas.md` | AnalysisPlan、MemoryNote 后 | 标注 support schema source，补 AnalysisPlan parameter_sets 建议 |
| `Data_Storage_Provenance__additions.md` | `docs/03_SPEC/Data_Storage_Provenance.md` | 存储分层后 | 增加 Artifact registry 与 retention/data package 边界 |
| `Execution_Jobs_Runs__additions.md` | `docs/03_SPEC/Execution_Jobs_Runs.md` | RunJob 状态机、Sandbox 后 | 增加 runner adapter 和 idempotent collect |
| `Report_Generation_Spec__additions.md` | `docs/03_SPEC/Report_Generation_Spec.md` | Artifact 引用、Reviewer 检查清单、验收标准 | 增加 evidence assertion schema 与 lineage 检查 |
| `Auth_Permission_Design__additions.md` | `docs/03_SPEC/Auth_Permission_Design.md` | Session、审计、API key 管理后 | 加 User/Session/Audit schema 与 secret ref |
| `WebSocket_Protocol__additions.md` | `docs/03_SPEC/WebSocket_Protocol.md` | 断线重连、事件持久化后 | 增加 snapshot schema、event retention、replay gap |
| `Workspace_Conventions__additions.md` | `docs/03_SPEC/Workspace_Conventions.md` | 路径体系、artifact、清理策略后 | 增加 snapshots、locks、exports、data packages |
| `Sensitivity_Calibration_Benchmark_Addendum__additions.md` | `docs/03_SPEC/Sensitivity_Calibration_Benchmark_Addendum.md` | Batch 运行后 | 加 ParameterSet mapping 和 stop condition |
| `Testing_Strategy__additions.md` | `docs/04_IMPLEMENTATION/Testing_Strategy.md` | 测试分层后 | 加 support schema、artifact、idempotency、snapshot、runner 测试 |
| `CICD_Release__additions.md` | `docs/04_IMPLEMENTATION/CICD_Release.md` | CI 阶段后 | 加 schema/doc generation、link/path、secret scan |
| `Repository_Layout__additions.md` | `docs/04_IMPLEMENTATION/Repository_Layout.md` | packages/services/routes 后 | 加新增 services 和 components |
| `Phased_Plan__additions.md` | `docs/04_IMPLEMENTATION/Phased_Plan.md` | Week 1 前或 Operational UX Sprint 后 | 加 readiness gate |

## 3. 合并原则

- 不把 support schema 升级为 8 个核心对象。
- 不让 Artifact 替代 RunRecord；Artifact 只是证据载体，RunRecord 是运行结果事实源。
- 不让 WebSocket event 成为证据来源；事件只用于实时体验与恢复。
- 不让 PI comment 自动进入科学结论。
- 不让 convenience API 维护独立数据层；必须代理到 canonical API。
