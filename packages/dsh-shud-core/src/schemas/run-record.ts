import { z } from "zod";

import { ArtifactSchema } from "./artifact.ts";
import { JobRecordIdSchema, RunIdSchema } from "./run-identifiers.ts";

export const RunExitClassSchema = z.enum([
  "ok",
  "nan",
  "file_io",
  "input",
  "cvode",
  "consistency",
  "other",
  "cancelled",
  "lost",
]);

export type RunExitClass = z.infer<typeof RunExitClassSchema>;

export function classifyRunExit(
  exitCode: number,
  missingOutcome?: "cancelled" | "lost",
): RunExitClass;
export function classifyRunExit(
  exitCode: number | null,
  missingOutcome: "cancelled" | "lost",
): RunExitClass;
export function classifyRunExit(
  exitCode: number | null,
  missingOutcome?: "cancelled" | "lost",
): RunExitClass {
  if (exitCode === null) {
    if (missingOutcome !== "cancelled" && missingOutcome !== "lost") {
      throw new TypeError("A missing exit code requires an explicit cancelled or lost outcome");
    }
    return missingOutcome;
  }
  if (!Number.isInteger(exitCode)) {
    throw new TypeError("Exit code must be an integer or null");
  }
  switch (exitCode) {
    case 0:
      return "ok";
    case 10:
      return "nan";
    case 12:
      return "file_io";
    case 13:
      return "input";
    case 19:
      return "cvode";
    case 20:
      return "consistency";
    default:
      return "other";
  }
}

function isRelativeArtifactPath(path: string): boolean {
  return !/^(?:[\\/]|[A-Za-z]:)/u.test(path) && !path.split(/[\\/]/u).includes("..");
}

export const RunRecordSchema = z
  .strictObject({
    run_id: RunIdSchema,
    job_id: JobRecordIdSchema,
    task_id: z.string().min(1).nullable(),
    stack_id: z.string().min(1).nullable(),
    data_id: z.string().min(1).nullable(),
    status: z.enum(["succeeded", "failed"]),
    command: z.array(z.string()).min(1),
    exit_code: z.number().int().nullable(),
    exit_class: RunExitClassSchema,
    artifacts: z.strictObject({
      stdout: z.string().min(1),
      stderr: z.string().min(1),
      shud_output: z.string().min(1),
      files: z.array(
        z.strictObject({
          path: z.string().min(1).refine(isRelativeArtifactPath, {
            message: "Expected a relative artifact path without parent traversal",
          }),
          size_bytes: ArtifactSchema.shape.size_bytes.unwrap(),
        }),
      ),
    }),
    numerical_health: z.strictObject({
      water_balance_residual: z.number().nullable(),
      cvode_failures: z.number().int().nonnegative().nullable(),
      negative_state_count: z.number().int().nonnegative().nullable(),
      max_solver_dt: z.number().nonnegative().nullable(),
    }),
    resources: z.strictObject({
      wall_seconds: z
        .number()
        .nonnegative()
        .nullable()
        .describe(
          "Original-instance observation window in seconds: (finished_at - started_at) / 1000. " +
            "New records require matching original start and successfully published terminal observations; " +
            "missing, recovered or mismatched observations produce null. finished_at is settlement observation, " +
            "not solver exit time. The window may include start-clock bias, detection delay and local cancellation grace; " +
            "it is not solver runtime, a solver-runtime upper bound or a fixed-precision measurement. " +
            "Negative known intervals are rejected even without observations. Valid committed records remain immutable " +
            "and historical numeric values are not retroactively certified.",
        ),
      peak_memory_mb: z.number().nonnegative().nullable(),
    }),
    llm: z.strictObject({
      response_model: z.string().min(1),
      response_model_source: z.enum(["response", "configured"]),
    }),
    collected_at: z.iso.datetime(),
  })
  .superRefine((record, context) => {
    const classMatches =
      record.exit_code === null
        ? record.exit_class === "cancelled" || record.exit_class === "lost"
        : record.exit_class === classifyRunExit(record.exit_code);
    if (!classMatches) {
      context.addIssue({
        code: "custom",
        path: ["exit_class"],
        message: "Exit class must match numeric exit evidence or an explicit missing-code outcome",
      });
    }
    const expectedStatus = record.exit_class === "ok" ? "succeeded" : "failed";
    if (record.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Exit class ${record.exit_class} requires status ${expectedStatus}`,
      });
    }
  });

export type RunRecord = z.infer<typeof RunRecordSchema>;
