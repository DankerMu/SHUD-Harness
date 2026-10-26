---
status: frozen
---

# Test Fixtures and Command Matrix

**状态：** v0.8.1 测试 fixture 补充  
**目标：** 明确每阶段用哪些 fixture、命令和 expected artifacts，避免测试依赖真实长任务。

> **排期语义（2026-10-20）**：原 W 周阶段标签已删；fixture 何时启用以 [Phased_Plan v2](Phased_Plan.md) 的里程碑 M1–M6 为准（ADR-0004）。

---

## 1. Fixture 层级

| Fixture | 目的 | 是否依赖 SHUD |
|---|---|---|
| schema-only | core/support schema 校验 | 否 |
| dummy-runner | job submit/log/collect/report | 否 |
| dummy-batch | AnalysisPlan/AnalysisProgressPayload（Heatmap 出 MVP；最小 OAT 见 Phased_Plan M5） | 否 |
| old-output fixture | rSHUD backward compatibility | 部分依赖 rSHUD |
| ccw tiny | 真实 SHUD/rSHUD 闭环 | 是 |
| report fixture | EvidenceReport/export/language guard | 否 |

---

## 2. Dummy runner

### 命令

```bash
bash scripts/fixtures/dummy-job.sh --duration-ms 500 --exit-code 0 --lines 10
```

### 预期输出

```text
<workspace>/runs/<run_id>/run-job.json      # RunJob 当前状态
<workspace>/runs/<run_id>/stdout.log
<workspace>/runs/<run_id>/stderr.log
<workspace>/runs/<run_id>/run-record.json
<workspace>/runs/<run_id>/metrics.yaml
# RunJob/RunRecord 位于上述运行目录；active.json、completed.json 与 lock 位于插件 stateDir
```

M2 的 RunJob/RunRecord 不经 `ctx.storage` 域保存；记录落点与索引/锁分工以 [Phased_Plan M2](Phased_Plan.md#2-m2-运行主链) 和 [design D2](../../openspec/changes/m2-run-chain/design.md) 为准。

### 用例

- RunJob（经 `ctx.jobs` 提交，dsh 重启后对账）；
- 作业日志落文件与回读；
- collect idempotency；
- report generation。

---

## 3. Dummy batch

> **M5 口径（Phased_Plan M5）**：M5 参数集用最小 OAT（3–5 组），产出用普通 artifact
> （analysis_progress.json + batch 汇总表），**不产 parquet / heatmap.json**；下述 3×3 命令与 parquet/heatmap
> 定义保留供 M5 之后（首个真实敏感性研究任务）复用。

### 命令

```bash
bash scripts/fixtures/dummy-batch.sh --params ksat=0.5,1,2 --params roughness=0.7,1,1.3 --fail PSET-005
```

### 预期输出

```text
<workspace>/runs/<plan_id>/analysis_plan.yaml
<workspace>/runs/<plan_id>/analysis_progress.json
<workspace>/runs/<plan_id>/sensitivity_results.parquet
<workspace>/runs/<plan_id>/heatmap.json
```

### 用例

- AnalysisProgressPayload 计数；
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
bash scripts/shud/build.sh --repo <workspace>/shud
bash scripts/shud/run_tiny_ccw.sh --repo <workspace>/shud --task TASK-001 --days 30
Rscript scripts/rshud/water_balance.R --run RUN-001
```

### 预期输出

```text
<workspace>/runs/RUN-001/run_record.yaml
<workspace>/runs/RUN-001/output/*.dat
<workspace>/runs/RUN-001/stdout.log
<workspace>/runs/RUN-001/stderr.log
<workspace>/runs/RUN-001/metrics.yaml
<workspace>/runs/RUN-001/hydrograph.json
<workspace>/reports/<report_id>.md          # M3 起
```

### 验收

- exit_code=0；
- RunRecord.status=succeeded；
- numerical_health.water_balance_residual 小于阈值；
- `rivqdown` 序列进入 metrics/figure artifact；
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
- Markdown 报告文件按状态带可见水印或 accepted 标记（Report_Generation_Spec §水印）。

---

## 6. Failure fixtures

| Fixture | 触发方式 | 预期 |
|---|---|---|
| schema_error | 缺 required field | Zod 校验拒绝 + ErrorRecord(category=schema_error) |
| permission_error | agent 调 PI decision | 策略门 deny（agent 身份不得持 pi 角色）+ ErrorRecord |
| lock_conflict | 两个 collect 同时执行 | 一个成功，一个 ErrorRecord(lock_conflict) 或同 idempotent result |
| timeout | dummy job sleep 超时 | RunJob.timed_out + ErrorRecord |
| parser_error | 删除 required output | ErrorRecord + report limitation |
| secret_leak_attempt | env 中放 fake secret | artifact/log/report 不包含 secret |
