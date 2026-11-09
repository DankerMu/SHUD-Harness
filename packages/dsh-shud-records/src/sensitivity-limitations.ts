import {
  instantiateSensitivityCoverage,
  REPORT_LIMITATION_TEMPLATES,
} from "@shud-harness/dsh-shud-core";
import type { SensitivitySummary } from "./sensitivity-summary-types.ts";

type CoveragePlan = Parameters<typeof instantiateSensitivityCoverage>[0];

/** Kinds 1/2 precede, kind 5 follows the caller's non-sensitivity kinds 3/4. */
export interface SensitivityLimitations {
  readonly leading: readonly [coverage: string, parameterRange: string];
  readonly trailing: readonly string[];
}

/**
 * Deterministic sensitivity limitations; all wording comes from core constants. Coverage is
 * instantiated by core from the plan when supplied, else from the companion's project,
 * end_days and row key/multiplier view of the same plan. Failed cells follow rows order.
 */
export function deriveSensitivityLimitations(
  summary: SensitivitySummary,
  plan: CoveragePlan = {
    project: summary.project,
    end_days: summary.end_days,
    parameter_sets: summary.rows.map((row) => ({
      baseline: row.baseline,
      changes: row.key === null ? {} : { [row.key]: row.multiplier! },
    })),
  },
): SensitivityLimitations {
  const trailing = summary.rows
    .filter((row) => row.status === "failed")
    .map((row) =>
      REPORT_LIMITATION_TEMPLATES.failed_cell.replace(
        /<parameter_set_id>|<run_id>|<exit_code>|<exit_class>/gu,
        (placeholder) =>
          placeholder === "<parameter_set_id>"
            ? row.parameter_set_id
            : placeholder === "<run_id>"
              ? row.run_id
              : placeholder === "<exit_code>"
                ? JSON.stringify(row.exit_code)
                : row.exit_class,
      ),
    );
  return {
    leading: [instantiateSensitivityCoverage(plan), REPORT_LIMITATION_TEMPLATES.parameter_range],
    trailing,
  };
}
