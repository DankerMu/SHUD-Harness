import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { computeRunMetrics } from "./index.ts";
import {
  makeClosedBudgetRun,
  waterBalanceInputPath,
  waterBalanceOutputPath,
  waterBalanceProject,
  writeClosedBudgetDat,
} from "./water-balance-test-harness.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "water-balance-residual-")));
  makeClosedBudgetRun(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function computeBudget() {
  const { metrics, health } = computeRunMetrics(root, waterBalanceProject);
  expect(metrics.status, metrics.reason ?? "budget inputs must be readable").toBe("ok");
  expect(metrics.reason).toBeNull();
  expect(metrics.numerical_health.water_balance_residual).toBe(metrics.water_balance.residual);
  expect(metrics.numerical_health.reasons.water_balance_residual).toBe(
    metrics.water_balance.reasons.residual,
  );
  expect(health.water_balance_residual).toBe(metrics.water_balance.residual);
  return metrics;
}

function expectResidualFailure(reason: string) {
  const metrics = computeBudget();
  expect(metrics.water_balance.residual).toBeNull();
  expect(metrics.water_balance.reasons.residual).toBe(reason);
  expect(metrics.verdicts.water_balance_residual).toBe("not_available");
  expect(metrics.flow).toMatchObject({ peak_flow_m3d: 16.5, peak_day: 0, total_runoff_m3: 33 });
  return metrics;
}

function replaceInput(kind: string, before: string, after: string): void {
  const path = join(root, waterBalanceInputPath(kind));
  const text = readFileSync(path, "utf8");
  expect(text, `${kind}: authored mutation matches input`).toContain(before);
  writeFileSync(path, text.replace(before, after));
}

function expectFinite(actual: number | null, expected: number, field: string): void {
  expect.soft(Number.isFinite(actual), `${field}: finite hand budget term`).toBe(true);
  expect.soft(actual, `${field}: hand budget ${expected}`).toBeCloseTo(expected, 12);
}

test("closed budget includes snow and canopy changes from nonzero initial storage", () => {
  const metrics = computeBudget();
  // Retained areas 200/300/600 m² and nonzero IC; two daily intervals.
  // Actual scale=1, unweighted registrations: Δsnow=.004, Δcanopy=.005.
  // Independent hand budget: |0.100 - 0.030 - 0.060 - 0.009| / 0.100 = 0.01.
  for (const [field, expected] of [
    ["P", 0.1],
    ["Qd", 0.03],
    ["AET", 0.06],
    ["delta_s_surf", 0],
    ["delta_s_us", 0],
    ["delta_s_gw", 0],
    ["delta_s_riv", 0],
    ["delta_s_snow", 0.004],
    ["delta_s_ic", 0.005],
    ["delta_s", 0.009],
    ["residual", 0.01],
  ] as const) {
    expectFinite(metrics.water_balance[field], expected, field);
    expect.soft(metrics.water_balance.reasons[field], field).toBeNull();
  }
  // Do not pin the verdict at 0.01: the unrounded floating result may straddle it.
});

test.each([
  { snow: 0.004, canopy: 0.0055, total: 0.0095, residual: 0.005, verdict: "pass" },
  { snow: 0.004, canopy: 0.004, total: 0.008, residual: 0.02, verdict: "warn" },
  { snow: 0, canopy: 0, total: 0, residual: 0.1, verdict: "fail" },
])("storage delta $total gives residual $residual and verdict $verdict", (budget) => {
  for (const [variable, initial, increment] of [
    ["eleysnow", [0.002, 0.003, 0.004], budget.snow],
    ["eleyic", [0.001, 0.002, 0.003], budget.canopy],
  ] as const) {
    writeClosedBudgetDat(root, variable, {
      rows: [
        { t_min: 0, values: initial },
        { t_min: 1440, values: initial.map((value) => value + increment) },
      ],
    });
  }
  const metrics = computeBudget();
  expectFinite(metrics.water_balance.delta_s_snow, budget.snow, "delta_s_snow");
  expectFinite(metrics.water_balance.delta_s_ic, budget.canopy, "delta_s_ic");
  expectFinite(metrics.water_balance.delta_s, budget.total, "delta_s");
  expectFinite(metrics.water_balance.residual, budget.residual, "residual");
  expect(metrics.water_balance.residual).not.toBeCloseTo(0.01, 12);
  expect(metrics.verdicts.water_balance_residual).toBe(budget.verdict);
});

test.each([0, -0.05])("P rate %s preserves flow with a null residual", (rate) => {
  writeClosedBudgetDat(root, "elevprcp", {
    rows: [0, 1440].map((t_min) => ({ t_min, values: [rate, rate, rate] })),
  });
  const metrics = expectResidualFailure("zero_precipitation");
  expectFinite(metrics.water_balance.P, rate === 0 ? 0 : -0.1, "P");
  expectFinite(metrics.water_balance.delta_s, 0.009, "delta_s");
  expect(metrics.water_balance.reasons.P).toBeNull();
});

test.each([
  { missing: ["eleyic"], first: "eleyic", negative: 0 },
  { missing: ["eleysnow", "eleyic"], first: "eleyic", negative: 0 },
  {
    missing: ["rivystage", "eleyunsat", "eleysurf", "eleysnow", "eleyic", "eleygw"],
    first: "eleygw",
    negative: null,
  },
  {
    missing: ["eleysnow", "eleyic", "elevprcp", "eleveta"],
    first: "eleveta",
    negative: 0,
  },
])("missing $missing selects $first by code point", ({ missing, first, negative }) => {
  for (const variable of missing) unlinkSync(join(root, waterBalanceOutputPath(variable)));
  const metrics = expectResidualFailure(`missing_variable:${first}`);
  expect(metrics.numerical_health.negative_state_count).toBe(negative);
  expect(metrics.numerical_health.reasons.negative_state_count).toBe(
    negative === null ? "missing_variable:eleygw" : null,
  );
  for (const variable of missing) {
    expect(metrics.inputs.map(({ path }) => path)).not.toContain(waterBalanceOutputPath(variable));
  }
  if (missing.includes("eleysnow")) {
    expect(metrics.water_balance.delta_s_snow).toBeNull();
    expect(metrics.water_balance.reasons.delta_s_snow).toBe("missing_variable:eleysnow");
  } else {
    expectFinite(metrics.water_balance.delta_s_snow, 0.004, "delta_s_snow");
  }
});

test("missing GEOL_THETAS reaches the residual without defaulting porosity", () => {
  replaceInput("cfg.calib", "GEOL_THETAS\t1.6\n", "");
  const metrics = expectResidualFailure("missing_calib:GEOL_THETAS");
  expect(metrics.water_balance.delta_s_us).toBeNull();
  expect(metrics.water_balance.delta_s_gw).toBeNull();
  expectFinite(metrics.water_balance.delta_s_snow, 0.004, "delta_s_snow");
  expectFinite(metrics.water_balance.delta_s_ic, 0.005, "delta_s_ic");
});

test.each(["elements", "rivers"])("%s IC shape mismatch reaches the residual", (table) => {
  if (table === "elements") {
    replaceInput("cfg.ic", "3\t6\t0\n", "2\t6\t0\n");
    replaceInput("cfg.ic", "3\t0.003\t0.004\t0.03\t0.9\t1.5\n", "");
  } else {
    replaceInput("cfg.ic", "2\t2\nIndex\tStage\n", "1\t2\nIndex\tStage\n");
    replaceInput("cfg.ic", "2\t0.4\n", "");
  }
  const metrics = expectResidualFailure("ic_shape_mismatch");
  if (table === "elements") expectFinite(metrics.water_balance.delta_s_riv, 0, "delta_s_riv");
  else expectFinite(metrics.water_balance.delta_s_snow, 0.004, "delta_s_snow");
});

test("nonoutlet NaN is counted once without poisoning the complete residual", () => {
  writeClosedBudgetDat(root, "rivqdown", {
    rows: [
      { t_min: 0, values: [16.5, NaN] },
      { t_min: 1440, values: [16.5, 11] },
    ],
  });
  const metrics = computeBudget();
  expect(metrics.nonfinite_count).toBe(1);
  expectFinite(metrics.water_balance.Qd, 0.03, "Qd");
  expectFinite(metrics.water_balance.residual, 0.01, "residual");
  expect(metrics.water_balance.reasons.residual).toBeNull();
});

test("canopy NaN is counted once but does not enter the four-state negative count", () => {
  writeClosedBudgetDat(root, "eleyic", {
    rows: [
      { t_min: 0, values: [0.001, 0.002, 0.003] },
      { t_min: 1440, values: [NaN, 0.007, 0.008] },
    ],
  });
  const metrics = expectResidualFailure("nonfinite:eleyic");
  expect(metrics.nonfinite_count).toBe(1);
  expect(metrics.numerical_health.negative_state_count).toBe(0);
  expect(metrics.numerical_health.reasons.negative_state_count).toBeNull();
  expectFinite(metrics.water_balance.delta_s_snow, 0.004, "delta_s_snow");
});

test("Snow IC NaN invalidates snow but not surface or canopy storage", () => {
  replaceInput("cfg.ic", "1\t0.001\t0.002\t0.01", "1\t0.001\tNaN\t0.01");
  const metrics = expectResidualFailure(`nonfinite:${waterBalanceInputPath("cfg.ic")}`);
  expect(metrics.water_balance.delta_s_snow).toBeNull();
  expectFinite(metrics.water_balance.delta_s_surf, 0, "delta_s_surf");
  expectFinite(metrics.water_balance.delta_s_ic, 0.005, "delta_s_ic");
});

test("unused metadata cells do not poison the consumed budget dependencies", () => {
  replaceInput("sp.att", "1\t1\t1\t1\t1\t1\t0\t0\t0", "1\tNaN\t1\t1\t1\t1\t0\t0\t0");
  replaceInput("para.geol", "1\t1.5\t0.25\t0.25", "1\tNaN\t0.25\t0.25");
  const metrics = computeBudget();
  expectFinite(metrics.water_balance.delta_s_us, 0, "delta_s_us");
  expectFinite(metrics.water_balance.delta_s_gw, 0, "delta_s_gw");
  expectFinite(metrics.water_balance.residual, 0.01, "residual");
});

test.each([
  { stage: "storage subtraction", reason: "nonfinite:eleysnow" },
  { stage: "storage total", reason: "nonfinite:delta_s" },
  { stage: "residual normalization", reason: "nonfinite:residual" },
  { stage: "precipitation sum", reason: "nonfinite:elevprcp" },
])("overflow in $stage yields $reason without raw nonfinites", ({ stage, reason }) => {
  if (stage === "storage subtraction") {
    replaceInput("cfg.ic", "1\t0.001\t0.002\t0.01", "1\t0.001\t-1.7976931348623157e308\t0.01");
    writeClosedBudgetDat(root, "eleysnow", {
      rows: [{ t_min: 0, values: [Number.MAX_VALUE, 0.007, 0.008] }],
    });
  } else if (stage === "storage total") {
    for (const variable of ["eleysnow", "eleyic"] as const) {
      writeClosedBudgetDat(root, variable, {
        rows: [{ t_min: 0, values: [1e308, 1e308, 1e308] }],
      });
    }
  } else if (stage === "residual normalization") {
    writeClosedBudgetDat(root, "eleysnow", {
      rows: [{ t_min: 0, values: [-1e308, -1e308, -1e308] }],
    });
  } else {
    writeClosedBudgetDat(root, "elevprcp", {
      rows: [0, 1440].map((t_min) => ({
        t_min,
        values: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
      })),
    });
  }
  const metrics = expectResidualFailure(reason);
  expect(metrics.nonfinite_count).toBe(0);
  expect(metrics.numerical_health.negative_state_count).toBe(0);
  if (stage === "storage total") {
    expect(Number.isFinite(metrics.water_balance.delta_s_snow)).toBe(true);
    expect(Number.isFinite(metrics.water_balance.delta_s_ic)).toBe(true);
  }
  if (stage === "residual normalization") {
    expect(Number.isFinite(metrics.water_balance.delta_s)).toBe(true);
    expect(metrics.water_balance.reasons.delta_s).toBeNull();
  }
});

test("undetermined precipitation interval propagates while storage remains available", () => {
  writeClosedBudgetDat(root, "elevprcp", { rows: [{ t_min: 0, values: [0.05, 0.05, 0.05] }] });
  const metrics = expectResidualFailure("interval_undetermined:elevprcp");
  expectFinite(metrics.water_balance.delta_s, 0.009, "delta_s");
});

test("empty canopy output is not treated as zero storage", () => {
  writeClosedBudgetDat(root, "eleyic", { rows: [] });
  const metrics = expectResidualFailure("empty_variable:eleyic");
  expect(metrics.water_balance.delta_s_ic).toBeNull();
  expectFinite(metrics.water_balance.delta_s_snow, 0.004, "delta_s_snow");
});
