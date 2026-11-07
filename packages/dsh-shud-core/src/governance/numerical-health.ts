// Canonical thresholds: docs/03_SPEC/SHUD_Output_Variables.md §13.
export const NUMERICAL_HEALTH_THRESHOLDS = Object.freeze({
  water_balance_residual: Object.freeze({ pass_max: 0.01, warn_max: 0.05 }),
  cvode_failures: Object.freeze({ pass_max: 0, warn_max: null }),
  negative_state_count: Object.freeze({ pass_max: 0, warn_max: 10 }),
});

export type NumericalHealthMetric = keyof typeof NUMERICAL_HEALTH_THRESHOLDS;
export type NumericalHealthVerdict = "pass" | "warn" | "fail" | "not_available";

// Opaque provenance for metrics.json; not a configurable threshold policy.
export const METRICS_METHOD_VERSION = "1" as const;

export function classifyNumericalHealth(
  metric: NumericalHealthMetric,
  value: number | null,
): NumericalHealthVerdict {
  if (!Object.hasOwn(NUMERICAL_HEALTH_THRESHOLDS, metric)) {
    throw new Error("Unsupported numerical health metric");
  }
  if (value === null) return "not_available";
  const thresholds = NUMERICAL_HEALTH_THRESHOLDS[metric];
  if (value <= thresholds.pass_max) return "pass";
  if (thresholds.warn_max !== null && value <= thresholds.warn_max) return "warn";
  return "fail";
}
