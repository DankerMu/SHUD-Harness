import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { computeRunMetrics } from "./run-metrics.ts";
import {
  makeMetricsRun,
  metricFields,
  project,
  writeDat,
  writeRiver,
} from "./run-metrics-test-harness.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(`${tmpdir()}/run-metrics-flow-`));
  makeMetricsRun(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function flowRows(rows: readonly (readonly [number, number])[]): void {
  writeDat(root, "rivqdown", {
    columns: [1],
    rows: rows.map(([t_min, value]) => ({ t_min, values: [value] })),
  });
}

function expectFlow(peak: number | null, day: number | null, total: number | null) {
  const result = computeRunMetrics(root, project);
  expect(result.metrics.status).toBe("ok");
  expect(result.metrics.reason).toBeNull();
  expect(result.metrics.flow).toMatchObject({
    peak_flow_m3d: peak,
    peak_day: day,
    total_runoff_m3: total,
  });
  return result.metrics;
}

test("uses only the ccw-shaped outlet 1 by column ID and derives runoff from time, not DT keys", () => {
  const metrics = expectFlow(30, 2, 60);
  expect(metrics.outlets).toEqual([1]);
  expect(metrics.flow.reasons).toEqual({
    peak_flow_m3d: null,
    peak_day: null,
    total_runoff_m3: null,
  });
});

test("finite negative outlet flows are neither clamped nor replaced by a zero peak", () => {
  flowRows([
    [0, -10],
    [1440, -20],
  ]);
  expectFlow(-10, 0, -30);
});

test("sums all outlets with unordered reach IDs and differently ordered physical columns", () => {
  writeRiver(root, [
    [3, -1],
    [2, 3],
    [1, -3],
  ]);
  writeDat(root, "rivqdown", {
    columns: [3, 2, 1],
    rows: [
      { t_min: 0, values: [4, 900, 6] },
      { t_min: 1440, values: [7, 800, 13] },
      { t_min: 2880, values: [11, 700, 19] },
    ],
  });
  expect(expectFlow(30, 2, 60).outlets).toEqual([1, 3]);
});

describe("literal time-column interval and peak selection", () => {
  test.each([
    {
      name: "ascending tied rows",
      rows: [
        [1440, 20],
        [4320, 20],
      ],
      day: 1,
      total: 80,
    },
    {
      name: "descending tied rows",
      rows: [
        [4320, 20],
        [1440, 20],
      ],
      day: 1,
      total: -80,
    },
    {
      name: "zero equal interval",
      rows: [
        [1440, 10],
        [1440, 20],
      ],
      day: 1,
      total: 0,
    },
    {
      name: "half-day interval",
      rows: [
        [0, 10],
        [720, 20],
      ],
      day: 0.5,
      total: 15,
    },
  ])("$name", ({ rows, day, total }) => {
    flowRows(rows as [number, number][]);
    expectFlow(20, day, total);
  });

  test.each([
    { name: "single row", rows: [[1440, 30]], day: 1 },
    {
      name: "unequal intervals",
      rows: [
        [0, 10],
        [1440, 20],
        [4320, 30],
      ],
      day: 3,
    },
    {
      name: "tiny unequal intervals are not rounded equal",
      rows: [
        [0, 10],
        [1440, 20],
        [2880.000000001, 30],
      ],
      day: 2880.000000001 / 1440,
    },
  ])("$name preserves peaks but cannot supply runoff", ({ rows, day }) => {
    flowRows(rows as [number, number][]);
    expect(expectFlow(30, day, null).flow.reasons).toEqual({
      peak_flow_m3d: null,
      peak_day: null,
      total_runoff_m3: "interval_undetermined:rivqdown",
    });
  });

  test("an empty series is ok with three explicit empty-variable reasons", () => {
    flowRows([]);
    expect(expectFlow(null, null, null).flow.reasons).toEqual({
      peak_flow_m3d: "empty_variable:rivqdown",
      peak_day: "empty_variable:rivqdown",
      total_runoff_m3: "empty_variable:rivqdown",
    });
  });

  test.each([
    {
      name: "maximum NaN time last",
      rows: [
        [1440, 20],
        [NaN, 20],
      ],
      day: null,
    },
    {
      name: "maximum NaN time first",
      rows: [
        [NaN, 20],
        [1440, 20],
      ],
      day: null,
    },
    {
      name: "nonmaximum NaN time last",
      rows: [
        [1440, 20],
        [NaN, 10],
      ],
      day: 1,
    },
    {
      name: "nonmaximum NaN time first",
      rows: [
        [NaN, 10],
        [1440, 20],
      ],
      day: 1,
    },
    {
      name: "maximum infinite time",
      rows: [
        [Infinity, 20],
        [1440, 10],
      ],
      day: null,
    },
  ])("$name does not manufacture an earliest peak time", ({ rows, day }) => {
    flowRows(rows as [number, number][]);
    const metrics = expectFlow(20, day, null);
    expect(metrics.nonfinite_count).toBe(1);
    expect(metrics.flow.reasons).toEqual({
      peak_flow_m3d: null,
      peak_day: day === null ? "nonfinite:rivqdown" : null,
      total_runoff_m3: "interval_undetermined:rivqdown",
    });
  });
});

describe("nonfinite data and arithmetic overflow", () => {
  test.each([NaN, Infinity, -Infinity])(
    "nonfinite outlet %s nulls all dependent flow values",
    (value) => {
      flowRows([
        [0, 10],
        [1440, value],
      ]);
      const metrics = expectFlow(null, null, null);
      expect(metrics.nonfinite_count).toBe(1);
      expect(Object.values(metrics.flow.reasons)).toEqual(Array(3).fill("nonfinite:rivqdown"));
    },
  );

  test("counts nonfinite date and non-outlet cells without letting them corrupt flow", () => {
    writeDat(root, "rivqdown", {
      start_date: NaN,
      columns: [2, 1],
      rows: [
        { t_min: 0, values: [Infinity, 10] },
        { t_min: 1440, values: [NaN, 20] },
        { t_min: 2880, values: [-Infinity, 30] },
      ],
    });
    expect(expectFlow(30, 2, 60).nonfinite_count).toBe(4);
  });

  test("finite outlet-sum overflow is not counted as an observed nonfinite cell", () => {
    writeRiver(root, [
      [1, -3],
      [2, -1],
    ]);
    writeDat(root, "rivqdown", {
      columns: [2, 1],
      rows: [{ t_min: 0, values: [Number.MAX_VALUE, Number.MAX_VALUE] }],
    });
    const metrics = expectFlow(null, null, null);
    expect(metrics.nonfinite_count).toBe(0);
    expect(Object.values(metrics.flow.reasons)).toEqual(Array(3).fill("nonfinite:rivqdown"));
  });

  test("runoff overflow keeps finite peaks and gives an explicit runoff reason", () => {
    flowRows([
      [0, 1e308],
      [1440, 1e308],
    ]);
    const metrics = expectFlow(1e308, 0, null);
    expect(metrics.nonfinite_count).toBe(0);
    expect(metrics.flow.reasons).toEqual({
      peak_flow_m3d: null,
      peak_day: null,
      total_runoff_m3: "nonfinite:rivqdown",
    });
  });

  test("finite times whose subtraction overflows cannot supply an interval", () => {
    flowRows([
      [-Number.MAX_VALUE, 10],
      [Number.MAX_VALUE, 20],
    ]);
    expect(expectFlow(20, Number.MAX_VALUE / 1440, null).flow.reasons.total_runoff_m3).toBe(
      "interval_undetermined:rivqdown",
    );
  });
});

function expectUnavailableValues(
  blocks: readonly { reasons: object }[],
  health: unknown,
  verdicts: unknown,
): void {
  for (const [index, block] of blocks.entries()) {
    const fields = Object.values(metricFields)[index];
    expect(Object.keys(block.reasons).sort()).toEqual([...fields].sort());
    for (const key of fields) {
      const reason = (block.reasons as Record<string, unknown>)[key];
      expect((block as unknown as Record<string, unknown>)[key]).toBeNull();
      expect(reason).toEqual(expect.any(String));
      expect(reason).not.toBe("");
    }
  }
  expect(health).toEqual({
    water_balance_residual: null,
    cvode_failures: null,
    negative_state_count: null,
    max_solver_dt: null,
  });
  expect(verdicts).toEqual({
    water_balance_residual: "not_available",
    cvode_failures: "not_available",
    negative_state_count: "not_available",
  });
}

test.each([
  { name: "missing required outlet", columns: [2], values: [10] },
  { name: "duplicate required outlet", columns: [1, 1], values: [10, 20] },
])("$name is unavailable rather than guessed or zero-filled", ({ columns, values }) => {
  writeDat(root, "rivqdown", { columns, rows: [{ t_min: 0, values }] });
  const result = computeRunMetrics(root, project);
  expect(result.metrics.status).toBe("unavailable");
  expect(result.metrics.reason).toContain("rivqdown");
  if (!("reason" in result)) throw new Error("Expected a controlled unavailable reason");
  expect(result.reason).toContain("rivqdown");
  expectUnavailableValues(
    [result.metrics.flow, result.metrics.water_balance, result.metrics.numerical_health],
    result.health,
    result.metrics.verdicts,
  );
});

test("duplicate non-outlet IDs remain reader-neutral and do not change the outlet sum", () => {
  writeDat(root, "rivqdown", {
    columns: [2, 2, 1],
    rows: [{ t_min: 1440, values: [100, 200, 30] }],
  });
  expectFlow(30, 1, null);
});

test.each([
  {
    name: "empty outlet set",
    reaches: [
      [1, 2],
      [2, 0],
    ],
    reason: /empty.*outlet|outlet.*empty/u,
  },
  {
    name: "duplicate outlet identity",
    reaches: [
      [1, -3],
      [1, -1],
    ],
    reason: /sp\.riv/u,
  },
  { name: "fractional outlet identity", reaches: [[1.5, -3]], reason: /sp\.riv/u },
  { name: "nonfinite outlet identity", reaches: [[NaN, -3]], reason: /sp\.riv/u },
])("$name returns controlled unavailable", ({ reaches, reason }) => {
  writeRiver(root, reaches as [number, number][]);
  const result = computeRunMetrics(root, project);
  expect(result.metrics.status).toBe("unavailable");
  expect(result.metrics.reason).toMatch(reason);
  expectUnavailableValues(
    [result.metrics.flow, result.metrics.water_balance, result.metrics.numerical_health],
    result.health,
    result.metrics.verdicts,
  );
});
