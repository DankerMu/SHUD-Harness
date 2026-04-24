# 轻量对象模型

## 1. 设计原则

不再把每个治理关切都建成独立对象。v0.6 使用：

```text
少量核心对象 + 字段维度 + checklist
```

## 2. 8 个核心对象

### 1. TaskCard

统一任务入口。替代过重的 RCS 主控地位。

```yaml
task_id: TASK-0001
type: engineering | science_assist | ops
owner: pi_or_engineer_name
title: Add event diagnostics to SHUD output
status: planned
question_or_goal: >
  Add event-scale diagnostics while preserving old rSHUD readers.
pi_decision_needed: true
linked_objects:
  stacklock: STACK-0001
  data: DATA-0001
  jobs: []
  reports: []
```

### 2. StackLock

合并 StackLock + EnvLock + HarnessLock。

```yaml
stack_id: STACK-0001
repos:
  SHUD: {commit: abc123}
  rSHUD: {commit: def456}
  AutoSHUD: {commit: ghi789}
runtime:
  container: shud-harness:2026-04-24
  r: 4.4.1
  python: 3.12
  sundials: 6.7.0
  gdal: 3.8
harness:
  version: 0.6.0
  prompt_pack: promptpack-0003
  skills_version: skills-0004
  policy_version: policy-0002
limits:
  cpu: 8
  memory_gb: 32
  wall_minutes: 240
```

### 3. DataProvenance

合并 DatasetManifest + ObservationManifest + PreprocessRecipe。

```yaml
data_id: DATA-0001
basin: cache_creek
sources:
  terrain:
    provider: USGS
    files: [{path: data/raw/dem.tif, sha256: "..."}]
  forcing:
    provider: NLDAS
    files: [{path: data/raw/forcing.nc, sha256: "..."}]
  observations:
    discharge:
      station: USGS-11451100
      rating_curve_version: rc_v5
      uncertainty_note: peak flow uncertainty higher during storm crest
preprocess:
  script: scripts/preprocess/cache_creek_event.sh
  params:
    crs: EPSG:26910
    event_window: [2008-02-14, 2008-02-17]
  outputs:
    - data/processed/cache_creek/event_2008_02_14/
```

### 4. RunJob

执行请求。覆盖本地短任务和长任务。

```yaml
job_id: JOB-0001
task_id: TASK-0001
backend: local | docker | slurm
status: submitted
command: bash scripts/run_tiny_case.sh
resources:
  cpu: 4
  memory_gb: 16
  wall_minutes: 60
cost_budget:
  advisory_llm_usd: 0.50     # 建议值，超出时状态栏提醒，不自动中断
  max_compute_hours: 2
```

### 5. RunRecord

执行结果。替代 RunManifest + ArtifactManifest 的大部分职责。

```yaml
run_id: RUN-0001
job_id: JOB-0001
status: success
stack_id: STACK-0001
data_id: DATA-0001
artifacts:
  stdout: artifacts/RUN-0001/stdout.txt
  stderr: artifacts/RUN-0001/stderr.txt
  metrics: artifacts/RUN-0001/metrics.parquet
  plots: artifacts/RUN-0001/plots/
numerical_health:
  water_balance_residual: 0.0008
  cvode_failures: 0
  negative_state_count: 0
resources:
  runtime_seconds: 2512
  memory_peak_mb: 1830
```

### 6. AnalysisPlan

合并 ExperimentSpec + SensitivityPlan + CalibrationSpec + BenchmarkPolicy 的任务级版本。

```yaml
analysis_id: PLAN-0001
task_id: TASK-0002
mode: sensitivity | calibration | benchmark | comparison
parameters:
  ksat_multiplier: [0.5, 1.0, 2.0]
  mannings_n_multiplier: [0.7, 1.0, 1.3]
metrics:
  - peak_flow_error
  - peak_timing_error
  - water_balance_residual
holdout:
  enabled: true
  basins: [walnut_gulch]
  events: [storm_2009_08_21]
rules:
  - Do not present calibration improvement as structural validation.
```

### 7. EvidenceReport

合并 EvidencePacket + ValidationReport。

```yaml
report_id: REPORT-0001
task_id: TASK-0001
status: draft | pi_reviewed | accepted | rejected
summary: >
  Tiny benchmark passes; old-output compatibility failed in rSHUD reader.
observations:
  - baseline available
  - water balance within threshold
  - old output reader fails when optional event_flux.csv missing
limitations:
  - no holdout event run
  - no full basin batch
pi_questions:
  - Should we make diagnostics optional or require schema version bump?
```

### 8. ChangeRequest

合并 ChangeSpec + OutputContract + CompatibilitySuite + Gate。

```yaml
change_id: CHG-0001
task_id: TASK-0001
risk: low | medium | high
files_changed:
  - repos/SHUD/src/output.c
  - repos/rSHUD/R/read_output.R
interface_impact:
  output_change: additive
  backward_compatible: false
compat_checks:
  old_output_reader: fail
  tiny_case: pass
gates:
  needs_pi_approval: true
  reason: output compatibility changed
patch_bundle: artifacts/CHG-0001.patch
```

## 3. 被合并/降级的对象

| v0.5 对象 | v0.6 处理方式 |
|---|---|
| EnvLock | 合并进 StackLock.runtime / StackLock.limits |
| HarnessLock | 合并进 StackLock.harness |
| DatasetManifest | 合并进 DataProvenance.sources |
| ObservationManifest | 合并进 DataProvenance.sources.observations |
| PreprocessRecipe | 合并进 DataProvenance.preprocess |
| CalibrationSpec | 合并进 AnalysisPlan.mode=calibration |
| HoldoutPolicy | 合并进 AnalysisPlan.holdout |
| JobSpec | 改名 RunJob |
| RunManifest | 改名 RunRecord |
| ArtifactManifest | 合并进 RunRecord.artifacts |
| EvidencePacket | 合并进 EvidenceReport |
| ValidationReport | 合并进 EvidenceReport |
| ChangeSpec | 合并进 ChangeRequest |
| OutputContract | 合并进 ChangeRequest.interface_impact |
| CompatibilitySuite | 合并进 ChangeRequest.compat_checks |
| HumanGate / ReleaseGate | 合并进 ChangeRequest.gates |
| BenchmarkPolicy | 合并进 AnalysisPlan.rules + benchmark config |

## 4. 保留治理能力，但不保留对象膨胀

治理不靠对象数量，而靠：

```text
- 关键字段必须存在；
- 报告必须回答关键问题；
- 高风险动作必须 PI approve；
- 所有 run 必须可回放。
```
