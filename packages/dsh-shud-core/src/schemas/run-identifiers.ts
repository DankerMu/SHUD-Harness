import { randomBytes } from "node:crypto";
import { z } from "zod";

export const JobRecordIdSchema = z
  .string()
  .regex(/^JOB-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/u)
  .brand<"JobRecordId">();
export const RunIdSchema = z
  .string()
  .regex(/^RUN-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/u)
  .brand<"RunId">();
export const TaskIdSchema = z
  .string()
  .regex(/^TASK-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/u)
  .brand<"TaskId">();
export const StackIdSchema = z
  .string()
  .regex(/^STACK-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/u)
  .brand<"StackId">();
export const DataIdSchema = z
  .string()
  .regex(/^DATA-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/u)
  .brand<"DataId">();
export const ReportIdSchema = z
  .string()
  .regex(/^REPORT-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/u)
  .brand<"ReportId">();
export const DecisionIdSchema = z
  .string()
  .regex(/^DEC-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/u)
  .brand<"DecisionId">();

export type JobRecordId = z.infer<typeof JobRecordIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type StackId = z.infer<typeof StackIdSchema>;
export type DataId = z.infer<typeof DataIdSchema>;
export type ReportId = z.infer<typeof ReportIdSchema>;
export type DecisionId = z.infer<typeof DecisionIdSchema>;

const identifierSchemas = {
  JOB: JobRecordIdSchema,
  RUN: RunIdSchema,
  TASK: TaskIdSchema,
  STACK: StackIdSchema,
  DATA: DataIdSchema,
  REPORT: ReportIdSchema,
  DEC: DecisionIdSchema,
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
