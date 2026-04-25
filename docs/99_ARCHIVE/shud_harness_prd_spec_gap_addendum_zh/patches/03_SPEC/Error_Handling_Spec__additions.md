# Patch: Error_Handling_Spec additions

**目标文档**：`docs/03_SPEC/Error_Handling_Spec.md`  
**插入位置**：错误分类、critical failure notification、验收标准附近。

## 新增错误类别

```text
ops_error
duckdb_error
dependency_error
health_check_error
alert_error
log_aggregation_error
```

## 新增处理规则

| 类别 | 示例 | 处理 |
|---|---|---|
| `ops_error` | disk full、OOM | 创建 OpsIncident，执行 runbook |
| `duckdb_error` | warehouse open/query failure | degraded mode，filesystem fallback |
| `dependency_error` | lockfile drift、native binding load fail | 阻塞 release 或标记 service degraded |
| `health_check_error` | ready check fail | 根据 severity 返回 not_ready/degraded |
| `alert_error` | alert dedupe/persist fail | 写 service log，不影响 RunRecord |
| `log_aggregation_error` | DuckDB aggregation fail | 保留 NDJSON，dashboard fallback |

## 关键规则

- DuckDB/ops dashboard 失败不等于科学运行失败；
- disk critical 可以 block new jobs；
- secret leak 可以 quarantine artifact；
- dependency drift 可以 block release；
- 所有 critical ops errors 必须有 OpsIncident。
