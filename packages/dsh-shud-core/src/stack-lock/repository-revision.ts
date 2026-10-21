import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { RepositoryRevision } from "../schemas/index.ts";

// Variables that would make git read a repository other than the one at repoPath.
const REPOSITORY_LOCATOR_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
] as const;

/**
 * Read-only snapshot of the git repository rooted exactly at `repoPath`.
 * Never writes to the repository: optional locks (index refresh) and fsmonitor are disabled.
 * `dirty` follows git status ignore rules; status output overflowing the read buffer counts as dirty.
 * Throws with `repoPath` in the message when it is not a repository root or has no commits.
 */
export function collectRepositoryRevision(repoPath: string): RepositoryRevision {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  for (const name of REPOSITORY_LOCATOR_VARS) delete env[name];
  const run = (args: readonly string[]): string =>
    execFileSync("git", ["-C", repoPath, "-c", "core.fsmonitor=false", ...args], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

  let topLevel: string;
  try {
    topLevel = run(["rev-parse", "--show-toplevel"]).trim();
  } catch (error) {
    throw new Error(`not a git repository: ${repoPath}: ${failureDetail(error)}`, {
      cause: error,
    });
  }
  if (topLevel !== realpathSync.native(repoPath)) {
    throw new Error(`not a git repository root: ${repoPath} (enclosing top-level is ${topLevel})`);
  }

  let commit: string;
  try {
    commit = run(["rev-parse", "--verify", "HEAD"]).trim();
  } catch (error) {
    throw new Error(`cannot read git HEAD at ${repoPath}: ${failureDetail(error)}`, {
      cause: error,
    });
  }

  let branch: string;
  try {
    branch = run(["symbolic-ref", "--short", "-q", "HEAD"]).trim();
  } catch (error) {
    // Detached HEAD: symbolic-ref -q exits 1 silently. Git forbids a branch named "HEAD".
    if (failureField(error, "status") !== 1 || failureField(error, "stdout") !== "") {
      throw new Error(`cannot read git branch at ${repoPath}: ${failureDetail(error)}`, {
        cause: error,
      });
    }
    branch = "HEAD";
  }

  let dirty: boolean;
  try {
    const status = run([
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ]);
    dirty = status.length > 0;
  } catch (error) {
    // Output overflowed the read buffer, so it was necessarily non-empty.
    if (failureField(error, "code") !== "ENOBUFS") {
      throw new Error(`cannot read git status at ${repoPath}: ${failureDetail(error)}`, {
        cause: error,
      });
    }
    dirty = true;
  }
  return { commit, branch, dirty };
}

function failureField(error: unknown, key: "code" | "status" | "stdout" | "stderr"): unknown {
  return typeof error === "object" && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

function failureDetail(error: unknown): string {
  const stderr = failureField(error, "stderr");
  const firstLine = typeof stderr === "string" ? (stderr.trim().split("\n")[0] ?? "") : "";
  if (firstLine !== "") return firstLine;
  return error instanceof Error ? error.message : "unknown git failure";
}
