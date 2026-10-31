import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { decideRawAccess, normalizeRawDirs } from "./decide.ts";

const args = {
  type: "science_assist",
  title: "ccw 30 天运行",
  question_or_goal: "跑通 ccw 并生成证据报告",
};
let root: string;
let cwd: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "raw-task-create-"));
  cwd = join(root, "workspace");
  fs.mkdirSync(cwd);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function decide(rawDirs: string[], session = cwd, input: unknown = args) {
  const before = fs.readdirSync(root, { recursive: true });
  const decision = decideRawAccess(
    { name: "task_create", arguments: input, cwd: session },
    normalizeRawDirs({ rawDirs }),
  );
  expect(fs.readdirSync(root, { recursive: true })).toEqual(before);
  return decision;
}

function deny(rawDirs: string[], session = cwd) {
  const decision = decide(rawDirs, session);
  expect(decision).toMatchObject({ kind: "deny", code: "raw-immutable" });
  expect(decision.reason).toMatch(/immutable/u);
}

test.each(["relative", "normalized", "absolute", "parent"])(
  "task_create protects an absent tasks root through its %s raw spelling",
  (kind) => {
    const raw =
      kind === "relative"
        ? "tasks"
        : kind === "normalized"
          ? "././tasks/"
          : kind === "absolute"
            ? join(cwd, "tasks")
            : "..";
    deny([raw]);
    expect(fs.existsSync(join(cwd, "tasks"))).toBe(false);
  },
);

test("task_create resolves a missing session suffix from its nearest physical ancestor", () => {
  const alias = join(root, "session-alias");
  fs.symlinkSync(cwd, alias);
  deny([cwd], join(alias, "missing", "nested"));
  expect(fs.existsSync(join(cwd, "missing"))).toBe(false);
});

test.each(["cwd", "tasks", "raw"])(
  "task_create protects an existing tasks root through a physical %s alias",
  (kind) => {
    const tasks = join(cwd, "tasks");
    fs.mkdirSync(tasks);
    fs.writeFileSync(join(tasks, "original.txt"), "protected task data\n");
    let session = cwd;
    let raw = tasks;
    if (kind === "cwd") {
      session = join(root, "session-alias");
      fs.symlinkSync(cwd, session);
    } else if (kind === "tasks") {
      raw = join(root, "physical-tasks");
      fs.renameSync(tasks, raw);
      fs.symlinkSync(raw, tasks);
    } else {
      raw = join(root, "raw-alias");
      fs.symlinkSync(tasks, raw);
    }
    deny([raw], session);
    expect(fs.readFileSync(join(tasks, "original.txt"), "utf8")).toBe("protected task data\n");
  },
);

test("task_create protects an existing root's native case alias", ({ skip }) => {
  fs.mkdirSync(join(cwd, "Tasks"));
  if (!fs.existsSync(join(cwd, "tasks"))) {
    skip("filesystem distinguishes task-root case spellings");
    return;
  }
  deny([join(cwd, "Tasks")]);
});

test.each(["tasks-sibling", "data/raw", "tasks/protected-child"])(
  "task_create passes through when raw %s does not contain the fixed tasks root",
  (raw) => {
    expect(decide([raw])).toEqual({ kind: "next", code: "unrelated" });
    expect(fs.existsSync(join(cwd, "tasks"))).toBe(false);
  },
);

test("task_create checks every configured raw root without deriving output from arguments", () => {
  for (const rawDirs of [
    ["data/raw", "tasks"],
    ["tasks", "data/raw"],
  ]) {
    expect(decide(rawDirs, cwd, null)).toMatchObject({ kind: "deny", code: "raw-immutable" });
  }
  expect(decide(["data/raw"], cwd, null)).toEqual({ kind: "next", code: "unrelated" });
});
