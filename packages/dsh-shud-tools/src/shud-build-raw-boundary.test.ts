import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { BuildIdSchema } from "@shud-harness/dsh-shud-core";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { readWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { admission, valueOf } from "./change-create/test-harness.ts";
import { expectToolError, treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  BASE_FILES,
  buildFixture,
  unchangedWorkspace,
  type BuildFixture,
} from "./shud-build/matrix/test-harness.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
let h: BuildFixture;
beforeEach(async () => {
  h = await buildFixture({ files: { ...BASE_FILES, "input/ccw/raw.txt": "protected input\n" } });
});
afterEach(async () => {
  await h.dispose();
});

async function deny(raw: string, args: unknown = { task_id: h.taskId }) {
  await h.apply(rawGuard, { rawDirs: [raw] });
  const seen = await admission(h);
  await unchangedWorkspace(h, async () => {
    vi.clearAllMocks();
    const message = expectToolError(await h.invoke("shud_build", args), /Raw data is immutable/u);
    expect(message).not.toContain(h.cwd);
    expect(message).not.toContain(h.taskId);
    expect(seen.executions).toBe(0);
    expect(seen.preExecutions).toBe(0);
    expect(seen.approvals).toEqual([]);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });
}

test.each([
  ["builds", "existing"],
  ["builds", "missing"],
  ["repos", "existing"],
  ["repos", "missing"],
  ["repos/SHUD", "existing"],
  ["repos/SHUD", "missing-source"],
  ["repos/SHUD", "missing-repos"],
])("raw %s protects its %s target and nearest ancestor", async (raw, state) => {
  let saved: string | undefined;
  if (raw === "builds" && state === "existing") {
    fs.mkdirSync(join(h.cwd, "builds"));
    fs.writeFileSync(join(h.cwd, "builds", "sentinel"), "protected build namespace\n");
  }
  if (state.startsWith("missing") && raw !== "builds") {
    saved = join(h.root, "saved-source");
    fs.renameSync(state === "missing-source" ? h.source : join(h.cwd, "repos"), saved);
  }
  const beforeSaved = saved ? await treeOrAbsent(saved) : null;
  await deny(raw);
  if (saved) expect(await treeOrAbsent(saved)).toEqual(beforeSaved);
});

test.each(["workspace", "raw-alias", "builds-alias", "repos-alias", "source-alias"])(
  "%s physical aliases retain raw containment",
  async (kind) => {
    let raw = "builds";
    if (kind === "workspace") {
      const alias = join(h.root, "workspace-alias");
      fs.symlinkSync(h.cwd, alias);
      Object.assign(h.agent.session.header, { cwd: alias });
    } else if (kind === "raw-alias") {
      raw = join(h.root, "raw-alias");
      fs.symlinkSync(h.source, raw);
    } else {
      const target =
        kind === "builds-alias"
          ? join(h.cwd, "builds")
          : kind === "repos-alias"
            ? join(h.cwd, "repos")
            : h.source;
      if (kind === "builds-alias") fs.mkdirSync(target);
      raw = join(h.root, "physical-raw");
      fs.renameSync(target, raw);
      fs.symlinkSync(raw, target);
    }
    const beforeRaw = await treeOrAbsent(raw.startsWith("/") ? raw : join(h.cwd, raw));
    await deny(raw);
    expect(await treeOrAbsent(raw.startsWith("/") ? raw : join(h.cwd, raw))).toEqual(beforeRaw);
  },
);

test.each(["existing-builds", "missing-builds", "source"])(
  "native case identity governs %s without assuming the filesystem",
  async (kind) => {
    const insensitive = fs.existsSync(join(h.cwd, "REPOS"));
    if (kind === "existing-builds") fs.mkdirSync(join(h.cwd, "builds"));
    const raw = kind === "source" ? "RePoS/ShUd" : "BuIlDs";
    if (insensitive) await deny(raw);
    else {
      await h.apply(rawGuard, { rawDirs: [raw] });
      const seen = await admission(h);
      await h.preserve(async () => {
        valueOf(await h.build());
      });
      expect(seen.executions).toBe(1);
      expect(seen.approvals).toEqual([]);
    }
  },
);

test.each([
  "builds-old",
  "repos-old",
  "tasks/TASK-20261102T093000-ffff",
  "changes/CHG-20261102T093000-ffff.json",
  "builds/BUILD-20261102T093000-ffff",
  "repos/SHUD/input/ccw",
  "data/raw",
])("disjoint raw %s reaches the real build without approval", async (raw) => {
  if (!fs.existsSync(join(h.cwd, raw))) fs.mkdirSync(join(h.cwd, raw), { recursive: true });
  const before = await treeOrAbsent(join(h.cwd, raw));
  await h.apply(rawGuard, { rawDirs: [raw] });
  const seen = await admission(h);
  await h.preserve(async () => {
    const result = valueOf(await h.build());
    const record = readWorkspaceRecord(h.cwd, "build", BuildIdSchema.parse(result.build_id), {
      readonly: true,
    });
    expect(
      childProcess.execFileSync(join(h.cwd, record.binary_path), [], { encoding: "utf8" }),
    ).toBe("base-matrix\n");
  });
  expect(seen.executions).toBe(1);
  expect(seen.approvals).toEqual([]);
  expect(await treeOrAbsent(join(h.cwd, raw))).toEqual(before);
});

test.each([null, {}, { task_id: "../escape" }, { task_id: "TASK-1", source_path: "unrelated" }])(
  "fixed raw denial precedes malformed arguments %j",
  async (args) => {
    await deny("builds", args);
  },
);
