# Minimal Schemas 草案

## TaskCard

```yaml
task_id: TASK-0001
type: engineering
owner: alice
title: Add optional event diagnostics
status: planned
question_or_goal: Add event-scale diagnostics without breaking old readers.
stack_id: STACK-0001
data_id: DATA-0001
inference_budget:
  mode: normal
  max_usd: 1.00
  max_model_calls: 12
created_at: 2026-04-24T00:00:00Z
updated_at: 2026-04-24T00:00:00Z
```

## StackLock

```yaml
stack_id: STACK-0001
repos:
  SHUD: {path: repos/SHUD, commit: abc123}
  rSHUD: {path: repos/rSHUD, commit: def456}
  AutoSHUD: {path: repos/AutoSHUD, commit: ghi789}
runtime:
  os: ubuntu-22.04
  r: 4.4.1
  python: 3.12
  sundials: 6.7.0
harness:
  runtime_version: 0.6.0
  prompt_pack: promptpack-0003
  skills_version: skills-0004
```

## DataProvenance

```yaml
data_id: DATA-0001
basin: cache_creek
event_window: [2008-02-14, 2008-02-17]
sources:
  terrain: []
  forcing: []
  observations: []
preprocess:
  script: scripts/preprocess/cache_creek.sh
  params: {}
  outputs: []
uncertainty_notes: []
```

## RunJob

```yaml
job_id: JOB-0001
task_id: TASK-0001
backend: local
status: created
command: bash scripts/run_tiny_case.sh
resources:
  cpu: 4
  memory_gb: 16
  wall_minutes: 60
```

## RunRecord

```yaml
run_id: RUN-0001
job_id: JOB-0001
status: success
stack_id: STACK-0001
data_id: DATA-0001
artifacts: {}
metrics: {}
numerical_health: {}
resources: {}
```

## AnalysisPlan

```yaml
analysis_id: PLAN-0001
task_id: TASK-0001
mode: sensitivity
parameters: {}
metrics: []
holdout:
  enabled: false
rules: []
```

## EvidenceReport

```yaml
report_id: REPORT-0001
task_id: TASK-0001
status: draft
summary: ""
observations: []
limitations: []
pi_questions: []
```

## ChangeRequest

```yaml
change_id: CHG-0001
task_id: TASK-0001
risk: medium
files_changed: []
interface_impact: {}
compat_checks: {}
gates:
  needs_pi_approval: false
patch_bundle: null
```

## MemoryNote

```yaml
note_id: NOTE-0001
type: failure_note
status: draft
task_id: TASK-0001
title: ""
body: ""
evidence: []
```
