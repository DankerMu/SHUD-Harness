import { z } from "zod";
import {
  AnalysisPlanIdSchema,
  ChangeIdSchema,
  DataIdSchema,
  JobRecordIdSchema,
  ReportIdSchema,
  StackIdSchema,
  TaskIdSchema,
  VerificationIdSchema,
} from "./run-identifiers.ts";

export const TaskStatusSchema = z.enum([
  "created",
  "planned",
  "running",
  "parked",
  "reporting",
  "awaiting_pi",
  "done",
  "cancelled",
  "blocked",
]);

export const TaskRuntimePhaseSchema = z.enum([
  "running_local",
  "submitted_job",
  "waiting_for_job",
  "collecting",
]);

export const TaskTypeSchema = z.enum([
  "engineering",
  "science_assist",
  "ops",
  "code_change",
  "sensitivity",
]);

export const InferenceBudgetSchema = z.object({
  mode: z.enum(["cheap", "normal", "deep"]),
  advisory_usd: z.number().nonnegative().optional(),
  advisory_model_calls: z.number().int().nonnegative().optional(),
  reviewer_enabled: z.boolean().optional(),
});

export const TaskCardSchema = z
  .object({
    task_id: TaskIdSchema,
    type: TaskTypeSchema,
    status: TaskStatusSchema,
    runtime_phase: TaskRuntimePhaseSchema.nullable().optional(),
    title: z.string().min(1),
    question_or_goal: z.string().min(1),
    created_by: z.string().min(1),
    current_owner: z.string().min(1),
    reviewer: z.string().min(1),
    stack_id: StackIdSchema.nullable(),
    data_id: DataIdSchema.nullable(),
    inference_budget: InferenceBudgetSchema,
    linked_jobs: z.array(JobRecordIdSchema),
    linked_reports: z.array(ReportIdSchema),
    linked_changes: z.array(ChangeIdSchema).default([]),
    linked_verifications: z.array(VerificationIdSchema).default([]),
    linked_analyses: z.array(AnalysisPlanIdSchema).default([]),
    source_base_commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable()
      .default(null),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    theory_bundle_ids: z.array(z.string().min(1)).optional(),
  })
  .refine((card) => (card.type === "code_change") === (card.source_base_commit !== null), {
    path: ["source_base_commit"],
    message: "Source base commit must be non-null exactly when the task type is code_change",
  })
  .refine((card) => card.type === "sensitivity" || card.linked_analyses.length === 0, {
    path: ["linked_analyses"],
    message: "Analysis links must be empty unless the task type is sensitivity",
  });

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskRuntimePhase = z.infer<typeof TaskRuntimePhaseSchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type InferenceBudget = z.infer<typeof InferenceBudgetSchema>;
export type TaskCard = z.infer<typeof TaskCardSchema>;
export type TaskCardInput = z.input<typeof TaskCardSchema>;
