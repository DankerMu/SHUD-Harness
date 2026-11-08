import type { ShudDat } from "./shud-dat.ts";
import type { ShudConfigEntry, ShudInputDataMap, ShudTable } from "./shud-text-input.ts";

function referencedRow(table: ShudTable, reference: number): number[] | undefined {
  return Number.isInteger(reference) && reference >= 1 ? table.rows[reference - 1] : undefined;
}

/** Node, geology and type references address rows, not informational Index columns. */
export function catchmentGeometry(mesh: ShudInputDataMap["sp.mesh"]) {
  const nodeColumns = ["Node1", "Node2", "Node3"].map((name) =>
    mesh.elements.columns.indexOf(name),
  );
  const x = mesh.nodes.columns.indexOf("X");
  const y = mesh.nodes.columns.indexOf("Y");
  const weights: number[] = [];
  let area = 0;
  for (const element of mesh.elements.rows) {
    const a = referencedRow(mesh.nodes, element[nodeColumns[0]]);
    const b = referencedRow(mesh.nodes, element[nodeColumns[1]]);
    const c = referencedRow(mesh.nodes, element[nodeColumns[2]]);
    if (a === undefined || b === undefined || c === undefined) return null;
    const triangle = Math.abs((b[x] - a[x]) * (c[y] - a[y]) - (c[x] - a[x]) * (b[y] - a[y])) / 2;
    if (!Number.isFinite(triangle)) return null;
    weights.push(triangle);
    area += triangle;
  }
  if (!Number.isFinite(area) || area <= 0) return null;
  for (let i = 0; i < weights.length; i += 1) weights[i] /= area;
  return { area, weights };
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
export function storageDeltas(dat: ShudDat, initial: ShudTable, column: string): number[] | null {
  if (dat.nonfinite_count > 0 || dat.rows.length === 0) return null;
  const positions = completeColumns(dat, initial.rows.length);
  if (positions === null) return null;
  const initialColumn = initial.columns.indexOf(column);
  const final = dat.rows[dat.rows.length - 1].values;
  const deltas = new Array<number>(positions.length);
  for (let i = 0; i < positions.length; i += 1) {
    const delta = final[positions[i]] - initial.rows[i][initialColumn];
    if (!Number.isFinite(delta)) return null;
    deltas[i] = delta;
  }
  return deltas;
}

export function elementPorosity(
  att: ShudTable,
  geol: ShudTable,
  calib: ShudConfigEntry[],
  count: number,
): number[] | null {
  if (att.rows.length !== count) return null;
  const multipliers = calib.filter(({ key }) => key === "GEOL_THETAS");
  if (multipliers.length !== 1 || !Number.isFinite(multipliers[0].value)) return null;
  const geologyColumn = att.columns.indexOf("GEOL");
  const thetaColumn = geol.columns.indexOf("ThetaS(m3_m3)");
  const porosity: number[] = [];
  for (const element of att.rows) {
    const geology = referencedRow(geol, element[geologyColumn]);
    if (geology === undefined) return null;
    const theta = geology[thetaColumn] * multipliers[0].value;
    if (!Number.isFinite(theta)) return null;
    porosity.push(theta);
  }
  return porosity;
}

export function elementStorage(
  deltas: readonly number[] | null,
  weights: readonly number[],
  porosity?: readonly number[],
): number | null {
  if (deltas === null || deltas.length !== weights.length) return null;
  let depth = 0;
  for (let i = 0; i < weights.length; i += 1) {
    depth += weights[i] * deltas[i] * (porosity === undefined ? 1 : porosity[i]);
  }
  return Number.isFinite(depth) ? depth : null;
}

export function riverStorage(
  deltas: readonly number[] | null,
  river: ShudInputDataMap["sp.riv"],
  area: number,
): number | null {
  if (deltas === null || deltas.length !== river.reaches.rows.length) return null;
  const typeColumn = river.reaches.columns.indexOf("Type");
  const lengthColumn = river.reaches.columns.indexOf("Length");
  const widthColumn = river.types.columns.indexOf("Width");
  let depth = 0;
  for (let i = 0; i < deltas.length; i += 1) {
    const reach = river.reaches.rows[i];
    const type = referencedRow(river.types, reach[typeColumn]);
    if (type === undefined) return null;
    depth += (deltas[i] * type[widthColumn] * reach[lengthColumn]) / area;
  }
  return Number.isFinite(depth) ? depth : null;
}

export function fluxDepth(dat: ShudDat, weights: readonly number[], interval: number | null) {
  if (interval === null || dat.nonfinite_count > 0) return null;
  const positions = completeColumns(dat, weights.length);
  if (positions === null) return null;
  let depth = 0;
  for (const row of dat.rows) {
    let daily = 0;
    for (let i = 0; i < weights.length; i += 1) daily += weights[i] * row.values[positions[i]];
    depth += daily * interval;
  }
  return Number.isFinite(depth) ? depth : null;
}
