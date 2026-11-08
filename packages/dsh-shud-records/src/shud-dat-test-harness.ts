// Independent Python struct.pack('<d', ...) oracle, copied as literals so tests and
// future #651 fixtures never depend on local workplans or the production decoder.
export const datOracle = {
  tail_hex:
    "00000050d61273410000000000000040000000000000f03f00000000000000400000000000000000000000000000f43f00000000000004c0000000000080964000000000000008400000000000001240000000000080a64000000000000000800000000000001840",
  sha256: "c61ae4c7e3bc9c9fa50044fcf471c3fe3bdc90fd466f84ebd7e2cd74d77979eb",
  size_bytes: 1128,
  start_date: 20000101,
  columns: [1, 2],
  rows: [
    { t_min: 0, values: [1.25, -2.5] },
    { t_min: 1440, values: [3, 4.5] },
    { t_min: 2880, values: [-0, 6] },
  ],
} as const;

/** Canonical synthetic .dat writer; #651 extends this helper rather than adding a writer. */
export function buildShudDat(
  input: {
    header?: Uint8Array;
    start_date?: number;
    columns?: readonly number[];
    rows?: readonly { t_min: number; values: readonly number[] }[];
  } = {},
): Buffer {
  const {
    header = Buffer.alloc(1024, 0x7f),
    start_date = datOracle.start_date,
    columns = datOracle.columns,
    rows = datOracle.rows,
  } = input;
  if (header.byteLength !== 1024) throw new Error("Synthetic .dat header must have 1024 bytes");
  if (rows.some((row) => row.values.length !== columns.length))
    throw new Error("Synthetic .dat rows must match the column count");
  const bytes = Buffer.alloc(1040 + 8 * columns.length + 8 * (columns.length + 1) * rows.length);
  bytes.set(header);
  let offset = 1024;
  const write = (value: number) => {
    bytes.writeDoubleLE(value, offset);
    offset += 8;
  };
  write(start_date);
  write(columns.length);
  for (const column of columns) write(column);
  for (const row of rows) {
    write(row.t_min);
    for (const value of row.values) write(value);
  }
  return bytes;
}
