import { inspect } from "node:util";
import { expect } from "vitest";
import { ShudInputError } from "./index.ts";
import type { ShudInputKind, ShudTable } from "./index.ts";

// Small literal writer-shaped inputs, independent of the production parser.
export const sections = {
  elements: "1 8\nID Node1 Node2 Node3 Nabr1 Nabr2 Nabr3 Zmax\n7 3 1 2 0 0 0 12\n",
  nodes: "3 5\nID X Y AqDepth Elevation\n3 0 0 30 10\n1 4 0 30 11\n2 0 3 30 12\n",
  att: "1 9\nINDEX SOIL GEOL LC FORC MF BC SS ilake\n7 2 13 0 1 1 -1 0 0\n",
  reaches: "1 6\nIndex Down Type Slope Length BC\n9 -3 4 -0.25 12 0\n",
  types:
    "1 9\nIndex Depth BankSlope Width Sinuosity Manning Cwr KsatH BedThick\n4 7 0 8 1 0.04 0.6 0.1 0.1\n",
  geometry: "1 6\nFrom.x From.y From.z To.x To.y To.z\n0 1 2 3 4 5\n",
  geol: "1 8\nINDEX KsatH(m_d) KsatV(m_d) ThetaS(m3_m3) ThetaR(m3_m3) vAreaF(m2_m2) macKsatH(m_d) Dmac(m)\n13 1.5 0.25 0.4 0.01 0.01 150 1\n",
  lc: "1 7\nINDEX ALBEDO VEGFRAC ROUGH RZD SOILDGRD IMPAF\n0 0.135 0 0.035 0 0 0\n",
  icElements: "1 6\nIndex Canopy Snow Surface Unsat GW\n7 0.1 0.2 -0.3 4 5\n",
  icRivers: "1 2\nIndex Stage\n9 0.05\n",
  lakes: "1 2\nIndex LakeStage\n2 18.447096\n",
};

export const smallInputs = {
  "sp.mesh": sections.elements + sections.nodes,
  "sp.att": sections.att,
  "sp.riv": sections.reaches + sections.types,
  "para.geol": sections.geol,
  "para.lc": sections.lc,
  "cfg.para": "START 0\nEND 1827\n",
  "cfg.calib": "GEOL_KSATV 1\nRIV_WDTH+ 50\n",
  "cfg.ic": sections.icElements + sections.icRivers,
} satisfies Record<ShudInputKind, string>;

export const inputKinds = Object.keys(smallInputs) as ShudInputKind[];
export const privatePayload = "private-input-payload-647";
export const privateNative = "private-native-fault-647";

export function expectInputError(
  action: () => unknown,
  path: string,
  stage: "missing" | "unsafe" | "read" | "parse",
  location: { column?: string; line?: number } = {},
): ShudInputError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ShudInputError);
  if (!(caught instanceof ShudInputError))
    throw new Error("Expected a controlled SHUD input error");
  expect(caught).toMatchObject({ path, stage, ...location });
  expect(caught.message).toContain(path);
  if (location.column !== undefined) expect(caught.message).toContain(location.column);
  expect(caught.cause).toBeUndefined();
  const diagnostic = inspect(caught, { depth: null, showHidden: true });
  expect(diagnostic).not.toContain(privatePayload);
  expect(diagnostic).not.toContain(privateNative);
  expect(caught).not.toHaveProperty("data");
  return caught;
}

export function expectTable(table: ShudTable, rows: number, columns: number): void {
  expect(table.columns).toHaveLength(columns);
  expect(table.rows).toHaveLength(rows);
  expect(table.rows.every((row) => row.length === columns)).toBe(true);
}
