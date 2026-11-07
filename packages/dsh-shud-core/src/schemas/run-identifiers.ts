import { randomBytes } from "node:crypto";
import { z } from "zod";

function identifierPattern(prefix: string): RegExp {
  return new RegExp(`^${prefix}-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$`, "u");
}

export const JobRecordIdSchema = z.string().regex(identifierPattern("JOB")).brand<"JobRecordId">();
export const RunIdSchema = z.string().regex(identifierPattern("RUN")).brand<"RunId">();
export const TaskIdSchema = z.string().regex(identifierPattern("TASK")).brand<"TaskId">();
export const StackIdSchema = z.string().regex(identifierPattern("STACK")).brand<"StackId">();
export const DataIdSchema = z.string().regex(identifierPattern("DATA")).brand<"DataId">();
export const ReportIdSchema = z.string().regex(identifierPattern("REPORT")).brand<"ReportId">();
export const DecisionIdSchema = z.string().regex(identifierPattern("DEC")).brand<"DecisionId">();
export const ChangeIdSchema = z.string().regex(identifierPattern("CHG")).brand<"ChangeId">();
export const VerificationIdSchema = z
  .string()
  .regex(identifierPattern("VC"))
  .brand<"VerificationId">();
export const BuildIdSchema = z.string().regex(identifierPattern("BUILD")).brand<"BuildId">();
export const AnalysisPlanIdSchema = z
  .string()
  .regex(identifierPattern("PLAN"))
  .brand<"AnalysisPlanId">();

export type JobRecordId = z.infer<typeof JobRecordIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type StackId = z.infer<typeof StackIdSchema>;
export type DataId = z.infer<typeof DataIdSchema>;
export type ReportId = z.infer<typeof ReportIdSchema>;
export type DecisionId = z.infer<typeof DecisionIdSchema>;
export type ChangeId = z.infer<typeof ChangeIdSchema>;
export type VerificationId = z.infer<typeof VerificationIdSchema>;
export type BuildId = z.infer<typeof BuildIdSchema>;
export type AnalysisPlanId = z.infer<typeof AnalysisPlanIdSchema>;

const identifierSchemas = {
  JOB: JobRecordIdSchema,
  RUN: RunIdSchema,
  TASK: TaskIdSchema,
  STACK: StackIdSchema,
  DATA: DataIdSchema,
  REPORT: ReportIdSchema,
  DEC: DecisionIdSchema,
  CHG: ChangeIdSchema,
  VC: VerificationIdSchema,
  BUILD: BuildIdSchema,
  PLAN: AnalysisPlanIdSchema,
};

export function createBrandedId<Prefix extends keyof typeof identifierSchemas>(
  prefix: Prefix,
  now?: Date,
): z.infer<(typeof identifierSchemas)[Prefix]>;
export function createBrandedId(prefix: keyof typeof identifierSchemas, now = new Date()) {
  const timestamp = now.toISOString().slice(0, 19).replace(/[-:]/gu, "");
  const suffix = randomBytes(2).toString("hex");
  return identifierSchemas[prefix].parse(`${prefix}-${timestamp}-${suffix}`);
}

export function generateRunIdentifiers(now = new Date()): {
  job_id: JobRecordId;
  run_id: RunId;
} {
  const job_id = createBrandedId("JOB", now);
  return {
    job_id,
    run_id: RunIdSchema.parse(`RUN-${job_id.slice(4)}`),
  };
}
