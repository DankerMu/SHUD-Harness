import { z } from "zod";

export const IdempotencyScopeSchema = z.enum([
  "task",
  "job",
  "report",
  "notification",
  "pi_gate",
  "export"
]);

export const IdempotencyStatusSchema = z.enum(["started", "completed", "failed"]);

export const IdempotencyRecordSchema = z.object({
  key: z.string().min(1),
  scope: IdempotencyScopeSchema,
  request_digest: z.string().min(1),
  status: IdempotencyStatusSchema,
  result_ref: z.string().min(1).optional(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  expires_at: z.string().min(1).optional()
});

export type IdempotencyScope = z.infer<typeof IdempotencyScopeSchema>;
export type IdempotencyStatus = z.infer<typeof IdempotencyStatusSchema>;
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;
