import { describe, expect, test } from "vitest";
import { parseShudTextInput } from "./index.ts";
import {
  expectInputError,
  privatePayload,
  sections,
  smallInputs,
} from "./shud-text-test-harness.ts";

// Expected doubles are literal independent C strtod reference results, not a second
// implementation of the parser. No runtime dependency on the investigation artifacts.
const numericCases: Array<[string, number]> = [
  ["0", 0],
  ["-0", -0],
  ["+0.0", 0],
  ["-0.0e99", -0],
  [".5", 0.5],
  ["1.", 1],
  ["+12.5", 12.5],
  ["-1.25e-3", -0.00125],
  ["1E+3", 1000],
  ["1e309", Infinity],
  ["-1e309", -Infinity],
  ["1e-9999", 0],
  ["-1e-9999", -0],
  ["inf", Infinity],
  ["+INFINITY", Infinity],
  ["-InF", -Infinity],
  ["nan", NaN],
  ["+NaN", NaN],
  ["-NAN", NaN],
  ["nan()", NaN],
  ["NaN(payload_647)", NaN],
  ["-nan(0x123)", NaN],
  ["0x1p0", 1],
  ["0x1.8p+2", 6],
  ["0x1.8", 1.5],
  ["+0X.Ap-1", 0.3125],
  ["0x1.", 1],
  ["0x10", 16],
  ["-0x0p0", -0],
  ["0x1.00000000000008p0", 1],
  ["0x1.000000000000080001p0", 1.0000000000000002],
  ["0x1.00000000000018p0", 1.0000000000000004],
  ["0x1p-1022", 2.2250738585072014e-308],
  ["0x0.fffffffffffffp-1022", 2.225073858507201e-308],
  ["0x1p-1074", 5e-324],
  ["0x1p-1075", 0],
  ["0x1.0000000000001p-1075", 5e-324],
  ["-0x1p-1075", -0],
  ["0x1.fffffffffffffp1023", 1.7976931348623157e308],
  ["0x1.fffffffffffff8p1023", Infinity],
  ["0x1p99999", Infinity],
  ["-0x1p99999", -Infinity],
  ["0x1p-99999", 0],
  ["-0x1p-99999", -0],
  ["0x10000000000000000000000000000000000000000000000000000000000000001p-256", 1],
];

const malformed = [
  "93abc",
  "bad",
  "1e",
  "1e+",
  "1e-",
  ".",
  "+",
  "--1",
  "1_000",
  "1,2",
  "0x",
  "0x.p1",
  "0x1p",
  "0x1p+",
  "0x1p1suffix",
  "0x1g",
  "0b10",
  "0o10",
  "Infinityx",
  "nan(payload",
  "nan(a-b)",
  "nan()tail",
  privatePayload,
];

// The complete independent boundary matrix runs once through a public table parser.
// Other dispatch paths retain representative grammar cases already exercised in RED.
const numericSeams = ["table", "cfg.para", "cfg.calib", "IC time"] as const;
const representativeTokens = ["-0", "-1.25e-3", "0x1.8p+2", "inf", "-InF", "nan"];
const representativeNumbers = numericCases.filter(([token]) =>
  representativeTokens.includes(token),
);
const representativeMalformed = malformed.filter((token) =>
  ["93abc", "bad", "1e+", "0x1p"].includes(token),
);

describe.each(numericSeams)("%s full-token numeric grammar", (seam) => {
  function value(token: string): number {
    if (seam === "table") {
      const text = sections.geol.replace("13 1.5", `13 ${token}`);
      return parseShudTextInput(Buffer.from(text), "numbers.para.geol", "para.geol").rows[0][1];
    }
    if (seam === "IC time") {
      const text = smallInputs["cfg.ic"].replace("1 6\n", `1 6 ${token}\n`);
      return parseShudTextInput(Buffer.from(text), "numbers.cfg.ic", "cfg.ic").time_min!;
    }
    return parseShudTextInput(Buffer.from(`GEOL_KSATV ${token}\n`), `numbers.${seam}`, seam)[0]
      .value;
  }

  test.each(seam === "table" ? numericCases : representativeNumbers)(
    "preserves %s as the independent expected double",
    (token, expected) => {
      expect(value(token)).toBe(expected); // Object.is also distinguishes -0 and accepts NaN.
    },
  );

  test.each(seam === "table" ? malformed : representativeMalformed)(
    "rejects the whole malformed token %s with a controlled location",
    (token) => {
      const path =
        seam === "table"
          ? "numbers.para.geol"
          : seam === "IC time"
            ? "numbers.cfg.ic"
            : `numbers.${seam}`;
      expectInputError(
        () => value(token),
        path,
        "parse",
        seam === "table" ? { column: "KsatH(m_d)", line: 3 } : { line: 1 },
      );
    },
  );
});

test.each([
  ["sp.mesh", smallInputs["sp.mesh"].replace("7 3 1 2", "7 nan inf -infinity"), "elements"],
  ["sp.att", sections.att.replace("7 2 13", "7 nan infinity"), "table"],
  ["sp.riv", smallInputs["sp.riv"].replace("9 -3 4", "9 nan infinity"), "reaches"],
  ["para.lc", sections.lc.replace("0 0.135 0", "0 nan infinity"), "table"],
  ["cfg.ic", smallInputs["cfg.ic"].replace("7 0.1 0.2", "7 nan infinity"), "elements"],
] as const)("%s retains nonfinite cells for later consumers", (kind, text, section) => {
  const data = parseShudTextInput(Buffer.from(text), `numbers.${kind}`, kind);
  const table =
    section === "table" && "rows" in data
      ? data
      : "elements" in data
        ? data.elements
        : "reaches" in data
          ? data.reaches
          : undefined;
  expect(table?.rows[0]?.[1]).toBeNaN();
  expect(table?.rows[0]?.[2]).toBe(Infinity);
});

test.each(["cfg.para", "cfg.calib"] as const)(
  "%s does not reuse the preceding value when the next value is missing",
  (kind) => {
    expectInputError(
      () => parseShudTextInput(Buffer.from("GEOL_KSATV 2\nGEOL_KSATH\n"), `numbers.${kind}`, kind),
      `numbers.${kind}`,
      "parse",
      { line: 2 },
    );
  },
);
