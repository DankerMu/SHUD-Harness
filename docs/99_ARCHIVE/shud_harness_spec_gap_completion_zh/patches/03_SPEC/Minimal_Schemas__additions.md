# Patch: Minimal_Schemas additions

**目标文件：** `docs/03_SPEC/Minimal_Schemas.md`

## 插入位置：文件开头说明后

新增：

```markdown
Support schema 的权威定义不放在本文件，见 `Support_Schema_Contracts.md`。Support schema 包括 Artifact、ErrorRecord、PiGate、PiGateDecision、NotificationRecord、ReportExport、AnalysisProgressPayload、User、Session、AuditEvent、LockRecord、IdempotencyRecord 等。
```

## 插入位置：AnalysisPlan 章节后

补充：

```markdown
实现 schema 应支持 `parameter_sets` 和 `batch_policy`，详细定义见 `Parameter_Set_And_Analysis_Run_Mapping.md`。本文件保留最小字段，避免核心对象膨胀。
```
