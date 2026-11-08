import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, test } from "vitest";
import { parseShudTextInput, readShudTextInput } from "./index.ts";
import type {
  ShudConfigEntry,
  ShudInputDataMap,
  ShudInputKind,
  ShudInputReadResult,
  ShudTable,
} from "./index.ts";
import {
  expectInputError,
  expectTable,
  inputKinds,
  privatePayload,
  sections,
  smallInputs,
} from "./shud-text-test-harness.ts";

function parse<K extends ShudInputKind>(text: string | Uint8Array, kind: K) {
  return parseShudTextInput(
    typeof text === "string" ? Buffer.from(text) : text,
    `mini.${kind}`,
    kind,
  );
}

// Read the pinned submodule directly: no duplicated large fixtures and no writes to SHUD.
const ccw = fileURLToPath(new URL("../../../SHUD/input/ccw/", import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function sourceTreeHashes(directory = ccw): Record<string, { sha256: string; size_bytes: number }> {
  const result: Record<string, { sha256: string; size_bytes: number }> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, sourceTreeHashes(path));
    else if (entry.isFile()) {
      const bytes = readFileSync(path);
      result[path] = { sha256: sha256(bytes), size_bytes: bytes.length };
    }
  }
  return result;
}

test("reads all eight ccw kinds with independent full-byte digests and leaves every source unchanged", () => {
  const treeBefore = sourceTreeHashes();
  expect(Object.keys(treeBefore)).toHaveLength(45);
  const before = new Map(
    inputKinds.map((kind) => {
      const bytes = readFileSync(`${ccw}/ccw.${kind}`);
      return [kind, { bytes, sha256: sha256(bytes), size_bytes: bytes.length }] as const;
    }),
  );
  try {
    for (const kind of inputKinds) {
      const expected = before.get(kind)!;
      const result = readShudTextInput(ccw, `ccw.${kind}`, kind);
      expect(result.path).toBe(`ccw.${kind}`);
      expect(result.sha256).toBe(expected.sha256);
      expect(result.size_bytes).toBe(expected.size_bytes);
      expect(Object.keys(result).sort()).toEqual(["data", "path", "sha256", "size_bytes"]);
    }
    const mesh = readShudTextInput(ccw, "ccw.sp.mesh", "sp.mesh").data;
    expectTable(mesh.elements, 1147, 8);
    expectTable(mesh.nodes, 629, 5);
    expect(mesh.elements.rows[0]).toEqual([1, 93, 95, 45, 74, 42, 120, 984.22]);
    expect(mesh.elements.rows.at(-1)).toEqual([1147, 619, 629, 435, 787, 1130, 76, 587.24]);
    expect(mesh.nodes.rows.at(-1)).toEqual([629, -2245216, 2108772, 30, 634.4]);
    const att = readShudTextInput(ccw, "ccw.sp.att", "sp.att").data;
    expectTable(att, 1147, 9);
    expect(att.columns).toEqual(["INDEX", "SOIL", "GEOL", "LC", "FORC", "MF", "BC", "SS", "ilake"]);
    expect(att.rows[0]).toEqual([1, 13, 13, 11, 1, 1, 0, 0, 0]);
    const river = readShudTextInput(ccw, "ccw.sp.riv", "sp.riv").data;
    expectTable(river.reaches, 103, 6);
    expectTable(river.types, 4, 9);
    expect(river.geometry).not.toBeNull();
    expectTable(river.geometry!, 103, 6);
    const down = river.reaches.columns.indexOf("Down");
    const id = river.reaches.columns.indexOf("Index");
    expect(river.reaches.rows.filter((row) => row[down] < 0).map((row) => row[id])).toEqual([1]);
    expect(river.reaches.rows[6]).toEqual([7, 6, 4, -0.002705109, 450.9989, 0]);
    expect(river.geometry!.rows[0]).toEqual([-2246527, 2108710, 451.48, -2244178, 2107150, 450.48]);
    const geol = readShudTextInput(ccw, "ccw.para.geol", "para.geol").data;
    expectTable(geol, 67, 8);
    expect(geol.rows[0]).toEqual([1, 1.652915, 0.1652915, 0.4102053, 0.01, 0.01, 165.2915, 1]);
    const lc = readShudTextInput(ccw, "ccw.para.lc", "para.lc").data;
    expectTable(lc, 17, 7);
    expect(lc.rows[0]).toEqual([0, 0.135, 0, 0.035, 0, 0, 0]);
    const ic = readShudTextInput(ccw, "ccw.cfg.ic", "cfg.ic").data;
    expectTable(ic.elements, mesh.elements.rows.length, 6);
    expectTable(ic.rivers, river.reaches.rows.length, 2);
    expect(ic.time_min).toBe(5256000);
    expect(ic.lakes).toBeNull();
    expect(ic.elements.rows[0]).toEqual([1, 0, 0, -0.000056, 9.985983, 0.02]);
    const para = readShudTextInput(ccw, "ccw.cfg.para", "cfg.para").data;
    expect(para).toHaveLength(29);
    expect(para[13]).toEqual({ key: "END", value: 1827, line: 14 });
    const calib = readShudTextInput(ccw, "ccw.cfg.calib", "cfg.calib").data;
    expect(calib).toHaveLength(38);
    expect(calib[7]).toEqual({ key: "SOIL_KINF", value: 0.01, line: 8 });
    expect(calib[34]).toEqual({ key: "RIV_WDTH+", value: 50, line: 35 });
  } finally {
    for (const [kind, expected] of before) {
      const after = readFileSync(`${ccw}/ccw.${kind}`);
      expect(after).toEqual(expected.bytes);
      expect(sha256(after)).toBe(expected.sha256);
    }
    expect(sourceTreeHashes()).toEqual(treeBefore);
  }
});

describe("structured parser results", () => {
  test("infers each kind's public data and reader result without casts", () => {
    const data = parse(smallInputs["sp.mesh"], "sp.mesh");
    expectTypeOf(data).toEqualTypeOf<ShudInputDataMap["sp.mesh"]>();
    expectTypeOf(data.elements).toEqualTypeOf<ShudTable>();
    expectTypeOf(parse(smallInputs["cfg.calib"], "cfg.calib")).toEqualTypeOf<ShudConfigEntry[]>();
    expectTypeOf(readShudTextInput(ccw, "ccw.para.lc", "para.lc")).toEqualTypeOf<
      ShudInputReadResult<"para.lc">
    >();
    expect(data.elements.rows).toEqual([[7, 3, 1, 2, 0, 0, 0, 12]]);
    expect(data.nodes.rows.map((row) => row[0])).toEqual([3, 1, 2]);
  });

  test.each(inputKinds)(
    "accepts %s without a terminal newline and preserves input bytes",
    (kind) => {
      const bytes = Buffer.from(smallInputs[kind].trimEnd());
      const before = Buffer.from(bytes);
      expect(parse(bytes, kind)).toEqual(parse(smallInputs[kind], kind));
      expect(bytes).toEqual(before);
    },
  );

  test("preserves optional geometry and lake sections, or explicit null when absent", () => {
    expect(parse(smallInputs["sp.riv"], "sp.riv").geometry).toBeNull();
    expect(parse(smallInputs["sp.riv"] + sections.geometry, "sp.riv").geometry).toEqual({
      columns: ["From.x", "From.y", "From.z", "To.x", "To.y", "To.z"],
      rows: [[0, 1, 2, 3, 4, 5]],
    });
    const absent = parse(smallInputs["cfg.ic"], "cfg.ic");
    expect(absent.time_min).toBeNull();
    expect(absent.lakes).toBeNull();
    const present = parse(
      smallInputs["cfg.ic"].replace("1 6\n", "1 6 12.5\n") + sections.lakes,
      "cfg.ic",
    );
    expect(present.time_min).toBe(12.5);
    expect(present.lakes).toEqual({ columns: ["Index", "LakeStage"], rows: [[2, 18.447096]] });
    expect(present.rivers.rows).toEqual([[9, 0.05]]);
  });

  test("selects geol and landcover columns by name, retaining order and an eighth LC column", () => {
    const geol = parse(
      sections.geol.replace("KsatH(m_d) KsatV(m_d)", "KsatV(m_d) KsatH(m_d)"),
      "para.geol",
    );
    expect(geol.columns.slice(1, 3)).toEqual(["KsatV(m_d)", "KsatH(m_d)"]);
    expect(geol.rows[0]).toEqual([13, 1.5, 0.25, 0.4, 0.01, 0.01, 150, 1]);
    const lc = parse(
      "1 8\nROUGH INDEX VEGFRAC ALBEDO RZD SOILDGRD IMPAF Extra\n0.035 0 0.8 0.135 0 0 0 9\n",
      "para.lc",
    );
    expect(lc.columns).toEqual([
      "ROUGH",
      "INDEX",
      "VEGFRAC",
      "ALBEDO",
      "RZD",
      "SOILDGRD",
      "IMPAF",
      "Extra",
    ]);
    expect(lc.rows).toEqual([[0.035, 0, 0.8, 0.135, 0, 0, 0, 9]]);
  });

  test("accepts zero declared rows without inventing cross-file count or index constraints", () => {
    const ic = parse(
      "0 6\nIndex Canopy Snow Surface Unsat GW\n1 2\nIndex Stage\n99 -1\n",
      "cfg.ic",
    );
    expect(ic.elements.rows).toEqual([]);
    expect(ic.rivers.rows).toEqual([[99, -1]]);
  });
});

describe.each(["cfg.para", "cfg.calib"] as const)("%s byte-oriented keys", (kind) => {
  test("skips only specified first bytes, retains duplicates, unknown keys, suffixes and source lines", () => {
    const bytes = Buffer.concat([
      Buffer.from("#"),
      Buffer.from([0xff]),
      Buffer.from(
        " comment\n GEOL_KSATV bad\n\n\0bad\nGEOL_KSATV 2\n\t geol_ksatv 3\r\nRIV_WDTH+ 50 ignored trailing content\nfuture_key 4\n",
      ),
    ]);
    expect(parse(bytes, kind)).toEqual([
      { key: "GEOL_KSATV", value: 2, line: 5 },
      { key: "GEOL_KSATV", value: 3, line: 6 },
      { key: "RIV_WDTH+", value: 50, line: 7 },
      { key: "FUTURE_KEY", value: 4, line: 8 },
    ]);
    expect(parse(Buffer.from("\rEND 2\n"), kind)).toEqual([{ key: "END", value: 2, line: 1 }]);
    expect(parse(Buffer.alloc(0), kind)).toEqual([]);
  });

  test("ignores arbitrary bytes after a complete value token without accepting a numeric prefix", () => {
    expect(
      parse(Buffer.concat([Buffer.from("END 2 \t"), Buffer.from([0xff, 0xfe])]), kind),
    ).toEqual([{ key: "END", value: 2, line: 1 }]);
    expectInputError(() => parse("END 2\nEND\n", kind), `mini.${kind}`, "parse", { line: 2 });
    expectInputError(() => parse(`END ${privatePayload}\n`, kind), `mini.${kind}`, "parse", {
      line: 1,
    });
  });
});

const tableCases = [
  {
    kind: "sp.mesh",
    text: smallInputs["sp.mesh"],
    required: ["Node1", "Node2", "Node3", "X", "Y"],
  },
  { kind: "sp.att", text: sections.att, required: ["GEOL"] },
  {
    kind: "sp.riv",
    text: smallInputs["sp.riv"],
    required: ["Index", "Down", "Type", "Length", "Width", "Manning"],
  },
  {
    kind: "para.geol",
    text: sections.geol,
    required: ["KsatH(m_d)", "KsatV(m_d)", "ThetaS(m3_m3)"],
  },
  { kind: "para.lc", text: sections.lc, required: ["ROUGH", "VEGFRAC"] },
  {
    kind: "cfg.ic",
    text: smallInputs["cfg.ic"],
    required: ["Index", "Canopy", "Snow", "Surface", "Unsat", "GW", "Stage"],
  },
  {
    kind: "sp.riv",
    text: smallInputs["sp.riv"] + sections.geometry,
    required: ["From.x", "From.y", "From.z", "To.x", "To.y", "To.z"],
  },
  { kind: "cfg.ic", text: smallInputs["cfg.ic"] + sections.lakes, required: ["LakeStage"] },
] satisfies Array<{ kind: ShudInputKind; text: string; required: string[] }>;

for (const { kind, text, required } of tableCases) {
  describe(`${kind} required columns ${required.join(", ")}`, () => {
    test.each(required)("rejects missing registered column %s without exposing input", (column) => {
      const changed = text.replace(column, privatePayload);
      expectInputError(() => parse(changed, kind), `mini.${kind}`, "parse", { column });
    });
  });
}

describe("strict table shape failures", () => {
  // TabularData.cpp reads dimensions with "%d %d", not the cell-number grammar.
  test.each(["1e0 7", "1.0 7", "0x1 7", "1 7e0", "1 7.0", "1 0x7"])(
    "rejects non-integer-token dimension spelling %j",
    (header) => {
      expectInputError(
        () => parse(sections.lc.replace("1 7", header), "para.lc"),
        "mini.para.lc",
        "parse",
        { line: 1 },
      );
    },
  );

  test.each(["+1 +7", "01 007", "+01 +007"])(
    "accepts signed decimal integer dimensions with leading zeroes %j",
    (header) => {
      expect(parse(sections.lc.replace("1 7", header), "para.lc")).toEqual({
        columns: ["INDEX", "ALBEDO", "VEGFRAC", "ROUGH", "RZD", "SOILDGRD", "IMPAF"],
        rows: [[0, 0.135, 0, 0.035, 0, 0, 0]],
      });
    },
  );

  test.each([
    "",
    "1",
    "-1 7",
    "1 -7",
    "1 0",
    "1.5 7",
    "NaN 7",
    "Infinity 7",
    "9007199254740992 7",
    "1 7 extra",
  ])("rejects malformed dimensions %j", (header) => {
    expectInputError(
      () => parse(sections.lc.replace("1 7", header), "para.lc"),
      "mini.para.lc",
      "parse",
    );
  });

  test.each([
    ["short header", sections.lc.replace(" IMPAF", "")],
    ["extra header", sections.lc.replace(" IMPAF", " IMPAF Extra")],
    ["short row", sections.lc.replace("0 0.135 0 0.035 0 0 0", "0 0.135 0 0.035 0 0")],
    ["extra row cell", sections.lc.replace("0 0.135 0 0.035 0 0 0", "0 0.135 0 0.035 0 0 0 9")],
    ["missing row", sections.lc.replace("1 7", "2 7")],
    ["extra row", sections.lc + "1 0 0 0 0 0 0\n"],
    ["unrecognized trailing bytes", sections.lc + privatePayload],
    ["missing column header", "0 7\n"],
  ])("rejects %s instead of truncating", (_label, text) => {
    expectInputError(() => parse(text, "para.lc"), "mini.para.lc", "parse");
  });

  test.each(["sp.mesh", "sp.riv", "cfg.ic"] as const)(
    "rejects absent mandatory second section in %s",
    (kind) => {
      const first = {
        "sp.mesh": sections.elements,
        "sp.riv": sections.reaches,
        "cfg.ic": sections.icElements,
      }[kind];
      expectInputError(() => parse(first, kind), `mini.${kind}`, "parse");
    },
  );

  test.each([
    ["sp.riv", smallInputs["sp.riv"] + sections.geometry.replace("1 6", "2 6")],
    ["cfg.ic", smallInputs["cfg.ic"] + sections.lakes.replace("1 2", "2 2")],
    ["sp.riv", smallInputs["sp.riv"] + sections.geometry + sections.geometry],
    ["cfg.ic", smallInputs["cfg.ic"] + sections.lakes + sections.lakes],
    ["cfg.ic", smallInputs["cfg.ic"].replace("1 6\n", "1 6 bad\n")],
    ["cfg.ic", smallInputs["cfg.ic"].replace("1 6\n", "1 6 1 2\n")],
  ] as const)("rejects malformed present optional sections for %s", (kind, text) => {
    expectInputError(() => parse(text, kind), `mini.${kind}`, "parse");
  });

  test.each(["sp.mesh", "sp.att", "sp.riv", "para.geol", "para.lc", "cfg.ic"] as const)(
    "rejects empty %s",
    (kind) => {
      expectInputError(() => parse("", kind), `mini.${kind}`, "parse");
    },
  );
});
