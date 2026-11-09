import * as fs from "node:fs";
import { join } from "node:path";
import type * as NodeCrypto from "node:crypto";
import type * as NodeFs from "node:fs";
import { AnalysisPlanIdSchema, AnalysisPlanSchema } from "@shud-harness/dsh-shud-core";
import { writeWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cardPath, expectToolError, OTHER_TASK, TASK } from "./task-linked/test-harness.ts";
import {
  analysesDir,
  analysisHarness,
  fileSnapshot,
  planNames,
  readCard,
  readPlan,
  seedCard,
  seedOrphan,
  sensitivityCard,
  successValue,
  validArgs,
  workspaceSnapshot,
  type AnalysisHarness,
} from "./analysis-create/test-harness.ts";

const entropy = vi.hoisted(() => ({ suffixes: [] as string[] }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof NodeCrypto>();
  return {
    ...actual,
    randomBytes(size: number, callback?: (error: Error | null, bytes: Buffer) => void) {
      if (callback) return actual.randomBytes(size, callback);
      const suffix = size === 2 ? entropy.suffixes.shift() : undefined;
      return suffix === undefined ? actual.randomBytes(size) : Buffer.from(suffix, "hex");
    },
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), renameSync: vi.fn(actual.renameSync) };
});
const native = await vi.importActual<typeof NodeFs>("node:fs");

const WRITE_BACK = "plan 已落盘、任务卡回写失败";
const ORPHAN = "PLAN-20261108T093000-5c1e";
const SECOND = "PLAN-20261108T093000-77aa";
let h: AnalysisHarness;
beforeEach(async () => {
  entropy.suffixes = [];
  vi.clearAllMocks();
  h = await analysisHarness();
});
afterEach(async () => {
  vi.mocked(fs.lstatSync).mockImplementation(native.lstatSync);
  vi.mocked(fs.renameSync).mockImplementation(native.renameSync);
  vi.useRealTimers();
  await h.dispose();
});

function failCardWrite() {
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (String(to).endsWith(`/tasks/${TASK}/task.json`)) throw new Error("injected card failure");
    native.renameSync(from, to);
  });
}

function planIdIn(message: string) {
  const match = /PLAN-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}/u.exec(message);
  if (!match) throw new Error(`No plan id in: ${message}`);
  return AnalysisPlanIdSchema.parse(match[0]);
}

test.each([
  { label: "identical arguments", retry: validArgs },
  {
    label: "explicit threads 1 and project ccw",
    retry: { ...validArgs, threads: 1, project: "ccw" },
  },
  {
    label: "different labels",
    retry: {
      ...validArgs,
      parameter_sets: validArgs.parameter_sets.map((set) => ({ ...set, label: "renamed" })),
    },
  },
])("write-back failure keeps the plan; $label retry links the same id", async ({ retry }) => {
  const original = seedCard(h);
  const cardBefore = native.readFileSync(cardPath(h));
  failCardWrite();
  const message = expectToolError(await h.invoke(validArgs), new RegExp(WRITE_BACK, "u"));
  const id = planIdIn(message);
  expect(planNames(h)).toEqual([`${id}.json`]);
  expect(readPlan(h, id).task_id).toBe(TASK);
  expect(native.readFileSync(cardPath(h))).toEqual(cardBefore);
  expect(native.readdirSync(join(h.cwd, "tasks", TASK))).toEqual(["task.json"]);

  vi.mocked(fs.renameSync).mockImplementation(native.renameSync);
  const plan = fileSnapshot(join(analysesDir(h), `${id}.json`));
  const value = successValue(await h.invoke(retry));
  expect(value.analysis_plan_id).toBe(id);
  expect(value.parameter_sets).toEqual(readPlan(h, id).parameter_sets);
  expect(fileSnapshot(join(analysesDir(h), `${id}.json`))).toEqual(plan);
  expect(planNames(h)).toEqual([`${id}.json`]);
  const card = readCard(h);
  expect(card.linked_analyses).toEqual([id]);
  expect(card.updated_at).not.toBe(original.updated_at);
  expect(card.status).toBe("planned");
});

test.each([
  { label: "left runnable status", change: { status: "reporting" as const } },
  {
    label: "gained a link",
    change: { linked_analyses: [AnalysisPlanIdSchema.parse(SECOND)] },
  },
])("card that $label between scan and write-back keeps the plan", async ({ change }) => {
  seedCard(h);
  let injected = false;
  vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) => {
    if (!injected && String(path).endsWith("ccw.cfg.para")) {
      injected = true;
      writeWorkspaceRecord(h.cwd, "task", sensitivityCard(change));
    }
    return native.lstatSync(path, options);
  });
  const message = expectToolError(await h.invoke(validArgs), new RegExp(WRITE_BACK, "u"));
  expect(injected).toBe(true);
  const id = planIdIn(message);
  expect(planNames(h)).toEqual([`${id}.json`]);
  expect(readCard(h)).toEqual(sensitivityCard(change));
});

test.each([
  {
    label: "different multiplier",
    args: {
      ...validArgs,
      parameter_sets: validArgs.parameter_sets.map((set, index) =>
        index === 2 ? { ...set, changes: { GEOL_KSATH: 1.5 } } : set,
      ),
    },
  },
  {
    label: "different order",
    args: {
      ...validArgs,
      parameter_sets: [0, 2, 1, 3].map((index) => validArgs.parameter_sets[index]),
    },
  },
  { label: "different end_days", args: { ...validArgs, end_days: 91 } },
  { label: "threads 2", args: { ...validArgs, threads: 2 } },
  { label: "different basis", args: { ...validArgs, rationale_basis: "Another basis." } },
  { label: "different input_dir", args: { ...validArgs, input_dir: "input/copy/ccw" } },
  { label: "modified ccw.cfg.calib", args: validArgs, modify: true },
])("orphan with $label is named and left untouched", async ({ args, modify }) => {
  seedCard(h);
  seedOrphan(h, ORPHAN);
  native.cpSync(h.input, join(h.cwd, "input", "copy", "ccw"), { recursive: true });
  if (modify) native.appendFileSync(join(h.input, "ccw.cfg.calib"), "\n");
  const before = await workspaceSnapshot(h);
  expectToolError(await h.invoke(args), new RegExp(ORPHAN, "u"));
  expect(await workspaceSnapshot(h)).toEqual(before);
  expect(readCard(h).linked_analyses).toEqual([]);
});

test("two orphan plans for the card are both named", async () => {
  seedCard(h);
  seedOrphan(h, ORPHAN);
  seedOrphan(h, SECOND);
  const before = await workspaceSnapshot(h);
  const message = expectToolError(await h.invoke(validArgs), new RegExp(ORPHAN, "u"));
  expect(message).toContain(SECOND);
  expect(await workspaceSnapshot(h)).toEqual(before);
});

test.each([
  { label: "invalid JSON", install: (path: string) => native.writeFileSync(path, "{not json") },
  {
    label: "symbolic link",
    install(path: string) {
      const target = join(h.root, "outside-plan.json");
      native.writeFileSync(target, JSON.stringify({ task_id: OTHER_TASK }));
      native.symlinkSync(target, path);
    },
  },
  { label: "directory", install: (path: string) => native.mkdirSync(path) },
  {
    label: "unreadable task_id",
    install: (path: string) => native.writeFileSync(path, JSON.stringify({ task_id: 7 })),
  },
  {
    label: "schema-invalid orphan",
    install: (path: string) => native.writeFileSync(path, JSON.stringify({ task_id: TASK })),
  },
])("$label plan entry is named, never skipped", async ({ install }) => {
  seedCard(h);
  native.mkdirSync(analysesDir(h));
  install(join(analysesDir(h), `${ORPHAN}.json`));
  const before = await workspaceSnapshot(h);
  expectToolError(await h.invoke(validArgs), new RegExp(ORPHAN, "u"));
  expect(await workspaceSnapshot(h)).toEqual(before);
});

test("another card's plan and unrelated names do not block creation", async () => {
  seedCard(h);
  seedOrphan(h, ORPHAN, { task_id: OTHER_TASK });
  native.writeFileSync(join(analysesDir(h), "notes.txt"), "not a plan\n");
  const other = fileSnapshot(join(analysesDir(h), `${ORPHAN}.json`));
  const value = successValue(await h.invoke(validArgs));
  expect(value.analysis_plan_id).not.toBe(ORPHAN);
  expect(planNames(h)).toHaveLength(3);
  expect(fileSnapshot(join(analysesDir(h), `${ORPHAN}.json`))).toEqual(other);
  expect(readCard(h).linked_analyses).toEqual([value.analysis_plan_id]);
});

function seedCollisions(suffixes: string[]) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T09:30:00.000Z"));
  return suffixes.map((suffix) => {
    const { path } = seedOrphan(h, `PLAN-20261108T093000-${suffix}`, { task_id: OTHER_TASK });
    return { path, before: fileSnapshot(path) };
  });
}

test("one id collision publishes and links the reallocated id", async () => {
  seedCard(h);
  const [existing] = seedCollisions(["aaaa"]);
  entropy.suffixes = ["aaaa", "bbbb"];
  const value = successValue(await h.invoke(validArgs));
  expect(value.analysis_plan_id).toBe("PLAN-20261108T093000-bbbb");
  expect(readCard(h).linked_analyses).toEqual(["PLAN-20261108T093000-bbbb"]);
  expect(fileSnapshot(existing.path)).toEqual(existing.before);
  expect(AnalysisPlanSchema.parse(readPlan(h, value.analysis_plan_id)).task_id).toBe(TASK);
});

test("four consecutive id collisions write nothing and leave the card", async () => {
  seedCard(h);
  const existing = seedCollisions(["aaaa", "bbbb", "cccc", "dddd"]);
  entropy.suffixes = ["aaaa", "bbbb", "cccc", "dddd"];
  const before = await workspaceSnapshot(h);
  expectToolError(await h.invoke(validArgs), /collision|conflict/iu);
  expect(await workspaceSnapshot(h)).toEqual(before);
  for (const entry of existing) expect(fileSnapshot(entry.path)).toEqual(entry.before);
  expect(readCard(h).linked_analyses).toEqual([]);
});
