# Test Fixtures and Command Matrix

**状态：** v0.8.1 测试 fixture 补充  
**目标：** 明确每阶段用哪些 fixture、命令和 expected artifacts，避免测试依赖真实长任务。

---

## 1. Fixture 层级

| Fixture | 阶段 | 目的 | 是否依赖 SHUD |
|---|---:|---|---|
| schema-only | W1+ | core/support schema 校验 | 否 |
| dummy-runner | W3+ | job submit/log/collect/report | 否 |
| dummy-batch | W6+ | AnalysisPlan/BatchProgress/Heatmap | 否 |
| old-output fixture | W5+ | rSHUD backward compatibility | 部分依赖 rSHUD |
| ccw tiny | W4+ | 真实 SHUD/rSHUD 闭环 | 是 |
| report fixture | W7+ | EvidenceReport/export/language guard | 否 |

---

## 2. Dummy runner

### 命令

```bash
bun scripts/fixtures/dummy-job.ts --duration-ms 500 --exit-code 0 --lines 10
```

### 预期输出

```text
workspace/jobs/JOB-*/job.yaml
workspace/artifacts/JOB-*/stdout.log
workspace/artifacts/JOB-*/stderr.log
workspace/runs/RUN-*/run_record.yaml
workspace/artifacts/RUN-*/metrics.yaml
```

### 用例

- W3 RunJob；
- W3 WebSocket log stream；
- W3 collect idempotency；
- W7 report generation；
- W8 Zero tool adapter。

---

## 3. Dummy batch

### 命令

```bash
bun scripts/fixtures/dummy-batch.ts --params ksat=0.5,1,2 --params roughness=0.7,1,1.3 --fail PSET-005
```

### 预期输出

```text
workspace/analysis_plans/PLAN-*/analysis_plan.yaml
workspace/artifacts/PLAN-*/analysis_progress.json
workspace/artifacts/PLAN-*/sensitivity_results.parquet
workspace/artifacts/PLAN-*/heatmap.json
```

### 用例

- BatchProgressGrid；
- failed parameter set 保留；
- heatmap aggregation；
- partial report limitations。

---

## 4. ccw tiny

### 预设

- SHUD submodule 已初始化；
- `input/ccw` 可用；
- patch `END=30` 只发生在 task workspace，不改 root submodule；
- 编译和运行日志必须成为 artifact。

### 命令草案

```bash
bash scripts/shud/build.sh --repo workspace/repos/SHUD
bash scripts/shud/run_tiny_ccw.sh --repo workspace/repos/SHUD --task TASK-001 --days 30
Rscript scripts/rshud/water_balance.R --run RUN-001
```

### 预期输出

```text
workspace/runs/RUN-001/run_record.yaml
workspace/runs/RUN-001/output/*.dat
workspace/artifacts/RUN-001/stdout.log
workspace/artifacts/RUN-001/stderr.log
workspace/artifacts/RUN-001/metrics.yaml
workspace/artifacts/RUN-001/hydrograph.json
```

### 验收

- exit_code=0；
- RunRecord.status=succeeded；
- numerical_health.water_balance_residual 小于阈值；
- HydrographChart 可加载 `rivqdown`；
- StackLock/DataProvenance/RunJob/RunRecord 均可追溯。

---

## 5. Report fixture

### 输入

```text
one succeeded RunRecord
one failed RunRecord
one metrics artifact
one missing figure artifact
one AnalysisPlan progress artifact
```

### 验收

- report 包含 observations；
- report 包含 limitations；
- report 包含 pi_questions；
- missing artifact 被标注，不崩溃；
- forbidden language guard 生效；
- HTML export 有 watermark 或 accepted 标记。

---

## 6. Failure fixtures

| Fixture | 触发方式 | 预期 |
|---|---|---|
| schema_error | 缺 required field | API 400 envelope |
| permission_error | agent 调 PI decision | API 403 envelope |
| lock_conflict | 两个 collect 同时执行 | 一个成功，一个 409 或同 idempotent result |
| timeout | dummy job sleep 超时 | RunJob.timed_out + ErrorRecord |
| parser_error | 删除 required output | ErrorRecord + report limitation |
| secret_leak_attempt | env 中放 fake secret | artifact/log/report 不包含 secret |
