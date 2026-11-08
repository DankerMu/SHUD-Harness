import type { STORAGE_DEPTH_CONVERSIONS } from "@shud-harness/dsh-shud-core";
import type { ShudDat } from "./shud-dat.ts";
import type { ShudConfigEntry, ShudInputDataMap, ShudTable } from "./shud-text-input.ts";
import { compareMetricPaths, type RunMetrics } from "./run-metrics-wire.ts";

export type WaterValue<T> = { value: T; reason: null } | { value: null; reason: string };

interface CatchmentGeometry {
  area: number;
  weights: number[];
}

type StorageConversion = {
  output: Pick<(typeof STORAGE_DEPTH_CONVERSIONS)["snow"]["output"], "scale" | "veg_frac_weighted">;
  ic: Pick<(typeof STORAGE_DEPTH_CONVERSIONS)["snow"]["ic"], "scale" | "veg_frac_weighted">;
};

export function waterFailure(reason: string): { value: null; reason: string } {
  return { value: null, reason };
}

export function finiteWater(value: number, source: string): WaterValue<number> {
  return Number.isFinite(value) ? { value, reason: null } : waterFailure(`nonfinite:${source}`);
}

// Dependency causes, not raw evidence counts, determine whether a quantity is usable.
const REASON_ORDER = [
  "missing_variable",
  "unreadable_input",
  "missing_calib",
  "ic_shape_mismatch",
  "nonfinite",
  "interval_undetermined",
  "empty_variable",
] as const;

export function firstWaterReason(...reasons: (string | null)[]): string | null {
  let first: string | null = null;
  let firstRank = Infinity;
  for (const reason of reasons) {
    if (reason === null) continue;
    const separator = reason.indexOf(":");
    const kind = separator < 0 ? reason : reason.slice(0, separator);
    const rank = REASON_ORDER.findIndex((candidate) => candidate === kind);
    if (
      first === null ||
      rank < firstRank ||
      (rank === firstRank && compareMetricPaths(reason, first) < 0)
    ) {
      first = reason;
      firstRank = rank;
    }
  }
  return first;
}

function referencedRow(table: ShudTable, reference: number): number[] | undefined {
  return Number.isInteger(reference) && reference >= 1 ? table.rows[reference - 1] : undefined;
}

/** A missing table hides its upper bound, not the reference's own numeric validity. */
function referenceReason(table: ShudTable | null, reference: number, path: string): string | null {
  if (!Number.isFinite(reference)) return `nonfinite:${path}`;
  if (
    !Number.isInteger(reference) ||
    reference < 1 ||
    (table !== null && reference > table.rows.length)
  ) {
    return `unreadable_input:${path}`;
  }
  return null;
}

/** Node, geology and type references address rows, not informational Index columns. */
export function catchmentGeometry(
  mesh: ShudInputDataMap["sp.mesh"],
  path: string,
): WaterValue<CatchmentGeometry> {
  const nodeColumns = ["Node1", "Node2", "Node3"].map((name) =>
    mesh.elements.columns.indexOf(name),
  );
  const x = mesh.nodes.columns.indexOf("X");
  const y = mesh.nodes.columns.indexOf("Y");
  const weights: number[] = [];
  let area = 0;
  let reason: string | null = null;
  for (const element of mesh.elements.rows) {
    let elementReason: string | null = null;
    for (const column of nodeColumns) {
      const invalidReference = referenceReason(mesh.nodes, element[column], path);
      if (invalidReference !== null) {
        elementReason = firstWaterReason(elementReason, invalidReference);
      }
    }
    if (elementReason !== null) {
      reason = firstWaterReason(reason, elementReason);
      continue;
    }
    const a = referencedRow(mesh.nodes, element[nodeColumns[0]])!;
    const b = referencedRow(mesh.nodes, element[nodeColumns[1]])!;
    const c = referencedRow(mesh.nodes, element[nodeColumns[2]])!;
    const triangle = Math.abs((b[x] - a[x]) * (c[y] - a[y]) - (c[x] - a[x]) * (b[y] - a[y])) / 2;
    if (!Number.isFinite(triangle)) {
      reason = firstWaterReason(reason, `nonfinite:${path}`);
      continue;
    }
    weights.push(triangle);
    area += triangle;
  }
  // A partial area cannot establish a zero-area cause or usable weights.
  if (reason !== null) return waterFailure(reason);
  if (!Number.isFinite(area)) return waterFailure(`nonfinite:${path}`);
  if (area <= 0) return waterFailure(`unreadable_input:${path}`);
  for (let i = 0; i < weights.length; i += 1) weights[i] /= area;
  return { value: { area, weights }, reason: null };
}

/** Complete one-based entity coverage, independent of physical .dat column order. */
function completeColumns(dat: ShudDat, count: number): number[] | null {
  if (count === 0 || dat.columns.length !== count) return null;
  const positions = new Array<number>(count).fill(-1);
  for (let i = 0; i < dat.columns.length; i += 1) {
    const id = dat.columns[i];
    if (!Number.isInteger(id) || id < 1 || id > count || positions[id - 1] !== -1) return null;
    positions[id - 1] = i;
  }
  return positions;
}

/** Copy only compact final-minus-IC deltas, never retain a view of the whole dat buffer. */
export function storageDeltas(
  dat: ShudDat,
  initial: ShudTable,
  column: string,
  count: number,
  variable: string,
  initialPath: string,
  conversion?: StorageConversion,
): WaterValue<number[]> {
  const positions = completeColumns(dat, count);
  const initialColumn = initial.columns.indexOf(column);
  const reason = firstWaterReason(
    positions === null ? `unreadable_input:${dat.path}` : null,
    initial.rows.length !== count ? "ic_shape_mismatch" : null,
    dat.nonfinite_count > 0 ? `nonfinite:${variable}` : null,
    initial.rows.some((row) => !Number.isFinite(row[initialColumn]))
      ? `nonfinite:${initialPath}`
      : null,
    dat.rows.length === 0 ? `empty_variable:${variable}` : null,
  );
  if (reason !== null) return waterFailure(reason);
  const final = dat.rows[dat.rows.length - 1].values;
  const deltas = new Array<number>(positions!.length);
  for (let i = 0; i < positions!.length; i += 1) {
    // The registered output and IC factors apply separately, before subtraction.
    // All shipped registrations are unweighted; there is no vegetation source to read.
    const output = final[positions![i]] * (conversion?.output.scale ?? 1);
    const start = initial.rows[i][initialColumn] * (conversion?.ic.scale ?? 1);
    const delta = output - start;
    if (!Number.isFinite(delta)) return waterFailure(`nonfinite:${variable}`);
    deltas[i] = delta;
  }
  return { value: deltas, reason: null };
}

export function elementPorosity(
  att: WaterValue<ShudTable>,
  geol: WaterValue<ShudTable>,
  calib: WaterValue<ShudConfigEntry[]>,
  count: number,
  inputPath: (kind: string) => string,
): WaterValue<number[]> {
  let reason = firstWaterReason(att.reason, geol.reason, calib.reason);
  const attPath = inputPath("sp.att");
  const geolPath = inputPath("para.geol");
  const calibPath = inputPath("cfg.calib");
  let multiplier: number | null = null;
  if (calib.value !== null) {
    const multipliers = calib.value.filter(({ key }) => key === "GEOL_THETAS");
    if (multipliers.length === 0) {
      reason = firstWaterReason(reason, "missing_calib:GEOL_THETAS");
    } else if (multipliers.length !== 1) {
      reason = firstWaterReason(reason, `unreadable_input:${calibPath}`);
    } else if (!Number.isFinite(multipliers[0].value)) {
      reason = firstWaterReason(reason, `nonfinite:${calibPath}`);
    } else {
      multiplier = multipliers[0].value;
    }
  }
  const porosity: number[] = [];
  if (att.value !== null) {
    if (att.value.rows.length !== count) {
      reason = firstWaterReason(reason, `unreadable_input:${attPath}`);
    }
    const geologyColumn = att.value.columns.indexOf("GEOL");
    const thetaColumn = geol.value?.columns.indexOf("ThetaS(m3_m3)");
    for (const element of att.value.rows) {
      const reference = element[geologyColumn];
      const invalidReference = referenceReason(geol.value, reference, attPath);
      if (invalidReference !== null) reason = firstWaterReason(reason, invalidReference);
      // An unreadable geology table cannot establish an out-of-range upper bound
      // or any ThetaS value; other readable inputs still retain their own causes.
      if (invalidReference !== null || geol.value === null) continue;
      const geology = referencedRow(geol.value, reference)!;
      if (!Number.isFinite(geology[thetaColumn!])) {
        reason = firstWaterReason(reason, `nonfinite:${geolPath}`);
        continue;
      }
      if (multiplier === null) continue;
      const theta = geology[thetaColumn!] * multiplier;
      if (!Number.isFinite(theta)) {
        reason = firstWaterReason(reason, `nonfinite:${geolPath}`);
      } else {
        porosity.push(theta);
      }
    }
  }
  return reason === null ? { value: porosity, reason: null } : waterFailure(reason);
}

export function elementStorage(
  deltas: readonly number[],
  weights: readonly number[],
  variable: string,
  porosity?: readonly number[],
): WaterValue<number> {
  let depth = 0;
  for (let i = 0; i < weights.length; i += 1) {
    depth += weights[i] * deltas[i] * (porosity === undefined ? 1 : porosity[i]);
  }
  return finiteWater(depth, variable);
}

export function riverStorage(
  deltas: WaterValue<number[]>,
  river: ShudInputDataMap["sp.riv"],
  geometry: WaterValue<CatchmentGeometry>,
  path: string,
): WaterValue<number> {
  const typeColumn = river.reaches.columns.indexOf("Type");
  const lengthColumn = river.reaches.columns.indexOf("Length");
  const widthColumn = river.types.columns.indexOf("Width");
  let reason = firstWaterReason(deltas.reason, geometry.reason);
  // River metadata is independently inspectable even when Stage or geometry fails.
  for (const reach of river.reaches.rows) {
    const reference = reach[typeColumn];
    const invalidReference = referenceReason(river.types, reference, path);
    if (invalidReference !== null) reason = firstWaterReason(reason, invalidReference);
    if (!Number.isFinite(reach[lengthColumn])) {
      reason = firstWaterReason(reason, `nonfinite:${path}`);
    }
    if (invalidReference !== null) continue;
    const type = referencedRow(river.types, reference)!;
    if (!Number.isFinite(type[widthColumn])) {
      reason = firstWaterReason(reason, `nonfinite:${path}`);
    }
  }
  if (reason !== null) return waterFailure(reason);
  const area = geometry.value!.area;
  const changes = deltas.value!;
  let depth = 0;
  for (let i = 0; i < changes.length; i += 1) {
    const reach = river.reaches.rows[i];
    const type = referencedRow(river.types, reach[typeColumn])!;
    depth += (changes[i] * type[widthColumn] * reach[lengthColumn]) / area;
  }
  return finiteWater(depth, "rivystage");
}

export function fluxDepth(
  dat: ShudDat,
  geometry: WaterValue<CatchmentGeometry>,
  count: number,
  interval: number | null,
  variable: string,
): WaterValue<number> {
  const positions = completeColumns(dat, count);
  const reason = firstWaterReason(
    geometry.reason,
    positions === null ? `unreadable_input:${dat.path}` : null,
    dat.nonfinite_count > 0 ? `nonfinite:${variable}` : null,
    interval === null ? `interval_undetermined:${variable}` : null,
  );
  if (reason !== null) return waterFailure(reason);
  const { weights } = geometry.value!;
  let depth = 0;
  for (const row of dat.rows) {
    let daily = 0;
    for (let i = 0; i < weights.length; i += 1) daily += weights[i] * row.values[positions![i]];
    depth += daily * interval!;
  }
  return finiteWater(depth, variable);
}

export function totalWaterBalance(water: RunMetrics["water_balance"]): void {
  const stores = [
    "delta_s_surf",
    "delta_s_us",
    "delta_s_gw",
    "delta_s_riv",
    "delta_s_snow",
    "delta_s_ic",
  ] as const;
  const storageReason = firstWaterReason(...stores.map((field) => water.reasons[field]));
  const total =
    storageReason === null
      ? finiteWater(
          stores.reduce((sum, field) => sum + water[field]!, 0),
          "delta_s",
        )
      : waterFailure(storageReason);
  water.delta_s = total.value;
  water.reasons.delta_s = total.reason;
  const reason = firstWaterReason(
    water.reasons.P,
    water.reasons.Qd,
    water.reasons.AET,
    total.reason,
  );
  const residual =
    reason !== null
      ? waterFailure(reason)
      : water.P! <= 0
        ? waterFailure("zero_precipitation")
        : finiteWater(
            Math.abs(water.P! - water.Qd! - water.AET! - water.delta_s!) / water.P!,
            "residual",
          );
  water.residual = residual.value;
  water.reasons.residual = residual.reason;
}
