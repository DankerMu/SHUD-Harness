import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { cardPath, expectToolError } from "./task-linked/test-harness.ts";
import {
  analysesDir,
  analysisHarness,
  seedCard,
  validArgs,
  workspaceSnapshot,
  type AnalysisHarness,
} from "./analysis-create/test-harness.ts";

let h: AnalysisHarness;
beforeEach(async () => {
  h = await analysisHarness();
  seedCard(h);
});
afterEach(async () => {
  await h.dispose();
});

async function expectRejected(args: unknown, message: RegExp) {
  const before = await workspaceSnapshot(h);
  const text = expectToolError(await h.invoke(args), message);
  expect(await workspaceSnapshot(h)).toEqual(before);
  return text;
}

test.each(["symlink", "file"])("analyses as a %s is named and gains nothing", async (kind) => {
  const outside = join(h.root, "outside-analyses");
  fs.mkdirSync(outside);
  if (kind === "symlink") fs.symlinkSync(outside, analysesDir(h));
  else fs.writeFileSync(analysesDir(h), "not a directory\n");
  const card = fs.readFileSync(cardPath(h));
  await expectRejected(validArgs, /analyses/u);
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.readFileSync(cardPath(h))).toEqual(card);
});

const sets = validArgs.parameter_sets;
test.each([
  {
    label: "absent input_dir",
    prepare() {},
    args: { ...validArgs, input_dir: "input/absent" },
    message: /input_dir/u,
  },
  {
    label: "file input_dir",
    prepare() {
      fs.writeFileSync(join(h.cwd, "input", "file"), "not a directory\n");
    },
    args: { ...validArgs, input_dir: "input/file", project: "ccw" },
    message: /input_dir.*directory/u,
  },
  ...["ccw.cfg.para", "ccw.cfg.calib", "ccw.para.geol", "ccw.para.lc"].map((file) => ({
    label: `missing ${file}`,
    prepare() {
      fs.rmSync(join(h.input, file));
    },
    args: validArgs,
    message: new RegExp(file.replaceAll(".", "\\."), "u"),
  })),
  {
    label: "symlinked category table",
    prepare() {
      const target = join(h.root, "outside.para.lc");
      fs.renameSync(join(h.input, "ccw.para.lc"), target);
      fs.symlinkSync(target, join(h.input, "ccw.para.lc"));
    },
    args: validArgs,
    message: /ccw\.para\.lc/u,
  },
])("$label is named without writes", async (row) => {
  row.prepare();
  await expectRejected(row.args, row.message);
});

test.each([
  {
    label: "two baselines",
    parameter_sets: [sets[0], sets[0], sets[1], sets[2]],
  },
  {
    label: "two-key perturbation",
    parameter_sets: [
      sets[0],
      { baseline: false, changes: { GEOL_KSATH: 2, LC_ROUGH: 2 } },
      sets[3],
    ],
  },
  {
    label: "multiplier 2.5",
    parameter_sets: [sets[0], sets[1], { baseline: false, changes: { GEOL_KSATH: 2.5 } }],
  },
  {
    label: "non-whitelisted SOIL_BETA",
    parameter_sets: [sets[0], sets[1], { baseline: false, changes: { SOIL_BETA: 2 } }],
  },
  { label: "too few sets", parameter_sets: [sets[0], sets[1]] },
  { label: "empty label", parameter_sets: [{ ...sets[0], label: "" }, sets[1], sets[2]] },
])("$label names parameter_sets and writes nothing", async ({ parameter_sets }) => {
  await expectRejected({ ...validArgs, parameter_sets }, /parameter_sets/u);
});

test("an out-of-range product names the key, row and range without writes", async () => {
  const calib = join(h.input, "ccw.cfg.calib");
  fs.writeFileSync(
    calib,
    fs.readFileSync(calib, "latin1").replace("GEOL_KSATH\t1", "GEOL_KSATH\t1e9"),
    "latin1",
  );
  await expectRejected(validArgs, /GEOL_KSATH.*row 0.*range \[0, 1000\]/u);
});

test("a missing calibration key is named without writes", async () => {
  const calib = join(h.input, "ccw.cfg.calib");
  fs.writeFileSync(
    calib,
    fs
      .readFileSync(calib, "latin1")
      .split("\n")
      .filter((line) => !line.startsWith("LC_ROUGH"))
      .join("\n"),
    "latin1",
  );
  await expectRejected(validArgs, /missing.*LC_ROUGH/u);
});
