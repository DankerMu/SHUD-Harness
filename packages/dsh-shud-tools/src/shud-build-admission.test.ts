import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { TaskIdSchema } from "@shud-harness/dsh-shud-core";
import {
  readWorkspaceRecord,
  rewriteChangeRequest,
  writeWorkspaceRecord,
} from "@shud-harness/dsh-shud-records";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fileSnapshot, git, seedSource } from "./change-create/test-harness.ts";
import { expectToolError, treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  buildFixture,
  candidate,
  PRIVATE,
  unchangedWorkspace,
  type BuildFixture,
} from "./shud-build/matrix/test-harness.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawnSync: vi.fn(actual.spawnSync) };
});
const nativeProcess = await vi.importActual<typeof childProcess>("node:child_process");
let h: BuildFixture;
beforeEach(async () => {
  h = await buildFixture();
});
afterEach(async () => {
  vi.mocked(childProcess.execFile).mockImplementation(nativeProcess.execFile);
  await h.dispose();
});
function noBuildProcess() {
  expect(childProcess.spawnSync).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(childProcess.execFile)
      .mock.calls.some((call) => Array.isArray(call[1]) && call[1].includes("archive")),
  ).toBe(false);
}

test.each(["missing", "symlink", "file", "fifo", "nonrepo", "nested", "unborn", "sha256"])(
  "%s checkout is rejected without writing through its namespace",
  async (kind) => {
    const saved = join(h.root, "saved-source");
    fs.renameSync(h.source, saved);
    if (kind === "symlink") fs.symlinkSync(saved, h.source);
    else if (kind === "file") fs.writeFileSync(h.source, PRIVATE);
    else if (kind === "fifo") childProcess.execFileSync("mkfifo", [h.source]);
    else if (kind !== "missing") {
      fs.mkdirSync(h.source);
      if (kind === "nested") git(h.cwd, "init", "-q", "--template=");
      if (kind === "unborn") git(h.source, "init", "-q", "--template=");
      if (kind === "sha256") seedSource(h, ["Makefile"], "sha256");
    }
    const beforeSaved = await treeOrAbsent(saved);
    await unchangedWorkspace(h, async () => {
      vi.clearAllMocks();
      expectToolError(await h.build(), /repos\/SHUD|checkout/iu);
      noBuildProcess();
    });
    expect(await treeOrAbsent(saved)).toEqual(beforeSaved);
  },
);

test.each(["modified", "untracked", "deleted", "renamed", "staged-added"])(
  "base build rejects %s source observations before reserving output",
  async (kind) => {
    const file = join(h.source, "docs/note.txt");
    if (kind === "modified") fs.writeFileSync(file, "dirty\n");
    if (kind === "untracked" || kind === "staged-added") {
      fs.writeFileSync(join(h.source, "new.cpp"), "new\n");
      if (kind === "staged-added") git(h.source, "add", "new.cpp");
    }
    if (kind === "deleted") fs.unlinkSync(file);
    if (kind === "renamed") git(h.source, "mv", "docs/note.txt", "docs/moved.txt");
    await unchangedWorkspace(h, async () => {
      vi.clearAllMocks();
      const message = expectToolError(await h.build(), /clean|observation/iu);
      if (kind === "modified") expect(message).toContain("docs/note.txt");
      noBuildProcess();
    });
  },
);

test.each([false, true])(
  "checkout drift fails for candidate=%s with both exact commits",
  async (isCandidate) => {
    const change = isCandidate ? await candidate(h) : undefined;
    git(
      h.source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-qm",
      "drift",
    );
    const head = git(h.source, "rev-parse", "HEAD").toString("utf8").trim();
    await unchangedWorkspace(h, async () => {
      vi.clearAllMocks();
      const message = expectToolError(
        await h.build(change ? { change_id: change } : {}),
        /drift|pinned base/iu,
      );
      expect(message).toContain(h.head);
      expect(message).toContain(head);
      noBuildProcess();
    });
  },
);

test.each([
  "proposed",
  "task",
  "base",
  "paths",
  "digest",
  "diff",
  "extra-diff",
  "tampered",
  "missing",
  "linked",
  "fifo",
  "patches-link",
  "patches-file",
  "patches-fifo",
  "cr-json",
  "cr-identity",
  "cr-missing",
  "cr-linked",
  "changes-link",
])("candidate %s evidence fails before archive, reservation or make", async (kind) => {
  const id = await candidate(h);
  const change = readWorkspaceRecord(h.cwd, "change", id, { readonly: true });
  const patch = join(h.cwd, change.patch_path);
  if (["proposed", "task", "base", "paths", "digest"].includes(kind)) {
    rewriteChangeRequest(h.cwd, {
      ...change,
      ...(kind === "proposed"
        ? { status: "proposed" as const, approval_ref: null, approved_at: null }
        : {}),
      ...(kind === "task" ? { task_id: TaskIdSchema.parse("TASK-20261102T093000-ffff") } : {}),
      ...(kind === "base" ? { base_commit: "f".repeat(40) } : {}),
      ...(kind === "paths" ? { files_changed: ["docs/note.txt", "src/Model/f.cpp"] } : {}),
      ...(kind === "digest" ? { patch_sha256: "f".repeat(64) } : {}),
    });
  }
  if (kind === "diff")
    fs.writeFileSync(join(h.source, "src/Model/f.cpp"), 'printf "unapproved\\n"\n');
  if (kind === "extra-diff")
    fs.writeFileSync(join(h.source, "docs/note.txt"), "additional unapproved change\n");
  if (kind === "tampered") fs.appendFileSync(patch, "tampered\n");
  if (["missing", "linked", "fifo"].includes(kind)) {
    fs.renameSync(patch, `${patch}.saved`);
    if (kind === "linked") fs.symlinkSync(`${patch}.saved`, patch);
    if (kind === "fifo") childProcess.execFileSync("mkfifo", [patch]);
  }
  if (["patches-link", "patches-file", "patches-fifo", "changes-link"].includes(kind)) {
    const directory = join(h.cwd, kind === "changes-link" ? "changes" : "patches");
    fs.renameSync(directory, `${directory}-saved`);
    if (kind.endsWith("link")) fs.symlinkSync(`${directory}-saved`, directory);
    else if (kind === "patches-fifo") childProcess.execFileSync("mkfifo", [directory]);
    else fs.writeFileSync(directory, PRIVATE);
  }
  if (kind === "cr-json" || kind === "cr-identity") {
    fs.writeFileSync(
      join(h.cwd, "changes", `${id}.json`),
      kind === "cr-json"
        ? `{${PRIVATE}`
        : JSON.stringify({ ...change, change_id: "CHG-20261102T093000-ffff" }),
    );
  }
  if (kind === "cr-missing" || kind === "cr-linked") {
    const path = join(h.cwd, "changes", `${id}.json`);
    fs.renameSync(path, `${path}.saved`);
    if (kind === "cr-linked") fs.symlinkSync(`${path}.saved`, path);
  }
  await unchangedWorkspace(h, async () => {
    vi.clearAllMocks();
    const message = expectToolError(
      await h.build({ change_id: id }),
      /approved|mismatch|paths|patch|CR/iu,
    );
    expect(message).not.toContain(PRIVATE);
    noBuildProcess();
  });
});

test.each(["symlink", "file", "fifo"])(
  "unsafe existing builds %s is never followed",
  async (kind) => {
    const builds = join(h.cwd, "builds");
    const target = join(h.cwd, "foreign-builds");
    fs.mkdirSync(target);
    fs.writeFileSync(join(target, "sentinel"), PRIVATE);
    if (kind === "symlink") fs.symlinkSync(target, builds);
    if (kind === "file") fs.writeFileSync(builds, PRIVATE);
    if (kind === "fifo") childProcess.execFileSync("mkfifo", [builds]);
    await unchangedWorkspace(h, async () => {
      vi.clearAllMocks();
      const message = expectToolError(await h.build(), /build|directory/iu);
      expect(message).toContain("builds");
      noBuildProcess();
    });
  },
);

test.each(["status", "pin"])(
  "task %s changed during Git observation is rechecked before effects",
  async (kind) => {
    const beforeSource = await treeOrAbsent(h.source);
    let expectedCard = fileSnapshot(h.cardPath);
    let changed = false;
    vi.mocked(childProcess.execFile).mockImplementation((...args) => {
      if (Array.isArray(args[1]) && args[1].includes("status") && !changed) {
        changed = true;
        const card = readWorkspaceRecord(h.cwd, "task", h.taskId, { readonly: true });
        writeWorkspaceRecord(h.cwd, "task", {
          ...card,
          ...(kind === "status"
            ? { status: "done" as const }
            : { source_base_commit: "f".repeat(40) }),
        });
        expectedCard = fileSnapshot(h.cardPath);
      }
      return nativeProcess.execFile(...args);
    });
    const operation = h.build();
    const result = await operation;
    expect(changed).toBe(true);
    expectToolError(result, /planned|running|pin/iu);
    const actual = readWorkspaceRecord(h.cwd, "task", h.taskId, { readonly: true });
    expect(kind === "status" ? actual.status : actual.source_base_commit).toBe(
      kind === "status" ? "done" : "f".repeat(40),
    );
    expect(await treeOrAbsent(h.source)).toEqual(beforeSource);
    expect(fileSnapshot(h.cardPath)).toEqual(expectedCard);
    expect(fs.existsSync(join(h.cwd, "builds"))).toBe(false);
  },
);
