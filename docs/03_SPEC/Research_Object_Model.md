# 轻量对象模型

## 1. 设计原则

不再把每个治理关切都建成独立对象。v0.6 使用：

```text
少量核心对象 + 字段维度 + checklist
```

## 2. 8 个核心对象

### 1. TaskCard

统一任务入口。替代过重的 RCS 主控地位。
字段定义以 `03_SPEC/Minimal_Schemas.md` 为准。

```yaml
task_id: TASK-0001
type: engineering | science_assist | ops
status: created | planned | running | parked | reporting | awaiting_pi | done | cancelled
title: "Add event diagnostics to SHUD output"
question_or_goal: "Add event-scale diagnostics while preserving old rSHUD readers."
created_by: alice
current_owner: alice
reviewer: pi_name
stack_id: STACK-0001
data_id: DATA-0001
linked_jobs: []
linked_reports: []
```

### 2. StackLock

合并 StackLock + EnvLock + HarnessLock。
字段定义以 `03_SPEC/Minimal_Schemas.md` 为准。

```yaml
stack_id: STACK-0001
repos:
  SHUD:      { commit: 9b55b0c, branch: master }
  rSHUD:     { commit: d162db3, branch: master }
  AutoSHUD:  { commit: 1cbec6f, branch: master }
runtime:
  os: "Darwin 24.6.0"
  r_version: "4.4.1"
  r_packages_lock: renv.lock
  python_version: "3.12.4"
  sundials_version: "6.0.0"
  gcc_version: "14.1.0"
  gdal_version: "3.9.0"
harness:
  version: "0.8.0"
  prompt_pack: promptpack-0001
  skills_version: skills-0001
fingerprint: "sha256:..."
created_at: 2026-04-25T10:00:00Z
```

> `limits` 已移入 RunJob.resources（执行级，非环境级）。

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
字段定义以 `03_SPEC/Minimal_Schemas.md` 为准。

```yaml
job_id: JOB-0001
task_id: TASK-0001
backend: local_direct | local_job | docker_job
status: created | submitted | running | succeeded | failed | cancelled | timed_out | collected
command: "cd repos/SHUD && make shud && ./shud ccw"
cwd: "workspaces/TASK-0001/worktrees/SHUD"
resources:
  max_wall_minutes: 30
  max_memory_mb: 4096
cost_budget:
  max_compute_minutes: 60
pid: null
submitted_at: null
finished_at: null
```

### 5. RunRecord

执行结果。替代 RunManifest + ArtifactManifest 的大部分职责。
字段定义以 `03_SPEC/Minimal_Schemas.md` 为准。

```yaml
run_id: RUN-0001
job_id: JOB-0001
task_id: TASK-0001
stack_id: STACK-0001
data_id: DATA-0001
status: succeeded | failed
command: "cd repos/SHUD && make shud && ./shud ccw"
artifacts:
  stdout: "artifacts/RUN-0001/stdout.log"
  stderr: "artifacts/RUN-0001/stderr.log"
  shud_output: "runs/RUN-0001/output/"
  metrics_summary: "artifacts/RUN-0001/metrics.yaml"
  plots: ["artifacts/RUN-0001/hydrograph.png"]
numerical_health:
  water_balance_residual: 0.0008
  cvode_failures: 0
  negative_state_count: 0
  max_solver_dt: 5.2
resources:
  wall_seconds: 420
  peak_memory_mb: 1830
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
status: draft | reviewed | awaiting_pi | accepted | revision_requested | rejected
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
