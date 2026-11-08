import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AnalysisPlanSchema, type AnalysisPlan } from "@shud-harness/dsh-shud-core";
import { checkCalibProducts } from "./index.ts";
import { snapshotTree } from "./run-metrics-test-harness.ts";
import { sections } from "./shud-text-test-harness.ts";
import { analysisCase } from "./workspace-files-test-harness.ts";

const ccw = fileURLToPath(new URL("../../../SHUD/input/ccw/", import.meta.url));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "calib-products-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("accepts ccw products with exact input digests and leaves every input unchanged", () => {
  const sourceBefore = snapshotTree(ccw);
  const input = join(root, "ccw");
  cpSync(ccw, input, { recursive: true });
  const before = snapshotTree(input);
  const expected = Object.fromEntries(
    ["ccw.cfg.calib", "ccw.para.geol", "ccw.para.lc"].map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(join(input, path)))
        .digest("hex"),
    ]),
  );
  const sets = AnalysisPlanSchema.parse(analysisCase.value).parameter_sets;

  expect(checkCalibProducts(input, "ccw", sets)).toEqual(expected);

  expect(snapshotTree(input)).toEqual(before);
  expect(snapshotTree(ccw)).toEqual(sourceBefore);
});

test("rejects an out-of-range landcover product without changing input bytes or mtime", () => {
  writeFileSync(join(root, "mini.cfg.calib"), "LC_ROUGH 40\n");
  writeFileSync(join(root, "mini.para.lc"), sections.lc.replace("0 0.135 0 0.035", "7 0.135 0 1"));
  const sets: AnalysisPlan["parameter_sets"] = [
    { parameter_set_id: "PSET-1", label: null, baseline: true, changes: {} },
    { parameter_set_id: "PSET-2", label: null, baseline: false, changes: { LC_ROUGH: 0.5 } },
    { parameter_set_id: "PSET-3", label: null, baseline: false, changes: { LC_ROUGH: 2 } },
  ];
  const before = snapshotTree(root);
  let failure: unknown;
  try {
    checkCalibProducts(root, "mini", sets);
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    stage: "product",
    path: "mini.para.lc",
    key: "LC_ROUGH",
    // Zero-based category-table row position, independent of the category's INDEX=7.
    row_index: 0,
    // Independent hand-worked result: (1 / 60) * 40 * 2 = 4 / 3, outside [0, 1].
    product: 1.3333333333333333,
    range: [0, 1],
  });
  expect(snapshotTree(root)).toEqual(before);
});

test("ccw landcover remains in range with baseline forty after its registered conversion", () => {
  const input = join(root, "ccw");
  cpSync(ccw, input, { recursive: true });
  const path = join(input, "ccw.cfg.calib");
  writeFileSync(
    path,
    readFileSync(path, "latin1").replace("LC_ROUGH\t1", "LC_ROUGH\t40"),
    "latin1",
  );
  const before = snapshotTree(input);
  const sets = AnalysisPlanSchema.parse(analysisCase.value).parameter_sets;

  expect(Object.keys(checkCalibProducts(input, "ccw", sets)).sort()).toEqual([
    "ccw.cfg.calib",
    "ccw.para.geol",
    "ccw.para.lc",
  ]);
  expect(snapshotTree(input)).toEqual(before);
});
