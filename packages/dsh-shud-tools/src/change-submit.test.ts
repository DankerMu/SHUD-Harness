import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { PreToolDecision } from "@deepseek-ai/dsh-tools";
import { beforeEach, expect, test, vi } from "vitest";
import { readWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import {
  CHANGE_ID,
  failure,
  snapshotFile,
  submitHarness,
  writeChangeSentinel,
  writeProposedChange,
} from "./change-submit/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    renameSync: vi.fn(actual.renameSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(native.renameSync);
  vi.mocked(fs.mkdirSync).mockReset().mockImplementation(native.mkdirSync);
});

test("registered change_submit schema is closed and exposes only approval identity", async () => {
  const h = await submitHarness();
  try {
    const schema = h.runtime.schemas(h.agent).find((entry) => entry.name === "change_submit");
    expect(schema).toBeDefined();
    expect(schema?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["change_id"],
    });
    expect(Object.keys(schema?.parameters?.properties ?? {})).toEqual(["change_id"]);
  } finally {
    await h.dispose();
  }
});

test.each([
  null,
  [],
  7,
  false,
  "PRIVATE_ROOT",
  {},
  { change_id: "../PRIVATE_PATH" },
  { change_id: 7 },
  { change_id: CHANGE_ID, comment: "PRIVATE_COMMENT" },
])("change_submit rejects closed-schema input %j before publication", async (args) => {
  const h = await submitHarness();
  try {
    const fixture = await writeProposedChange(h.cwd);
    const before = await snapshotFile(fixture.changePath);
    vi.mocked(fs.renameSync).mockClear();
    const result = await h.submit(args);
    expect(result.isError).toBe(true);
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(await snapshotFile(fixture.changePath)).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test.each(["absent-agent", "missing-cwd", "empty-cwd", "empty-call-id"] as const)(
  "change_submit requires execution context %s before reads",
  async (fault) => {
    const h = await submitHarness();
    try {
      const fixture = await writeProposedChange(h.cwd);
      const before = await snapshotFile(fixture.changePath);
      if (fault === "missing-cwd") Reflect.deleteProperty(h.agent.session.header, "cwd");
      if (fault === "empty-cwd") Object.assign(h.agent.session.header, { cwd: "" });
      vi.clearAllMocks();
      failure(
        await h.submit(
          { change_id: CHANGE_ID },
          fault === "empty-call-id" ? "" : "context-call",
          fault === "absent-agent" ? null : h.agent,
        ),
        /cwd|callId/iu,
      );
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(fs.renameSync).not.toHaveBeenCalled();
      expect(await snapshotFile(fixture.changePath)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  "created",
  "planned",
  "parked",
  "reporting",
  "awaiting_pi",
  "done",
  "cancelled",
  "blocked",
] as const)(
  "change_submit rejects task status %s without reading patch or rewriting evidence",
  async (status) => {
    const h = await submitHarness();
    try {
      const fixture = await writeProposedChange(h.cwd);
      const card = readWorkspaceRecord(h.cwd, "task", fixture.change.task_id, { readonly: true });
      native.writeFileSync(fixture.taskPath, JSON.stringify({ ...card, status }));
      const paths = [fixture.changePath, fixture.taskPath, fixture.patchPath];
      const before = await Promise.all(paths.map(snapshotFile));
      vi.clearAllMocks();
      failure(await h.submit(), /requires running/iu);
      expect(vi.mocked(fs.readFileSync).mock.calls.map(([path]) => path)).not.toContain(
        fixture.patchPath,
      );
      expect(fs.renameSync).not.toHaveBeenCalled();
      expect(await Promise.all(paths.map(snapshotFile))).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

for (const target of ["change", "task", "patch"] as const) {
  test.each([
    "missing",
    "root-missing",
    "root-file",
    "root-symlink",
    "symlink",
    "directory",
    "fifo",
    "corrupt",
    "foreign-id",
    "read-error",
  ] as const)(`${target} %s is rejected without CR publication`, async (fault) => {
    const h = await submitHarness();
    try {
      const fixture = await writeProposedChange(h.cwd);
      const path =
        target === "change"
          ? fixture.changePath
          : target === "task"
            ? fixture.taskPath
            : fixture.patchPath;
      const directory = join(
        h.cwd,
        target === "change" ? "changes" : target === "task" ? "tasks" : "patches",
      );
      const outside = join(h.root, "PRIVATE_OUTSIDE");
      if (fault === "root-missing") native.rmSync(directory, { recursive: true });
      else if (fault === "root-file") {
        native.rmSync(directory, { recursive: true });
        native.writeFileSync(directory, "not a directory");
      } else if (fault === "root-symlink") {
        native.renameSync(directory, outside);
        native.symlinkSync(outside, directory);
      } else if (fault === "corrupt") native.writeFileSync(path, "PRIVATE_CORRUPT");
      else if (fault === "foreign-id") {
        if (target === "patch") native.writeFileSync(path, "abd");
        else {
          const record = JSON.parse(native.readFileSync(path, "utf8")) as Record<string, unknown>;
          Object.assign(
            record,
            target === "change"
              ? {
                  change_id: "CHG-20261102T090000-ffff",
                  patch_path: "patches/CHG-20261102T090000-ffff.patch",
                }
              : { task_id: "TASK-20261102T090000-ffff" },
          );
          native.writeFileSync(path, JSON.stringify(record));
        }
      } else if (fault !== "read-error") {
        native.renameSync(path, outside);
        if (fault === "symlink") native.symlinkSync(outside, path);
        if (fault === "directory") native.mkdirSync(path);
        if (fault === "fifo") execFileSync("mkfifo", [path]);
      }
      const before =
        target === "change" &&
        ["missing", "root-missing", "root-file", "directory", "fifo"].includes(fault)
          ? undefined
          : await snapshotFile(fixture.changePath);
      vi.clearAllMocks();
      if (fault === "read-error")
        vi.mocked(fs.readFileSync).mockImplementation((...args) => {
          if (args[0] === path)
            throw Object.assign(new Error("PRIVATE_IO_DETAIL"), { code: "EACCES" });
          return native.readFileSync(...args);
        });
      failure(await h.submit(), /change_submit/iu);
      expect(fs.renameSync).not.toHaveBeenCalled();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
      if (before) expect(await snapshotFile(fixture.changePath)).toEqual(before);
      if (fault === "root-missing") expect(native.existsSync(directory)).toBe(false);
      if (["symlink", "directory", "fifo", "root-symlink"].includes(fault)) {
        expect(vi.mocked(fs.readFileSync).mock.calls.map(([entry]) => entry)).not.toContain(path);
      }
    } finally {
      await h.dispose();
    }
  });
}

test("canonical rename failure preserves proposed CR and reports only controlled write diagnostics", async () => {
  const h = await submitHarness();
  try {
    const fixture = await writeProposedChange(h.cwd);
    const sibling = await writeChangeSentinel(h.cwd, fixture.change);
    const paths = [fixture.changePath, fixture.taskPath, fixture.patchPath, ...sibling.paths];
    const before = await Promise.all(paths.map(snapshotFile));
    vi.mocked(fs.renameSync).mockClear();
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (to === fixture.changePath)
        throw Object.assign(new Error("PRIVATE_RENAME_CAUSE"), { code: "EIO" });
      native.renameSync(from, to);
    });
    failure(await h.submit(), /write/iu);
    expect(vi.mocked(fs.renameSync).mock.calls.map(([, target]) => target)).toEqual([
      fixture.changePath,
    ]);
    expect(await Promise.all(paths.map(snapshotFile))).toEqual(before);
    expect(native.readdirSync(join(h.cwd, "changes")).sort()).toEqual([
      `${CHANGE_ID}.json`,
      `${sibling.change.change_id}.json`,
    ]);
  } finally {
    await h.dispose();
  }
});

test("approval owns only four CR fields and neither requires code_change type/base nor reads source or links", async () => {
  const h = await submitHarness();
  try {
    const fixture = await writeProposedChange(h.cwd);
    const card = readWorkspaceRecord(h.cwd, "task", fixture.change.task_id, { readonly: true });
    native.writeFileSync(
      fixture.taskPath,
      JSON.stringify({
        ...card,
        type: "science_assist",
        source_base_commit: null,
        linked_changes: [],
        linked_reports: ["REPORT-20261102T090000-ffff"],
      }),
    );
    native.mkdirSync(join(h.cwd, "repos", "SHUD"), { recursive: true });
    const source = join(h.cwd, "repos", "SHUD", "PRIVATE_SOURCE");
    native.writeFileSync(source, "untouched source");
    const paths = [fixture.taskPath, fixture.patchPath, source];
    const before = await Promise.all(paths.map(snapshotFile));
    vi.clearAllMocks();
    const approvalStarted = Date.now();
    expect(await h.submit()).toMatchObject({
      isError: false,
      value: { change_id: CHANGE_ID, status: "approved", approval_ref: "change-submit-contract" },
    });
    const reads = vi.mocked(fs.readFileSync).mock.calls.map(([path]) => path);
    expect(
      reads.every((path) =>
        [fixture.changePath, fixture.taskPath, fixture.patchPath].includes(String(path)),
      ),
    ).toBe(true);
    expect(fs.renameSync).toHaveBeenCalledTimes(1);
    const approved = readWorkspaceRecord(h.cwd, "change", CHANGE_ID, { readonly: true });
    expect(approved).toEqual({
      ...fixture.change,
      status: "approved",
      approval_ref: "change-submit-contract",
      approved_at: approved.approved_at,
      updated_at: approved.updated_at,
    });
    expect(approved.approved_at).toBe(approved.updated_at);
    expect(approved.approved_at).toBeTypeOf("string");
    expect(Date.parse(approved.updated_at)).toBeGreaterThanOrEqual(approvalStarted);
    expect(Date.parse(approved.updated_at)).toBeLessThanOrEqual(Date.now());
    expect(await Promise.all(paths.map(snapshotFile))).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test("native ToolRuntime rejects an array with an own change_id before policy admission", async () => {
  const h = await submitHarness();
  try {
    const fixture = await writeProposedChange(h.cwd);
    const before = await snapshotFile(fixture.changePath);
    const admitted = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: "cancel" }));
    h.ctx.on("tools/pre-execute", admitted);
    const result = await h.submit(Object.assign([], { change_id: CHANGE_ID }));
    expect(result.isError).toBe(true);
    expect(admitted).not.toHaveBeenCalled();
    expect(await snapshotFile(fixture.changePath)).toEqual(before);
  } finally {
    await h.dispose();
  }
});
