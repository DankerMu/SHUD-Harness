import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { collectRepositoryRevision } from "./repository-revision.ts";

// Inherited repository-locator variables (e.g. GIT_INDEX_FILE inside a git hook) must not leak
// into the fixture repos built by these tests.
const LOCATOR_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
] as const;

let root: string;

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", devNull);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const name of LOCATOR_VARS) vi.stubEnv(name, undefined);
  root = mkdtempSync(join(tmpdir(), "stack-lock-revision-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("collectRepositoryRevision", () => {
  test("clean checkout reports the full HEAD id, branch and dirty=false", () => {
    const repo = committedRepo("clean");
    const head = git(repo, "rev-parse", "HEAD");

    expect(head).toMatch(/^[0-9a-f]{40}$/u);
    expect(collectRepositoryRevision(repo)).toEqual({ commit: head, branch: "main", dirty: false });
  });

  test("a tracked modification marks dirty without changing the commit", () => {
    const repo = committedRepo("tracked");
    const head = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "model.txt"), "edited\n");

    expect(collectRepositoryRevision(repo)).toEqual({ commit: head, branch: "main", dirty: true });
  });

  test("an untracked file marks dirty", () => {
    const repo = committedRepo("untracked");
    writeFileSync(join(repo, "new.txt"), "new\n");

    expect(collectRepositoryRevision(repo).dirty).toBe(true);
  });

  test("a file ignored by .gitignore keeps the checkout clean", () => {
    const repo = committedRepo("ignored");
    writeFileSync(join(repo, ".gitignore"), "*.log\n");
    commitAll(repo);
    writeFileSync(join(repo, "run.log"), "ignored\n");

    expect(collectRepositoryRevision(repo).dirty).toBe(false);
  });

  test("detached HEAD reports branch HEAD and the pre-detach commit", () => {
    const repo = committedRepo("detached");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "--detach");

    expect(collectRepositoryRevision(repo)).toEqual({ commit: head, branch: "HEAD", dirty: false });
  });

  test("a gitfile checkout (like a submodule) is collected normally", () => {
    const repo = join(root, "gitfile");
    git(root, "init", "-q", "-b", "main", "--separate-git-dir", join(root, "gitfile.git"), repo);
    writeFileSync(join(repo, "model.txt"), "v1\n");
    commitAll(repo);
    const head = git(repo, "rev-parse", "HEAD");

    expect(statSync(join(repo, ".git")).isFile()).toBe(true);
    expect(collectRepositoryRevision(repo)).toEqual({ commit: head, branch: "main", dirty: false });
  });

  test("an inherited GIT_DIR pointing at another repository does not redirect collection", () => {
    const target = committedRepo("target", "target\n");
    const other = committedRepo("other", "other\n");
    const targetHead = git(target, "rev-parse", "HEAD");
    expect(git(other, "rev-parse", "HEAD")).not.toBe(targetHead);

    vi.stubEnv("GIT_DIR", join(other, ".git"));

    expect(collectRepositoryRevision(target)).toEqual({
      commit: targetHead,
      branch: "main",
      dirty: false,
    });
  });

  test("a plain directory, a repository without commits and an empty subdirectory all throw with the path", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(() => collectRepositoryRevision(plain)).toThrow(plain);

    const unborn = join(root, "unborn");
    git(root, "init", "-q", "-b", "main", unborn);
    expect(() => collectRepositoryRevision(unborn)).toThrow(unborn);

    const parent = committedRepo("parent");
    const uninitializedSubmodule = join(parent, "SHUD");
    mkdirSync(uninitializedSubmodule);
    expect(() => collectRepositoryRevision(uninitializedSubmodule)).toThrow(uninitializedSubmodule);
  });

  test("a stat-only change stays clean and leaves .git/index byte-identical", () => {
    const repo = committedRepo("readonly");
    const file = join(repo, "model.txt");
    const committedMtime = statSync(file).mtime.getTime() / 1000;
    utimesSync(file, committedMtime + 5, committedMtime + 5);
    const indexBefore = sha256(join(repo, ".git", "index"));

    expect(collectRepositoryRevision(repo).dirty).toBe(false);
    expect(sha256(join(repo, ".git", "index"))).toBe(indexBefore);
  });

  test("status.showUntrackedFiles=no cannot hide an untracked file", () => {
    const repo = committedRepo("hidden-untracked");
    git(repo, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(repo, "new.txt"), "new\n");

    expect(collectRepositoryRevision(repo).dirty).toBe(true);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitAll(repo: string): void {
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
}

function committedRepo(name: string, content = "v1\n"): string {
  const repo = join(root, name);
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "model.txt"), content);
  commitAll(repo);
  return repo;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
