import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { decideRawAccess, normalizeRawDirs, RAW_READ_PROVENANCE_REASON } from "./decide.ts";

const task = "TASK-20261027T080005-3f9c";
const other = "TASK-20261027T080005-abcd";
let root: string;
let cwd: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "raw-task-target-"));
  cwd = join(root, "workspace");
  fs.mkdirSync(cwd);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function decide(args: unknown, rawDirs: string[], session = cwd) {
  return decideRawAccess(
    { name: "shud_run", arguments: args, cwd: session },
    normalizeRawDirs({ rawDirs }),
  );
}
function deny(args: unknown, rawDirs: string[], session = cwd) {
  const decision = decide(args, rawDirs, session);
  expect(decision).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  expect(decision.reason).toMatch(/immutable/u);
}

for (const exists of [false, true]) {
  test.each(["tasks", `tasks/${task}`, `tasks/${task}/task.json`, "."])(
    `exact task target under protected %s denies; exists=${exists}`,
    (raw) => {
      if (exists) {
        fs.mkdirSync(join(cwd, "tasks", task), { recursive: true });
        fs.writeFileSync(join(cwd, "tasks", task, "task.json"), "protected bytes");
      }
      deny({ input_dir: "input/tiny", task_id: task }, [raw]);
      expect(fs.existsSync(join(cwd, "tasks", task, "task.json"))).toBe(exists);
      if (exists)
        expect(fs.readFileSync(join(cwd, "tasks", task, "task.json"), "utf8")).toBe(
          "protected bytes",
        );
    },
  );
}

test.each(["cwd", "tasks", "task-directory", "target-file", "raw"])(
  "physical %s alias retains exact target protection",
  (alias) => {
    fs.mkdirSync(join(cwd, "tasks", task), { recursive: true });
    const target = join(cwd, "tasks", task, "task.json");
    fs.writeFileSync(target, "protected bytes");
    let session = cwd;
    let raw = target;
    if (alias === "cwd") {
      session = join(root, "session-alias");
      fs.symlinkSync(cwd, session);
    } else if (alias === "raw") {
      raw = join(root, "raw-alias");
      fs.symlinkSync(target, raw);
    } else {
      const source =
        alias === "tasks"
          ? join(cwd, "tasks")
          : alias === "task-directory"
            ? join(cwd, "tasks", task)
            : target;
      const moved = join(root, "physical-target");
      fs.renameSync(source, moved);
      fs.symlinkSync(moved, source);
      raw =
        alias === "tasks"
          ? join(moved, task, "task.json")
          : alias === "task-directory"
            ? join(moved, "task.json")
            : moved;
    }
    deny({ input_dir: "input/tiny", task_id: task }, [raw], session);
  },
);

test("session alias protects a task target whose entire managed suffix is absent", () => {
  const alias = join(root, "session-alias");
  fs.symlinkSync(cwd, alias);
  deny({ task_id: task }, [join(cwd, "tasks", task, "task.json")], alias);
  expect(fs.existsSync(join(cwd, "tasks"))).toBe(false);
});

test("native case alias protects the same physical task target", ({ skip }) => {
  fs.mkdirSync(join(cwd, "Tasks", task), { recursive: true });
  const target = join(cwd, "Tasks", task, "task.json");
  fs.writeFileSync(target, "protected bytes");
  if (!fs.existsSync(join(cwd, "tasks", task, "task.json"))) {
    skip("filesystem distinguishes task-root case spellings");
    return;
  }
  deny({ input_dir: "input/tiny", task_id: task }, [target]);
});

test.each([`tasks/${other}`, `tasks/${other}/task.json`, `tasks/${task}-sibling`, "tasks-input"])(
  "unrelated task or sibling %s is not blanket-denied",
  (raw) => {
    expect(decide({ input_dir: "input/tiny", task_id: task }, [raw])).toEqual({
      kind: "next",
      code: "unrelated",
    });
  },
);

test.each([false, true])(
  "task output denial precedes input ask and malformed input; reversed=%s",
  (reversed) => {
    const roots = ["input", `tasks/${task}/task.json`];
    for (const input of [{ input_dir: "input/tiny" }, {}, { input_dir: null }, { input_dir: 7 }]) {
      deny({ ...input, task_id: task }, reversed ? [...roots].reverse() : roots);
    }
    expect(decide({ input_dir: "input/tiny", task_id: task }, ["input"])).toMatchObject({
      kind: "ask",
      reason: RAW_READ_PROVENANCE_REASON,
    });
  },
);

test.each([
  undefined,
  null,
  "",
  "TASK-0001",
  "../reports/x",
  "TASK-20261027T080005-ABCD",
  7,
  {},
  [],
])("absent or invalid id %j adds no task-derived lookup or output denial", (task_id) => {
  const lookup = vi.spyOn(fs.realpathSync, "native");
  const args =
    task_id === undefined ? { input_dir: "input/tiny" } : { input_dir: "input/tiny", task_id };
  expect(decide({ input_dir: "input/tiny" }, ["tasks"])).toEqual({
    kind: "next",
    code: "unrelated",
  });
  const baseline = lookup.mock.calls.map(([path]) => String(path));
  lookup.mockClear();
  expect(decide(args, ["tasks"])).toEqual({ kind: "next", code: "unrelated" });
  expect(lookup.mock.calls.map(([path]) => String(path))).toEqual(baseline);
  lookup.mockClear();
  expect(decide(args, ["unrelated"])).toEqual({ kind: "next", code: "unrelated" });
  expect(
    lookup.mock.calls.map(([path]) => String(path)).filter((path) => path.includes("/tasks")),
  ).toEqual([]);
  expect(fs.existsSync(join(cwd, "tasks"))).toBe(false);
  expect(decide(args, ["input"])).toMatchObject({
    kind: "ask",
    reason: RAW_READ_PROVENANCE_REASON,
  });
  for (const output of ["runs", "stacks", "provenance"]) deny(args, [output]);
});
