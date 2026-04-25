# Patch: Minimal_Schemas.md additions

**目标文档：** `docs/03_SPEC/Minimal_Schemas.md`  
**目的：** 增加 v0.8.1 support schemas。  
**合并方式：** 不改变 8 个核心对象；在核心对象定义之后新增 `Support Schemas for Operational UX` 章节。

## 插入位置

建议插入到 9 个 canonical objects / MemoryNote 定义之后、验收标准之前。

## 新增内容

```markdown
## Support Schemas for Operational UX

以下 schema 是 v0.8.1 operational UX 支撑对象，不属于 8 个核心对象。它们用于通知、报告导出、批运行进度和 PI decision comment。

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
```

## 额外字段建议

在对应核心对象中可增加可选字段：

```ts
interface TaskCard {
  notification_recipients?: string[];
  pi_owner_email?: string;
  reviewer_email?: string;
}

interface EvidenceReport {
  exports?: ReportExport[];
  decision_history?: PiGateDecision[];
}

interface AnalysisPlan {
  progress_artifact_id?: string;
  progress_summary?: Pick<AnalysisProgressPayload, "total" | "queued" | "running" | "collecting" | "succeeded" | "failed" | "cancelled" | "blocked">;
}
```
