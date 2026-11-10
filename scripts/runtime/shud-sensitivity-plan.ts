/**
 * The fixed acceptance plan (oat-sensitivity criterion 1): one constant, shared by the evaluator
 * and the session driver's prompt. Free of built package output, so the driver may import it
 * before its own build step.
 */
export const FIXED_PLAN = {
  project: "ccw",
  end_days: 90,
  threads: 1,
  parameter_sets: ["baseline", "GEOL_KSATH×0.5", "GEOL_KSATH×2", "LC_ROUGH×2"],
} as const;
