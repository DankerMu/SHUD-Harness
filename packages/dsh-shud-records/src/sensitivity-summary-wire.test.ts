import { expect, test } from "vitest";
import {
  parseSensitivitySummary,
  serializeSensitivitySummary,
  SensitivitySummaryError,
  type SensitivitySummary,
} from "./index.ts";
import { EXPECTED_SUMMARY_BYTES } from "./sensitivity-summary-test-harness.ts";

function oracle(): SensitivitySummary {
  return JSON.parse(EXPECTED_SUMMARY_BYTES) as SensitivitySummary;
}

const mutations: [string, (value: SensitivitySummary) => void][] = [
  ["unknown top field", (value) => Object.assign(value, { ranking: [] })],
  ["unknown row field", (value) => Object.assign(value.rows[0], { elasticity: 1 })],
  [
    "missing metric reason",
    (value) => {
      Reflect.deleteProperty(value.rows[0].metric_reasons, "peak_day");
    },
  ],
  [
    "extra delta reason",
    (value) => Object.assign(value.rows[0].delta_reasons, { peak_day: "baseline_row" }),
  ],
  ["wrong method", (value) => Object.assign(value, { method_version: "future" })],
  [
    "bad plan digest",
    (value) => {
      value.plan_sha256 = "xyz";
    },
  ],
  [
    "bad metrics digest",
    (value) => {
      value.inputs[0].metrics_sha256 = "A".repeat(64);
    },
  ],
  [
    "foreign pset",
    (value) => {
      value.rows[1].parameter_set_id = "PSET-5";
    },
  ],
  [
    "duplicate job",
    (value) => {
      value.rows[1].job_id = value.rows[0].job_id;
    },
  ],
  [
    "duplicate run",
    (value) => {
      value.superseded_runs[0].run_id = value.rows[0].run_id;
    },
  ],
  [
    "misordered inputs",
    (value) => {
      value.inputs.reverse();
    },
  ],
  [
    "failed input included",
    (value) => {
      value.inputs.push({ run_id: value.rows[2].run_id, metrics_sha256: "a".repeat(64) });
    },
  ],
  [
    "nonfinite metric",
    (value) => {
      value.rows[1].peak_day = Infinity;
    },
  ],
  [
    "nonfinite delta",
    (value) => {
      value.rows[1].delta_peak_day = NaN;
    },
  ],
  [
    "numeric metric with reason",
    (value) => {
      value.rows[1].metric_reasons.peak_day = "missing_output";
    },
  ],
  [
    "null metric without reason",
    (value) => {
      value.rows[1].peak_day = null;
    },
  ],
  [
    "baseline delta computed",
    (value) => {
      value.rows[0].delta_peak_day = 0;
    },
  ],
  [
    "day zero-baseline reason",
    (value) => {
      value.rows[1].delta_peak_day = null;
      value.rows[1].delta_reasons.delta_peak_day = "zero_baseline";
    },
  ],
  [
    "missing zero-baseline reason",
    (value) => {
      value.rows[1].delta_reasons.delta_total_runoff_pct = null;
    },
  ],
  [
    "failed metric-null reason",
    (value) => {
      value.rows[2].delta_reasons.delta_peak_day = "metric_null";
    },
  ],
  [
    "failed verdict",
    (value) => {
      value.rows[2].water_balance_residual_verdict = "not_available";
    },
  ],
  [
    "failed metric populated",
    (value) => {
      value.rows[2].peak_day = 0;
    },
  ],
  [
    "baseline missing",
    (value) => {
      value.rows[0].baseline = false;
    },
  ],
  [
    "superseded foreign pset",
    (value) => {
      value.superseded_runs[0].parameter_set_id = "PSET-5";
    },
  ],
  [
    "collected without record class",
    (value) => {
      value.superseded_runs[0].exit_class = null;
    },
  ],
];

test.each(mutations)("strict summary wire rejects %s with a controlled error", (_name, mutate) => {
  const value = oracle();
  mutate(value);
  expect(() => parseSensitivitySummary(value)).toThrow(SensitivitySummaryError);
  expect(() => serializeSensitivitySummary(value)).toThrow(SensitivitySummaryError);
});

test("serialization restores the frozen field order without mutating shuffled objects", () => {
  const reverse = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reverse);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, entry]) => [key, reverse(entry)]),
      );
    }
    return value;
  };
  const value = reverse(oracle()) as SensitivitySummary;
  const before = JSON.stringify(value);
  expect(serializeSensitivitySummary(value)).toBe(EXPECTED_SUMMARY_BYTES);
  expect(JSON.stringify(value)).toBe(before);
});

test("wire consumption does not recompute stored finite deltas or classify verdicts", () => {
  const value = oracle();
  value.rows[1].delta_peak_day = 9;
  value.rows[1].water_balance_residual_verdict = "warn";
  expect(parseSensitivitySummary(value)).toMatchObject({
    rows: [{}, { delta_peak_day: 9, water_balance_residual_verdict: "warn" }, {}],
  });
});

test("native serialization canonicalizes signed zero without inventing a reason", () => {
  const value = oracle();
  value.rows[1].delta_peak_day = -0;
  expect(serializeSensitivitySummary(value)).toContain('"delta_peak_day":0,');
  expect(value.rows[1].delta_reasons.delta_peak_day).toBeNull();
});
