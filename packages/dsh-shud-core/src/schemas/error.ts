import { z } from "zod";

export const ErrorCategorySchema = z.enum([
  "schema_error",
  "permission_error",
  "workspace_error",
  "sandbox_error",
  "build_error",
  "runtime_error",
  "numerical_error",
  "parser_error",
  "report_error",
  "agent_error",
  "notification_error"
]);

export const ErrorSeveritySchema = z.enum(["info", "warn", "error", "critical"]);

export const RemediationNextActionSchema = z.enum([
  "escalate_to_pi",
  "open_gate",
  "adjust_scope",
  "fix_and_retry",
  "abort"
]);

export const ErrorRemediationSchema = z.object({
  next_action: RemediationNextActionSchema,
  hint: z.string().min(1),
  ref: z.string().min(1).optional()
});

export const ErrorRecordSchema = z.object({
  error_id: z.string().min(1),
  category: ErrorCategorySchema,
  severity: ErrorSeveritySchema,
  task_id: z.string().min(1).optional(),
  job_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  report_id: z.string().min(1).optional(),
  message: z.string().min(1),
  user_message: z.string().min(1),
  evidence_refs: z.array(z.string()),
  retryable: z.boolean(),
  recommended_next_actions: z.array(z.string()),
  remediation: ErrorRemediationSchema.optional(),
  created_at: z.string().min(1)
});

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;
export type ErrorSeverity = z.infer<typeof ErrorSeveritySchema>;
export type RemediationNextAction = z.infer<typeof RemediationNextActionSchema>;
export type ErrorRemediation = z.infer<typeof ErrorRemediationSchema>;
export type ErrorRecord = z.infer<typeof ErrorRecordSchema>;
