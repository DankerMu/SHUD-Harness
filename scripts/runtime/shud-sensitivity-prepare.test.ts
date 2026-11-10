import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { snapshotTree } from "../../packages/dsh-shud-records/src/report-code-change-test-harness.ts";
import * as inputFile from "../../packages/dsh-shud-records/src/shud-input-file.ts";
import {
  SOURCE_FILES,
  fileHashes,
  fileList,
  hash,
  makeSensitivityHarness,
  type SensitivityHarness,
} from "./sensitivity/test-harness.ts";
import {
  ccwSha256,
  prepareSensitivityWorkspace,
  type SensitivityPrepareInput,
} from "./shud-sensitivity-prepare.ts";

vi.mock("../../packages/dsh-shud-records/src/shud-input-file.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof inputFile>();
  return { ...actual, readShudInputFile: vi.fn(actual.readShudInputFile) };
});
const readSpy = vi.mocked(inputFile.readShudInputFile);
const MANAGED = ["tasks", "runs", "reports", "stacks", "provenance", "analyses"];
const SORTED_NAMES = Object.keys(SOURCE_FILES).sort();

let h: SensitivityHarness;
beforeEach(() => {
  h = makeSensitivityHarness();
  readSpy.mockClear();
});
afterEach(() => h.dispose());

function prepare(overrides: Partial<SensitivityPrepareInput> = {}) {
  return prepareSensitivityWorkspace({
    workspace: h.workspace,
    recordPath: h.record,
    root: h.root,
    env: h.env,
    ...overrides,
  });
}

/** Failure contract: names the item, never creates the copy or the record, source untouched. */
async function expectRejected(
  item: string,
  overrides: Partial<SensitivityPrepareInput> = {},
): Promise<void> {
  const record = overrides.recordPath ?? h.record;
  const source = snapshotTree(h.source);
  await expect(prepare(overrides)).rejects.toThrow(item);
  expect(fs.existsSync(record)).toBe(false);
  expect(fs.existsSync(join(h.workspace, "input/ccw"))).toBe(false);
  expect(snapshotTree(h.source)).toEqual(source);
}

test("copies the constructed ccw source and records independently computed start hashes", async () => {
  const sourceBefore = snapshotTree(h.source);
  const headsBefore = h.heads();
  fs.mkdirSync(join(h.root, "data/raw/nested"), { recursive: true });
  fs.writeFileSync(join(h.root, "data/raw/nested/station.bin"), Buffer.from([1, 2, 3]));
  fs.mkdirSync(h.workspace);

  const record = await prepare();

  const copy = join(h.workspace, "input/ccw");
  const expectedSha = Object.fromEntries(
    SORTED_NAMES.map((name) => [name, hash("sha256", SOURCE_FILES[name])]),
  );
  const expectedMd5 = Object.fromEntries(
    SORTED_NAMES.map((name) => [name, hash("md5", SOURCE_FILES[name])]),
  );
  expect(fileList(copy)).toEqual(SORTED_NAMES);
  expect(fileHashes(copy, "sha256")).toEqual(expectedSha);
  expect(record).toEqual({
    workspace: h.workspace,
    source: h.source,
    source_md5: expectedMd5,
    source_sha256: expectedSha,
    copy_sha256: expectedSha,
    submodules: headsBefore,
    raw: {
      exists: true,
      md5: { "harness/nested/station.bin": hash("md5", Buffer.from([1, 2, 3])) },
      roots: { harness: true, workspace: false },
    },
  });
  for (const map of [record.source_md5, record.source_sha256, record.copy_sha256])
    expect(Object.keys(map)).toEqual(SORTED_NAMES);
  expect(JSON.parse(fs.readFileSync(h.record, "utf8"))).toEqual(record);
  expect(fileList(h.evidence)).toEqual(["preparation.json"]);
  expect(Object.values(record.submodules).every((head) => /^[0-9a-f]{40}$/u.test(head))).toBe(true);
  expect(h.heads()).toEqual(headsBefore);
  expect(snapshotTree(h.source)).toEqual(sourceBefore);
  expect(fileList(h.dshHome)).toEqual(["sentinel"]);
});

test("creates an absent workspace and records absent data/raw as exists:false", async () => {
  const record = await prepare();
  expect(fileList(h.workspace)).toEqual(SORTED_NAMES.map((name) => `input/ccw/${name}`));
  expect(record.raw).toEqual({
    exists: false,
    md5: {},
    roots: { harness: false, workspace: false },
  });
  expect(ccwSha256(join(h.workspace, "input/ccw"))).toEqual(record.copy_sha256);
});

test("accepts a workspace under the unresolved os.tmpdir() alias and records its physical path", async () => {
  const parent = fs.mkdtempSync(join(tmpdir(), "shud-sensitivity-alias-"));
  try {
    const record = await prepare({ workspace: join(parent, "nested/ws") });
    expect(record.workspace).toBe(join(fs.realpathSync(parent), "nested/ws"));
    expect(fileList(join(parent, "nested/ws/input/ccw"))).toEqual(SORTED_NAMES);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("hashes every source and copy file through exactly one records safe read each", async () => {
  await prepare();
  const copy = join(h.workspace, "input/ccw");
  const calls = readSpy.mock.calls.map(([base, relative]) => `${base}|${relative}`).sort();
  expect(calls).toEqual(
    [
      ...SORTED_NAMES.map((name) => `${h.source}|${name}`),
      ...SORTED_NAMES.map((name) => `${copy}|${name}`),
    ].sort(),
  );
});

test("rejects workspace path hazards naming the path without writing", async () => {
  const outside = join(h.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "keep"), "outside bytes\n");
  const outsideBefore = snapshotTree(outside);

  fs.symlinkSync(outside, h.workspace, "dir");
  await expectRejected(h.workspace);
  fs.unlinkSync(h.workspace);

  fs.writeFileSync(h.workspace, "file workspace\n");
  await expectRejected(h.workspace);
  await expectRejected(join(h.workspace, "below"), { workspace: join(h.workspace, "below") });
  fs.unlinkSync(h.workspace);

  fs.mkdirSync(h.workspace);
  fs.symlinkSync(outside, join(h.workspace, "input"), "dir");
  await expectRejected(join(h.workspace, "input"));
  fs.unlinkSync(join(h.workspace, "input"));

  fs.writeFileSync(join(h.workspace, "input"), "not a directory\n");
  await expectRejected(join(h.workspace, "input"));
  expect(snapshotTree(outside)).toEqual(outsideBefore);
});

test("rejects record paths that exist, lack a parent, or fall under input or a managed root", async () => {
  fs.mkdirSync(join(h.workspace, "input"), { recursive: true });
  fs.writeFileSync(h.record, "earlier record\n");
  await expect(prepare()).rejects.toThrow(h.record);
  expect(fs.readFileSync(h.record, "utf8")).toBe("earlier record\n");
  expect(fs.existsSync(join(h.workspace, "input/ccw"))).toBe(false);
  fs.unlinkSync(h.record);

  const missingParent = join(h.root, "absent/record.json");
  await expectRejected(missingParent, { recordPath: missingParent });
  expect(fs.existsSync(join(h.root, "absent"))).toBe(false);

  const inputRecord = join(h.workspace, "input/record.json");
  await expectRejected(inputRecord, { recordPath: inputRecord });
  fs.rmdirSync(join(h.workspace, "input"));
  for (const recordPath of [join(h.workspace, "input"), join(h.workspace, "tasks")])
    await expectRejected(recordPath, { recordPath });
  fs.mkdirSync(join(h.workspace, "analyses"));
  const analysesRecord = join(h.workspace, "analyses/record.json");
  await expect(prepare({ recordPath: analysesRecord })).rejects.toThrow(
    `Record path must be outside workspace input and managed roots: ${analysesRecord}`,
  );
  expect(fs.readdirSync(h.workspace)).toEqual(["analyses"]);
  expect(fs.readdirSync(join(h.workspace, "analyses"))).toEqual([]);
});

test.each([...MANAGED, "input/ccw", "runs as symlink"])(
  "occupied workspace path %s fails naming it and is not modified",
  async (occupied) => {
    const name = occupied.split(" ")[0];
    const path = join(h.workspace, name);
    fs.mkdirSync(join(path, ".."), { recursive: true });
    if (occupied.endsWith("symlink")) {
      fs.mkdirSync(join(h.root, "foreign"));
      fs.symlinkSync(join(h.root, "foreign"), path, "dir");
    } else {
      fs.mkdirSync(path);
      fs.writeFileSync(join(path, "earlier"), "earlier evidence\n");
    }
    const before = snapshotTree(h.workspace);
    await expect(prepare()).rejects.toThrow(`Occupied workspace path: ${path}`);
    expect(snapshotTree(h.workspace)).toEqual(before);
    expect(fs.existsSync(h.record)).toBe(false);
  },
);

test("rejects symlink and FIFO source entries before any write", async () => {
  const link = join(h.source, "linked.att");
  fs.symlinkSync(join(h.source, "ccw.sp.att"), link);
  await expectRejected(link);
  fs.unlinkSync(link);

  const fifo = join(h.source, "forcing/pipe");
  execFileSync("mkfifo", [fifo]);
  await expectRejected(fifo);
  expect(fs.existsSync(h.workspace)).toBe(false);
});

test("an exceeded byte budget names the file before any write", async () => {
  const first = SOURCE_FILES[SORTED_NAMES[0]].length;
  await expectRejected(`Hash byte budget exceeded: ${join(h.source, SORTED_NAMES[1])}`, {
    hashBudget: first,
  });
  expect(fs.existsSync(h.workspace)).toBe(false);
});

test("a corrupted copy fails verification naming the file, leaves copies and writes no record", async () => {
  const corrupt = join(h.workspace, "input/ccw/ccw.cfg.para");
  await expect(
    prepare({
      writeFile(path, bytes) {
        fs.writeFileSync(path, path === corrupt ? Buffer.from("tampered\n") : bytes, {
          flag: "wx",
        });
      },
    }),
  ).rejects.toThrow(`Copy verification failed: ${corrupt}`);
  expect(fs.existsSync(h.record)).toBe(false);
  expect(fileList(join(h.workspace, "input/ccw"))).toEqual(SORTED_NAMES);
  expect(fs.readFileSync(corrupt, "utf8")).toBe("tampered\n");
});

test("a failing copy write names the file, keeps earlier copies and writes no record", async () => {
  const copy = join(h.workspace, "input/ccw");
  const failing = join(copy, SORTED_NAMES[2]);
  await expect(
    prepare({
      writeFile(path, bytes) {
        if (path === failing) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        fs.writeFileSync(path, bytes, { flag: "wx" });
      },
    }),
  ).rejects.toThrow(`Copy write failed: ${failing}: ENOSPC`);
  expect(fileList(copy)).toEqual(SORTED_NAMES.slice(0, 2));
  expect(fs.existsSync(h.record)).toBe(false);
});

test("an unreadable or non-root submodule fails naming it before any write", async () => {
  fs.rmSync(join(h.root, "rSHUD/.git"), { recursive: true });
  await expectRejected(`Cannot read submodule rSHUD HEAD: ${join(h.root, "rSHUD")}`);
  expect(fs.existsSync(h.workspace)).toBe(false);
});

test("the record is created exclusively and never overwrites a path that appears during the copy", async () => {
  await expect(
    prepare({
      writeFile(path, bytes) {
        fs.writeFileSync(path, bytes, { flag: "wx" });
        if (!fs.existsSync(h.record)) fs.writeFileSync(h.record, "concurrent writer\n");
      },
    }),
  ).rejects.toThrow(`Record write failed: ${h.record}: EEXIST`);
  expect(fs.readFileSync(h.record, "utf8")).toBe("concurrent writer\n");
  expect(fileList(join(h.workspace, "input/ccw"))).toEqual(SORTED_NAMES);
});
