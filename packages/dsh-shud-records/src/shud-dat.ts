import { endianness } from "node:os";
import { readShudInputFile, ShudInputError, shudInputPath } from "./shud-input-file.ts";

export interface ShudDatRow {
  /** Interval-start model time in minutes, not the file's starting date. */
  t_min: number;
  /** Raw interval-average samples in column order; no scientific interpretation. */
  values: Float64Array;
}

export interface ShudDat {
  /** Normalized relative POSIX path. */
  path: string;
  /** Original starting-date metadata, without date parsing or unit conversion. */
  start_date: number;
  columns: number[];
  rows: ShudDatRow[];
  /** Retained nonfinite metadata, times and values; structural nonfinites are errors. */
  nonfinite_count: number;
  sha256: string;
  size_bytes: number;
}

/**
 * Read one verified little-endian SHUD .dat observation, closing before decoding.
 * The 1024-byte header is opaque. Only layout is validated: column ids and times
 * are neither sorted nor deduplicated, and empty dimensions remain valid transport.
 * Values view owned, aligned file storage rather than a shared Node Buffer pool.
 */
export function readShudDat(outputBase: string, relativePath: string): ShudDat {
  if (endianness() !== "LE") {
    throw new ShudInputError(
      "parse",
      shudInputPath(relativePath),
      "unsupported platform: little-endian byte order required",
    );
  }
  const { path, bytes, sha256, size_bytes } = readShudInputFile(outputBase, relativePath);
  if (bytes.length < 1040)
    throw new ShudInputError("parse", path, "file length is shorter than the 1040-byte header");

  const start_date = bytes.readDoubleLE(1024);
  const numVar = bytes.readDoubleLE(1032);
  if (!Number.isFinite(numVar) || !Number.isInteger(numVar) || numVar < 0)
    throw new ShudInputError("parse", path, "NumVar must be a finite nonnegative integer");
  // Prove the declared extent using observed bytes before multiplication or allocation.
  if (numVar > Math.floor((bytes.length - 1040) / 8))
    throw new ShudInputError("parse", path, "NumVar column extent exceeds file length");
  const rowOffset = 1040 + 8 * numVar;
  const rowWidth = 8 * (numVar + 1);
  const payloadLength = bytes.length - rowOffset;
  if (payloadLength % rowWidth !== 0)
    throw new ShudInputError("parse", path, "row payload length is not aligned to NumVar");

  const columns = new Array<number>(numVar);
  for (let i = 0; i < numVar; i += 1) {
    const column = bytes.readDoubleLE(1040 + 8 * i);
    if (!Number.isFinite(column) || !Number.isInteger(column) || column < 0)
      throw new ShudInputError("parse", path, "column id must be a finite nonnegative integer");
    columns[i] = column;
  }

  let nonfinite_count = Number.isFinite(start_date) ? 0 : 1;
  const rows = new Array<ShudDatRow>(payloadLength / rowWidth);
  for (let i = 0, offset = rowOffset; i < rows.length; i += 1, offset += rowWidth) {
    const t_min = bytes.readDoubleLE(offset);
    // The native LE guard makes these aligned views little-endian as well. The shared
    // reader owns the entire backing allocation, including for small pooled-size files.
    const values = new Float64Array(bytes.buffer, bytes.byteOffset + offset + 8, numVar);
    if (!Number.isFinite(t_min)) nonfinite_count += 1;
    for (const value of values) {
      if (!Number.isFinite(value)) nonfinite_count += 1;
    }
    rows[i] = { t_min, values };
  }
  return { path, start_date, columns, rows, nonfinite_count, sha256, size_bytes };
}
