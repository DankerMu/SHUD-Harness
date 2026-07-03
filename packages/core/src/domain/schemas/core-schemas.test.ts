import { describe, expect, test } from "bun:test";
import {
  ArtifactSchema,
  ErrorRecordSchema,
  IdempotencyRecordSchema,
  LockRecordSchema,
  TaskCardSchema
} from "./index";

describe("core Zod schemas", () => {
  test("TaskCard accepts a valid stored object and rejects missing required fields", () => {
    const parsed = TaskCardSchema.safeParse(validTaskCard());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("created");
      expect(parsed.data.runtime_phase).toBeNull();
    }

    const missingTitle = TaskCardSchema.safeParse(removeKey(validTaskCard(), "title"));
    expect(missingTitle.success).toBe(false);
    expect(issuePaths(missingTitle)).toContain("title");
  });

  test("TaskCard rejects status values outside the coarse state machine", () => {
    const invalid = TaskCardSchema.safeParse({
      ...validTaskCard(),
      status: "revised"
    });

    expect(invalid.success).toBe(false);
    expect(issuePaths(invalid)).toContain("status");
  });

  test("Artifact accepts a valid object and rejects missing required fields", () => {
    const parsed = ArtifactSchema.safeParse(validArtifact());
    expect(parsed.success).toBe(true);

    const missingPath = ArtifactSchema.safeParse(removeKey(validArtifact(), "path"));
    expect(missingPath.success).toBe(false);
    expect(issuePaths(missingPath)).toContain("path");
  });

  test("ErrorRecord accepts remediation and rejects invalid next_action", () => {
    const parsed = ErrorRecordSchema.safeParse(validErrorRecord());
    expect(parsed.success).toBe(true);

    const withoutRef = ErrorRecordSchema.safeParse({
      ...validErrorRecord(),
      remediation: {
        next_action: "fix_and_retry",
        hint: "Retry after fixing the workspace path."
      }
    });
    expect(withoutRef.success).toBe(true);

    const invalid = ErrorRecordSchema.safeParse({
      ...validErrorRecord(),
      remediation: {
        next_action: "try_anyway",
        hint: "Remove the unsupported tool.",
        ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
      }
    });
    expect(invalid.success).toBe(false);
    expect(issuePaths(invalid)).toContain("remediation.next_action");
  });

  test("IdempotencyRecord accepts request_digest and rejects missing required fields", () => {
    const parsed = IdempotencyRecordSchema.safeParse(validIdempotencyRecord());
    expect(parsed.success).toBe(true);

    const missingDigest = IdempotencyRecordSchema.safeParse(
      removeKey(validIdempotencyRecord(), "request_digest")
    );
    expect(missingDigest.success).toBe(false);
    expect(issuePaths(missingDigest)).toContain("request_digest");

    const invalidStatus = IdempotencyRecordSchema.safeParse({
      ...validIdempotencyRecord(),
      status: "running"
    });
    expect(invalidStatus.success).toBe(false);
    expect(issuePaths(invalidStatus)).toContain("status");
  });

  test("LockRecord accepts a valid object and rejects missing required fields", () => {
    const parsed = LockRecordSchema.safeParse(validLockRecord());
    expect(parsed.success).toBe(true);

    const missingHolder = LockRecordSchema.safeParse(removeKey(validLockRecord(), "holder"));
    expect(missingHolder.success).toBe(false);
    expect(issuePaths(missingHolder)).toContain("holder");

    const invalidStatus = LockRecordSchema.safeParse({
      ...validLockRecord(),
      status: "open"
    });
    expect(invalidStatus.success).toBe(false);
    expect(issuePaths(invalidStatus)).toContain("status");
  });
});

function validTaskCard() {
  return {
    task_id: "TASK-0001",
    type: "engineering",
    status: "created",
    runtime_phase: null,
    title: "Add optional event diagnostics",
    question_or_goal: "Add event_flux output without breaking old rSHUD readers",
    created_by: "alice",
    current_owner: "alice",
    reviewer: "pi_name",
    inference_budget: {
      mode: "normal",
      advisory_usd: 1,
      advisory_model_calls: 12,
      reviewer_enabled: false
    },
    linked_jobs: [],
    linked_reports: [],
    created_at: "2026-04-25T10:00:00Z",
    updated_at: "2026-04-25T10:00:00Z"
  };
}

function validArtifact() {
  return {
    artifact_id: "ART-0001",
    task_id: "TASK-0001",
    type: "report_markdown",
    path: "reports/TASK-0001_report.md",
    media_type: "text/markdown",
    created_at: "2026-04-25T10:00:00Z",
    created_by: "agent",
    evidence_usable: false,
    retention_class: "debug",
    source_refs: [],
    redaction_status: "not_needed"
  };
}

function validErrorRecord() {
  return {
    error_id: "ERR-0001",
    category: "permission_error",
    severity: "error",
    task_id: "TASK-0001",
    message: "Policy gate denied bash.",
    user_message: "This command writes to a protected path.",
    evidence_refs: [],
    retryable: false,
    recommended_next_actions: ["Use a governed workspace path."],
    remediation: {
      next_action: "adjust_scope",
      hint: "Use a governed workspace path instead of data/raw.",
      ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
    },
    created_at: "2026-04-25T10:00:00Z"
  };
}

function validIdempotencyRecord() {
  return {
    key: "task:TASK-0001:create",
    scope: "task",
    request_digest: "sha256:abc123",
    status: "completed",
    result_ref: "TASK-0001",
    created_at: "2026-04-25T10:00:00Z",
    updated_at: "2026-04-25T10:01:00Z"
  };
}

function validLockRecord() {
  return {
    lock_id: "LOCK-0001",
    scope: "task",
    target_id: "TASK-0001",
    holder: "worker-1",
    acquired_at: "2026-04-25T10:00:00Z",
    expires_at: "2026-04-25T10:01:00Z",
    status: "held",
    reason: "task snapshot write"
  };
}

function removeKey<T extends Record<string, unknown>, K extends keyof T>(object: T, key: K): Omit<T, K> {
  const clone = { ...object };
  delete clone[key];
  return clone;
}

function issuePaths(result: { success: true } | { success: false; error: { issues: Array<{ path: Array<string | number> }> } }): string[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}
