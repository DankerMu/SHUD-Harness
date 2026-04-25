# Support Schema Contracts

**状态：** v0.8.1 P0 补充规范  
**适用范围：** Artifact、PI gate、notification、report export、analysis progress、error/audit/session、locks、snapshots、runner result。  
**目标：** 将分散在各文档中的 support object 固定为统一 schema，避免实现时漂移。

Support schema 不属于 v0.8 的 8 个核心对象，但必须由 Zod 定义并进入 API/WebSocket/文件落盘校验。

## 1. Artifact

```ts
interface Artifact {
  artifact_id: string;
  task_id: string;
  run_id?: string;
  job_id?: string;
  report_id?: string;
  analysis_plan_id?: string;
  type:
    | "log"
    | "metrics"
    | "figure"
    | "timeseries"
    | "report_markdown"
    | "report_export"
    | "patch"
    | "repo_context"
    | "toolcall"
    | "manifest"
    | "analysis_progress"
    | "error";
  path: string;
  media_type: string;
  size_bytes?: number;
  sha256?: string;
  created_at: string;
  created_by: "system" | "agent" | "user";
  evidence_usable: boolean;
  retention_class: "ephemeral" | "debug" | "evidence" | "accepted_report" | "benchmark";
  source_refs: string[];
  redaction_status: "not_needed" | "redacted" | "unsafe";
}
```

## 2. ArtifactManifest

```ts
interface ArtifactManifest {
  manifest_id: string;
  task_id: string;
  run_id?: string;
  report_id?: string;
  artifacts: Artifact[];
  generated_at: string;
  generator: string;
  manifest_sha256?: string;
}
```

## 2.1 RepoContextBrief

RepoContextBrief 是 Repo Explorer 生成的只读仓库上下文简报。它用于计划、编码和 review，不作为科学证据使用。对应 Artifact 应使用：

```text
type = "repo_context"
created_by = "agent"
evidence_usable = false
retention_class = "debug"
```

```ts
interface RepoContextBrief {
  brief_id: string;
  task_id: string;
  created_by_agent_id: string;
  created_at: string;
  repos: Array<"SHUD" | "rSHUD" | "AutoSHUD" | "zero" | "harness">;
  trigger: "code_change" | "debugging" | "cross_repo" | "spec_code_alignment" | "failure_followup";
  inspected_refs: Array<{
    repo: string;
    path: string;
    symbol?: string;
    reason: string;
  }>;
  entrypoints: Array<{
    repo: string;
    path: string;
    symbol?: string;
    notes?: string;
  }>;
  impact_surface: Array<{
    repo: string;
    path: string;
    risk: string;
    required_followup?: string;
  }>;
  recommended_test_commands: string[];
  risks: string[];
  unknowns: string[];
  artifact_refs: string[];
}
```

## 3. ErrorRecord

```ts
interface ErrorRecord {
  error_id: string;
  category:
    | "schema_error"
    | "permission_error"
    | "workspace_error"
    | "sandbox_error"
    | "build_error"
    | "runtime_error"
    | "numerical_error"
    | "parser_error"
    | "report_error"
    | "agent_error"
    | "notification_error";
  severity: "info" | "warn" | "error" | "critical";
  task_id?: string;
  job_id?: string;
  run_id?: string;
  report_id?: string;
  message: string;
  user_message: string;
  evidence_refs: string[];
  retryable: boolean;
  recommended_next_actions: string[];
  created_at: string;
}
```

## 4. FailureRecord

失败运行也应可复盘。若 RunRecord 无法完整生成，使用 FailureRecord 保留最小证据。

```ts
interface FailureRecord {
  failure_id: string;
  task_id: string;
  job_id?: string;
  attempted_command?: string;
  stack_id?: string;
  data_id?: string;
  error_id: string;
  artifacts: {
    stdout?: string;
    stderr?: string;
    partial_output?: string;
    toolcall?: string;
  };
  created_at: string;
}
```

## 5. PiGate

```ts
interface PiGate {
  gate_id: string;
  task_id: string;
  report_id?: string;
  change_id?: string;
  reason: string;
  required_role: "pi";
  gate_type:
    | "physics_change"
    | "default_parameter_change"
    | "benchmark_baseline_overwrite"
    | "validated_claim"
    | "breaking_output_change"
    | "raw_data_delete"
    | "high_risk_patch"
    | "report_acceptance";
  status: "open" | "approved" | "rejected" | "revision_requested" | "cancelled";
  evidence_refs: string[];
  created_by: "coordinator" | "reviewer" | "system";
  created_at: string;
  resolved_at?: string;
}
```

## 6. PiGateDecision

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
  idempotency_key?: string;
  created_at: string;
}
```

## 7. NotificationRecord

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
  status: "pending" | "sent" | "failed" | "skipped" | "suppressed";
  dedupe_key: string;
  attempted_at?: string;
  sent_at?: string;
  error_id?: string;
}
```

## 8. ReportExport

```ts
interface ReportExport {
  export_id: string;
  report_id: string;
  task_id: string;
  format: "html" | "markdown";
  status_at_export: "draft" | "reviewed" | "awaiting_pi" | "accepted" | "revision_requested" | "rejected" | "archived";
  output_path: string;
  manifest_path: string;
  inline_assets: boolean;
  include_logs: boolean;
  created_at: string;
  created_by: "system" | "user";
  sha256?: string;
}
```

## 9. AnalysisProgressPayload

```ts
interface AnalysisProgressPayload {
  analysis_plan_id: string;
  task_id: string;
  total: number;
  queued: number;
  running: number;
  collecting: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  blocked: number;
  updated_at: string;
  cells: Array<{
    parameter_set_id: string;
    job_id?: string;
    run_id?: string;
    status: "queued" | "running" | "collecting" | "succeeded" | "failed" | "cancelled" | "blocked";
    parameter_changes: Record<string, unknown>;
    log_artifact_id?: string;
    metrics_artifact_id?: string;
    failure_reason?: string;
    started_at?: string;
    completed_at?: string;
  }>;
}
```

## 10. User / Session / AuditEvent

详细定义见 `User_Session_And_Audit_Schema.md`。实现时这些 schema 应从同一个 Zod 包导出。

## 11. LockRecord / IdempotencyRecord / WorkspaceSnapshot

详细定义见：

```text
Idempotency_Concurrency_Locking_Spec.md
Workspace_Snapshot_And_Recovery_Spec.md
```

## 12. Requirement

```ts
interface Requirement {
  requirement_id: string;
  type: "user_story" | "functional" | "non_functional" | "data" | "governance" | "integration" | "test";
  title: string;
  statement: string;
  priority: "P0" | "P1" | "P2" | "P3";
  status: "draft" | "approved" | "implemented" | "verified" | "deprecated" | "blocked";
  source_doc: string;
  related_docs: string[];
  acceptance_criteria: string[];
  test_ids: string[];
  release_gate?: string;
}
```

## 13. HealthStatus / HealthCheck

```ts
interface HealthStatus {
  status: "ok" | "degraded" | "not_ready" | "failed";
  service: string;
  version: string;
  uptime_seconds: number;
  checks: HealthCheck[];
  timestamp: string;
}

interface HealthCheck {
  name: string;
  status: "ok" | "warn" | "fail" | "skipped";
  message?: string;
  evidence_refs?: string[];
}
```

## 14. MetricSample

```ts
interface MetricSample {
  metric: string;
  value: number;
  unit?: string;
  labels: Record<string, string>;
  timestamp: string;
}
```

## 15. AlertRule / AlertRecord

```ts
interface AlertRule {
  rule_id: string;
  metric: string;
  condition: string;
  severity: "info" | "warning" | "error" | "critical";
  threshold: number | string;
  duration?: string;
  action: "dashboard_only" | "notify" | "block_new_jobs" | "require_admin";
}

interface AlertRecord {
  alert_id: string;
  rule_id: string;
  severity: "info" | "warning" | "error" | "critical";
  status: "active" | "resolved" | "suppressed";
  message: string;
  evidence_refs: string[];
  created_at: string;
  resolved_at?: string;
}
```

## 16. OpsIncident

```ts
interface OpsIncident {
  incident_id: string;
  category:
    | "disk_full"
    | "job_stuck"
    | "duckdb_corruption"
    | "smtp_failure"
    | "oom"
    | "secret_leak"
    | "websocket_failure"
    | "artifact_corruption"
    | "dependency_failure";
  severity: "warning" | "error" | "critical";
  status: "open" | "mitigated" | "resolved" | "postmortem_required";
  task_ids?: string[];
  job_ids?: string[];
  evidence_refs: string[];
  runbook_ref: string;
  created_at: string;
  updated_at: string;
}
```

## 17. DependencyLock

```ts
interface DependencyLock {
  lock_id: string;
  created_at: string;
  package_manager: {
    name: "bun";
    version: string;
    lockfile_path: string;
    lockfile_sha256: string;
  };
  packages: Array<{
    name: string;
    version: string;
    dependency_type: "runtime" | "dev" | "peer" | "optional";
    source: "npm" | "git" | "local";
  }>;
  native_dependencies?: Array<{
    name: string;
    version: string;
    source: string;
    platform: string;
  }>;
  submodules: Array<{
    name: "SHUD" | "rSHUD" | "AutoSHUD" | "zero";
    commit: string;
    dirty: boolean;
  }>;
}
```

## 18. 验收标准

- [ ] 每个 support schema 都有 Zod 定义。
- [ ] 每个 support schema 都能生成 JSON Schema。
- [ ] support schema 变更会触发 schema drift CI。
- [ ] support object 不替代 8 个核心对象。
- [ ] 所有文件落盘前通过 schema 校验。
- [ ] 新对象（Requirement、RepoContextBrief、HealthStatus、AlertRule/Record、OpsIncident、DependencyLock）进入 Zod schema。
- [ ] schema generation 覆盖新增对象。
- [ ] AlertRecord/OpsIncident 必须包含 evidence_refs。
- [ ] Requirement 编号唯一性有测试。
