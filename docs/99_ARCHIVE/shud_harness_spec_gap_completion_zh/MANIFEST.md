# Manifest

| 路径 | 类型 | 用途 |
|---|---|---|
| `docs/00_INDEX/Spec_Gap_Audit_v0_8_1.md` | 新增 | 全面审查结论、剩余缺口、优先级 |
| `docs/00_INDEX/Spec_Gap_Merge_Map.md` | 新增 | 每个补充点应合并到哪个文档、哪个章节 |
| `docs/00_INDEX/CANONICAL_CONTRACTS.md` | 新增/补齐 | canonical schema、API、path、event、artifact、lock 的唯一事实源索引 |
| `docs/03_SPEC/Support_Schema_Contracts.md` | 新增 | support schema 的权威定义 |
| `docs/03_SPEC/Artifact_Registry_Spec.md` | 新增 | artifact 类型、manifest、生命周期、可证据性 |
| `docs/03_SPEC/Report_Review_And_Evidence_Lineage_Spec.md` | 新增 | 报告 assertion 与 RunRecord/artifact 的证据链 |
| `docs/03_SPEC/Idempotency_Concurrency_Locking_Spec.md` | 新增 | idempotency key、任务锁、collect/export/decision 去重 |
| `docs/03_SPEC/Workspace_Snapshot_And_Recovery_Spec.md` | 新增 | session snapshot、parked recovery、event replay 的恢复契约 |
| `docs/03_SPEC/User_Session_And_Audit_Schema.md` | 新增 | User、Session、AuditEvent、PermissionDecision schema |
| `docs/03_SPEC/Config_Secrets_And_Environment_Spec.md` | 新增 | 配置、环境变量、secret 引用、redaction 规则 |
| `docs/03_SPEC/Runner_Adapter_Contracts.md` | 新增 | local/direct/job/docker/slurm runner 的统一 adapter contract |
| `docs/03_SPEC/Data_Package_And_Retention_Spec.md` | 新增 | 报告分享包、导出包、retention 与删除边界 |
| `docs/03_SPEC/Parameter_Set_And_Analysis_Run_Mapping.md` | 新增 | AnalysisPlan parameter_sets 与 RunJob/RunRecord 映射 |
| `docs/04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md` | 新增 | REST API 错误响应、idempotency header、retry 规则 |
| `docs/04_IMPLEMENTATION/Schema_Generation_And_Drift_Control.md` | 新增 | Zod → JSON Schema → Markdown 的生成和 drift 检查 |
| `docs/04_IMPLEMENTATION/MVP_Implementation_Readiness_Checklist.md` | 新增 | Week 1 开工前 readiness gate |
| `patches/*` | 补丁说明 | 对现有文档的插入位置、补充内容、验收标准 |
