import { z } from "zod";
import { isRelativePosixPath } from "./relative-posix-path.ts";
import {
  BuildIdSchema,
  ChangeIdSchema,
  RunIdSchema,
  TaskIdSchema,
  VerificationIdSchema,
} from "./run-identifiers.ts";

const RelativePathSchema = z.string().min(1).refine(isRelativePosixPath, {
  message: "Expected a relative POSIX path without parent traversal or NUL",
});
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const VerificationCaseSchema = z
  .strictObject({
    vc_id: VerificationIdSchema,
    task_id: TaskIdSchema,
    change_id: ChangeIdSchema,
    bundle_id: z.string().min(1).nullable(),
    case_type: z.enum([
      "dimension_check",
      "mass_balance",
      "limiting_case",
      "manufactured_solution",
      "regression",
      "unit_test",
      "tiny_basin",
      "output_semantics",
    ]),
    expected_result_source: z.enum([
      "analytic",
      "published",
      "pi_provided",
      "baseline_regression",
      "agent_proposed",
    ]),
    target_code_targets: z.array(RelativePathSchema),
    description: z.string().min(1),
    expected_result: z.string().min(1),
    pass_criteria: z.string().min(1),
    base_run_id: RunIdSchema,
    candidate_run_id: RunIdSchema,
    base_build_id: BuildIdSchema,
    candidate_build_id: BuildIdSchema,
    artifact_refs: z.array(RelativePathSchema).length(2),
    observed: z.strictObject({
      compared_path: RelativePathSchema,
      base_sha256: DigestSchema,
      candidate_sha256: DigestSchema,
    }),
    status: z.enum(["not_run", "running", "passed", "failed", "inconclusive", "waived_by_pi"]),
    failure_reason: z.string().min(1).nullable(),
    reviewed_by: z.string().min(1),
    reviewer_notes: z.array(z.string().min(1)).min(1),
    compatibility_verdict: z.enum(["compatible", "incompatible", "unknown"]),
    created_at: z.iso.datetime(),
  })
  .superRefine((record, context) => {
    if (record.status !== "passed" && record.status !== "failed") return;

    const passed = record.status === "passed";
    const equal = record.observed.base_sha256 === record.observed.candidate_sha256;
    if (passed !== equal) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Passed requires equal observed hashes; failed requires differing observed hashes",
      });
    }
    if (passed !== (record.failure_reason === null)) {
      context.addIssue({
        code: "custom",
        path: ["failure_reason"],
        message: "Passed requires a null failure reason; failed requires a nonempty reason",
      });
    }
  });

export type VerificationCase = z.infer<typeof VerificationCaseSchema>;
