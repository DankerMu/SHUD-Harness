import { z } from "zod";

export const LockScopeSchema = z.enum(["task", "job", "run", "report", "workspace", "worktree"]);

export const LockStatusSchema = z.enum([
  "held",
  "released",
  "expired",
  "stolen_after_recovery"
]);

export const LockRecordSchema = z.object({
  lock_id: z.string().min(1),
  scope: LockScopeSchema,
  target_id: z.string().min(1),
  holder: z.string().min(1),
  acquired_at: z.string().min(1),
  expires_at: z.string().min(1),
  status: LockStatusSchema,
  reason: z.string().min(1)
});

export type LockScope = z.infer<typeof LockScopeSchema>;
export type LockStatus = z.infer<typeof LockStatusSchema>;
export type LockRecord = z.infer<typeof LockRecordSchema>;
