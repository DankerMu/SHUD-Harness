import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { decideRawAccess, normalizeRawDirs, RAW_READ_PROVENANCE_REASON } from "./decide.ts";

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
const id = "TASK-20261108T093000-c3d4";
const task = `tasks/${id}/task.json`;
const plan = "analyses/PLAN-20261108T093000-5c1e.json";
const PRIVATE = "PRIVATE_RAW_ANALYSIS_663";
const unavailable = { kind: "deny", code: "raw-target-unavailable" };
const immutable = { kind: "deny", code: "raw-immutable" };
const delegated = { kind: "next", code: "unrelated" };
let root: string;
let cwd: string;
beforeEach(() => {
  root = native.mkdtempSync(join(tmpdir(), "raw-analysis-"));
  cwd = join(root, "workspace");
  native.mkdirSync(cwd);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.mocked(fs.realpathSync.native).mockImplementation(native.realpathSync.native);
  native.rmSync(root, { recursive: true, force: true });
});
function decide(rawDirs: string[], args: unknown, workspace: string) {
  return decideRawAccess(
    { name: "analysis_create", arguments: args, cwd: workspace },
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
  native.mkdirSync(join(cwd, "analyses"));
  native.writeFileSync(join(cwd, plan), PRIVATE);
  native.mkdirSync(join(cwd, "tasks", id), { recursive: true });
  native.writeFileSync(join(cwd, task), PRIVATE);
}
// Every decision leaves the workspace untouched and reads no file content.
function expectDecision(rawDirs: string[], args: unknown, expected: object, workspace = cwd) {
  const before = snapshot();
  const result = decide(rawDirs, args, workspace);
  expect(result).toMatchObject(expected);
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  noContentIO();
  expect(snapshot()).toEqual(before);
  return result;
}

for (const exists of [false, true]) {
  test.each([".", "analyses", "tasks", `tasks/${id}`, task])(
    `analysis write targets exist=${exists} are denied under raw %s`,
    (raw) => {
      if (exists) seed();
      const result = expectDecision([raw], { task_id: id, input_dir: "input/ccw" }, immutable);
      expect(result.reason).toContain("immutable");
    },
  );
  test.each([
    "analyses-input",
    "analyses-old",
    "tasks-sibling",
    "analyses/PLAN-20261108T093000-ffff.json",
    "tasks/TASK-20261108T093000-ffff",
    "tasks/TASK-20261108T093000-ffff/task.json",
    `${task}-suffix`,
    "runs",
    "changes",
    "data/raw",
  ])(`analysis write targets exist=${exists} leave unrelated raw %s alone`, (raw) => {
    if (exists) seed();
    expectDecision([raw], { task_id: id }, delegated);
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
  { task_id: "TASK-0001" },
  { task_id: "../escape" },
  { task_id: 7 },
])("invalid %j falls back to the tasks root while always protecting analyses", (args) => {
  for (const raw of ["tasks", "analyses"]) expectDecision([raw], args, immutable);
  expectDecision([task], args, delegated);
  expectDecision(["data/raw"], args, delegated);
});

test.each(["arguments", "task_id", "input_dir"] as const)(
  "unavailable %s identity keeps the fixed fallback without throwing",
  (kind) => {
    const thrower = {
      get() {
        throw new Error(PRIVATE);
      },
    };
    const call =
      kind === "arguments"
        ? {
            name: "analysis_create",
            cwd,
            get arguments(): unknown {
              throw new Error(PRIVATE);
            },
          }
        : {
            name: "analysis_create",
            cwd,
            arguments: Object.defineProperty(
              kind === "task_id" ? { input_dir: "prot/ccw" } : { task_id: id },
              kind,
              thrower,
            ),
          };
    native.mkdirSync(join(cwd, "prot/ccw"), { recursive: true });
    for (const [raw, expected] of [
      ["tasks", immutable],
      ["analyses", immutable],
      ["unrelated", delegated],
    ] as const) {
      const result = decideRawAccess(call, normalizeRawDirs({ rawDirs: [raw] }));
      expect(result).toMatchObject(expected);
      expect(JSON.stringify(result)).not.toContain(PRIVATE);
    }
    noContentIO();
  },
);

test.each(["prot/ccw", "link", "prot"])(
  "raw input %s asks with the shud_run provenance decision",
  (input) => {
    native.mkdirSync(join(cwd, "prot/ccw"), { recursive: true });
    native.symlinkSync(join(cwd, "prot/ccw"), join(cwd, "link"));
    const result = expectDecision(["prot"], { task_id: id, input_dir: input }, { kind: "ask" });
    expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
    const shudRun = decideRawAccess(
      { name: "shud_run", arguments: { input_dir: input }, cwd },
      normalizeRawDirs({ rawDirs: ["prot"] }),
    );
    expect(result).toBe(shudRun);
  },
);

test.each([[["prot", "analyses"]], [["analyses", "prot"]], [["prot", task]], [[task, "prot"]]])(
  "write denial precedes raw input approval for raw roots %j",
  (rawDirs) => {
    native.mkdirSync(join(cwd, "prot/ccw"), { recursive: true });
    expectDecision(rawDirs, { task_id: id, input_dir: "prot/ccw" }, immutable);
  },
);

test.each([undefined, null, 7, ["prot/ccw"], { path: "prot/ccw" }])(
  "non-string input %j keeps the write-target decision",
  (input) => {
    native.mkdirSync(join(cwd, "prot/ccw"), { recursive: true });
    expectDecision(["prot"], { task_id: id, input_dir: input }, delegated);
    expectDecision(["prot", "analyses"], { task_id: id, input_dir: input }, immutable);
  },
);

test("path text in other arguments does not influence the decision", () => {
  native.mkdirSync(join(cwd, "data/raw"), { recursive: true });
  const args = {
    task_id: id,
    input_dir: "input/ccw",
    rationale_basis: ["data/raw/x", "analyses", task],
    parameter_sets: [{ path: "data/raw/x", target: "analyses/x.json" }],
    analysis_plan_id: "../data/raw",
  };
  expectDecision(["data/raw"], args, delegated);
});

test.each(["session", "analyses", "tasks", "task-file", "raw-alias", "physical-parent"] as const)(
  "analysis raw target follows the %s physical alias",
  (alias) => {
    seed();
    let workspace = cwd;
    let raw = join(cwd, "analyses");
    if (alias === "session") {
      workspace = join(root, "session-alias");
      native.symlinkSync(cwd, workspace);
    } else if (alias === "analyses" || alias === "tasks") {
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
      native.symlinkSync(join(cwd, "analyses"), raw);
    } else {
      native.mkdirSync(join(cwd, "child"));
      const aliasPath = join(root, "child-alias");
      native.symlinkSync(join(cwd, "child"), aliasPath);
      workspace = `${aliasPath}/..`;
    }
    expectDecision([raw], { task_id: id }, immutable, workspace);
  },
);

test("missing target under an aliased task root is protected without creating it", () => {
  const outside = join(root, "physical-tasks");
  native.mkdirSync(outside);
  native.symlinkSync(outside, join(cwd, "tasks"));
  expectDecision([join(outside, id, "task.json")], { task_id: id }, immutable);
});

test.each(["analyses", "tasks", "raw", "input"] as const)(
  "physical resolution failure on the %s path denies without leaking error text",
  (fault) => {
    native.mkdirSync(join(cwd, "prot/ccw"), { recursive: true });
    const suffix = { analyses: "/analyses", tasks: "/tasks", raw: "/prot", input: "/prot/ccw" }[
      fault
    ];
    vi.mocked(fs.realpathSync.native).mockImplementation((path, options) => {
      if (String(path).endsWith(suffix))
        throw Object.assign(new Error(`${PRIVATE} ${String(path)}`), { code: "EACCES" });
      return native.realpathSync.native(path, options);
    });
    const result = expectDecision(
      fault === "raw" ? ["prot"] : ["unrelated"],
      { task_id: "TASK-0001", input_dir: "prot/ccw" },
      unavailable,
    );
    expect(result.reason).not.toMatch(/EACCES|prot|analyses|tasks|raw-analysis-/);
  },
);

test.each(["analyses", "tasks", "raw-loop", "input-loop"] as const)(
  "symlink loop on the %s path denies as unavailable",
  (loop) => {
    native.symlinkSync(loop, join(cwd, loop));
    const result = expectDecision(
      loop === "raw-loop" ? [loop] : ["unrelated"],
      { input_dir: "input-loop/ccw" },
      unavailable,
    );
    expect(result.reason).not.toContain(loop);
  },
);

test("an input directory containing a NUL byte denies as unavailable", () => {
  const result = expectDecision(["unrelated"], { input_dir: `prot\0${PRIVATE}` }, unavailable);
  expect(result.reason).not.toContain("prot");
});

test("unproved missing case alias fails closed without probing files", () => {
  expectDecision(["ANALYSES"], { task_id: id }, { kind: "deny", code: "raw-path-unavailable" });
});

test("case aliases follow independently observed filesystem identity", () => {
  seed();
  const raw = join(cwd, "Analyses");
  const actual = native.lstatSync(join(cwd, "analyses"));
  const alternate = native.lstatSync(raw, { throwIfNoEntry: false });
  if (alternate) {
    expect(alternate.ino).toBe(actual.ino);
    expect(alternate.dev).toBe(actual.dev);
    expectDecision([raw], { task_id: id }, immutable);
  } else expectDecision([raw], { task_id: id }, delegated);
});

test("shud_run reading a plan under analyses keeps its existing decision", () => {
  seed();
  native.mkdirSync(join(cwd, "input/ccw"), { recursive: true });
  const run = (rawDirs: string[], input_dir = "input/ccw") =>
    decideRawAccess(
      { name: "shud_run", arguments: { input_dir, task_id: id }, cwd },
      normalizeRawDirs({ rawDirs }),
    );
  expect(run(["analyses"])).toEqual(delegated);
  expect(run([plan])).toEqual(delegated);
  expect(run(["data/raw"], "analyses")).toEqual(delegated);
});
