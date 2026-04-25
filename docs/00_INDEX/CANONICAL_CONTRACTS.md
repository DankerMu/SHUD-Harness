# Canonical Contracts Index

**状态：** v0.8.1 合同索引  
**目标：** 明确每类工程事实的唯一来源，避免实现时在多个 Markdown 文档中寻找字段定义。

## 1. Canonical source 顺序

当文档之间出现冲突时，按以下顺序判定：

1. **Zod schema 源码**：`packages/core/src/domain/schemas/*`，进入实现后为最高事实源。
2. **生成文档**：`docs/generated/schema/*`，由 Zod 自动生成。
3. **核心对象手写语义**：`docs/03_SPEC/Minimal_Schemas.md`。
4. **Support schema 手写语义**：`docs/03_SPEC/Support_Schema_Contracts.md`。
5. **专题规范**：WebSocket、Artifact、Report、Runner、Auth、Workspace、Visualization 等。
6. **自包含总规格**：`docs/SPEC_v0.8_Final.md`，用于阅读和 onboarding，但字段细节必须同步 canonical schema。

## 2. 核心对象字段

唯一来源：

```text
docs/03_SPEC/Minimal_Schemas.md
```

覆盖对象：

```text
TaskCard
StackLock
DataProvenance
RunJob
RunRecord
AnalysisPlan
EvidenceReport
ChangeRequest
MemoryNote
```

## 3. Support schema 字段

唯一来源：

```text
docs/03_SPEC/Support_Schema_Contracts.md
```

覆盖对象：

```text
Artifact
ArtifactManifest
ErrorRecord
FailureRecord
PiGate
PiGateDecision
NotificationRecord
ReportExport
AnalysisProgressPayload
User
Session
AuditEvent
PermissionDecision
ConfigRecord
RunnerResult
WorkspaceSnapshot
IdempotencyRecord
LockRecord
```

## 4. API registry

唯一来源：

```text
docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md
```

API 错误响应和 idempotency header 的详细契约见：

```text
docs/04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md
```

## 5. WebSocket event registry

唯一来源：

```text
docs/03_SPEC/WebSocket_Protocol.md
```

事件 replay、snapshot 和 gap recovery 见：

```text
docs/03_SPEC/Workspace_Snapshot_And_Recovery_Spec.md
```

## 6. Artifact registry

唯一来源：

```text
docs/03_SPEC/Artifact_Registry_Spec.md
```

所有 EvidenceReport、Visualization、ReportExport、RunRecord 中引用的 artifact 都必须有 artifact metadata 或 manifest entry。

## 7. 路径体系

唯一来源：

```text
docs/03_SPEC/Workspace_Conventions.md
```

补充：

```text
docs/03_SPEC/Data_Package_And_Retention_Spec.md
docs/03_SPEC/Idempotency_Concurrency_Locking_Spec.md
```

## 8. Runner contract

唯一来源：

```text
docs/03_SPEC/Runner_Adapter_Contracts.md
```

执行模式枚举仍以 `Minimal_Schemas.md` 中 `RunJob.backend` 为准。

## 9. Schema drift policy

唯一来源：

```text
docs/04_IMPLEMENTATION/Schema_Generation_And_Drift_Control.md
```

实现阶段禁止长期维护两套手写 schema。Markdown schema 应由 Zod 生成或至少由 CI 对比。

## 10. Requirements catalog

唯一来源：

```text
docs/00_INDEX/Requirements_Catalog.md
docs/00_INDEX/Requirements_Numbering_Conventions.md
```

覆盖：

```text
US-* FR-* NFR-* DR-* GR-* IR-* TR-* 编号、状态、优先级、验收标准
```

## 11. Performance NFR

唯一来源：

```text
docs/03_SPEC/Performance_NFR_Spec.md
```

测试映射：

```text
docs/04_IMPLEMENTATION/Performance_Test_Plan.md
```

## 12. Observability / monitoring

唯一来源：

```text
docs/03_SPEC/Observability_Monitoring_Spec.md
docs/03_SPEC/Alerting_Thresholds_Spec.md
docs/03_SPEC/Log_Aggregation_Spec.md
```

Support schema 仍以 `docs/03_SPEC/Support_Schema_Contracts.md` 为字段事实源。

## 13. Operations runbook

唯一来源：

```text
docs/04_IMPLEMENTATION/Operations_Runbook.md
```

## 14. Dependency versioning

唯一来源：

```text
docs/04_IMPLEMENTATION/Dependency_Versioning_Policy.md
```

实现后 lockfile 和 `package.json` 的 `packageManager` 为依赖版本事实源，release manifest 记录发布时快照。
