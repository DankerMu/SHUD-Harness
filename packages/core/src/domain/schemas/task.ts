import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "created",
  "planned",
  "running",
  "parked",
  "reporting",
  "awaiting_pi",
  "done",
  "cancelled",
  "blocked"
]);

export const TaskRuntimePhaseSchema = z.enum([
  "running_local",
  "submitted_job",
  "waiting_for_job",
  "collecting"
]);

export const TaskTypeSchema = z.enum(["engineering", "science_assist", "ops"]);

export const InferenceBudgetSchema = z.object({
  mode: z.enum(["cheap", "normal", "deep"]),
  advisory_usd: z.number().nonnegative().optional(),
  advisory_model_calls: z.number().int().nonnegative().optional(),
  reviewer_enabled: z.boolean().optional()
});

export const TaskCardSchema = z.object({
  task_id: z.string().min(1),
  type: TaskTypeSchema,
  status: TaskStatusSchema,
  runtime_phase: TaskRuntimePhaseSchema.nullable().optional(),
  title: z.string().min(1),
  question_or_goal: z.string().min(1),
  created_by: z.string().min(1),
  current_owner: z.string().min(1),
  reviewer: z.string().min(1),
  stack_id: z.string().min(1).optional(),
  data_id: z.string().min(1).optional(),
  inference_budget: InferenceBudgetSchema,
  linked_jobs: z.array(z.string().min(1)),
  linked_reports: z.array(z.string().min(1)),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  theory_bundle_ids: z.array(z.string().min(1)).optional()
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskRuntimePhase = z.infer<typeof TaskRuntimePhaseSchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type InferenceBudget = z.infer<typeof InferenceBudgetSchema>;
export type TaskCard = z.infer<typeof TaskCardSchema>;
