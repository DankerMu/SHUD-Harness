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
    realpathSync: Object.assign(vi.fn(actual.realpathSync), {
      native: vi.fn(actual.realpathSync.native),
    }),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
const id = "TASK-20261102T090000-c3d4";
const task = `tasks/${id}/task.json`;
const PRIVATE = "PRIVATE_RAW_VERIFICATION_540";
let root: string;
let cwd: string;
beforeEach(() => {
  root = native.mkdtempSync(join(tmpdir(), "raw-verification-"));
  cwd = join(root, "workspace");
  native.mkdirSync(cwd);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.mocked(fs.realpathSync.native).mockImplementation(native.realpathSync.native);
  native.rmSync(root, { recursive: true, force: true });
});
function decide(rawDirs: string[], args: unknown = { task_id: id }, workspace = cwd) {
  return decideRawAccess(
    { name: "verification_run", arguments: args, cwd: workspace },
    normalizeRawDirs({ rawDirs }),
  );
}
function noContentIO() {
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(fs.mkdirSync).not.toHaveBeenCalled();
  expect(fs.writeFileSync).not.toHaveBeenCalled();
}
function snapshot() {
  return ["", ...native.readdirSync(root, { recursive: true }).map(String).sort()].map(
    (relative) => {
      const path = join(root, relative);
      const stat = native.lstatSync(path, { bigint: true });
      return {
        relative,
        ino: stat.ino,
        mode: stat.mode,
        mtimeNs: stat.mtimeNs,
        bytes: stat.isFile() ? native.readFileSync(path) : undefined,
        link: stat.isSymbolicLink() ? native.readlinkSync(path) : undefined,
      };
    },
  );
}
function seed() {
  native.mkdirSync(join(cwd, "verifications"));
  native.mkdirSync(join(cwd, "tasks", id), { recursive: true });
  native.writeFileSync(join(cwd, task), PRIVATE);
}

for (const exists of [false, true]) {
  test.each([".", "verifications", "tasks", `tasks/${id}`, task])(
    `verification targets exist=${exists} are denied under raw %s`,
    (raw) => {
      if (exists) seed();
      const before = snapshot();
      expect(decide([raw])).toMatchObject({ kind: "deny", code: "raw-immutable" });
      noContentIO();
      expect(snapshot()).toEqual(before);
    },
  );
  test.each([
    "verifications-sibling",
    "tasks-sibling",
    "tasks/TASK-20261102T090000-ffff/task.json",
    `${task}-suffix`,
    "changes",
    "patches",
    "builds",
    "reports",
    "data/raw",
  ])(`verification targets exist=${exists} leave unrelated raw %s alone`, (raw) => {
    if (exists) seed();
    const before = snapshot();
    expect(decide([raw])).toEqual({ kind: "next", code: "unrelated" });
    noContentIO();
    expect(snapshot()).toEqual(before);
  });
}

test.each([
  undefined,
  null,
  [],
  Object.assign([], { task_id: id }),
  7,
  "private",
  {},
  { task_id: "../escape" },
  { task_id: "TASK-invalid" },
  { task_id: 7 },
])("invalid %j falls back to tasks while always protecting verifications", (args) => {
  const call = { name: "verification_run", arguments: args, cwd };
  const before = snapshot();
  for (const raw of ["tasks", "verifications"]) {
    expect(decideRawAccess(call, normalizeRawDirs({ rawDirs: [raw] }))).toMatchObject({
      kind: "deny",
      code: "raw-immutable",
    });
  }
  expect(decideRawAccess(call, normalizeRawDirs({ rawDirs: [task] }))).toEqual({
    kind: "next",
    code: "unrelated",
  });
  noContentIO();
  expect(snapshot()).toEqual(before);
});

test.each(["arguments", "task_id", "coercion"] as const)(
  "unavailable %s identity keeps the fixed fallback separate from IO failure",
  (kind) => {
    const coercion = vi.fn(() => {
      throw new Error(PRIVATE);
    });
    const args =
      kind === "task_id"
        ? Object.defineProperty({}, "task_id", {
            get() {
              throw new Error(PRIVATE);
            },
          })
        : { task_id: { toString: coercion } };
    const call =
      kind === "arguments"
        ? {
            name: "verification_run",
            cwd,
            get arguments(): unknown {
              throw new Error(PRIVATE);
            },
          }
        : { name: "verification_run", cwd, arguments: args };
    const before = snapshot();
    for (const raw of ["tasks", "verifications", "unrelated"]) {
      const result = decideRawAccess(call, normalizeRawDirs({ rawDirs: [raw] }));
      expect(result).toEqual(
        raw === "unrelated"
          ? { kind: "next", code: "unrelated" }
          : expect.objectContaining({ kind: "deny", code: "raw-immutable" }),
      );
      expect(JSON.stringify(result)).not.toContain(PRIVATE);
    }
    expect(coercion).not.toHaveBeenCalled();
    noContentIO();
    expect(snapshot()).toEqual(before);
  },
);

test.each([
  "session",
  "verifications",
  "tasks",
  "task-file",
  "raw-alias",
  "physical-parent",
] as const)("verification raw target follows the %s physical alias", (alias) => {
  seed();
  let workspace = cwd;
  let raw = join(cwd, task);
  if (alias === "session") {
    workspace = join(root, "session-alias");
    native.symlinkSync(cwd, workspace);
  } else if (alias === "verifications" || alias === "tasks") {
    const outside = join(root, "physical-root");
    native.renameSync(join(cwd, alias), outside);
    native.symlinkSync(outside, join(cwd, alias));
    raw = alias === "tasks" ? join(outside, id, "task.json") : outside;
  } else if (alias === "task-file") {
    raw = join(root, "physical-task.json");
    native.renameSync(join(cwd, task), raw);
    native.symlinkSync(raw, join(cwd, task));
  } else if (alias === "raw-alias") {
    raw = join(root, "raw-alias");
    native.symlinkSync(join(cwd, task), raw);
  } else {
    native.mkdirSync(join(cwd, "child"));
    const aliasPath = join(root, "child-alias");
    native.symlinkSync(join(cwd, "child"), aliasPath);
    workspace = `${aliasPath}/..`;
  }
  const before = snapshot();
  expect(decide([raw], { task_id: id }, workspace)).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  noContentIO();
  expect(snapshot()).toEqual(before);
});

test("missing target under an aliased task root is protected without creating it", () => {
  const outside = join(root, "physical-tasks");
  native.mkdirSync(outside);
  native.symlinkSync(outside, join(cwd, "tasks"));
  const before = snapshot();
  expect(decide([join(outside, id, "task.json")])).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  noContentIO();
  expect(snapshot()).toEqual(before);
});

test("missing workspace ancestors preserve prospective target protection", () => {
  const workspace = join(cwd, "missing", "nested");
  const before = snapshot();
  expect(decide([join(workspace, task)], { task_id: id }, workspace)).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  noContentIO();
  expect(snapshot()).toEqual(before);
});

test.each(["verifications", task])("raw list ordering cannot hide protected %s", (raw) => {
  for (const rawDirs of [
    ["unrelated", raw],
    [raw, "unrelated"],
  ]) {
    expect(decide(rawDirs)).toMatchObject({ kind: "deny", code: "raw-immutable" });
  }
  noContentIO();
});

test("physical resolution failure is not confused with invalid argument fallback", () => {
  const before = snapshot();
  vi.mocked(fs.realpathSync.native).mockImplementation((path, options) => {
    if (String(path).endsWith("/verifications"))
      throw Object.assign(new Error(PRIVATE), { code: "EACCES" });
    return native.realpathSync.native(path, options);
  });
  const result = decide(["unrelated"]);
  expect(result).toMatchObject({ kind: "deny", code: "raw-target-unavailable" });
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  noContentIO();
  expect(snapshot()).toEqual(before);
});

test("unproved missing case alias fails closed without probing files", () => {
  const before = snapshot();
  expect(decide(["VERIFICATIONS"])).toMatchObject({ kind: "deny", code: "raw-path-unavailable" });
  noContentIO();
  expect(snapshot()).toEqual(before);
});

test("case aliases follow independently observed filesystem identity", () => {
  seed();
  const raw = join(cwd, "Verifications");
  const actual = native.lstatSync(join(cwd, "verifications"));
  const alternate = native.lstatSync(raw, { throwIfNoEntry: false });
  const before = snapshot();
  if (alternate) {
    expect(alternate.ino).toBe(actual.ino);
    expect(alternate.dev).toBe(actual.dev);
    expect(decide([raw])).toMatchObject({ kind: "deny", code: "raw-immutable" });
  } else expect(decide([raw])).toEqual({ kind: "next", code: "unrelated" });
  noContentIO();
  expect(snapshot()).toEqual(before);
});
