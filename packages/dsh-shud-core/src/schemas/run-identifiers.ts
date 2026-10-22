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

export type JobRecordId = z.infer<typeof JobRecordIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;

export function generateRunIdentifiers(now = new Date()): {
  job_id: JobRecordId;
  run_id: RunId;
} {
  const timestamp = now.toISOString().slice(0, 19).replace(/[-:]/gu, "");
  const suffix = randomBytes(2).toString("hex");
  return {
    job_id: JobRecordIdSchema.parse(`JOB-${timestamp}-${suffix}`),
    run_id: RunIdSchema.parse(`RUN-${timestamp}-${suffix}`),
  };
}
