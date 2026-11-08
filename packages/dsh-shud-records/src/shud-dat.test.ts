import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readShudDat, type ShudDat, type ShudDatRow } from "./index.ts";
import { buildShudDat, datOracle } from "./shud-dat-test-harness.ts";
import { expectInputError } from "./shud-text-test-harness.ts";

const relative = "mini.rivqdown.dat";
let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(`${tmpdir()}/shud-dat-layout-`));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function readBytes(bytes: Buffer): ShudDat {
  writeFileSync(`${base}/${relative}`, bytes);
  return readShudDat(base, relative);
}

function expectLayoutError(bytes: Buffer, reason: RegExp): void {
  const error = expectInputError(() => readBytes(bytes), relative, "parse");
  expect(error.message).toMatch(reason);
  expect(error).not.toHaveProperty("rows");
  expect(error).not.toHaveProperty("nonfinite_count");
}

describe("synthetic .dat bytes and public decoding", () => {
  test("canonical builder matches an independent literal byte vector and digest", () => {
    const bytes = buildShudDat();
    expect(bytes.length).toBe(1128);
    expect(bytes.subarray(0, 1024)).toEqual(Buffer.alloc(1024, 0x7f));
    expect(bytes.subarray(1024).toString("hex")).toBe(datOracle.tail_hex);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(datOracle.sha256);
  });

  test("returns the original date, interval-start minutes, column order and signed values", () => {
    // Decode literal bytes, not the builder's output: the two checks are independent.
    const bytes = Buffer.concat([Buffer.alloc(1024, 0x7f), Buffer.from(datOracle.tail_hex, "hex")]);
    const result: ShudDat = readBytes(bytes);
    expect(result).toEqual({
      path: relative,
      start_date: 20000101,
      columns: [1, 2],
      rows: [
        { t_min: 0, values: new Float64Array([1.25, -2.5]) },
        { t_min: 1440, values: new Float64Array([3, 4.5]) },
        { t_min: 2880, values: new Float64Array([-0, 6]) },
      ],
      nonfinite_count: 0,
      sha256: datOracle.sha256,
      size_bytes: 1128,
    });
    const row: ShudDatRow = result.rows[2];
    expect(row.values).toBeInstanceOf(Float64Array);
    expect(Object.is(row.values[0], -0)).toBe(true);
  });

  test("small-file typed arrays expose no unrelated Buffer-pool backing bytes", () => {
    const result = readBytes(buildShudDat());
    for (const { values } of result.rows) {
      // An owned whole-file buffer or smaller owned payload is fine. A view of an
      // 8192-byte pool behind this 1128-byte file exposes unrelated memory.
      expect(values.buffer.byteLength).toBeLessThanOrEqual(1128);
      expect(values.byteOffset + values.byteLength).toBeLessThanOrEqual(values.buffer.byteLength);
    }
    expect(result.rows.map((row) => Array.from(row.values))).toEqual([
      [1.25, -2.5],
      [3, 4.5],
      [-0, 6],
    ]);
  });

  test("treats all 1024 header bytes as opaque rather than text or magic", () => {
    const header = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
    const result = readBytes(buildShudDat({ header }));
    expect(result.start_date).toBe(20000101);
    expect(result.columns).toEqual([1, 2]);
    expect(result.rows.map((row) => row.t_min)).toEqual([0, 1440, 2880]);
    expect(result.nonfinite_count).toBe(0);
  });
});

describe("layout rejection without partial rows", () => {
  test.each([0, 1039])("rejects a %i-byte file below the minimum", (length) => {
    expectLayoutError(buildShudDat().subarray(0, length), /length|short|1040|header/iu);
  });

  test.each([2.5, -1, NaN, Infinity, -Infinity])("rejects structural NumVar %s", (count) => {
    const bytes = buildShudDat();
    bytes.writeDoubleLE(count, 1032);
    expectLayoutError(bytes, /NumVar|column count/iu);
  });

  test.each([-1, 0.5, NaN, Infinity, -Infinity])("rejects structural column id %s", (id) => {
    const bytes = buildShudDat();
    bytes.writeDoubleLE(id, 1048);
    expectLayoutError(bytes, /column/iu);
  });

  test("rejects a declared column array extending beyond the observed bytes", () => {
    expectLayoutError(buildShudDat().subarray(0, 1048), /column|extent|length/iu);
  });

  test.each([Number.MAX_SAFE_INTEGER, Number.MAX_VALUE])(
    "bounds huge NumVar %s by actual bytes instead of allocating declared storage",
    (count) => {
      const bytes = buildShudDat();
      bytes.writeDoubleLE(count, 1032);
      expectLayoutError(bytes, /NumVar|column|extent|length/iu);
    },
  );

  test.each([1, 8, 16])("rejects the last row truncated by %i bytes", (missing) => {
    expectLayoutError(buildShudDat().subarray(0, 1128 - missing), /row|align|length/iu);
  });

  test("rejects a trailing byte instead of silently ignoring it", () => {
    expectLayoutError(Buffer.concat([buildShudDat(), Buffer.from([0])]), /row|align|length/iu);
  });
});

describe("consumer-neutral transport values", () => {
  test.each([{ columns: [] }, { columns: [1, 2] }])(
    "accepts zero rows with columns $columns",
    ({ columns }) => {
      const result = readBytes(buildShudDat({ columns, rows: [] }));
      expect(result.columns).toEqual(columns);
      expect(result.rows).toEqual([]);
      expect(result.start_date).toBe(20000101);
      expect(result.nonfinite_count).toBe(0);
    },
  );

  test("accepts zero-variable rows containing only time, including signed zero", () => {
    const result = readBytes(
      buildShudDat({
        columns: [],
        rows: [
          { t_min: -0, values: [] },
          { t_min: 12, values: [] },
        ],
      }),
    );
    expect(result.rows).toEqual([
      { t_min: -0, values: new Float64Array() },
      { t_min: 12, values: new Float64Array() },
    ]);
    expect(result.columns).toEqual([]);
    expect(result.nonfinite_count).toBe(0);
  });

  test("preserves zero, duplicate and unordered ids and nonmonotone repeated times", () => {
    const result = readBytes(
      buildShudDat({
        start_date: -0,
        columns: [2, 0, 2, 1],
        rows: [
          { t_min: 12, values: [1, 2, 3, 4] },
          { t_min: -5, values: [5, 6, 7, 8] },
          { t_min: -5, values: [9, 10, 11, 12] },
        ],
      }),
    );
    expect(result.start_date).toBe(-0);
    expect(result.columns).toEqual([2, 0, 2, 1]);
    expect(result.rows.map(({ t_min, values }) => [t_min, ...values])).toEqual([
      [12, 1, 2, 3, 4],
      [-5, 5, 6, 7, 8],
      [-5, 9, 10, 11, 12],
    ]);
    expect(result.nonfinite_count).toBe(0);
  });

  test.each([NaN, Infinity, -Infinity])(
    "retains nonfinite metadata %s and every nonfinite time/value position with an exact count",
    (start_date) => {
      const result = readBytes(
        buildShudDat({
          start_date,
          rows: [
            { t_min: NaN, values: [Infinity, -Infinity] },
            { t_min: Infinity, values: [NaN, -0] },
            { t_min: -Infinity, values: [7, NaN] },
          ],
        }),
      );
      expect(result.start_date).toBe(start_date);
      expect(result.rows.map(({ t_min, values }) => [t_min, ...values])).toEqual([
        [NaN, Infinity, -Infinity],
        [Infinity, NaN, -0],
        [-Infinity, 7, NaN],
      ]);
      expect(result.nonfinite_count).toBe(8);
      expect(Object.is(result.rows[1].values[1], -0)).toBe(true);
    },
  );
});
