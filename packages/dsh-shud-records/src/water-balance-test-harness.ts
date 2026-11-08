import { chmodSync, cpSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildShudDat } from "./shud-dat-test-harness.ts";

export const waterBalanceFixture = fileURLToPath(
  new URL("../test/fixtures/wb-mini/", import.meta.url),
);
export const waterBalanceProject = "wbmini";
export const sharedWaterFields = [
  "P",
  "Qd",
  "AET",
  "delta_s_surf",
  "delta_s_us",
  "delta_s_gw",
  "delta_s_riv",
] as const;

// Independent synthetic observations, not metric expectations. Repeat six four-day
// weather/storage cycles: 24 interval-start rows, each representing exactly one day.
// PET is independently authored because wb.all consumes it even though it is not scored.
const observations = {
  elevprcp: [
    [0.002, 0.004, 0.007],
    [0.008, 0.001, 0.003],
    [0.005, 0.009, 0.002],
    [0.001, 0.003, 0.006],
  ],
  eleveta: [
    [0.001, 0.002, 0.003],
    [0.002, 0.001, 0.004],
    [0.003, 0.002, 0.001],
    [0.001, 0.003, 0.002],
  ],
  elevetp: [
    [0.004, 0.006, 0.008],
    [0.007, 0.005, 0.009],
    [0.006, 0.008, 0.005],
    [0.005, 0.007, 0.006],
  ],
  rivqdown: [
    [2, 7],
    [5, 11],
    [3, 8],
    [4, 9],
  ],
  eleysurf: [
    [0.015, 0.018, 0.035],
    [0.025, 0.014, 0.045],
    [0.018, 0.012, 0.04],
    [0.02, 0.01, 0.05],
  ],
  eleyunsat: [
    [0.45, 0.65, 0.95],
    [0.5, 0.6, 1],
    [0.55, 0.55, 1.05],
    [0.6, 0.5, 1.1],
  ],
  eleygw: [
    [0.75, 1.25, 1.4],
    [0.7, 1.3, 1.3],
    [0.65, 1.35, 1.2],
    [0.6, 1.4, 1.1],
  ],
  rivystage: [
    [0.225, 0.375],
    [0.25, 0.325],
    [0.275, 0.3],
    [0.3, 0.25],
  ],
} as const;

// Canonical inputs to the existing sole writer. Materialize once outside tests;
// tests only compare disk bytes with buildShudDat(input), never rewrite fixtures.
// Ascending column IDs are required by rSHUD's positional joins.
export const waterBalanceDatInputs = Object.entries(observations).map(([variable, cycle]) => ({
  path: `output/${waterBalanceProject}.out/${waterBalanceProject}.${variable}.dat`,
  input: {
    start_date: 20000101,
    columns: Array.from({ length: cycle[0].length }, (_, index) => index + 1),
    rows: Array.from({ length: 24 }, (_, day) => ({
      t_min: day * 1440,
      values: cycle[day % cycle.length],
    })),
  } satisfies NonNullable<Parameters<typeof buildShudDat>[0]>,
}));

// Independent two-day hand budget; committed wb-mini inputs and R oracle stay untouched.
const closedBudgetObservations = {
  elevprcp: [
    [0.05, 0.05, 0.05],
    [0.05, 0.05, 0.05],
  ],
  eleveta: [
    [0.03, 0.03, 0.03],
    [0.03, 0.03, 0.03],
  ],
  rivqdown: [
    [16.5, 7],
    [16.5, 11],
  ],
  eleysurf: [
    [0.01, 0.02, 0.03],
    [0.01, 0.02, 0.03],
  ],
  eleyunsat: [
    [0.4, 0.7, 0.9],
    [0.4, 0.7, 0.9],
  ],
  eleygw: [
    [0.8, 1.2, 1.5],
    [0.8, 1.2, 1.5],
  ],
  rivystage: [
    [0.2, 0.4],
    [0.2, 0.4],
  ],
  eleysnow: [
    [0.002, 0.003, 0.004],
    [0.006, 0.007, 0.008],
  ],
  eleyic: [
    [0.001, 0.002, 0.003],
    [0.006, 0.007, 0.008],
  ],
} as const;

type ClosedBudgetVariable = keyof typeof closedBudgetObservations;
type DatInput = NonNullable<Parameters<typeof buildShudDat>[0]>;

export const waterBalanceInputPath = (kind: string) =>
  `input/${waterBalanceProject}/${waterBalanceProject}.${kind}`;
export const waterBalanceOutputPath = (variable: string) =>
  `output/${waterBalanceProject}.out/${waterBalanceProject}.${variable}.dat`;

export function writeClosedBudgetDat(
  root: string,
  variable: ClosedBudgetVariable,
  overrides: DatInput = {},
): void {
  const rows = closedBudgetObservations[variable];
  writeFileSync(
    join(root, waterBalanceOutputPath(variable)),
    buildShudDat({
      start_date: 20000101,
      columns: Array.from({ length: rows[0].length }, (_, index) => index + 1),
      rows: rows.map((values, day) => ({ t_min: day * 1440, values })),
      ...overrides,
    }),
  );
}

export function makeClosedBudgetRun(root: string): void {
  cpSync(waterBalanceFixture, root, { recursive: true });
  for (const variable of Object.keys(closedBudgetObservations) as ClosedBudgetVariable[]) {
    writeClosedBudgetDat(root, variable);
  }
}

export function setTreeWritable(directory: string, writable: boolean): void {
  chmodSync(directory, writable ? 0o700 : 0o500);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) setTreeWritable(path, writable);
    else chmodSync(path, writable ? 0o600 : 0o400);
  }
}
