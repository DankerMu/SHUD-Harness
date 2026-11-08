import { isAbsolute } from "node:path";
import { z } from "zod";

import { ParameterSetIdSchema } from "./analysis-plan.ts";
import {
  AnalysisPlanIdSchema,
  BuildIdSchema,
  JobRecordIdSchema,
  RunIdSchema,
} from "./run-identifiers.ts";

export const RunJobSchema = z
  .strictObject({
    job_id: JobRecordIdSchema,
    run_id: RunIdSchema,
    task_id: z.string().min(1).nullable(),
    stack_id: z.string().min(1).nullable(),
    data_id: z.string().min(1).nullable(),
    analysis_plan_id: AnalysisPlanIdSchema.nullable().default(null),
    parameter_set_id: ParameterSetIdSchema.nullable()
      .default(null)
      .describe(
        "Runtime validation requires analysis_plan_id and parameter_set_id to be both null or both non-null. " +
          "Missing identifiers default to null without rewriting stored records.",
      ),
    build_id: BuildIdSchema.nullable().default(null),
    threads: z.number().int().positive().nullable().default(null),
    binary_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable()
      .default(null),
    backend: z.literal("local_job"),
    status: z.enum([
      "created",
      "submitted",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "collected",
    ]),
    project: z.string().min(1),
    label: z
      .string()
      .min(1)
      .regex(/^[^\r\n]*$/u)
      .nullable(),
    input_dir: z.string().refine(isAbsolute, "Expected an absolute input directory"),
    run_dir: z.string().refine(isAbsolute, "Expected an absolute run directory"),
    command: z.array(z.string()).min(1),
    end_days: z.number().int().positive().nullable(),
    owner_session: z.string().min(1).nullable(),
    dsh_job_id: z
      .string()
      .regex(/^shud-[0-9a-f]{16}$/u)
      .nullable(),
    dsh_job_ids: z.array(z.string().regex(/^shud-[0-9a-f]{16}$/u)),
    pid: z.number().int().positive().nullable(),
    pid_started_at: z.iso.datetime().nullable(),
    input_bytes: z.number().int().nonnegative(),
    submitted_at: z.iso.datetime().nullable(),
    started_at: z.iso
      .datetime()
      .nullable()
      .describe(
        "Accepted wrapper start identity time from lstart, not a precise solver start measurement; null when unknown. " +
          "A persisted timestamp, including one retained or adopted during recovery, does not by itself authorize numeric wall_seconds.",
      ),
    finished_at: z.iso
      .datetime()
      .nullable()
      .describe(
        "Settlement-observation timestamp, not solver exit time; null before settlement or when unknown. " +
          "Completion and collection retries preserve this endpoint. Numeric wall_seconds additionally requires " +
          "matching start and terminal observations from the original submitting instance.",
      ),
    cancel_requested_at: z.iso.datetime().nullable(),
    exit_code: z.number().int().nullable(),
    llm: z.strictObject({
      response_model: z.string().min(1),
      response_model_source: z.enum(["response", "configured"]),
    }),
    notify: z.strictObject({
      status: z.enum(["pending", "delivered", "unreachable"]),
      attempts: z.number().int().nonnegative(),
      at: z.iso.datetime().nullable(),
      detail: z.string().nullable(),
    }),
  })
  .superRefine((job, context) => {
    if ((job.analysis_plan_id !== null) !== (job.parameter_set_id !== null)) {
      context.addIssue({
        code: "custom",
        path: ["parameter_set_id"],
        message: "Parameter set id must be non-null exactly when the run has an analysis plan id",
      });
    }
    if ((job.build_id !== null) !== (job.binary_sha256 !== null)) {
      context.addIssue({
        code: "custom",
        path: ["binary_sha256"],
        message: "Binary digest must be non-null exactly when the run has a build id",
      });
    }
    if (job.status !== "running") return;
    for (const field of ["pid", "pid_started_at"] as const) {
      if (job[field] === null) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `A running job requires ${field}`,
        });
      }
    }
  });

export type RunJob = z.infer<typeof RunJobSchema>;
