import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { decideRawAccess, normalizeRawDirs } from "./decide.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
const id = "CHG-20261102T090000-a1b2";
const relative = `changes/${id}.json`;
let root: string;
let cwd: string;
beforeEach(() => {
  root = native.mkdtempSync(join(tmpdir(), "raw-change-target-"));
  cwd = join(root, "workspace");
  native.mkdirSync(cwd);
  vi.clearAllMocks();
});
afterEach(() => native.rmSync(root, { recursive: true, force: true }));
function decide(rawDirs: string[], args: unknown = { change_id: id }, workspace = cwd) {
  return decideRawAccess(
    { name: "change_submit", arguments: args, cwd: workspace },
    normalizeRawDirs({ rawDirs }),
  );
}
function noContentIO() {
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(fs.mkdirSync).not.toHaveBeenCalled();
  expect(fs.writeFileSync).not.toHaveBeenCalled();
}
function seed() {
  native.mkdirSync(join(cwd, "changes"));
  native.writeFileSync(join(cwd, relative), "PRIVATE_INVALID_JSON_DO_NOT_READ");
}

for (const exists of [false, true]) {
  test.each([".", "changes", relative])(
    `exact write target exists=${exists} protected by %s`,
    (raw) => {
      if (exists) seed();
      expect(decide([raw])).toMatchObject({ kind: "deny", code: "raw-immutable" });
      noContentIO();
      expect(native.readdirSync(cwd)).toEqual(exists ? ["changes"] : []);
    },
  );
  test.each([
    "changes-sibling",
    "changes/unrelated-subtree",
    "changes/CHG-20261102T090000-ffff.json",
    `changes/${id}.json-suffix`,
    `patches/${id}.patch`,
    "patches",
    "tasks",
    "repos/SHUD",
    "builds",
    "reports",
  ])(`valid id exists=${exists} does not protect unrelated %s`, (raw) => {
    if (exists) seed();
    expect(decide([raw])).toEqual({ kind: "next", code: "unrelated" });
    noContentIO();
  });
}

test.each([
  undefined,
  null,
  [],
  Object.assign([], { change_id: id }),
  9,
  "PRIVATE_INPUT",
  {},
  { change_id: "../PRIVATE_ESCAPE" },
  { change_id: "CHG-invalid" },
  { change_id: 9 },
])("invalid arguments %j use only the changes-root fallback", (args) => {
  // Pass undefined explicitly without the helper's default argument.
  const call = { name: "change_submit", arguments: args, cwd };
  expect(decideRawAccess(call, normalizeRawDirs({ rawDirs: ["changes"] }))).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  expect(decideRawAccess(call, normalizeRawDirs({ rawDirs: [relative] }))).toEqual({
    kind: "next",
    code: "unrelated",
  });
  expect(decideRawAccess(call, normalizeRawDirs({ rawDirs: ["patches", "tasks"] }))).toEqual({
    kind: "next",
    code: "unrelated",
  });
  noContentIO();
  expect(native.readdirSync(cwd)).toEqual([]);
});

test.each(["session", "changes", "target", "raw", "case", "dotdot"] as const)(
  "change_submit protects physical %s alias",
  (alias) => {
    seed();
    let workspace = cwd;
    let raw = join(cwd, relative);
    if (alias === "session") {
      workspace = join(root, "session-alias");
      native.symlinkSync(cwd, workspace);
    } else if (alias === "changes") {
      const outside = join(root, "physical-changes");
      native.renameSync(join(cwd, "changes"), outside);
      native.symlinkSync(outside, join(cwd, "changes"));
      raw = join(outside, `${id}.json`);
    } else if (alias === "target") {
      raw = join(root, "physical-target");
      native.renameSync(join(cwd, relative), raw);
      native.symlinkSync(raw, join(cwd, relative));
    } else if (alias === "raw") {
      raw = join(root, "raw-alias");
      native.symlinkSync(join(cwd, relative), raw);
    } else if (alias === "case") {
      raw = join(cwd, "Changes", `${id}.json`);
      const original = native.lstatSync(join(cwd, relative));
      const alternate = native.lstatSync(raw, { throwIfNoEntry: false });
      expect(original.isFile()).toBe(true);
      if (alternate) {
        expect(alternate.isFile()).toBe(true);
        expect(alternate.dev).toBe(original.dev);
        expect(alternate.ino).toBe(original.ino);
      } else {
        expect(decide([raw], { change_id: id }, workspace)).toEqual({
          kind: "next",
          code: "unrelated",
        });
        noContentIO();
        return;
      }
    } else {
      native.mkdirSync(join(cwd, "child"));
      workspace = join(cwd, "child", "..");
    }
    expect(decide([raw], { change_id: id }, workspace)).toMatchObject({
      kind: "deny",
      code: "raw-immutable",
    });
    noContentIO();
  },
);

test("missing exact target beneath a physical changes alias is protected without path creation", () => {
  const physical = join(root, "physical");
  native.mkdirSync(physical);
  native.symlinkSync(physical, join(cwd, "changes"));
  expect(decide([join(physical, `${id}.json`)])).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  expect(native.readdirSync(physical)).toEqual([]);
  noContentIO();
});

test("missing workspace ancestors still protect the exact prospective change JSON", () => {
  const workspace = join(cwd, "not-created", "nested");
  expect(decide([join(workspace, relative)], { change_id: id }, workspace)).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  expect(native.readdirSync(cwd)).toEqual([]);
  noContentIO();
});

test("metadata-only routing does not follow change_id coercion or read corrupt JSON", () => {
  seed();
  const coercion = vi.fn(() => "PRIVATE_COERCION");
  expect(decide(["changes"], { change_id: { toString: coercion } })).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  expect(coercion).not.toHaveBeenCalled();
  expect(decide(["unrelated"])).toEqual({ kind: "next", code: "unrelated" });
  noContentIO();
});

test("unavailable physical identity fails closed without content reads", () => {
  native.symlinkSync("changes", join(cwd, "changes"));
  expect(decide(["unrelated"])).toMatchObject({ kind: "deny" });
  noContentIO();
});

test.each(["data/raw", "changes"])(
  "throwing change identity falls back to changes against raw %s",
  (raw) => {
    // Public decision seam: native ToolRuntime rejects accessor-bearing non-JSON inputs earlier.
    const input = Object.defineProperty({}, "change_id", {
      get() {
        throw new Error("PRIVATE_CHANGE_ID_ACCESSOR");
      },
    });
    const decision = decide([raw], input);
    if (raw === "changes") {
      expect(decision).toMatchObject({ kind: "deny", code: "raw-immutable" });
    } else {
      expect(decision).toEqual({ kind: "next", code: "unrelated" });
    }
    expect(JSON.stringify(decision)).not.toContain("PRIVATE_CHANGE_ID_ACCESSOR");
    noContentIO();
    expect(native.readdirSync(cwd)).toEqual([]);
  },
);
