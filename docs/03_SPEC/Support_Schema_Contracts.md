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

## 12. 验收标准

- [ ] 每个 support schema 都有 Zod 定义。
- [ ] 每个 support schema 都能生成 JSON Schema。
- [ ] support schema 变更会触发 schema drift CI。
- [ ] support object 不替代 8 个核心对象。
- [ ] 所有文件落盘前通过 schema 校验。
