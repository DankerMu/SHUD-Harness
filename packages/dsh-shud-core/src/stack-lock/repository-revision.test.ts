import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// Observed independently of the code under test: does this filesystem fold case?
const caseProbe = mkdtempSync(join(tmpdir(), "stack-lock-case-"));
mkdirSync(join(caseProbe, "Repo"));
const caseInsensitive = existsSync(join(caseProbe, "repo"));
rmSync(caseProbe, { recursive: true, force: true });

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stack-lock-revision-"));
  vi.stubEnv("GIT_CONFIG_GLOBAL", devNull);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  // Hides the host's default global ignore (~/.config/git/ignore) and attributes.
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "no-xdg-config"));
  for (const name of LOCATOR_VARS) vi.stubEnv(name, undefined);
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

  test("files ignored by .git/info/exclude or a repo-configured core.excludesFile keep the checkout clean", () => {
    const excluded = committedRepo("info-exclude");
    writeFileSync(join(excluded, ".git", "info", "exclude"), "local.tmp\n");
    writeFileSync(join(excluded, "local.tmp"), "ignored\n");
    expect(collectRepositoryRevision(excluded).dirty).toBe(false);

    const configured = committedRepo("excludes-file");
    const ignoreFile = join(root, "custom-ignore");
    writeFileSync(ignoreFile, "scratch.out\n");
    git(configured, "config", "core.excludesFile", ignoreFile);
    writeFileSync(join(configured, "scratch.out"), "ignored\n");
    expect(collectRepositoryRevision(configured).dirty).toBe(false);
  });

  test("status output larger than the read buffer still marks dirty without throwing", () => {
    const repo = committedRepo("flood");
    // 6000 lines of "?? <200-char name>\n" is ~1.2 MB, above execFileSync's 1 MiB default.
    const stem = "u".repeat(195);
    for (let i = 0; i < 6000; i += 1) {
      writeFileSync(join(repo, `${stem}${String(i).padStart(5, "0")}`), "");
    }

    expect(collectRepositoryRevision(repo).dirty).toBe(true);
  }, 60_000);

  test("any other status failure throws with the path", () => {
    const repo = committedRepo("corrupt-index");
    writeFileSync(join(repo, ".git", "index"), "not an index");

    expect(() => collectRepositoryRevision(repo)).toThrow(`cannot read git status at ${repo}: `);
  });

  test("a status overflow on stderr alone (empty stdout) throws instead of marking dirty", () => {
    const repo = committedRepo("stderr-flood");
    // ~1.1 MB of short warning lines on stderr, above execFileSync's 1 MiB default; nothing on stdout.
    shimGit(
      "status",
      `yes "warning: could not open directory 'x/': Permission denied" | head -n 20000 >&2; exit 0`,
    );

    expect(() => collectRepositoryRevision(repo)).toThrow(
      `cannot read git status at ${repo}: warning: could not open directory`,
    );
  });

  test("a non-overflow status failure throws even when stdout has output", () => {
    const repo = committedRepo("status-128");
    shimGit("status", "printf '?? x\\n'; exit 128");

    const error = thrownBy(() => collectRepositoryRevision(repo));
    expect(error.message).toContain(`cannot read git status at ${repo}: `);
    expect(error.cause).toMatchObject({ status: 128 });
  });

  test("symbolic-ref failing with a status other than 1 throws with the path", () => {
    const repo = committedRepo("symref-128");
    shimGit("symbolic-ref", "echo 'fatal: simulated symbolic-ref failure' >&2; exit 128");

    const error = thrownBy(() => collectRepositoryRevision(repo));
    expect(error.message).toBe(
      `cannot read git branch at ${repo}: fatal: simulated symbolic-ref failure`,
    );
    expect(error.cause).toMatchObject({ status: 128 });
  });

  test("symbolic-ref exiting 1 with output is not mistaken for a detached HEAD", () => {
    const repo = committedRepo("symref-1-output");
    shimGit("symbolic-ref", "echo refs/heads/x; exit 1");

    expect(() => collectRepositoryRevision(repo)).toThrow(`cannot read git branch at ${repo}: `);
  });

  test("HEAD pointing at a tag throws instead of reporting the tag as a branch", () => {
    const repo = committedRepo("head-tag");
    git(repo, "tag", "v1");
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/tags/v1\n");

    expect(() => collectRepositoryRevision(repo)).toThrow(`cannot read git branch at ${repo}: `);
  });

  test("a tag with the same name as the current branch does not change the branch name", () => {
    const repo = committedRepo("same-name-tag");
    git(repo, "checkout", "-q", "-b", "v1");
    git(repo, "tag", "v1");

    expect(collectRepositoryRevision(repo).branch).toBe("v1");
  });

  test("HEAD pointing at a branch named HEAD throws instead of reading as detached", () => {
    const repo = committedRepo("branch-named-head");
    git(repo, "update-ref", "refs/heads/HEAD", git(repo, "rev-parse", "HEAD"));
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/HEAD\n");

    expect(() => collectRepositoryRevision(repo)).toThrow(`cannot read git branch at ${repo}: `);
  });

  test.runIf(caseInsensitive)(
    "a case-variant spelling of the repository root is accepted on a case-insensitive filesystem",
    () => {
      const repo = committedRepo("Repo");
      const head = git(repo, "rev-parse", "HEAD");

      expect(collectRepositoryRevision(join(root, "repo"))).toEqual({
        commit: head,
        branch: "main",
        dirty: false,
      });
    },
  );
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

// Puts a `git` shim first on PATH that runs `action` when the collector's subcommand matches
// exactly (`$5` in `git -C <repo> -c core.fsmonitor=false <sub> ...`) and otherwise execs the
// real git. Call after the fixture repos are built; afterEach's unstubAllEnvs restores PATH.
function shimGit(subcommand: string, action: string): void {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shimDir = join(root, "shim");
  mkdirSync(shimDir);
  const shimPath = join(shimDir, "git");
  writeFileSync(
    `${shimPath}.script`,
    `#!/bin/sh\nif [ "$5" = "${subcommand}" ]; then\n${action}\nfi\nexec "${realGit}" "$@"\n`,
  );
  rmSync(shimPath, { force: true });
  symlinkSync(
    fileURLToPath(new URL("../../../../scripts/fixtures/exec-script.sh", import.meta.url)),
    shimPath,
  );
  vi.stubEnv("PATH", `${shimDir}${delimiter}${process.env.PATH ?? ""}`);
}

function thrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the action to throw");
}
