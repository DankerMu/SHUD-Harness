# CLI、轻量 API 与 Schemas

## 1. CLI 命令分组

```bash
shud-harness init

shud-harness task create
shud-harness task list
shud-harness task show
shud-harness task plan
shud-harness task clean

shud-harness stack lock
shud-harness data register

shud-harness run tiny
shud-harness job submit
shud-harness job status
shud-harness job collect

shud-harness analysis sensitivity
shud-harness analysis calibration

shud-harness report build
shud-harness patch diff
shud-harness patch bundle

shud-harness note add
shud-harness note list
```

## 2. 任务创建示例

```bash
shud-harness task create \
  --type engineering \
  --title "Add optional event diagnostics" \
  --goal "Add event_flux output without breaking old rSHUD readers" \
  --budget normal
```

## 3. 运行示例

```bash
shud-harness stack lock --repos repos/SHUD repos/rSHUD repos/AutoSHUD
shud-harness data register --basin cache_creek --event 2008-02-14
shud-harness run tiny --task TASK-0001
shud-harness report build TASK-0001
```

## 4. Sensitivity 示例

```bash
shud-harness analysis sensitivity \
  --task TASK-0002 \
  --param ksat_multiplier=0.5,1.0,2.0 \
  --param mannings_n_multiplier=0.7,1.0,1.3 \
  --metric peak_flow_error \
  --metric water_balance_residual
```

## 5. 轻量 API

MVP 不需要完整 REST API。只需内部 Python functions：

```python
create_task(...)
lock_stack(...)
register_data(...)
submit_job(...)
collect_job(...)
build_report(...)
bundle_patch(...)
```

未来 Web UI 可包装这些 functions。

## 6. Schema validation

每个 YAML 对象读写时必须 validate。

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

## 7. Report generation

Report 由 deterministic template + optional LLM polish 组成：

```text
metrics summary: script/SQL 生成；
logs summary: script 生成；
interpretive text: LLM 草拟，但标记为 draft；
PI decision: 人工写入或确认。
```
