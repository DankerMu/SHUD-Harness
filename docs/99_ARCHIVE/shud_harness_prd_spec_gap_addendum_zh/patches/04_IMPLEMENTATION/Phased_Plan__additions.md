# Patch: Phased_Plan additions

**目标文档**：`docs/04_IMPLEMENTATION/Phased_Plan.md`  
**插入位置**：W0-W3、W7/W8 对应阶段。

## W0 / Readiness 增加

- 合并 Requirements_Catalog；
- 合并 Requirements_Numbering_Conventions；
- 确定 packageManager 和 lockfile；
- 生成 initial DependencyLock；
- 增加 health/live 和 health/ready 的 skeleton contract。

## W1 增加

- 实现 `/api/health/live`；
- 实现 `/api/health/ready` 的 workspace/artifact/event store 基础检查；
- 实现 structured API logs；
- 实现 requirements ID uniqueness check；
- API metadata perf smoke。

## W2-W3 增加

- job metrics；
- stale job detection；
- ops dashboard API skeleton；
- alert evaluator skeleton；
- log aggregation NDJSON；
- disk critical block new jobs。

## W4-W6 增加

- ccw tiny run metrics；
- batch progress latency measurement；
- storage/artifact metrics；
- DuckDB fallback/rebuild test。

## W7-W8 增加

- notification metrics；
- report/export performance test；
- runbook drills；
- dependency release manifest；
- requirements coverage report。
