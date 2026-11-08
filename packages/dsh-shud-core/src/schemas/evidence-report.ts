import { z } from "zod";
import {
  AnalysisPlanIdSchema,
  ChangeIdSchema,
  DataIdSchema,
  DecisionIdSchema,
  ReportIdSchema,
  RunIdSchema,
  StackIdSchema,
  TaskIdSchema,
  VerificationIdSchema,
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

export const EvidenceReportSchema = z
  .strictObject({
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
    change_ids: z
      .array(ChangeIdSchema)
      .refine(hasUniqueEntries, "Duplicate change ids")
      .default([]),
    verification_ids: z
      .array(VerificationIdSchema)
      .refine(hasUniqueEntries, "Duplicate verification ids")
      .default([]),
    analysis_ids: z
      .array(AnalysisPlanIdSchema)
      .refine(hasUniqueEntries, "Duplicate analysis ids")
      .default([])
      .describe(
        "Unique analysis plan references in caller order; omitted legacy references default to []. " +
          "Runtime validation requires a nonempty array exactly when sensitivity_summary is non-null.",
      ),
    sensitivity_summary: z
      .strictObject({
        path: z
          .string()
          .describe(
            "Runtime validation requires exactly reports/<this report_id>.sensitivity.json.",
          ),
        sha256: z
          .string()
          .length(64)
          .regex(/^[0-9a-f]{64}$/u),
      })
      .nullable()
      .default(null)
      .describe(
        "Strict summary file reference, or null when analysis_ids is empty; omitted legacy " +
          "references default to null. Schema validates reference shape, not file bytes or existence.",
      ),
    decision_history: z.array(PiGateDecisionSchema),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .superRefine((report, context) => {
    if (report.analysis_ids.length > 0 !== (report.sensitivity_summary !== null)) {
      context.addIssue({
        code: "custom",
        path: ["sensitivity_summary"],
        message: "A sensitivity summary is required exactly when analysis ids are nonempty",
      });
    }
    if (
      report.sensitivity_summary !== null &&
      report.sensitivity_summary.path !== `reports/${report.report_id}.sensitivity.json`
    ) {
      context.addIssue({
        code: "custom",
        path: ["sensitivity_summary", "path"],
        message: "Sensitivity summary path must be reports/<this report_id>.sensitivity.json",
      });
    }
  });

export type PiGateDecision = z.infer<typeof PiGateDecisionSchema>;
export type EvidenceReport = z.infer<typeof EvidenceReportSchema>;
