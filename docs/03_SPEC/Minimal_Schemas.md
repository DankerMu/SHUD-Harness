# Canonical Schema Contract (v0.8)

> **本文件是 8 个核心对象 + MemoryNote 的唯一权威字段定义。**
> 其他文档（Research_Object_Model、SPEC_v0.8_Final、Execution_Jobs_Runs 等）若与本文件冲突，以本文件为准。
> 进入实现后，Zod schema 必须与此一一对应。

---

## 1. TaskCard

```yaml
task_id: TASK-0001                    # 格式: TASK-NNNN
type: engineering | science_assist | ops
status: created | planned | running | parked | reporting | awaiting_pi | done | cancelled | blocked
runtime_phase: null               # 运行时辅助字段，见下方说明
title: "给 SHUD 添加 event flux 诊断输出"
question_or_goal: "在不破坏 rSHUD 旧版读取的前提下，添加 event_flux 可选输出"
created_by: alice                     # 创建者，不可变
current_owner: alice                  # 当前负责人，可转移
reviewer: pi_name                     # PI 或指定审阅者
stack_id: STACK-0001
data_id: DATA-0001
inference_budget:
  mode: cheap | normal | deep
  advisory_usd: 1.00                  # 软监控，超出时状态栏标黄，不自动中断
  advisory_model_calls: 12            # 同上
  reviewer_enabled: false
linked_jobs: [JOB-0001]              # RunJob ID 列表
linked_reports: [REPORT-0001]        # EvidenceReport ID 列表
created_at: 2026-04-25T10:00:00Z
updated_at: 2026-04-25T14:30:00Z
```

**废弃字段**: 单个 `owner`（歧义）、嵌套 `linked_objects`（过深）。

**runtime_phase 说明**:
TaskCard.status 使用粗粒度状态机管理任务生命周期。执行期间的细粒度阶段通过 `runtime_phase` 辅助字段跟踪，不参与核心状态流转：

| status | runtime_phase（可选值） | 语义 |
|--------|------------------------|------|
| running | `running_local` | 短命令在 sandbox 同步执行 |
| running | `submitted_job` | 已提交 RunJob，LLM loop 仍活跃 |
| parked | `waiting_for_job` | Agent 已暂停，等待外部 job 完成 |
| running | `collecting` | 正在收集日志、输出、指标和 artifact |

`runtime_phase` 仅用于前端展示和调试，不作为状态机转换条件。
其他文档（Park_Resume_Design、Control_Kernel、Execution_Jobs_Runs 等）中出现的
`running_local`、`submitted_job`、`parked_waiting_for_job`、`collecting` 均指 runtime_phase，不是 TaskCard.status。

**blocked 说明**: 当硬限制触发（max_retries、no_progress）或 workspace 损坏时，TaskCard 进入 `blocked`。需要人工检查后手动恢复。

**废弃状态**: `revised`（PI 要求修订时，TaskCard 回到 `planned` 并关联新的 ChangeRequest，不使用独立状态）。

---

## 2. StackLock

```yaml
stack_id: STACK-0001                  # 格式: STACK-NNNN
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
fingerprint: "sha256:..."             # 整体哈希，用于快速比对
created_at: 2026-04-25T10:00:00Z
```

**废弃字段**: `runtime.container`（MVP 不强制容器）、`limits`（已移入 RunJob.resources）、`policy_version`（已合并入 harness.version）。

---

## 3. DataProvenance

```yaml
data_id: DATA-0001                    # 格式: DATA-NNNN
basin: cache_creek
event_window: { start: 2008-01-01, end: 2008-02-28 }
sources:
  terrain:      { path: "data/raw/ccw/dem.tif",       sha256: "abc..." }
  mesh:         { path: "repos/SHUD/input/ccw/ccw.sp.mesh", sha256: "def..." }
  forcing:      { path: "data/raw/ccw/forcing/",      sha256: "ghi..." }
  observations:
    - { variable: discharge, station: "USGS-11451100", path: "data/raw/ccw/obs_q.csv", sha256: "jkl..." }
preprocess:
  script: "scripts/prep_ccw.R"
  params: { interpolation: IDW, resolution: "200m" }
  output_sha256: "mno..."
uncertainty_notes: "降水空间插值可能低估高海拔降水量"
```

**废弃字段**: `event_window` 作为顶层数组 `[start, end]`（改为对象 `{start, end}`）、`sources` 下无 sha256 的简写。

---

## 4. RunJob

```yaml
job_id: JOB-0001                      # 格式: JOB-NNNN
task_id: TASK-0001
backend: local_direct | local_job | docker_job
#   local_direct — 短命令，同步 bash 执行
#   local_job    — 长命令，后台进程 + pid/status file + Park/Resume
#   docker_job   — 可选，固定环境容器执行
#   slurm        — 仅定义接口，不在 MVP 实现
status: created | submitted | running | succeeded | failed | cancelled | timed_out | collected
command: "cd repos/SHUD && make shud && ./shud ccw"
cwd: "workspaces/TASK-0001/worktrees/SHUD"
resources:
  max_wall_minutes: 30
  max_memory_mb: 4096
cost_budget:
  max_compute_minutes: 60
pid: null                             # 仅 local_job 填写
submitted_at: null
finished_at: null
```

**废弃字段**: `backend: local`（歧义，不区分同步/异步）、`backend: slurm | k8s`（MVP 不实现）、`resources.cpu`（改用 max_memory_mb + max_wall_minutes）。

**状态机**:
```
created → submitted → running → succeeded | failed | cancelled | timed_out → collected
```

---

## 5. RunRecord

```yaml
run_id: RUN-0001                      # 格式: RUN-NNNN
job_id: JOB-0001
task_id: TASK-0001
stack_id: STACK-0001
data_id: DATA-0001
status: succeeded | failed            # 终态，只有两个值
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

**废弃字段**: `status: success`（统一用 `succeeded`，与 RunJob 终态对齐）、`metrics: {}`（改为 `artifacts.metrics_summary` 路径引用）。

---

## 6. AnalysisPlan

```yaml
analysis_id: PLAN-0001                # 格式: PLAN-NNNN
task_id: TASK-0001
mode: sensitivity | calibration | benchmark | comparison
baseline_run: RUN-0001                # 可选，comparison/benchmark 时必填
parameters:
  ksat_multiplier: [0.5, 1.0, 2.0]
  mannings_n_multiplier: [0.7, 1.0, 1.3]
metrics:
  - peak_flow_error
  - peak_timing_error
  - water_balance_residual
holdout:
  enabled: false
  basins: []
  events: []
rules:
  - "Do not present calibration improvement as structural validation."
```

---

## 7. EvidenceReport

```yaml
report_id: REPORT-0001                # 格式: REPORT-NNNN
task_id: TASK-0001
status: draft | reviewed | awaiting_pi | accepted | revision_requested | rejected | archived
summary: "Tiny benchmark passes; old-output compatibility failed in rSHUD reader."
observations:
  - "baseline available"
  - "water balance within threshold"
  - "old output reader fails when optional event_flux.csv missing"
limitations:
  - "no holdout event run"
  - "no full basin batch"
pi_questions:
  - "Should we make diagnostics optional or require schema version bump?"
linked_runs: [RUN-0001, RUN-0002]     # 支撑本报告的 RunRecord
created_at: 2026-04-25T15:00:00Z
```

**状态流转**: `draft` → `reviewed`（Reviewer 工程检查通过）→ `awaiting_pi` → `accepted | revision_requested | rejected`。
`revision_requested` 表示 PI 要求修订后重新提交（区别于直接 `rejected`）。
`archived` 是 `accepted` 或 `rejected` 之后的可选终态，表示报告已归档、不再活跃但保留可查。

**废弃字段**: 旧 4 态 `draft | pi_reviewed | accepted | rejected`（`pi_reviewed` 拆分为 `reviewed` + `awaiting_pi`，增加 `revision_requested`）。

---

## 8. ChangeRequest

```yaml
change_id: CHG-0001                   # 格式: CHG-NNNN
task_id: TASK-0001
risk: low | medium | high
files_changed:
  - "repos/SHUD/src/output.c"
  - "repos/rSHUD/R/read_output.R"
interface_impact:
  output_change: additive | breaking | none
  backward_compatible: true | false
compat_checks:
  old_output_reader: pass | fail | skipped
  tiny_case: pass | fail | skipped
gates:
  needs_pi_approval: true
  reason: "output compatibility changed"
patch_bundle: "artifacts/CHG-0001.patch"   # null 若未生成
```

---

## 9. MemoryNote

```yaml
note_id: NOTE-0001                    # 格式: NOTE-NNNN
type: failure_note | data_note | compatibility_note | pi_decision | playbook_candidate
status: draft | accepted | retired
task_id: TASK-0001
title: "rSHUD old output fails when optional diagnostics assumed"
body: "The rSHUD reader failed because it assumed event_flux.csv exists."
evidence: [RUN-0007, REPORT-0003]     # 关联的 run/report ID
created_by: agent | pi               # 创建者角色
reviewed_by: null                     # PI 审阅后填写
created_at: 2026-04-25T16:00:00Z
```

---

## 附录: 命名决策记录

| 冲突点 | 废弃写法 | Canonical 写法 | 理由 |
|--------|---------|---------------|------|
| RunJob.backend | `local` / `local \| docker \| slurm` | `local_direct \| local_job \| docker_job` | 区分同步/异步执行语义 |
| RunRecord.status | `success` | `succeeded` | 与 RunJob 终态命名一致 |
| TaskCard 所有者 | 单个 `owner` | `created_by` + `current_owner` + `reviewer` | 区分创建者、当前负责人、审阅者三个角色 |
| TaskCard 关联 | 嵌套 `linked_objects: {stacklock, data, jobs, reports}` | 扁平 `stack_id` + `data_id` + `linked_jobs[]` + `linked_reports[]` | 减少嵌套深度 |
| EvidenceReport.status | 仅 `draft` 或旧 4 态 `pi_reviewed` | `draft \| reviewed \| awaiting_pi \| accepted \| revision_requested \| rejected` | 区分 Reviewer 检查与 PI 审阅，增加修订态 |
| StackLock.limits | 在 StackLock 中 | 移入 RunJob.resources | limits 是执行级，不是环境级 |
| TaskCard 执行细节 | `running_local \| submitted_job \| parked_waiting_for_job \| collecting` 作为 TaskCard.status | 下沉至 `TaskCard.runtime_phase`；TaskCard.status 保持 `running \| parked` 粗粒度 | 执行细节属于 RunJob/ParkedState 领域，不应膨胀 TaskCard 状态机 |
| TaskCard.revised | `revised` 作为独立状态 | 废弃；PI 修订时回到 `planned` | 减少状态数，`revised` 语义可由 ChangeRequest 关联表达 |
| TaskCard.blocked | 未在 canonical schema 声明 | 加入 `blocked` | 硬限制和 workspace 损坏需要明确终态 |
