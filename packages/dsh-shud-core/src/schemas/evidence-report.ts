import { z } from "zod";
import {
  DataIdSchema,
  DecisionIdSchema,
  ReportIdSchema,
  RunIdSchema,
  StackIdSchema,
  TaskIdSchema,
} from "./run-identifiers.ts";

export const PiGateDecisionSchema = z
  .strictObject({
    decision_id: DecisionIdSchema,
    report_id: ReportIdSchema,
    approval_ref: z.string().min(1),
    outcome: z.enum(["accepted", "rejected", "revision_requested"]),
    comment: z.string().min(1).nullable(),
    decided_at: z.iso.datetime(),
  })
  .refine((decision) => (decision.outcome === "accepted") === (decision.comment === null), {
    message: "Accepted decisions require null comment; other outcomes require a nonempty comment",
    path: ["comment"],
  });

function hasUniqueEntries(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const EvidenceReportSchema = z.strictObject({
  report_id: ReportIdSchema,
  task_id: TaskIdSchema,
  status: z.enum([
    "draft",
    "reviewed",
    "awaiting_pi",
    "accepted",
    "revision_requested",
    "rejected",
    "archived",
  ]),
  summary: z.string().min(1),
  observations: z.array(z.string().min(1)),
  limitations: z.array(z.string().min(1)),
  pi_questions: z.array(z.string().min(1)),
  linked_runs: z.array(RunIdSchema).min(1),
  stack_ids: z.array(StackIdSchema).min(1).refine(hasUniqueEntries, "Duplicate stack ids"),
  data_ids: z.array(DataIdSchema).min(1).refine(hasUniqueEntries, "Duplicate data ids"),
  llm_response_models: z
    .array(z.string().min(1))
    .min(1)
    .refine(hasUniqueEntries, "Duplicate response models"),
  decision_history: z.array(PiGateDecisionSchema),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export type PiGateDecision = z.infer<typeof PiGateDecisionSchema>;
export type EvidenceReport = z.infer<typeof EvidenceReportSchema>;
