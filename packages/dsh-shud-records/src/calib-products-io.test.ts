import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { checkCalibProducts } from "./index.ts";
import { parameterSets, seedCalibInputs } from "./calib-products-test-harness.ts";
import { snapshotTree } from "./run-metrics-test-harness.ts";
import { installUnsafe } from "./test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
const sets = parameterSets([{ GEOL_KSATH: 0.5 }, { GEOL_KSATH: 2 }, { GEOL_KSATV: 2 }]);
let root: string;
let input: string;
beforeEach(() => {
  root = native.mkdtempSync(join(tmpdir(), "calib-io-"));
  input = join(root, "input");
  native.mkdirSync(input);
  seedCalibInputs(input);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(native.lstatSync);
  vi.mocked(fs.openSync).mockReset().mockImplementation(native.openSync);
  vi.mocked(fs.readSync).mockReset().mockImplementation(native.readSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(native.closeSync);
});
afterEach(() => {
  vi.restoreAllMocks();
  native.rmSync(root, { recursive: true, force: true });
});

test("repeated keys and a shared geology table consume each required file once for values and hashes", () => {
  const paths = ["mini.cfg.calib", "mini.para.geol"];
  const physicalInput = native.realpathSync.native(input);
  const expected = Object.fromEntries(
    paths.map((path) => [
      path,
      createHash("sha256")
        .update(native.readFileSync(join(input, path)))
        .digest("hex"),
    ]),
  );
  const before = snapshotTree(root);
  const descriptors = new Map<number, string>();
  const bytesRead = new Map<string, number>();
  vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
    const fd = native.openSync(path, flags, mode);
    descriptors.set(fd, String(path));
    return fd;
  });
  vi.mocked(fs.readSync).mockImplementation((...args) => {
    const count = native.readSync(...args);
    const path = descriptors.get(args[0])!;
    bytesRead.set(path, (bytesRead.get(path) ?? 0) + count);
    return count;
  });

  expect(checkCalibProducts(input, "mini", sets)).toEqual(expected);

  expect(fs.openSync).toHaveBeenCalledTimes(2);
  expect(fs.closeSync).toHaveBeenCalledTimes(2);
  expect(
    vi
      .mocked(fs.openSync)
      .mock.calls.map(([path]) => String(path))
      .sort(),
  ).toEqual(paths.map((path) => join(physicalInput, path)).sort());
  for (const [path, count] of bytesRead) expect(count).toBe(native.statSync(path).size);
  for (const [, flags] of vi.mocked(fs.openSync).mock.calls) {
    expect(flags).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  }
  expect(snapshotTree(root)).toEqual(before);
});

const allSets = parameterSets([
  { GEOL_KSATH: 2 },
  { GEOL_KSATV: 2 },
  { LC_ROUGH: 2 },
  { RIV_ROUGH: 2 },
]);
describe.each(["mini.cfg.calib", "mini.para.geol", "mini.para.lc", "mini.sp.riv"])(
  "%s required file",
  (path) => {
    test("missing files cannot supply calibration products", () => {
      native.unlinkSync(join(input, path));
      const before = snapshotTree(root);
      expect(() => checkCalibProducts(input, "mini", allSets)).toThrowError(
        expect.objectContaining({ stage: "missing", path }),
      );
      expect(snapshotTree(root)).toEqual(before);
    });

    test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
      "rejects a %s without following or reading it",
      (kind) => {
        const outside = join(root, "outside");
        native.writeFileSync(outside, "private-input-653\n");
        native.unlinkSync(join(input, path));
        installUnsafe(join(input, path), kind, outside);
        const before = snapshotTree(root);
        expect(() => checkCalibProducts(input, "mini", allSets)).toThrowError(
          expect.objectContaining({ stage: "unsafe", path }),
        );
        expect(vi.mocked(fs.openSync).mock.calls.map(([file]) => String(file))).not.toContain(
          join(native.realpathSync.native(input), path),
        );
        expect(snapshotTree(root)).toEqual(before);
      },
    );
  },
);

const unchecked = checkCalibProducts as (
  directory: string,
  project: unknown,
  sets: unknown,
) => unknown;
test.each(["../mini", "mini/child", "mini\\child", "", ".", "..", "mini\0", null, 1])(
  "invalid project %j rejects before filesystem access",
  (project) => {
    expect(() => unchecked(input, project, sets)).toThrowError(
      expect.objectContaining({ stage: "input", reason: "project" }),
    );
    expect(fs.lstatSync).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
  },
);

const invalidSets: unknown[] = [
  null,
  [],
  [{}],
  parameterSets([{ SOIL_BETA: 2 } as never, { GEOL_KSATH: 2 }]),
  parameterSets([{ geol_ksath: 2 } as never, { GEOL_KSATH: 2 }]),
  ...[0.49, 2.01, 1, NaN, Infinity, "2"].map((value) =>
    parameterSets([{ GEOL_KSATH: value as number }, { LC_ROUGH: 2 }]),
  ),
];
test.each(invalidSets.map((value) => ({ value })))(
  "invalid runtime parameter sets reject before filesystem access ($value)",
  ({ value }) => {
    expect(() => unchecked(input, "mini", value)).toThrowError(
      expect.objectContaining({ stage: "input", reason: "parameter_sets" }),
    );
    expect(fs.lstatSync).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
  },
);

test("native read failures close the owned descriptor and hide arbitrary content", () => {
  const before = snapshotTree(root);
  vi.mocked(fs.readSync).mockImplementationOnce(() => {
    throw new Error("private-native-653", { cause: new Error("private-input-653") });
  });
  let caught: unknown;
  try {
    checkCalibProducts(input, "mini", sets);
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ stage: "read", path: "mini.cfg.calib" });
  expect(inspect(caught, { depth: null })).not.toContain("private-");
  expect(caught).not.toHaveProperty("cause");
  expect(fs.closeSync).toHaveBeenCalledTimes(1);
  expect(snapshotTree(root)).toEqual(before);
});

test("all registered categories produce exactly the schema-required digest union", () => {
  const paths = ["mini.cfg.calib", "mini.para.geol", "mini.para.lc", "mini.sp.riv"];
  const expected = Object.fromEntries(
    paths.map((path) => [
      path,
      createHash("sha256")
        .update(native.readFileSync(join(input, path)))
        .digest("hex"),
    ]),
  );
  const before = snapshotTree(root);

  expect(checkCalibProducts(input, "mini", allSets)).toEqual(expected);

  expect(fs.openSync).toHaveBeenCalledTimes(4);
  expect(fs.closeSync).toHaveBeenCalledTimes(4);
  expect(snapshotTree(root)).toEqual(before);
});

test.each(["absent", "file"] as const)(
  "an %s input directory fails without creating or repairing paths",
  (kind) => {
    const path = join(root, "unusable");
    if (kind === "file") native.writeFileSync(path, "private-input-653");
    const before = snapshotTree(root);

    expect(() => checkCalibProducts(path, "mini", sets)).toThrow();

    expect(fs.openSync).not.toHaveBeenCalled();
    expect(snapshotTree(root)).toEqual(before);
  },
);

test("physical input-directory traversal cannot read a lexical calibration decoy", () => {
  native.mkdirSync(join(input, "child"));
  const alias = join(root, "alias");
  native.symlinkSync(join(input, "child"), alias);
  native.writeFileSync(join(root, "mini.cfg.calib"), "private-decoy-653 malformed\n");
  const before = snapshotTree(root);
  const expected = checkCalibProducts(input, "mini", sets);

  expect(checkCalibProducts(`${alias}/..`, "mini", sets)).toEqual(expected);

  expect(snapshotTree(root)).toEqual(before);
});
