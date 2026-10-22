---
status: frozen
canonical_for: [core-object-schemas, runjob-backend-enum, stacklock-llm]
---

# Canonical Schema Contract (v0.8)

> **本文件是 8 个核心对象 + MemoryNote 的唯一权威字段定义。**
> 其他文档（Research_Object_Model、SPEC_v0.8_Final、Execution_Jobs_Runs 等）若与本文件冲突，以本文件为准。
> 进入实现后，Zod schema 必须与此一一对应。

> **Canonical Source 说明：** Support schema（Artifact、ErrorRecord、PiGate、PiGateDecision、NotificationRecord、ReportExport、AnalysisProgressPayload、User、Session、AuditEvent、LockRecord、IdempotencyRecord 等）的权威定义不在本文件，见 [Support_Schema_Contracts.md](Support_Schema_Contracts.md)。本文件仅定义 8 个核心对象 + MemoryNote。

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
  SHUD:      { commit: 9b55b0c, branch: master, dirty: false }
  rSHUD:     { commit: d162db3, branch: master, dirty: false }
  AutoSHUD:  { commit: 1cbec6f, branch: master, dirty: false }
runtime:
  os: "Darwin 24.6.0"
  r_version: "4.4.1"
  r_packages_lock:                    # { path, sha256 } | null；下方为存在 renv.lock 的示例
    path: "renv.lock"
    sha256: "sha256:..."
  python_version: "3.12.4"
  sundials_version: "6.0.0"
  gcc_version: "14.1.0"
  gdal_version: "3.9.0"
harness:
  version: "0.8.0"
  cli_version: "0.1.0"                # 领域 CLI semver，见 Domain_CLI_Spec §5（T2 证据可追溯到生产它的 CLI 版本）
  prompt_pack: promptpack-0001
  skills_version: skills-0001
llm:                                  # 恰好三字段（ADR-0004 K4）
  base_url: "https://www.dmxapi.cn"   # string；第三方端点必锁：同名模型在不同端点可能被静默换版/量化
  request_alias: "deepseek-flash-guan" # string；请求中发送的 model id（ADR-0004 K3）
  response_model: "<响应体 model 字段原值>"  # string；API 返回的 `model` 字段，仅记录、不强制校验（K4）
fingerprint: "sha256:..."             # sha256: + 去掉 stack_id/created_at/fingerprint 后按键排序的紧凑 JSON 的 SHA-256，用于快速比对
created_at: 2026-04-25T10:00:00Z
```

**repos.dirty 说明**：`git status --porcelain --untracked-files=normal --ignore-submodules=none` 输出非空即 `true`（含 tracked 修改与 untracked 文件；沿用 git status 忽略语义，不含被 `.gitignore`、`.git/info/exclude` 或 `core.excludesFile`（未设置时为 `~/.config/git/ignore`）排除的文件；读取因输出超出缓冲上限而中断时，stdout 已有输出判 `true`，stdout 为空则抛错）；`commit` 为 HEAD 完整 id，`branch` 为 `refs/heads/<name>` 的 `<name>`，detached HEAD 时为 `HEAD`，HEAD 指向非分支引用（如 tag）或名为 `HEAD` 的分支时抛错。采集只读（`collectRepositoryRevision`），同一 commit 的 clean 与 dirty checkout 指纹不同。

**llm 字段说明**（ADR-0004 K4，取代 AGA-P0-1 的 model + params + prompt 锁）：`base_url` 或 `request_alias` 变化视为 **stack 变更**——需要新 StackLock，且触发行为 eval 子集（见 [Agent_Behavior_Eval_Spec](../04_IMPLEMENTATION/Agent_Behavior_Eval_Spec.md)）。`response_model` 是滚动别名（`deepseek-flash`）在建 lock 时的实际解析结果，只记录不强制：其变化**不**自动使 lock 失效，每条 RunRecord 另记 `llm.response_model`，可比性由 PI 看报告判断。cost_record 中的 per-call model 字段是计费粒度，不能替代本处的复现锁。

**废弃字段**: `runtime.container`（MVP 不强制容器）、`limits`（已移入 RunJob.resources）、`policy_version`（已合并入 harness.version）、`repos.zero`（内核改为 dsh，ADR-0004 K1）、`llm.provider` / `llm.model_id` / `llm.params_digest` / `llm.prompt_pack_digest`（K4 收窄为三字段）。

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

M2 字段处置依据 [m2-run-chain「Generated projection」](../../openspec/changes/m2-run-chain/specs/run-records/spec.md)：`cwd` 由 `run_dir` 取代，`command` 改为 argv 数组；执行资源限制与计算预算推迟 M3。下列 id 与状态集正文在 task 4.1 随 RunJob Zod 一并修订，此处只登记字段处置，不表示 M2 schema 已实现。

```yaml
job_id: JOB-0001                      # 格式: JOB-NNNN
task_id: TASK-0001
stack_id: STACK-0001                  # submit 时从 TaskCard 固化——RunRecord 的 stack/data 绑定由 job 携带，
data_id: DATA-0001                    # collect 不回猜（对抗审查 A01-3）
backend: local_direct | local_job | docker_job
#   local_direct — 短命令，同步 bash 执行
#   local_job    — 长命令，后台进程 + pid/status file + Park/Resume
#   docker_job   — 可选，固定环境容器执行
#   slurm        — 仅定义接口，不在 MVP 实现
status: created | submitted | running | succeeded | failed | cancelled | timed_out | collected
command: ["<shudBin>", "-o", "output/ccw.out", "ccw"] # argv；不经 shell 拼接
run_dir: "<session cwd>/runs/<run_id>"               # 取代 cwd
resources:                                          # M3；M2 不含执行限制
  max_wall_minutes: 30                               # M3
  max_memory_mb: 4096                                # M3
cost_budget:                                        # M3
  max_compute_minutes: 60                            # M3
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

M2 字段处置：`command` 为 argv 数组；`artifacts.metrics_summary` 与 `artifacts.plots` 推迟 M3。id、完整字段与 M2 取值约束在 task 4.2 随 RunRecord Zod 修订，当前不是已实现投影。

```yaml
run_id: RUN-0001                      # 格式: RUN-NNNN
job_id: JOB-0001
task_id: TASK-0001
stack_id: STACK-0001
data_id: DATA-0001
status: succeeded | failed            # 终态，只有两个值
command: ["<shudBin>", "-o", "output/ccw.out", "ccw"] # argv
artifacts:
  stdout: "artifacts/RUN-0001/stdout.log"
  stderr: "artifacts/RUN-0001/stderr.log"
  shud_output: "runs/RUN-0001/output/"
  metrics_summary: "artifacts/RUN-0001/metrics.yaml" # M3
  plots: ["artifacts/RUN-0001/hydrograph.png"]       # M3
numerical_health:
  water_balance_residual: 0.0008
  cvode_failures: 0
  negative_state_count: 0
  max_solver_dt: 5.2
resources:
  wall_seconds: 420
  peak_memory_mb: 1830
llm:
  response_model: "<响应体 model 字段原值>"  # string，必填；记录响应 model；变化不自动失效 lock（K4）
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

> **实现扩展：** AnalysisPlan 实现 schema 应支持 `parameter_sets` 和 `batch_policy`，详细定义见 [Parameter_Set_And_Analysis_Run_Mapping.md](Parameter_Set_And_Analysis_Run_Mapping.md)。本文件保留最小字段，避免核心对象膨胀。

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

## Theory-to-Code optional field additions

以下字段为 optional，不破坏现有 8 核心对象。high-risk `semantic_level` 触发 Scientific_Change_Gating_Spec。

```ts
// TaskCard optional additions
theory_bundle_ids?: string[];

// ChangeRequest additions
semantic_level?:
  | "pure_engineering"
  | "io_format"
  | "output_semantics"
  | "numerical_implementation"
  | "parameter_default"
  | "physical_equation"
  | "model_assumption";
theory_bundle_id?: string;
verification_case_ids?: string[];
pi_gate_required?: boolean;

// AnalysisPlan additions
requires_theory_bundle_id?: string;
baseline_run_id?: string;
search_preflight_status?: "not_run" | "passed" | "failed";
experiment_ledger_id?: string;

// EvidenceReport additions
theory_bundle_ids?: string[];
verification_case_ids?: string[];
```

---

## Support Schemas for Operational UX

以下 schema 是 v0.8.1 operational UX 支撑对象，不属于 8 个核心对象。它们用于通知、报告导出、批运行进度和 PI decision comment。

> **投影声明（2026-07-02 单源治理）**：本节全部定义（NotificationRecord / ReportExport /
> AnalysisProgressPayload / PiGateDecision / PiDecisionMemoryNote）为**投影副本**——字段事实源 =
> [Support_Schema_Contracts.md](Support_Schema_Contracts.md)（PiDecisionMemoryNote 的权威源为
> [PI_Decision_Comments_Spec.md](PI_Decision_Comments_Spec.md)）。改动先落权威源再同步此处；
> `schema:generate` 上线后本节转为生成物（CANONICAL_CONTRACTS 投影规则）。

### NotificationRecord

```ts
interface NotificationRecord {
  notification_id: string;
  task_id: string;
  job_id?: string;
  run_id?: string;
  analysis_plan_id?: string;
  report_id?: string;

  channel: "email";
  trigger:
    | "runrecord_created"
    | "report_draft_created"
    | "analysis_completed"
    | "critical_failure";

  recipient_email: string;
  subject: string;
  body_preview: string;

  status: "pending" | "sent" | "failed" | "skipped";
  dedupe_key: string;
  attempted_at?: string;
  sent_at?: string;
  error?: string;
}
```

### ReportExport

```ts
interface ReportExport {
  export_id: string;
  report_id: string;
  task_id: string;
  format: "html" | "markdown";
  status_at_export: "draft" | "reviewed" | "awaiting_pi" | "accepted" | "revision_requested" | "rejected" | "archived";
  output_path: string;
  inline_assets: boolean;
  include_logs: boolean;
  created_at: string;
  exported_by: "system" | string;
  included_artifacts: Array<{
    artifact_id: string;
    path: string;
    embedded: boolean | "summary_only";
  }>;
  excluded_artifacts: Array<{
    artifact_id: string;
    reason: string;
  }>;
}
```

### AnalysisProgressPayload

```ts
interface AnalysisProgressPayload {
  analysis_plan_id: string;
  task_id: string;
  total: number;
  queued: number;
  submitted: number;
  running: number;
  collecting: number;
  succeeded: number;
  failed: number;
  timed_out: number;
  cancelled: number;
  blocked: number;
  updated_at: string;
  cells: Array<{
    parameter_set_id: string;
    job_id?: string;
    run_id?: string;
    // 与 ParameterSet.status 派生源对齐，补 submitted/timed_out（对抗审查 A01-5：
    // 缺态会把超时误映射为 failed、已提交误映射为 queued）
    status: "queued" | "submitted" | "running" | "collecting" | "succeeded" | "failed" | "timed_out" | "cancelled" | "blocked";
    parameter_changes: Record<string, number | string | boolean>;
    log_artifact_id?: string;
    metrics_artifact_id?: string;
    report_section_ref?: string;
    failure_reason?: string;
    started_at?: string;
    completed_at?: string;
  }>;
}
```

### PiGateDecision

```ts
interface PiGateDecision {
  decision_id: string;
  gate_id: string;
  task_id: string;
  actor_user_id: string;
  actor_role: "pi";
  decision: "approved" | "rejected" | "request_revision";
  comment?: string;
  comment_required: boolean;
  next_action?: string;
  evidence_refs: string[];
  created_at: string;
}
```

> **枚举映射（对抗审查 A01-2）**：`decision` 是动词态枚举（`request_revision`），对象状态是名词态
> （PiGate.status / EvidenceReport.status 的 `revision_requested`）。两个集合不同，实现时必须是
> 两个独立 Zod enum + 一个显式映射函数（canonical 映射表见 PI_Decision_Comments_Spec）；
> 禁止 `report.status = decision` 直接赋值——枚举值不相等会静默丢迁移。

### MemoryNote(type=pi_decision)

```ts
interface PiDecisionMemoryNote {
  type: "pi_decision";
  note_id: string;
  task_id: string;
  report_id?: string;
  gate_id: string;
  decision: "approved" | "rejected" | "request_revision";
  comment: string;
  evidence_refs: string[];
  scope: "task" | "report" | "run" | "analysis_plan";
  evidence_level: "pi_confirmed";
  generalization_allowed: false;
  created_by: "pi";
  created_at: string;
}
```

### Operational UX 核心对象扩展字段

在对应核心对象中可增加可选字段：

```ts
// TaskCard 扩展
interface TaskCard {
  notification_recipients?: string[];
  pi_owner_email?: string;
  reviewer_email?: string;
}

// EvidenceReport 扩展
interface EvidenceReport {
  exports?: ReportExport[];
  decision_history?: PiGateDecision[];
}

// AnalysisPlan 扩展
interface AnalysisPlan {
  progress_artifact_id?: string;
  progress_summary?: Pick<AnalysisProgressPayload, "total" | "queued" | "submitted" | "running" | "collecting" | "succeeded" | "failed" | "timed_out" | "cancelled" | "blocked">;
}
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
