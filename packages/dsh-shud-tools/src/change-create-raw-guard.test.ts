import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  ChangeIdSchema,
  ChangeRequestSchema,
  TaskIdSchema,
  type TaskId,
} from "@shud-harness/dsh-shud-core";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { expectToolError, treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  admission,
  changeHarness,
  readCard,
  seedSource,
  seedTask,
  taskPath,
  type ChangeHarness,
  valueOf,
} from "./change-create/test-harness.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
let h: ChangeHarness;
let id: TaskId;
beforeEach(async () => {
  h = await changeHarness();
  seedSource(h);
  id = await seedTask(h);
  fs.writeFileSync(join(h.source, "Makefile"), "candidate\n");
});
afterEach(async () => {
  await h.dispose();
});

test.each([
  "changes",
  "patches",
  "tasks",
  "task-directory",
  "task-file",
  "repos",
  "repos/SHUD",
  ".",
])("fixed protected %s denies before execution, approval, Git or mutation", async (kind) => {
  const raw =
    kind === "task-file" ? taskPath(h, id) : kind === "task-directory" ? `tasks/${id}` : kind;
  const logs: string[] = [];
  h.ctx.logger.exporter({
    export(message) {
      logs.push(message.args.map(String).join(" "));
    },
  });
  await h.apply(rawGuard, { rawDirs: [raw] });
  const seen = await admission(h);
  const before = await treeOrAbsent(h.cwd);
  vi.mocked(childProcess.execFile).mockClear();
  vi.mocked(fs.readFileSync).mockClear();
  const message = expectToolError(await h.invoke("change_create", { task_id: id }), /immutable/iu);
  expect(seen.executions).toBe(0);
  expect(seen.approvals).toEqual([]);
  expect(childProcess.execFile).not.toHaveBeenCalled();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(message).not.toContain(h.cwd);
  expect(message).not.toContain(id);
  expect(logs.some((line) => line.includes("deny change_create raw-immutable"))).toBe(true);
  expect(logs.join("\n")).not.toContain(h.cwd);
  expect(await treeOrAbsent(h.cwd)).toEqual(before);
});

test.each([
  { rawTarget: "tasks", missingAncestor: "tasks" },
  { rawTarget: "task-directory", missingAncestor: "tasks" },
  { rawTarget: "task-file", missingAncestor: "tasks" },
  { rawTarget: "task-directory", missingAncestor: "task-directory" },
  { rawTarget: "task-file", missingAncestor: "task-directory" },
])(
  "absent $missingAncestor still protects raw $rawTarget before card admission",
  async ({ rawTarget, missingAncestor }) => {
    const tasks = join(h.cwd, "tasks");
    const directory = join(tasks, id);
    const missing = missingAncestor === "tasks" ? tasks : directory;
    fs.rmSync(missing, { recursive: true });
    const raw =
      rawTarget === "tasks" ? tasks : rawTarget === "task-directory" ? directory : taskPath(h, id);
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(raw)).toBe(false);
    const logs: string[] = [];
    h.ctx.logger.exporter({
      export(message) {
        logs.push(message.args.map(String).join(" "));
      },
    });
    await h.apply(rawGuard, { rawDirs: [raw] });
    const seen = await admission(h);
    const before = await treeOrAbsent(h.cwd);
    vi.mocked(childProcess.execFile).mockClear();
    vi.mocked(fs.readFileSync).mockClear();

    expectToolError(await h.invoke("change_create", { task_id: id }), /immutable/iu);

    expect(seen.preExecutions).toBe(0);
    expect(seen.executions).toBe(0);
    expect(seen.approvals).toEqual([]);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("deny change_create raw-immutable"))).toBe(true);
    expect(fs.existsSync(missing)).toBe(false);
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  },
);

test.each([{}, { task_id: "../escape" }, { task_id: "TASK-20261102T093000-A001" }])(
  "invalid or missing task identity still protects the tasks fallback: %j",
  async (args) => {
    await h.apply(rawGuard, { rawDirs: ["tasks"] });
    const seen = await admission(h);
    const before = await treeOrAbsent(h.cwd);
    vi.mocked(childProcess.execFile).mockClear();
    expectToolError(await h.invoke("change_create", args), /immutable/iu);
    expect(seen.executions).toBe(0);
    expect(seen.approvals).toEqual([]);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  },
);

test.each(["other-task", "raw-descendant", "source-descendant", "sibling-prefix", "description"])(
  "disjoint %s remains admitted and publishes real change evidence",
  async (kind) => {
    const other = TaskIdSchema.parse("TASK-20261102T093000-ffff");
    const raw =
      kind === "other-task"
        ? `tasks/${other}/task.json`
        : kind === "raw-descendant"
          ? "patches/raw-child"
          : kind === "source-descendant"
            ? "repos/SHUD/raw-child"
            : kind === "sibling-prefix"
              ? "patches-sibling"
              : "data/raw";
    await h.apply(rawGuard, { rawDirs: [raw] });
    const seen = await admission(h);
    const rawBefore = await treeOrAbsent(join(h.cwd, raw));
    const result = valueOf(
      await h.invoke("change_create", {
        task_id: id,
        description: `Mention only: ${raw} patches repos/SHUD tasks`,
      }),
    );
    expect(result.status).toBe("proposed");
    expect(seen.executions).toBe(1);
    expect(seen.approvals).toEqual([]);
    expect(readCard(h, id).linked_changes).toEqual([result.change_id]);
    expect(await treeOrAbsent(join(h.cwd, raw))).toEqual(rawBefore);
  },
);

test.each(["workspace", "raw-alias", "source-alias", "task-alias", "tasks-alias"])(
  "native %s aliases retain the fixed protected target boundary",
  async (kind) => {
    let raw = h.source;
    if (kind === "workspace") {
      const alias = join(h.root, "workspace-alias");
      fs.symlinkSync(h.cwd, alias);
      Object.assign(h.agent.session.header, { cwd: alias });
    } else if (kind === "raw-alias") {
      raw = join(h.root, "raw-source-alias");
      fs.symlinkSync(h.source, raw);
    } else {
      const target =
        kind === "source-alias"
          ? h.source
          : kind === "task-alias"
            ? taskPath(h, id)
            : join(h.cwd, "tasks");
      raw = join(h.root, "protected-physical");
      fs.renameSync(target, raw);
      fs.symlinkSync(raw, target);
      if (kind === "tasks-alias") raw = join(raw, id, "task.json");
    }
    await h.apply(rawGuard, { rawDirs: [raw] });
    const seen = await admission(h);
    const before = await treeOrAbsent(h.root);
    vi.mocked(childProcess.execFile).mockClear();
    expectToolError(await h.invoke("change_create", { task_id: id }), /immutable/iu);
    expect(seen.executions).toBe(0);
    expect(seen.approvals).toEqual([]);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(await treeOrAbsent(h.root)).toEqual(before);
  },
);

test("missing differently cased patches follows actual native namespace identity", async () => {
  const insensitive = fs.existsSync(join(h.cwd, "REPOS"));
  expect(fs.existsSync(join(h.cwd, "patches"))).toBe(false);
  await h.apply(rawGuard, { rawDirs: ["PaTcHeS"] });
  const seen = await admission(h);
  const before = await treeOrAbsent(h.cwd);
  vi.mocked(childProcess.execFile).mockClear();
  const result = await h.invoke("change_create", { task_id: id });
  if (insensitive) {
    expectToolError(result, /immutable/iu);
    expect(seen.executions).toBe(0);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  } else {
    expect(valueOf(result).status).toBe("proposed");
    expect(seen.executions).toBe(1);
  }
  expect(seen.approvals).toEqual([]);
});

test.each([
  { raw: "REPOS", physical: "repos" },
  { raw: "repos/shud", physical: "repos/SHUD" },
])(
  "source case spelling $raw follows independently observed native identity",
  async ({ raw, physical }) => {
    const rawPath = join(h.cwd, raw);
    const physicalPath = join(h.cwd, physical);
    const original = fs.lstatSync(physicalPath, { bigint: true });
    const alternate = fs.lstatSync(rawPath, { bigint: true, throwIfNoEntry: false });
    // The real filesystem, not the guard or OS name, determines whether this spelling aliases.
    // An unexpected existing distinct entry is a fixture failure, never a skipped case.
    if (alternate !== undefined) {
      expect(alternate.isDirectory()).toBe(true);
      expect([alternate.dev, alternate.ino]).toEqual([original.dev, original.ino]);
    }
    await h.apply(rawGuard, { rawDirs: [raw] });
    const seen = await admission(h);
    const before = await treeOrAbsent(h.cwd);
    const sourceBefore = await treeOrAbsent(h.source);
    vi.mocked(childProcess.execFile).mockClear();
    vi.mocked(fs.readFileSync).mockClear();

    const result = await h.invoke("change_create", { task_id: id });

    if (alternate !== undefined) {
      expectToolError(result, /immutable/iu);
      expect(seen.preExecutions).toBe(0);
      expect(seen.executions).toBe(0);
      expect(childProcess.execFile).not.toHaveBeenCalled();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } else {
      const published = valueOf(result);
      const changeId = ChangeIdSchema.parse(published.change_id);
      expect(published).toMatchObject({
        status: "proposed",
        patch_path: `patches/${changeId}.patch`,
      });
      expect(seen.preExecutions).toBe(1);
      expect(seen.executions).toBe(1);
      expect(childProcess.execFile).toHaveBeenCalled();
      const record = ChangeRequestSchema.parse(
        JSON.parse(fs.readFileSync(join(h.cwd, "changes", `${changeId}.json`), "utf8")),
      );
      expect(record).toMatchObject({ change_id: changeId, task_id: id, status: "proposed" });
      expect(fs.statSync(join(h.cwd, `patches/${changeId}.patch`)).isFile()).toBe(true);
      expect(readCard(h, id).linked_changes).toEqual([changeId]);
      expect(fs.existsSync(rawPath)).toBe(false);
    }
    expect(seen.approvals).toEqual([]);
    expect(await treeOrAbsent(h.source)).toEqual(sourceBefore);
  },
);

for (const evidence of ["missing", "corrupt"]) {
  test.each(["disjoint", "task-file", "source"])(
    `${evidence} card: raw %s decisions read metadata only`,
    async (kind) => {
      const path = taskPath(h, id);
      if (evidence === "missing") fs.unlinkSync(path);
      else fs.writeFileSync(path, "PRIVATE_CORRUPT_CARD_536");
      const raw = kind === "task-file" ? path : kind === "source" ? h.source : "data/raw";
      await h.apply(rawGuard, { rawDirs: [raw] });
      const seen = await admission(h);
      const readsBeforeTool: number[] = [];
      await h.ctx.plugin((services: Context) => {
        services.on("tools/pre-execute", (_event, next) => {
          readsBeforeTool.push(
            vi.mocked(fs.readFileSync).mock.calls.filter(([target]) => String(target) === path)
              .length,
          );
          return next();
        });
      });
      const before = await treeOrAbsent(h.cwd);
      vi.mocked(fs.readFileSync).mockClear();
      vi.mocked(childProcess.execFile).mockClear();
      const result = await h.invoke("change_create", { task_id: id });
      const message = expectToolError(
        result,
        kind === "disjoint" ? /task|read|missing|parse/iu : /immutable/iu,
      );
      expect(message).not.toContain("PRIVATE_CORRUPT_CARD_536");
      expect(readsBeforeTool).toEqual(kind === "disjoint" ? [0] : []);
      expect(seen.preExecutions).toBe(kind === "disjoint" ? 1 : 0);
      expect(seen.executions).toBe(kind === "disjoint" ? 1 : 0);
      if (kind !== "disjoint") expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(seen.approvals).toEqual([]);
      expect(childProcess.execFile).not.toHaveBeenCalled();
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    },
  );
}

test("raw source does not block task creation but blocks subsequent change publication", async () => {
  await h.apply(rawGuard, { rawDirs: ["repos/SHUD"] });
  const seen = await admission(h);
  vi.mocked(childProcess.execFile).mockClear();
  const another = await seedTask(h);
  expect(readCard(h, another).source_base_commit).toBe(readCard(h, id).source_base_commit);
  expect(childProcess.execFile).toHaveBeenCalled();
  expect(seen.executions).toBe(1);
  const before = await treeOrAbsent(h.cwd);
  vi.mocked(childProcess.execFile).mockClear();
  expectToolError(await h.invoke("change_create", { task_id: another }), /immutable/iu);
  expect(seen.executions).toBe(1);
  expect(seen.approvals).toEqual([]);
  expect(childProcess.execFile).not.toHaveBeenCalled();
  expect(await treeOrAbsent(h.cwd)).toEqual(before);
});

test.each(["changes", "patches"])(
  "existing protected %s retains bytes and metadata without any execution",
  async (raw) => {
    fs.mkdirSync(join(h.cwd, raw));
    fs.writeFileSync(join(h.cwd, raw, "protected.txt"), "original raw evidence\n");
    await h.apply(rawGuard, { rawDirs: [raw] });
    const seen = await admission(h);
    const before = await treeOrAbsent(h.cwd);
    vi.mocked(childProcess.execFile).mockClear();
    expectToolError(await h.invoke("change_create", { task_id: id }), /immutable/iu);
    expect(seen.executions).toBe(0);
    expect(seen.approvals).toEqual([]);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  },
);
