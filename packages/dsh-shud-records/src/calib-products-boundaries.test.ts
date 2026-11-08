import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkCalibProducts, CalibProductError, ShudInputError } from "./index.ts";
import { snapshotTree } from "./run-metrics-test-harness.ts";
import {
  categoryCases,
  parameterSets,
  seedCalibInputs,
  writeCategory,
  type CalibKey,
} from "./calib-products-test-harness.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "calib-boundaries-"));
  seedCalibInputs(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function check(key: CalibKey) {
  return checkCalibProducts(root, "mini", parameterSets([{ [key]: 0.5 }, { [key]: 2 }]));
}
function baseline(key: CalibKey, value: string) {
  writeFileSync(`${root}/mini.cfg.calib`, `${key} ${value}\n`);
}
function failure(action: () => unknown) {
  const before = snapshotTree(root);
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(snapshotTree(root)).toEqual(before);
  return caught;
}

// Independent numeric examples from the specified read conversions, not policy introspection.
test.each([
  ["GEOL_KSATH", "720000"],
  ["GEOL_KSATV", "720000"],
  ["LC_ROUGH", "30"],
  ["RIV_ROUGH", "60"],
] as const)("%s applies its read conversion before both multipliers", (key, raw) => {
  const path = writeCategory(root, key, raw);
  expect(Object.keys(check(key)).sort()).toEqual(["mini.cfg.calib", path].sort());
});

test.each([
  ["GEOL_KSATH", "1440000", 2000, [0, 1000]],
  ["GEOL_KSATV", "1440000", 2000, [0, 1000]],
  ["LC_ROUGH", "60", 2, [0, 1]],
] as const)("%s checks a repeated key's second multiplier", (key, raw, product, range) => {
  const path = writeCategory(root, key, raw);
  expect(failure(() => check(key))).toMatchObject({
    stage: "product",
    key,
    path,
    row_index: 0,
    product,
    range,
  });
});

test.each(["GEOL_KSATH", "GEOL_KSATV", "LC_ROUGH"] as const)(
  "%s accepts zero and a negative baseline when the resulting products are in range",
  (key) => {
    writeCategory(root, key, "0");
    baseline(key, "0");
    expect(check(key)).toHaveProperty(["mini.cfg.calib"]);
    writeCategory(root, key, "-1");
    baseline(key, "-1");
    expect(check(key)).toHaveProperty(["mini.cfg.calib"]);
    baseline(key, "1");
    expect(failure(() => check(key))).toMatchObject({ stage: "product", key, row_index: 0 });
  },
);

test.each(["0", "-1", "5e-324", "nan", "inf", "-inf"])(
  "river raw Manning %s cannot produce a finite positive product",
  (raw) => {
    writeCategory(root, "RIV_ROUGH", raw);
    const caught = failure(() => check("RIV_ROUGH"));
    expect(caught).toMatchObject({
      stage: "product",
      key: "RIV_ROUGH",
      row_index: 0,
      range: "finite-positive",
    });
    if (raw === "0" || raw === "5e-324") expect(caught).toMatchObject({ product: 0 });
  },
);

test("river conversion precedes multiplication and has no finite upper bound", () => {
  writeCategory(root, "RIV_ROUGH", "1e308");
  baseline("RIV_ROUGH", "2");
  expect(check("RIV_ROUGH")).toHaveProperty(["mini.sp.riv"]);
});

test("intermediate overflow is not repaired by regrouping the later multiplier", () => {
  writeCategory(root, "RIV_ROUGH", "1e308");
  baseline("RIV_ROUGH", "120");
  expect(failure(() => check("RIV_ROUGH"))).toMatchObject({ stage: "product", product: Infinity });
});

test.each(["GEOL_KSATH", "GEOL_KSATV", "LC_ROUGH"] as const)(
  "%s rejects nonfinite products even with a zero baseline",
  (key) => {
    writeCategory(root, key, "inf");
    baseline(key, "0");
    expect(failure(() => check(key))).toMatchObject({ stage: "product", key, product: NaN });
  },
);

test("the second landcover row is checked and reported by zero-based position", () => {
  writeFileSync(
    `${root}/mini.para.lc`,
    "2 7\nINDEX ALBEDO VEGFRAC ROUGH RZD SOILDGRD IMPAF\n7 0 0 1 0 0 0\n92 0 0 120 0 0 0\n",
  );
  expect(failure(() => check("LC_ROUGH"))).toMatchObject({
    key: "LC_ROUGH",
    row_index: 1,
    product: 4,
    range: [0, 1],
  });
});

describe.each(categoryCases)("$key calibration and category failures", ({ key, path }) => {
  test.each(["", "#KEY 1\n", " KEY 1\n", "\0KEY 1\n", "\n"])(
    "rejects missing effective key in %j",
    (text) => {
      writeFileSync(`${root}/mini.cfg.calib`, text.replaceAll("KEY", key));
      expect(failure(() => check(key))).toMatchObject({
        stage: "calibration",
        reason: "missing",
        key,
        path: "mini.cfg.calib",
      });
    },
  );
  test("accepts tab-leading mixed-case entries while skipping first-byte comments", () => {
    writeFileSync(
      `${root}/mini.cfg.calib`,
      `#${key} bad\n ${key} bad\n\0${key} bad\n\n\t${key.toLowerCase()} 1\r\n`,
    );
    expect(check(key)).toHaveProperty([path]);
  });
  test("rejects case-insensitive duplicate effective keys", () => {
    writeFileSync(`${root}/mini.cfg.calib`, `${key} 1\n${key.toLowerCase()} 2\n`);
    expect(failure(() => check(key))).toMatchObject({
      stage: "calibration",
      reason: "duplicate",
      key,
    });
  });
  test.each(["nan", "inf", "-Infinity", "1e309"])("rejects nonfinite baseline %s", (value) => {
    baseline(key, value);
    expect(failure(() => check(key))).toMatchObject({
      stage: "calibration",
      reason: "nonfinite",
      key,
    });
  });
  test.each(["private-secret-653", "1suffix", ""])(
    "malformed baseline %j names requested keys without source payload",
    (value) => {
      baseline(key, value);
      const caught = failure(() => check(key));
      expect(caught).toBeInstanceOf(CalibProductError);
      expect(caught).toMatchObject({
        stage: "calibration",
        reason: "parse",
        keys: [key],
        path: "mini.cfg.calib",
      });
      expect(inspect(caught, { depth: null })).not.toContain("private-secret-653");
      expect(caught).not.toHaveProperty("cause");
    },
  );
  test("rejects malformed category numbers without exposing the token", () => {
    writeCategory(root, key, "badcell");
    const caught = failure(() => check(key));
    expect(caught).toBeInstanceOf(ShudInputError);
    expect(caught).toMatchObject({ stage: "parse", path });
    expect(inspect(caught, { depth: null })).not.toContain("badcell");
  });
  test("rejects a missing registered column", () => {
    const column = {
      GEOL_KSATH: "KsatH(m_d)",
      GEOL_KSATV: "KsatV(m_d)",
      LC_ROUGH: "ROUGH",
      RIV_ROUGH: "Manning",
    }[key];
    const text = readFileSync(`${root}/${path}`, "utf8");
    writeFileSync(`${root}/${path}`, text.replace(column, "private-secret-653"));
    const caught = failure(() => check(key));
    expect(caught).toMatchObject({ stage: "parse", path, column });
    expect(inspect(caught, { depth: null })).not.toContain("private-secret-653");
  });
});

test("malformed calibration lists all requested registered keys without blaming an unparsed token", () => {
  writeFileSync(`${root}/mini.cfg.calib`, "private-secret-653 bad\n");
  const caught = failure(() =>
    checkCalibProducts(root, "mini", parameterSets([{ GEOL_KSATV: 2 }, { LC_ROUGH: 2 }])),
  );
  expect(caught).toMatchObject({ stage: "calibration", keys: ["GEOL_KSATV", "LC_ROUGH"] });
  expect(inspect(caught, { depth: null })).not.toContain("private-secret-653");
});

test("river baseline positivity is judged by its resulting product", () => {
  writeCategory(root, "RIV_ROUGH", "-60");
  baseline("RIV_ROUGH", "-1");
  expect(check("RIV_ROUGH")).toHaveProperty(["mini.sp.riv"]);
  baseline("RIV_ROUGH", "0");
  expect(failure(() => check("RIV_ROUGH"))).toMatchObject({
    stage: "product",
    range: "finite-positive",
  });
});

test.each([
  ["GEOL_KSATH", "1e-303"],
  ["GEOL_KSATV", "1e-303"],
  ["LC_ROUGH", "1e-308"],
] as const)("%s transforms large finite values before applying small baselines", (key, value) => {
  writeCategory(root, key, "1e308");
  baseline(key, value);
  expect(check(key)).toHaveProperty(["mini.cfg.calib"]);
});

test("malformed calibration retains its physical line without exposing unrelated bytes", () => {
  writeFileSync(`${root}/mini.cfg.calib`, "#ignored\n\nLC_ROUGH private-secret-653\n");
  const caught = failure(() => check("LC_ROUGH"));
  expect(caught).toMatchObject({
    stage: "calibration",
    path: "mini.cfg.calib",
    keys: ["LC_ROUGH"],
    line: 3,
  });
  expect(inspect(caught, { depth: null })).not.toContain("private-secret-653");
});
