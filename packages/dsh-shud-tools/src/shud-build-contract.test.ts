import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { BuildIdSchema } from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord, writeWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as policyGate from "../../dsh-shud-policy-gate/src/index.ts";
import { admission, valueOf } from "./change-create/test-harness.ts";
import { expectToolError } from "./task-linked/test-harness.ts";
import {
  buildFixture,
  PRIVATE,
  unchangedWorkspace,
  type BuildFixture,
} from "./shud-build/matrix/test-harness.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawnSync: vi.fn(actual.spawnSync) };
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
let h: BuildFixture;
beforeEach(async () => {
  h = await buildFixture();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await h.dispose();
});

const invalid = [
  null,
  [],
  "build",
  7,
  false,
  {},
  { task_id: "../tasks/x" },
  { task_id: "TASK-20261102T093000-ABCD" },
  ...[null, 7, [], "CHG-1", "../patches/x"].map((change_id) => ({ change_id })),
  ...[null, "true", 1, []].map((rhs_openmp) => ({ rhs_openmp })),
  ...["source_path", "cwd", "sundialsRoot", "approve"].map((key) => ({ [key]: PRIVATE })),
];
test.each(invalid)("closed build arguments reject %j before workspace IO", async (args) => {
  const input =
    typeof args === "object" && args !== null && !Array.isArray(args) && Object.keys(args).length
      ? { task_id: h.taskId, ...args }
      : args;
  await unchangedWorkspace(h, async () => {
    vi.clearAllMocks();
    expectToolError(
      await h.invoke("shud_build", input),
      /object|task_id|change_id|rhs_openmp|parameter/iu,
    );
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(fs.lstatSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });
});

test.each([undefined, ""])("missing session cwd %j fails before IO", async (cwd) => {
  Object.assign(h.agent.session.header, { cwd });
  try {
    await unchangedWorkspace(h, async () => {
      vi.clearAllMocks();
      expectToolError(await h.build(), /cwd|workspace/iu);
      expect(childProcess.execFile).not.toHaveBeenCalled();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
  } finally {
    Object.assign(h.agent.session.header, { cwd: h.cwd });
  }
});

test("missing jobs configuration mounts existing tools but never guesses an environment root", async () => {
  await h.dispose();
  h = await buildFixture({ configured: false });
  vi.stubEnv("SUNDIALS_ROOT", h.sundialsRoot);
  vi.stubEnv("SUNDIALS_DIR", h.sundialsRoot);
  await unchangedWorkspace(h, async () => {
    vi.clearAllMocks();
    expectToolError(await h.build(), /sundialsRoot/u);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });
});

test("reloaded real jobs provider replaces its build configuration without argument mutation", async () => {
  const next = join(h.root, "next-sundials");
  fs.mkdirSync(next);
  await h.reloadJobs(next);
  const args = Object.freeze({ task_id: h.taskId, rhs_openmp: true });
  const record = await h.preserve(async () => {
    const result = valueOf(await h.invoke("shud_build", args));
    return readWorkspaceRecord(h.cwd, "build", BuildIdSchema.parse(result.build_id), {
      readonly: true,
    });
  });
  expect(record.sundials_dir).toBe(next);
  expect(record.make_argv).toContain(`SUNDIALS_DIR=${next}`);
  expect(record.make_argv).not.toContain(`SUNDIALS_DIR=${h.sundialsRoot}`);
  expect(record.rhs_openmp).toBe(true);
  expect(args).toEqual({ task_id: h.taskId, rhs_openmp: true });
  await h.reloadJobs();
  await unchangedWorkspace(h, async () => {
    expectToolError(await h.build(), /sundialsRoot/u);
  });
});

test.each([
  "missing",
  "json",
  "schema",
  "foreign",
  "science",
  "done",
  "parked",
  "cancelled",
  "task-link",
  "tasks-link",
  "task-directory-link",
  "task-fifo",
])("readonly task admission rejects %s without Git or output mutation", async (kind) => {
  const card = readWorkspaceRecord(h.cwd, "task", h.taskId, { readonly: true });
  if (kind === "missing") fs.unlinkSync(h.cardPath);
  else if (kind === "json") fs.writeFileSync(h.cardPath, `{${PRIVATE}`);
  else if (kind === "schema")
    fs.writeFileSync(h.cardPath, JSON.stringify({ ...card, source_base_commit: PRIVATE }));
  else if (kind === "foreign")
    fs.writeFileSync(h.cardPath, JSON.stringify({ ...card, task_id: "TASK-20261102T093000-ffff" }));
  else if (kind.endsWith("link") || kind === "task-fifo") {
    const target =
      kind === "tasks-link"
        ? join(h.cwd, "tasks")
        : kind === "task-directory-link"
          ? join(h.cwd, "tasks", h.taskId)
          : h.cardPath;
    const saved = `${target}.saved`;
    fs.renameSync(target, saved);
    if (kind === "task-fifo") childProcess.execFileSync("mkfifo", [target]);
    else fs.symlinkSync(saved, target);
  } else
    writeWorkspaceRecord(h.cwd, "task", {
      ...card,
      ...(kind === "science"
        ? { type: "science_assist" as const, source_base_commit: null }
        : { status: kind as "done" | "parked" | "cancelled" }),
    });
  await unchangedWorkspace(h, async () => {
    vi.clearAllMocks();
    const message = expectToolError(await h.build(), /task|code_change|planned|running/iu);
    expect(message).not.toContain(PRIVATE);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });
});

test.each(["worker", "reviewer", "coordinator", "coder"])(
  "actual policy gate enforces the projected %s role before build execution",
  async (role) => {
    const original = h.agent.ctx;
    await original.plugin((services: Context) => {
      services.provide("sessionProjections", {
        stateOf(session: object, key: string) {
          return session === h.agent.session && key === "agentPreset" ? role : undefined;
        },
      });
    });
    await original.plugin({
      inject: ["sessionProjections"],
      apply(consumer: Context) {
        Object.assign(h.agent, { ctx: consumer });
      },
    });
    await h.apply(policyGate, {});
    const seen = await admission(h);
    await h.preserve(async () => {
      vi.clearAllMocks();
      const result = await h.build();
      if (role === "coder") {
        const value = valueOf(result);
        expect(
          readWorkspaceRecord(h.cwd, "build", BuildIdSchema.parse(value.build_id), {
            readonly: true,
          }).task_id,
        ).toBe(h.taskId);
        expect(seen.executions).toBe(1);
      } else {
        expectToolError(result, new RegExp(`Role ${role}.*shud_build`, "u"));
        expect(seen.executions).toBe(0);
        expect(childProcess.execFile).not.toHaveBeenCalled();
        expect(childProcess.spawnSync).not.toHaveBeenCalled();
        expect(fs.existsSync(join(h.cwd, "builds"))).toBe(false);
      }
      expect(seen.approvals).toEqual([]);
    });
  },
);
