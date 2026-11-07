import { isAbsolute } from "node:path";
import { z } from "zod";
import { CALIB_MULTIPLIER_RANGE, CALIB_WHITELIST } from "../governance/calib-whitelist.ts";
import { isProjectComponent } from "../project-component.ts";
import { AnalysisPlanIdSchema, TaskIdSchema } from "./run-identifiers.ts";

export const ParameterSetIdSchema = z.string().regex(/^PSET-[1-5]$/u);

const CalibKeySchema = z.enum(Object.keys(CALIB_WHITELIST) as (keyof typeof CALIB_WHITELIST)[]);
const MultiplierSchema = z
  .number()
  .min(CALIB_MULTIPLIER_RANGE[0])
  .max(CALIB_MULTIPLIER_RANGE[1])
  .refine((value) => value !== 1, { message: "A perturbation multiplier must differ from 1" });
const ParameterSetSchema = z.strictObject({
  parameter_set_id: ParameterSetIdSchema,
  label: z.string().min(1).nullable(),
  baseline: z.boolean(),
  changes: z.partialRecord(CalibKeySchema, MultiplierSchema),
});
// Digest paths are stricter than existing record paths: no empty or dot segments either.
const DigestPathSchema = z
  .string()
  .min(1)
  .regex(/^(?!\.{1,2}(?:\/|$))[^/\0]+(?:\/(?!\.{1,2}(?:\/|$))[^/\0]+)*$/u);
const DigestSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/u);

export const AnalysisPlanSchema = z
  .strictObject({
    analysis_plan_id: AnalysisPlanIdSchema,
    task_id: TaskIdSchema,
    mode: z.literal("sensitivity").describe("Only the literal sensitivity is allowed."),
    strategy: z.literal("one_at_a_time").describe("Only the literal one_at_a_time is allowed."),
    input_dir: z.string().min(1).refine(isAbsolute, {
      message: "Input directory must be an absolute path",
    }),
    project: z.string().refine(isProjectComponent, {
      message: "Project must be one nonempty path component other than dot or parent traversal",
    }),
    end_days: z.number().int().positive(),
    threads: z.number().int().positive(),
    parameter_sets: z
      .array(ParameterSetSchema)
      .min(3)
      .max(5)
      .describe(
        "Requires 3–5 parameter sets. Runtime validation requires exactly one empty baseline, " +
          "one changed key per perturbation, " +
          "sequential PSET ids and distinct changes. Multipliers must differ from 1. " +
          "Baseline position is unrestricted; parameter sets have no persisted run status.",
      ),
    parameter_space_rationale: z.strictObject({
      proposed_by: z.literal("agent").describe("Only the literal agent is allowed."),
      basis: z.string().min(1),
      confirmed_by: z.null().describe("Only null is allowed; M5 has no plan confirmation path."),
    }),
    input_digests: z
      .record(DigestPathSchema, DigestSchema)
      .describe(
        "Runtime validation requires exactly <project>.cfg.calib and the deduplicated whitelist " +
          "table filenames used by parameter_sets; values identify the original input bytes.",
      ),
    created_by: z.string().min(1),
    created_at: z.iso.datetime(),
  })
  .superRefine((plan, context) => {
    let baselineCount = 0;
    const perturbations = new Map<string, Set<number>>();
    const requiredFiles = new Set([`${plan.project}.cfg.calib`]);
    for (const [index, set] of plan.parameter_sets.entries()) {
      const changes = Object.entries(set.changes);
      if (set.baseline) baselineCount += 1;
      if (changes.length !== (set.baseline ? 0 : 1)) {
        context.addIssue({
          code: "custom",
          path: ["parameter_sets"],
          message: "Baseline changes must be empty; each perturbation must change exactly one key",
        });
      }
      if (set.parameter_set_id !== `PSET-${index + 1}`) {
        context.addIssue({
          code: "custom",
          path: ["parameter_sets"],
          message: "Parameter set ids must follow array order from PSET-1",
        });
      }
      for (const [key, multiplier] of changes) {
        const entry = CALIB_WHITELIST[key as keyof typeof CALIB_WHITELIST];
        requiredFiles.add(entry.table.replace("<project>", () => plan.project));
        // Multi-key changes are already invalid; only singleton changes can be valid duplicates.
        if (changes.length !== 1) continue;
        const seen = perturbations.get(key);
        if (seen?.has(multiplier)) {
          context.addIssue({
            code: "custom",
            path: ["parameter_sets"],
            message: "Parameter set changes must be distinct",
          });
        }
        if (seen) seen.add(multiplier);
        else perturbations.set(key, new Set([multiplier]));
      }
    }
    if (baselineCount !== 1) {
      context.addIssue({
        code: "custom",
        path: ["parameter_sets"],
        message: "Exactly one baseline parameter set is required",
      });
    }
    const digestFiles = Object.keys(plan.input_digests);
    if (
      digestFiles.length !== requiredFiles.size ||
      digestFiles.some((file) => !requiredFiles.has(file))
    ) {
      context.addIssue({
        code: "custom",
        path: ["input_digests"],
        message: "Input digests must exactly cover cfg.calib and the used whitelist tables",
      });
    }
  });

export type AnalysisPlan = z.infer<typeof AnalysisPlanSchema>;
