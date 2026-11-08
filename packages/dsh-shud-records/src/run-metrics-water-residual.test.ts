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
import { computeRunMetrics, type RunMetrics } from "./index.ts";
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

function expectPrecedenceFailure(
  components: readonly (keyof RunMetrics["water_balance"]["reasons"])[],
  reason: string,
  nonfiniteCount = 0,
  storageReason = reason,
) {
  const metrics = computeBudget();
  for (const field of [...components, "residual"] as const) {
    expect.soft(metrics.water_balance[field], `${field}: no partial value`).toBeNull();
    expect.soft(metrics.water_balance.reasons[field], `${field}: selected cause`).toBe(reason);
  }
  expect.soft(metrics.water_balance.delta_s, "delta_s: no partial sum").toBeNull();
  expect.soft(metrics.water_balance.reasons.delta_s, "delta_s: selected cause").toBe(storageReason);
  expect.soft(metrics.numerical_health.reasons.water_balance_residual).toBe(reason);
  expect(metrics.verdicts.water_balance_residual).toBe("not_available");
  expect(metrics.nonfinite_count).toBe(nonfiniteCount);
  expect(metrics.flow).toMatchObject({ peak_flow_m3d: 16.5, peak_day: 0, total_runoff_m3: 33 });
  return metrics;
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

test("combined precedence: incomplete Stage columns outrank river IC shape mismatch", () => {
  replaceInput("cfg.ic", "2\t2\nIndex\tStage\n", "1\t2\nIndex\tStage\n");
  replaceInput("cfg.ic", "2\t0.4\n", "");
  writeClosedBudgetDat(root, "rivystage", {
    columns: [1],
    rows: [
      { t_min: 0, values: [0.2] },
      { t_min: 1440, values: [0.2] },
    ],
  });
  const metrics = expectPrecedenceFailure(
    ["delta_s_riv"],
    `unreadable_input:${waterBalanceOutputPath("rivystage")}`,
  );
  expectFinite(metrics.water_balance.delta_s_snow, 0.004, "delta_s_snow");
  expectFinite(metrics.water_balance.P, 0.1, "P");
});

test("combined precedence: incomplete precipitation columns outrank nonfinite geometry", () => {
  replaceInput("sp.mesh", "1\t0\t0\t10\t100", "1\tNaN\t0\t10\t100");
  writeClosedBudgetDat(root, "elevprcp", {
    columns: [1, 2],
    rows: [
      { t_min: 0, values: [0.05, 0.05] },
      { t_min: 1440, values: [0.05, 0.05] },
    ],
  });
  const geometryReason = `nonfinite:${waterBalanceInputPath("sp.mesh")}`;
  const metrics = expectPrecedenceFailure(
    ["P"],
    `unreadable_input:${waterBalanceOutputPath("elevprcp")}`,
    0,
    geometryReason,
  );
  for (const field of ["Qd", "AET", "delta_s_snow"] as const) {
    expect(metrics.water_balance[field]).toBeNull();
    expect(metrics.water_balance.reasons[field]).toBe(geometryReason);
  }
});

test.each(["empty", "nonfinite"])(
  "combined precedence: invalid river Type outranks %s Stage",
  (state) => {
    replaceInput("sp.riv", "2\t1\t2\t0.02\t50\t0", "2\t1\t9\t0.02\t50\t0");
    writeClosedBudgetDat(root, "rivystage", {
      rows: state === "empty" ? [] : [{ t_min: 0, values: [NaN, 0.4] }],
    });
    const metrics = expectPrecedenceFailure(
      ["delta_s_riv"],
      `unreadable_input:${waterBalanceInputPath("sp.riv")}`,
      state === "empty" ? 0 : 1,
    );
    expect(metrics.numerical_health.negative_state_count).toBe(state === "empty" ? 0 : null);
    expect(metrics.numerical_health.reasons.negative_state_count).toBe(
      state === "empty" ? null : "nonfinite:rivystage",
    );
    expectFinite(metrics.water_balance.delta_s_snow, 0.004, "delta_s_snow");
    expectFinite(metrics.water_balance.P, 0.1, "P");
  },
);

test("combined precedence: later invalid node reference outranks earlier nonfinite geometry", () => {
  replaceInput("sp.mesh", "1\t0\t0\t10\t100", "1\tNaN\t0\t10\t100");
  replaceInput("sp.mesh", "2\t2\t4\t3\t3\t1\t0\t101", "2\t99\t4\t3\t3\t1\t0\t101");
  expectPrecedenceFailure(
    [
      "P",
      "Qd",
      "AET",
      "delta_s_surf",
      "delta_s_us",
      "delta_s_gw",
      "delta_s_riv",
      "delta_s_snow",
      "delta_s_ic",
    ],
    `unreadable_input:${waterBalanceInputPath("sp.mesh")}`,
  );
});

test("combined precedence: later invalid GEOL reference outranks earlier nonfinite reference", () => {
  replaceInput("sp.att", "1\t1\t1\t1\t1\t1\t0\t0\t0", "1\t1\tNaN\t1\t1\t1\t0\t0\t0");
  replaceInput("sp.att", "2\t1\t2\t1\t1\t1\t0\t0\t0", "2\t1\t9\t1\t1\t1\t0\t0\t0");
  const metrics = expectPrecedenceFailure(
    ["delta_s_us", "delta_s_gw"],
    `unreadable_input:${waterBalanceInputPath("sp.att")}`,
  );
  expectFinite(metrics.water_balance.delta_s_snow, 0.004, "delta_s_snow");
  expectFinite(metrics.water_balance.delta_s_riv, 0, "delta_s_riv");
});

test("combined precedence: later invalid river Type outranks earlier nonfinite Length", () => {
  replaceInput("sp.riv", "1\t-3\t1\t0.01\t30\t0", "1\t-3\t1\t0.01\tNaN\t0");
  replaceInput("sp.riv", "2\t1\t2\t0.02\t50\t0", "2\t1\t9\t0.02\t50\t0");
  const metrics = expectPrecedenceFailure(
    ["delta_s_riv"],
    `unreadable_input:${waterBalanceInputPath("sp.riv")}`,
  );
  expectFinite(metrics.water_balance.delta_s_snow, 0.004, "delta_s_snow");
  expectFinite(metrics.water_balance.Qd, 0.03, "Qd");
});

test("combined precedence: invalid GEOL reference outranks missing calibration key", () => {
  replaceInput("cfg.calib", "GEOL_THETAS\t1.6\n", "");
  replaceInput("sp.att", "2\t1\t2\t1\t1\t1\t0\t0\t0", "2\t1\t9\t1\t1\t1\t0\t0\t0");
  const metrics = expectPrecedenceFailure(
    ["delta_s_us", "delta_s_gw"],
    `unreadable_input:${waterBalanceInputPath("sp.att")}`,
  );
  expectFinite(metrics.water_balance.delta_s_snow, 0.004, "delta_s_snow");
  expectFinite(metrics.water_balance.delta_s_surf, 0, "delta_s_surf");
});
