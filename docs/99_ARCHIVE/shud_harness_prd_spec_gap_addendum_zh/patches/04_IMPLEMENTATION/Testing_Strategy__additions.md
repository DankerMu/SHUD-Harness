# Patch: Testing_Strategy additions

**目标文档**：`docs/04_IMPLEMENTATION/Testing_Strategy.md`  
**插入位置**：阶段测试矩阵、补充测试类别、验收标准之后。

## 新增测试类别

### Observability tests

- `OBS-HEALTH-001`: live endpoint returns 200。
- `OBS-HEALTH-002`: ready detects workspace not writable。
- `OBS-HEALTH-003`: disk critical triggers alert and blocks new jobs。
- `OBS-LOG-001`: API request writes structured NDJSON。
- `OBS-LOG-002`: secret values redacted。
- `OBS-ALERT-001`: alert dedupe works。
- `OBS-DASH-001`: ops dashboard returns health/jobs/storage/errors/dependencies。

### Performance tests

- `PERF-API-001`: metadata API P95 <= 300ms in mock workspace。
- `PERF-WS-001`: reconnect + replay/snapshot <= 5s。
- `PERF-REPORT-001`: tiny report generation <= 30s。
- `PERF-BATCH-001`: batch progress update <= 2s。
- `PERF-CONC-001`: MVP concurrency smoke。

### Dependency tests

- lockfile exists；
- frozen install；
- packageManager fixed；
- dependency status endpoint；
- DuckDB client smoke；
- submodule status captured。

### Requirements tests

- requirement IDs unique；
- P0/P1 requirements have acceptance criteria；
- P0 requirements have test_ids before release；
- Traceability matrix references valid requirement IDs。
