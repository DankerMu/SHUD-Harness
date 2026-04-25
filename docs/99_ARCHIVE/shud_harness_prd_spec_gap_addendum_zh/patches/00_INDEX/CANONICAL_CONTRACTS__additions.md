# Patch: CANONICAL_CONTRACTS additions

**目标文档**：`docs/00_INDEX/CANONICAL_CONTRACTS.md`  
**插入位置**：现有 canonical source 列表之后。

## 新增 canonical source

```markdown
## Requirements catalog

唯一来源：

```text
docs/00_INDEX/Requirements_Catalog.md
docs/00_INDEX/Requirements_Numbering_Conventions.md
```

覆盖：

```text
US-* FR-* NFR-* DR-* GR-* IR-* TR-* 编号、状态、优先级、验收标准
```

## Performance NFR

唯一来源：

```text
docs/03_SPEC/Performance_NFR_Spec.md
```

测试映射：

```text
docs/04_IMPLEMENTATION/Performance_Test_Plan.md
```

## Observability / monitoring

唯一来源：

```text
docs/03_SPEC/Observability_Monitoring_Spec.md
docs/03_SPEC/Alerting_Thresholds_Spec.md
docs/03_SPEC/Log_Aggregation_Spec.md
```

Support schema 仍以：

```text
docs/03_SPEC/Support_Schema_Contracts.md
```

为字段事实源。

## Operations runbook

唯一来源：

```text
docs/04_IMPLEMENTATION/Operations_Runbook.md
```

## Dependency versioning

唯一来源：

```text
docs/04_IMPLEMENTATION/Dependency_Versioning_Policy.md
```

实现后 lockfile 和 `package.json` 的 `packageManager` 为依赖版本事实源，release manifest 记录发布时快照。
```
