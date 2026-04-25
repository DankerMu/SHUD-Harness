# Patch: MASTER_INDEX additions

**目标文档**：`docs/00_INDEX/MASTER_INDEX.md`  
**插入位置**：00_INDEX、03_SPEC、04_IMPLEMENTATION 文件表。  
**合并方式**：新增链接，不删除既有文档。

## 1. 在 00_INDEX/ 表中加入

```markdown
| [`Requirements_Catalog.md`](Requirements_Catalog.md) | 正式需求目录（US/FR/NFR/DR/GR/IR/TR 编号体系） |
| [`Requirements_Numbering_Conventions.md`](Requirements_Numbering_Conventions.md) | 需求编号、状态、优先级和 traceability 规则 |
| [`PRD_Spec_Gap_Audit_v0_8_2.md`](PRD_Spec_Gap_Audit_v0_8_2.md) | v0.8.2 PRD/Spec 缺口审查 |
| [`PRD_Spec_Merge_Map.md`](PRD_Spec_Merge_Map.md) | v0.8.2 补充文档合并地图 |
```

## 2. 在 03_SPEC/ 运行时或新增“监控与 NFR”小节加入

```markdown
| [`Observability_Monitoring_Spec.md`](../03_SPEC/Observability_Monitoring_Spec.md) | 可观测性、健康检查、指标与 Ops Dashboard |
| [`Alerting_Thresholds_Spec.md`](../03_SPEC/Alerting_Thresholds_Spec.md) | 告警阈值、严重性、dedupe 与升级策略 |
| [`Log_Aggregation_Spec.md`](../03_SPEC/Log_Aggregation_Spec.md) | 结构化日志、聚合、保留与 redaction |
| [`Performance_NFR_Spec.md`](../03_SPEC/Performance_NFR_Spec.md) | REST、WebSocket、report、batch、并发性能 NFR |
```

## 3. 在 04_IMPLEMENTATION/ 表中加入

```markdown
| [`Operations_Runbook.md`](../04_IMPLEMENTATION/Operations_Runbook.md) | 磁盘满、Job 卡死、DuckDB 损坏、SMTP 故障、OOM、密钥泄露运维手册 |
| [`Dependency_Versioning_Policy.md`](../04_IMPLEMENTATION/Dependency_Versioning_Policy.md) | Bun/npm/TypeScript/Zod/React/DuckDB 依赖锁定与更新策略 |
| [`Performance_Test_Plan.md`](../04_IMPLEMENTATION/Performance_Test_Plan.md) | 性能 NFR 测试计划 |
| [`Observability_Test_Plan.md`](../04_IMPLEMENTATION/Observability_Test_Plan.md) | 健康检查、日志、指标、告警和 runbook drill 测试计划 |
```
