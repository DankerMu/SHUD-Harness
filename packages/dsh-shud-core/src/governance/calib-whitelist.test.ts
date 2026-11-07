import { describe, expect, test } from "vitest";
import { CALIB_MULTIPLIER_RANGE, CALIB_WHITELIST } from "../index.ts";

// Independent expectations audited against pinned SHUD readers and checkValue calls.
const SOURCE_CASES = [
  {
    key: "GEOL_KSATH",
    table: "<project>.para.geol",
    column: "KsatH(m_d)",
    divisor: 1440,
    range: [0, 1000],
    readSource: "SHUD/src/ModelData/MD_readin.cpp:324",
    calibSource: "SHUD/src/classes/ModelConfigure.cpp:98",
    rangeSource: "SHUD/src/classes/ModelConfigure.cpp:110",
  },
  {
    key: "GEOL_KSATV",
    table: "<project>.para.geol",
    column: "KsatV(m_d)",
    divisor: 1440,
    range: [0, 1000],
    readSource: "SHUD/src/ModelData/MD_readin.cpp:325",
    calibSource: "SHUD/src/classes/ModelConfigure.cpp:99",
    rangeSource: "SHUD/src/classes/ModelConfigure.cpp:111",
  },
  {
    key: "LC_ROUGH",
    table: "<project>.para.lc",
    column: "ROUGH",
    divisor: 60,
    range: [0, 1],
    readSource: "SHUD/src/ModelData/MD_readin.cpp:349",
    calibSource: "SHUD/src/classes/ModelConfigure.cpp:121",
    rangeSource: "SHUD/src/classes/ModelConfigure.cpp:130",
  },
  {
    key: "RIV_ROUGH",
    table: "<project>.sp.riv",
    column: "Manning",
    divisor: 60,
    range: null,
    readSource: "SHUD/src/classes/River.cpp:29",
    calibSource: "SHUD/src/classes/River.cpp:40",
    rangeSource: null,
  },
] as const;

describe("calibration whitelist", () => {
  test("registers exactly the four multiplicative calibration keys", () => {
    expect(Object.keys(CALIB_WHITELIST)).toEqual([
      "GEOL_KSATH",
      "GEOL_KSATV",
      "LC_ROUGH",
      "RIV_ROUGH",
    ]);
  });

  test.each(["GEOL_THETAS", "TS_SFCTMP+", "geol_ksath", "SOIL_BETA"])(
    "does not register unsupported key %s",
    (key) => {
      expect(Object.hasOwn(CALIB_WHITELIST, key)).toBe(false);
    },
  );

  test.each(SOURCE_CASES)("maps $key to its audited category file and column", (expected) => {
    const entry = CALIB_WHITELIST[expected.key];
    expect(entry.key).toBe(expected.key);
    expect(entry.table).toBe(expected.table);
    expect(entry.column).toBe(expected.column);
  });

  test.each(SOURCE_CASES)("preserves the serializable SHUD read divisor for $key", (expected) => {
    const transform = CALIB_WHITELIST[expected.key].read_transform;
    expect(transform).toEqual({ operation: "divide", divisor: expected.divisor });
  });

  test.each(SOURCE_CASES)("registers the actual SHUD range or absence for $key", (expected) => {
    expect(CALIB_WHITELIST[expected.key].check_range).toEqual(expected.range);
  });

  test.each(SOURCE_CASES)("cites the pinned read and calibration sources for $key", (expected) => {
    const sources = CALIB_WHITELIST[expected.key].source;
    expect(sources).toContain(expected.readSource);
    expect(sources).toContain(expected.calibSource);
    if (expected.rangeSource !== null) expect(sources).toContain(expected.rangeSource);
    for (const source of sources) expect(source).toMatch(/^SHUD\/src\/[^:]+:\d+$/);
  });

  test("documents the absent river range check without borrowing the landcover check", () => {
    const river = CALIB_WHITELIST.RIV_ROUGH;
    expect(river.check_range).toBeNull();
    expect(river.source).toContain("SHUD/src/ModelData/MD_CheckInputData.cpp:2");
    expect(river.source).not.toContain("SHUD/src/classes/ModelConfigure.cpp:130");
  });

  test("prevents runtime extension or replacement of the closed registration", () => {
    expect(Object.isFrozen(CALIB_WHITELIST)).toBe(true);
    expect(Reflect.set(CALIB_WHITELIST, "GEOL_THETAS", {})).toBe(false);
    expect(Reflect.set(CALIB_WHITELIST, "GEOL_KSATH", {})).toBe(false);
    expect(Reflect.deleteProperty(CALIB_WHITELIST, "RIV_ROUGH")).toBe(false);
    expect(CALIB_WHITELIST.GEOL_KSATH.column).toBe("KsatH(m_d)");
    expect(CALIB_WHITELIST.RIV_ROUGH.column).toBe("Manning");
  });

  test.each(SOURCE_CASES)(
    "prevents nested mutation of $key facts and source arrays",
    (expected) => {
      const entry = CALIB_WHITELIST[expected.key];
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.read_transform)).toBe(true);
      expect(Object.isFrozen(entry.source)).toBe(true);
      expect(Reflect.set(entry, "table", "<project>.para.soil")).toBe(false);
      expect(Reflect.set(entry.read_transform, "divisor", 1)).toBe(false);
      expect(Reflect.set(entry.source, "0", "invented source")).toBe(false);
      expect(Reflect.set(entry.source, "length", 0)).toBe(false);
      if (entry.check_range !== null) {
        expect(Object.isFrozen(entry.check_range)).toBe(true);
        expect(Reflect.set(entry.check_range, "0", -1)).toBe(false);
        expect(Reflect.set(entry.check_range, "1", Infinity)).toBe(false);
      }
      expect(entry.table).toBe(expected.table);
      expect(entry.read_transform.divisor).toBe(expected.divisor);
      expect(entry.check_range).toEqual(expected.range);
      expect(entry.source).toContain(expected.readSource);
    },
  );
});

describe("calibration multiplier bounds", () => {
  test("publishes the inclusive half-to-double interval without a runtime override", () => {
    expect(CALIB_MULTIPLIER_RANGE).toEqual([0.5, 2]);
    expect(Object.isFrozen(CALIB_MULTIPLIER_RANGE)).toBe(true);
    expect(Reflect.set(CALIB_MULTIPLIER_RANGE, "0", 0.49)).toBe(false);
    expect(Reflect.set(CALIB_MULTIPLIER_RANGE, "1", 2.01)).toBe(false);
    expect(Reflect.set(CALIB_MULTIPLIER_RANGE, "2", 3)).toBe(false);
    expect(CALIB_MULTIPLIER_RANGE).toEqual([0.5, 2]);
  });
});
