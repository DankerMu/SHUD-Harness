import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { ChangeIdSchema, ChangeRequestSchema } from "@shud-harness/dsh-shud-core";
import { writeWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { expectToolError, treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  changeHarness,
  git,
  noChangeObjects,
  PRIVATE,
  readCard,
  seedSource,
  seedTask,
  sourceSnapshot,
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
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    readFileSync: vi.fn(actual.readFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});
let h: ChangeHarness;
beforeEach(async () => {
  h = await changeHarness();
});
afterEach(async () => {
  await h.dispose();
});
const validId = "TASK-20261102T093000-a001";

const invalidArgs = [
  null,
  [],
  "change",
  1,
  false,
  {},
  { task_id: "../tasks/x" },
  { task_id: "TASK-20261102T093000-A001" },
  { task_id: validId, semantic_level: "low" },
  { task_id: validId, semantic_level: null },
  { task_id: validId, description: null },
  { task_id: validId, description: [] },
  ...["a\nb", "a\rb", "a\u2028b", "a\u2029b"].map((description) => ({
    task_id: validId,
    description,
  })),
  ...["source_path", "cwd", "change_id", "approval_ref"].map((key) => ({
    task_id: validId,
    [key]: PRIVATE,
  })),
];
test.each(invalidArgs)(
  "change_create rejects closed-contract violation before IO: %j",
  async (args) => {
    vi.clearAllMocks();
    expectToolError(
      await h.invoke("change_create", args),
      /object|task_id|semantic_level|description|parameter/iu,
    );
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(fs.lstatSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  },
);

test.each([undefined, ""])("change_create requires explicit session cwd: %j", async (cwd) => {
  Object.assign(h.agent.session.header, { cwd });
  vi.clearAllMocks();
  try {
    expectToolError(await h.invoke("change_create", { task_id: validId }), /cwd|workspace/iu);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(fs.lstatSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  } finally {
    Object.assign(h.agent.session.header, { cwd: h.cwd });
  }
});

test.each(["missing", "json", "schema", "identity", "science", "done", "cancelled"])(
  "readonly card admission rejects %s evidence without Git or object writes",
  async (kind) => {
    seedSource(h);
    const id = await seedTask(h);
    const path = taskPath(h, id);
    if (kind === "missing") fs.unlinkSync(path);
    else if (kind === "json") fs.writeFileSync(path, `{${PRIVATE}`);
    else if (kind === "schema")
      fs.writeFileSync(path, JSON.stringify({ ...readCard(h, id), source_base_commit: PRIVATE }));
    else if (kind === "identity")
      fs.writeFileSync(path, JSON.stringify({ ...readCard(h, id), task_id: validId }));
    else
      writeWorkspaceRecord(h.cwd, "task", {
        ...readCard(h, id),
        ...(kind === "science"
          ? { type: "science_assist" as const, source_base_commit: null }
          : { status: kind as "done" | "cancelled" }),
      });
    const before = await treeOrAbsent(h.cwd);
    vi.mocked(childProcess.execFile).mockClear();
    const message = expectToolError(
      await h.invoke("change_create", { task_id: id }),
      /task|type|status/iu,
    );
    expect(message).not.toContain(PRIVATE);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  },
);

test("checkout drift reports both validated commits before status or diff", async () => {
  const pinned = seedSource(h);
  const id = await seedTask(h);
  fs.writeFileSync(join(h.source, "Makefile"), "committed change\n");
  git(h.source, "add", "Makefile");
  git(
    h.source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "drift",
  );
  const head = git(h.source, "rev-parse", "HEAD").toString("utf8").trim();
  const before = await treeOrAbsent(h.cwd);
  vi.mocked(childProcess.execFile).mockClear();
  const message = expectToolError(await h.invoke("change_create", { task_id: id }), /drift|base/iu);
  expect(message).toContain(pinned);
  expect(message).toContain(head);
  const commands = vi.mocked(childProcess.execFile).mock.calls.map((call) => call[1]);
  expect(
    commands.some(
      (argv) => Array.isArray(argv) && (argv.includes("status") || argv.includes("diff")),
    ),
  ).toBe(false);
  expect(await treeOrAbsent(h.cwd)).toEqual(before);
});

test.each(["empty", "untracked", "deleted", "renamed", "staged-added"])(
  "unsupported %s observation preserves source and card with no output objects",
  async (kind) => {
    seedSource(h);
    const id = await seedTask(h);
    const rejected = `${PRIVATE}-unsupported.cpp`;
    if (kind === "untracked" || kind === "staged-added") {
      fs.writeFileSync(join(h.source, rejected), "new\n");
      if (kind === "staged-added") git(h.source, "add", rejected);
    }
    if (kind === "deleted") fs.unlinkSync(join(h.source, "Makefile"));
    if (kind === "renamed") git(h.source, "mv", "Makefile", rejected);
    const before = await treeOrAbsent(h.cwd);
    const sourceBefore = sourceSnapshot(h, []);
    vi.mocked(childProcess.execFile).mockClear();
    const message = expectToolError(
      await h.invoke("change_create", { task_id: id }),
      /no modifications|Unsupported source changes/iu,
    );
    if (["untracked", "renamed", "staged-added"].includes(kind))
      expect(message).toContain(rejected);
    if (kind === "deleted") expect(message).toContain("Makefile");
    expect(
      vi
        .mocked(childProcess.execFile)
        .mock.calls.some((call) => Array.isArray(call[1]) && call[1].includes("diff")),
    ).toBe(false);
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
    expect(sourceSnapshot(h, [])).toEqual(sourceBefore);
    noChangeObjects(h);
  },
);

test.each([
  { level: undefined, expected: "numerical_implementation", risk: "high" },
  { level: "physical_equation", expected: "physical_equation", risk: "high" },
])(
  "declaration $level produces canonical semantics without changing the pinned source",
  async ({ level, expected, risk }) => {
    const head = seedSource(h, ["Makefile", "docs/note.md"]);
    const id = await seedTask(h);
    for (const path of ["Makefile", "docs/note.md"])
      fs.writeFileSync(join(h.source, path), "candidate\n");
    const before = sourceSnapshot(h, ["Makefile", "docs/note.md"]);
    const result = valueOf(
      await h.invoke("change_create", {
        task_id: id,
        ...(level === undefined ? {} : { semantic_level: level }),
      }),
    );
    const changeId = ChangeIdSchema.parse(result.change_id);
    const record = ChangeRequestSchema.parse(
      JSON.parse(fs.readFileSync(join(h.cwd, "changes", `${changeId}.json`), "utf8")),
    );
    expect(record).toMatchObject({
      base_commit: head,
      semantic_floor: "numerical_implementation",
      semantic_level: expected,
      risk,
      floor_categories: ["pure_engineering", "numerical_implementation"],
      files_changed: ["Makefile", "docs/note.md"],
      description: null,
      status: "proposed",
      approval_ref: null,
      approved_at: null,
    });
    expect(result.explanation).toBeUndefined();
    expect(sourceSnapshot(h, ["Makefile", "docs/note.md"])).toEqual(before);
  },
);

test("special path names retain literal patch identity and exact independent digest", async () => {
  const paths = [":(exclude)normal.cpp", "normal.cpp", "src/a b.cpp", "src/line\nbreak.cpp"];
  seedSource(h, paths);
  const id = await seedTask(h);
  for (const path of paths) fs.writeFileSync(join(h.source, path), `candidate ${path}\n`);
  const before = sourceSnapshot(h, paths);
  const expectedPatch = git(
    h.source,
    "diff",
    "HEAD",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
  );
  const result = valueOf(await h.invoke("change_create", { task_id: id }));
  const changeId = ChangeIdSchema.parse(result.change_id);
  const record = ChangeRequestSchema.parse(
    JSON.parse(fs.readFileSync(join(h.cwd, "changes", `${changeId}.json`), "utf8")),
  );
  expect(record.files_changed).toEqual(paths);
  expect(fs.readFileSync(join(h.cwd, record.patch_path))).toEqual(expectedPatch);
  expect(record.patch_sha256).toBe(createHash("sha256").update(expectedPatch).digest("hex"));
  expect(sourceSnapshot(h, paths)).toEqual(before);
});

test("change attribution follows the current preset projection rather than the frozen session header", async () => {
  seedSource(h);
  const id = await seedTask(h);
  fs.writeFileSync(join(h.source, "Makefile"), "candidate\n");
  Object.assign(h.agent.session.header, { agentPreset: "coordinator" });
  const original = h.agent.ctx;
  let current = "coder";
  await original.plugin((services: Context) => {
    services.provide("sessionProjections", {
      stateOf(session: object, key: string) {
        return session === h.agent.session && key === "agentPreset" ? current : undefined;
      },
    });
  });
  await original.plugin({
    inject: ["sessionProjections"],
    apply(consumer: Context) {
      Object.assign(h.agent, { ctx: consumer });
    },
  });
  for (const preset of ["coder", "reviewer"]) {
    current = preset;
    const result = valueOf(await h.invoke("change_create", { task_id: id }));
    const changeId = ChangeIdSchema.parse(result.change_id);
    const record = ChangeRequestSchema.parse(
      JSON.parse(fs.readFileSync(join(h.cwd, "changes", `${changeId}.json`), "utf8")),
    );
    expect(record.created_by).toBe(preset);
  }
});
