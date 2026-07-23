import { z } from "zod";

export const ArtifactTypeSchema = z.enum([
  "log",
  "metrics",
  "figure",
  "timeseries",
  "report_markdown",
  "report_export",
  "patch",
  "repo_context",
  "toolcall",
  "manifest",
  "analysis_progress",
  "error"
]);

export const ArtifactCreatedBySchema = z.enum(["system", "agent", "user"]);

export const ArtifactRetentionClassSchema = z.enum([
  "ephemeral",
  "debug",
  "evidence",
  "accepted_report",
  "benchmark"
]);

export const ArtifactRedactionStatusSchema = z.enum(["not_needed", "redacted", "unsafe"]);

export const ArtifactSchema = z.strictObject({
  artifact_id: z.string().min(1),
  task_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  job_id: z.string().min(1).optional(),
  report_id: z.string().min(1).optional(),
  analysis_plan_id: z.string().min(1).optional(),
  type: ArtifactTypeSchema,
  path: z.string().min(1),
  media_type: z.string().min(1),
  size_bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().min(1).optional(),
  created_at: z.string().min(1),
  created_by: ArtifactCreatedBySchema,
  evidence_usable: z.boolean(),
  llm_generated: z.boolean().default(false),
  retention_class: ArtifactRetentionClassSchema,
  source_refs: z.array(z.string()),
  redaction_status: ArtifactRedactionStatusSchema
});

export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;
export type ArtifactCreatedBy = z.infer<typeof ArtifactCreatedBySchema>;
export type ArtifactRetentionClass = z.infer<typeof ArtifactRetentionClassSchema>;
export type ArtifactRedactionStatus = z.infer<typeof ArtifactRedactionStatusSchema>;
export type ArtifactInput = z.input<typeof ArtifactSchema>;
export type Artifact = ArtifactInput;
export type StoredArtifact = z.output<typeof ArtifactSchema>;
