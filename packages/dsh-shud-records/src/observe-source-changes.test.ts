import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createChangeRequest,
  deriveChangeRequest,
  observeSourceChanges,
  readChangePatch,
  readWorkspaceRecord,
  writeChangePatch,
} from "./index.ts";
import { ChangeIdSchema, TaskIdSchema } from "@shud-harness/dsh-shud-core";
import {
  commitSource,
  fixtureGit,
  putSource,
  realGit,
  sourceRepo,
  sourceSnapshot,
} from "./source-observation-test-harness.ts";

let suite: string;
let root: string;
let shimDir: string;
let tracePath: string;

beforeAll(() => {
  suite = mkdtempSync(join(tmpdir(), "source-observation-"));
  shimDir = join(suite, "bin");
  tracePath = join(suite, "git-trace.bin");
  mkdirSync(shimDir);
  // The existing native probe records key names, never secret values, before runtime startup.
  execFileSync(
    "cc",
    [
      "-std=c99",
      "-Wall",
      "-Wextra",
      "-Werror",
      `-DTRACE_PATH=${JSON.stringify(tracePath)}`,
      `-DREAL_GIT=${JSON.stringify(realGit)}`,
      fileURLToPath(new URL("../../../scripts/fixtures/git-environment.c", import.meta.url)),
      "-o",
      join(shimDir, "git"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
});
beforeEach(() => {
  root = mkdtempSync(join(suite, "case-"));
  writeFileSync(tracePath, "");
  vi.stubEnv("PATH", `${shimDir}${delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("HOME", root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
afterAll(() => rmSync(suite, { recursive: true, force: true }));

// Only test consumer-visible presence/absence; the exact native trace grammar belongs to core.
function traceFields(): string[] {
  return readFileSync(tracePath, "utf8").split("\0");
}
function expectNoDiff(): void {
  expect(traceFields()).not.toContain("diff");
}

// Git's actual HEAD diff is an independent byte oracle, not a mock echo of the observer's argv.
function expectedPatch(repo: string, paths: string[]): Buffer {
  return fixtureGit(
    repo,
    "-c",
    "core.fsmonitor=false",
    "diff",
    "HEAD",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--",
    ...paths.map((path) => `:(literal)${path}`),
  );
}

describe("observeSourceChanges with real Git", () => {
  test("returns exactly two modified tracked paths in codepoint order, ignoring a new ignored file", async () => {
    const repo = sourceRepo(root, {
      ".gitignore": "ignored/\n",
      "z.cpp": "before\n",
      "a.cpp": "before\n",
    });
    putSource(repo, "z.cpp", "z after\n");
    putSource(repo, "a.cpp", "a after\n");
    putSource(repo, "ignored/new.cpp", "ignored bytes\n");
    const paths = ["a.cpp", "z.cpp"];
    const targets = [
      ...paths,
      ".git/HEAD",
      ".git/index",
      ".git/refs/heads/main",
      "ignored/new.cpp",
    ];
    const before = targets.map((path) => sourceSnapshot(join(repo, path)));
    const result = await observeSourceChanges(repo);
    expect(result.files_changed).toEqual(paths);
    expect(Buffer.isBuffer(result.patch)).toBe(true);
    expect(result.patch).toEqual(expectedPatch(repo, paths));
    expect(result.patch.toString()).toContain("+a after\n");
    expect(result.patch.toString()).toContain("+z after\n");
    expect(result.patch.toString()).not.toContain("ignored bytes");
    expect(targets.map((path) => sourceSnapshot(join(repo, path)))).toEqual(before);
  });

  test("accepts staged, unstaged and MM modifications and diffs against HEAD, not only the index", async () => {
    const repo = sourceRepo(root, {
      "both.cpp": "before\n",
      "staged.cpp": "before\n",
      "unstaged.cpp": "before\n",
    });
    putSource(repo, "both.cpp", "index version\n");
    putSource(repo, "staged.cpp", "staged after\n");
    fixtureGit(repo, "add", "both.cpp", "staged.cpp");
    putSource(repo, "both.cpp", "worktree version\n");
    putSource(repo, "unstaged.cpp", "unstaged after\n");
    expect(fixtureGit(repo, "status", "--porcelain", "-z").toString()).toBe(
      "MM both.cpp\0M  staged.cpp\0 M unstaged.cpp\0",
    );
    const result = await observeSourceChanges(repo);
    expect(result.files_changed).toEqual(["both.cpp", "staged.cpp", "unstaged.cpp"]);
    expect(result.patch).toEqual(expectedPatch(repo, ["both.cpp", "staged.cpp", "unstaged.cpp"]));
    expect(result.patch.toString()).toContain("-before\n+worktree version\n");
    expect(result.patch.toString()).not.toContain("index version");
  });

  test("preserves whitespace, quoting, backslash, BOM and astral names without UTF16 sorting", async () => {
    // Literal codepoint order; U+E000 precedes U+FEFF and U+10000, unlike UTF16 sorting.
    const paths = [
      "src/a\tb.cpp",
      "src/a\nb.cpp",
      "src/a b.cpp",
      'src/quote".cpp',
      "src/slash\\.cpp",
      "\ue000.cpp",
      "\ufeffname.cpp",
      "\u{10000}.cpp",
    ];
    const repo = sourceRepo(root, Object.fromEntries(paths.map((path) => [path, "before\n"])));
    for (const [index, path] of paths.entries()) putSource(repo, path, `special-${index}\n`);
    const result = await observeSourceChanges(repo);
    expect(result.files_changed).toEqual(paths);
    expect(result.patch).toEqual(expectedPatch(repo, paths));
    for (const index of paths.keys())
      expect(result.patch.toString()).toContain(`+special-${index}\n`);
  });

  test("literal glob, colon and exclusion names neither suppress changes nor select decoy files", async () => {
    const paths = [
      ":(exclude)normal.cpp",
      ":colon.cpp",
      "bracket[ab].cpp",
      "normal.cpp",
      "question?.cpp",
      "star*.cpp",
    ];
    const repo = sourceRepo(root, {
      ...Object.fromEntries(paths.map((path) => [path, "before\n"])),
      "bracketa.cpp": "decoy bracket\n",
      "questionx.cpp": "decoy question\n",
      "star-other.cpp": "decoy star\n",
    });
    for (const [index, path] of paths.entries()) putSource(repo, path, `literal-${index}\n`);
    const result = await observeSourceChanges(repo);
    expect(result.files_changed).toEqual(paths);
    expect(result.patch).toEqual(expectedPatch(repo, paths));
    for (const index of paths.keys())
      expect(result.patch.toString()).toContain(`+literal-${index}\n`);
    expect(result.patch.toString()).not.toContain("decoy");
    // Independent negative control: raw exclusion magic would silently omit normal.cpp.
    const raw = fixtureGit(repo, "diff", "HEAD", "--", ":(exclude)normal.cpp", "normal.cpp");
    expect(raw).toEqual(Buffer.alloc(0));
  });

  test("returns real Git patch bytes without CRLF or final-newline normalization", async () => {
    const repo = sourceRepo(root);
    putSource(repo, "model.cpp", Buffer.from([0xc3, 0xa9, 13, 10, 97]));
    const before = sourceSnapshot(join(repo, "model.cpp"));
    const result = await observeSourceChanges(repo);
    expect(result.files_changed).toEqual(["model.cpp"]);
    expect(Buffer.isBuffer(result.patch)).toBe(true);
    expect(result.patch).toEqual(expectedPatch(repo, ["model.cpp"]));
    expect(result.patch.includes(Buffer.from([43, 0xc3, 0xa9, 13, 10]))).toBe(true);
    expect(result.patch.toString()).toContain("+a\n\\ No newline at end of file\n");
    expect(sourceSnapshot(join(repo, "model.cpp"))).toEqual(before);
  });

  test("clean observation is an empty Buffer and never performs an unfiltered diff", async () => {
    const repo = sourceRepo(root);
    expect(await observeSourceChanges(repo)).toEqual({ files_changed: [], patch: Buffer.alloc(0) });
    expect(traceFields()).toContain("status");
    expectNoDiff();
  });

  test.each([
    "untracked",
    "staged addition",
    "intent-to-add",
    "worktree deletion",
    "staged deletion",
    "rename",
    "type change",
    "conflict",
  ] as const)("rejects %s with involved paths and without generating a diff", async (kind) => {
    const repo = sourceRepo(root);
    let paths = ["model.cpp"];
    if (kind === "untracked" || kind === "staged addition" || kind === "intent-to-add") {
      putSource(repo, "new.cpp", "new\n");
      paths = ["new.cpp"];
      if (kind === "staged addition") fixtureGit(repo, "add", "new.cpp");
      if (kind === "intent-to-add") fixtureGit(repo, "add", "-N", "new.cpp");
    } else if (kind === "worktree deletion") rmSync(join(repo, "model.cpp"));
    else if (kind === "staged deletion") fixtureGit(repo, "rm", "-q", "model.cpp");
    else if (kind === "rename") {
      fixtureGit(repo, "mv", "model.cpp", "renamed.cpp");
      paths = ["model.cpp", "renamed.cpp"];
    } else if (kind === "type change") {
      rmSync(join(repo, "model.cpp"));
      symlinkSync("other.cpp", join(repo, "model.cpp"));
    } else {
      fixtureGit(repo, "checkout", "-q", "-b", "other");
      putSource(repo, "model.cpp", "other branch\n");
      commitSource(repo);
      fixtureGit(repo, "checkout", "-q", "main");
      putSource(repo, "model.cpp", "main branch\n");
      commitSource(repo);
      expect(() =>
        fixtureGit(
          repo,
          "-c",
          "user.name=fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "merge",
          "other",
        ),
      ).toThrow();
      expect(fixtureGit(repo, "status", "--porcelain", "-z").toString()).toContain(
        "UU model.cpp\0",
      );
    }
    const error: unknown = await observeSourceChanges(repo).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    for (const path of paths) expect((error as Error).message).toContain(path);
    expectNoDiff();
  });

  test.each(["missing", "symlink", "dangling symlink", "file", "fifo"] as const)(
    "rejects a %s source root before any Git process",
    async (kind) => {
      const source = join(root, "source");
      if (kind === "symlink") symlinkSync(sourceRepo(root), source, "dir");
      if (kind === "dangling symlink") symlinkSync(join(root, "absent"), source, "dir");
      if (kind === "file") writeFileSync(source, "not a directory");
      if (kind === "fifo") execFileSync("mkfifo", [source]);
      await expect(observeSourceChanges(source)).rejects.toThrow();
      expect(readFileSync(tracePath)).toEqual(Buffer.alloc(0));
    },
  );

  test.each(["nonrepository", "nested directory", "foreign git directory"] as const)(
    "rejects a %s root before target status or diff",
    async (kind) => {
      const repo = sourceRepo(root);
      const source = join(kind === "nested directory" ? repo : root, "source");
      mkdirSync(source);
      if (kind === "foreign git directory")
        writeFileSync(join(source, ".git"), `gitdir: ${join(repo, ".git")}\n`);
      if (kind === "foreign git directory") fixtureGit(repo, "config", "core.worktree", repo);
      const result = observeSourceChanges(source);
      if (kind === "nonrepository") await expect(result).rejects.toThrow();
      else await expect(result).rejects.toThrow(/not a git repository root/u);
      expect(traceFields()).toContain("rev-parse");
      expect(traceFields()).not.toContain("status");
      expectNoDiff();
    },
  );

  test("native Git children exclude host secrets and locators and ignore external diff, textconv, fsmonitor and color", async () => {
    const repo = sourceRepo(root, {
      "model.cpp": "before\n",
      ".gitattributes": "model.cpp diff=fixture\n",
    });
    const foreign = join(root, "foreign");
    mkdirSync(foreign);
    const foreignRepo = sourceRepo(foreign);
    const markers: string[] = [];
    for (const config of ["diff.external", "diff.fixture.textconv", "core.fsmonitor"]) {
      const marker = join(root, `${config}.marker`);
      const script = join(root, `${config}.cjs`);
      markers.push(marker);
      writeFileSync(
        script,
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\nprocess.stdout.write("external-decoy\\n");\n`,
        { mode: 0o755 },
      );
      fixtureGit(repo, "config", config, JSON.stringify(script));
    }
    fixtureGit(repo, "config", "color.ui", "always");
    putSource(repo, "model.cpp", "after\n");
    vi.stubEnv("DMXAPI_KEY", "fake-source-observation-sentinel");
    vi.stubEnv("GIT_DIR", join(foreignRepo, ".git"));
    vi.stubEnv("GIT_WORK_TREE", foreignRepo);
    const result = await observeSourceChanges(repo);
    expect(result.files_changed).toEqual(["model.cpp"]);
    expect(result.patch).toEqual(expectedPatch(repo, ["model.cpp"]));
    const text = result.patch.toString();
    expect(text).toContain("diff --git a/model.cpp b/model.cpp\n");
    expect(text).toContain("--- a/model.cpp\n+++ b/model.cpp\n");
    expect(text).toContain("@@ -1 +1 @@\n-before\n+after\n");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("external-decoy");
    for (const marker of markers) expect(existsSync(marker)).toBe(false);
    const trace = traceFields();
    expect(trace).toContain("status");
    expect(trace).toContain("diff");
    expect(trace).toContain("PATH");
    expect(trace).not.toContain("DMXAPI_KEY");
    expect(trace).not.toContain("GIT_DIR");
    expect(trace).not.toContain("GIT_WORK_TREE");
    expect(readFileSync(tracePath, "utf8")).not.toContain("fake-source-observation-sentinel");
  });

  test("observed bytes compose through pure derivation, candidate publication and readonly readback", async () => {
    const repo = sourceRepo(root);
    putSource(repo, "model.cpp", "after\n");
    const observation = await observeSourceChanges(repo);
    const { record } = deriveChangeRequest({
      ...observation,
      change_id: ChangeIdSchema.parse("CHG-20261102T090000-a1b2"),
      task_id: TaskIdSchema.parse("TASK-20261102T090000-c3d4"),
      base_commit: fixtureGit(repo, "rev-parse", "HEAD").toString().trim(),
      created_by: "coder",
      created_at: "2026-11-02T09:00:00Z",
    });
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const published = createChangeRequest(workspace, record);
    expect(published).toEqual(record);
    writeChangePatch(workspace, published.change_id, observation.patch);
    const recordPath = join(workspace, "changes", `${published.change_id}.json`);
    const patchPath = join(workspace, published.patch_path);
    const before = [sourceSnapshot(recordPath), sourceSnapshot(patchPath)];
    expect(readWorkspaceRecord(workspace, "change", record.change_id, { readonly: true })).toEqual(
      record,
    );
    expect(readChangePatch(workspace, record.change_id, { readonly: true })).toEqual(
      expectedPatch(repo, ["model.cpp"]),
    );
    expect([sourceSnapshot(recordPath), sourceSnapshot(patchPath)]).toEqual(before);
  });
});
