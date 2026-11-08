import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { computeRunMetrics } from "./run-metrics.ts";
import { buildShudDat } from "./shud-dat-test-harness.ts";
import {
  sharedWaterFields,
  waterBalanceDatInputs,
  waterBalanceFixture,
  waterBalanceProject,
} from "./water-balance-test-harness.ts";

test("committed wb-mini binaries equal the canonical dataset bytes without rewriting them", () => {
  for (const { path, input } of waterBalanceDatInputs) {
    expect(readFileSync(join(waterBalanceFixture, path)), path).toEqual(buildShudDat(input));
  }
});

test("seven shared water-balance terms match the frozen rSHUD reference", () => {
  const expected = JSON.parse(
    readFileSync(join(waterBalanceFixture, "expected-rshud.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(Object.keys(expected)).toEqual([...sharedWaterFields]);
  const { metrics } = computeRunMetrics(waterBalanceFixture, waterBalanceProject);
  expect(metrics.status, metrics.reason ?? "fixture must be readable").toBe("ok");
  for (const field of sharedWaterFields) {
    const reference = expected[field];
    const actual = metrics.water_balance[field];
    expect(typeof reference, `${field}: numeric rSHUD reference`).toBe("number");
    expect(Number.isFinite(reference), `${field}: finite rSHUD reference`).toBe(true);
    expect.soft(actual, `${field}: computed shared term`).not.toBeNull();
    expect.soft(Number.isFinite(actual), `${field}: finite computed shared term`).toBe(true);
    if (typeof reference !== "number" || actual === null) continue;
    if (reference === 0) {
      expect.soft(actual, `${field}: exact zero reference`).toBe(0);
    } else {
      expect
        .soft(Math.abs(actual - reference) / Math.abs(reference), `${field}: relative error`)
        .toBeLessThanOrEqual(1e-12);
    }
  }
});

test("Qd needs only outlet columns and preserves all seven shared terms", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "water-balance-outlet-")));
  try {
    cpSync(waterBalanceFixture, root, { recursive: true });
    const baseline = computeRunMetrics(root, waterBalanceProject).metrics;
    const expected = JSON.parse(readFileSync(join(root, "expected-rshud.json"), "utf8")) as Record<
      (typeof sharedWaterFields)[number],
      number
    >;
    const discharge = waterBalanceDatInputs.find(({ path }) => path.endsWith(".rivqdown.dat"));
    if (discharge === undefined) throw new Error("Canonical fixture must define rivqdown");
    const outletColumn = discharge.input.columns.indexOf(1);
    expect(outletColumn).toBeGreaterThanOrEqual(0);
    writeFileSync(
      join(root, discharge.path),
      buildShudDat({
        ...discharge.input,
        columns: [1],
        rows: discharge.input.rows.map(({ t_min, values }) => ({
          t_min,
          values: [values[outletColumn]],
        })),
      }),
    );
    const { metrics } = computeRunMetrics(root, waterBalanceProject);
    expect(metrics.status, metrics.reason ?? "outlet-only discharge is complete for Qd").toBe("ok");
    expect(metrics.flow.total_runoff_m3).toBe(baseline.flow.total_runoff_m3);
    for (const field of sharedWaterFields) {
      const actual = metrics.water_balance[field];
      const reference = expected[field];
      expect.soft(actual, `${field}: outlet-only discharge retains the shared term`).not.toBeNull();
      expect.soft(Number.isFinite(actual), `${field}: finite shared term`).toBe(true);
      if (actual === null) continue;
      const error = reference === 0 ? Math.abs(actual) : Math.abs((actual - reference) / reference);
      expect
        .soft(error, `${field}: frozen reference error`)
        .toBeLessThanOrEqual(reference === 0 ? 0 : 1e-12);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
