import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { RepositoryRevision } from "../schemas/index.ts";
import { compareRepositoryPaths } from "./compare-paths.ts";

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
 * `dirty` follows git status ignore rules; any porcelain output counts as dirty, even if the read
 * overflowed; an overflow with empty stdout throws.
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

  let ref: string;
  try {
    ref = run(["symbolic-ref", "-q", "HEAD"]).trim();
  } catch (error) {
    // Detached HEAD: symbolic-ref -q exits 1 silently.
    if (failureField(error, "status") !== 1 || failureField(error, "stdout") !== "") {
      throw new Error(`cannot read git branch at ${repoPath}: ${failureDetail(error)}`, {
        cause: error,
      });
    }
    ref = "";
  }
  // Only refs/heads/<name> is a branch, and <name> HEAD would read as detached.
  // HEAD symref'd elsewhere (e.g. a tag, whose rev-parse may be a tag object) fails.
  const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
  if (ref !== "" && (name === undefined || name === "HEAD")) {
    throw new Error(`cannot read git branch at ${repoPath}: HEAD points at ${ref}, not a branch`);
  }
  const branch = name ?? "HEAD";

  let status: string;
  let dirty_paths_truncated = false;
  try {
    status = run([
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ]);
  } catch (error) {
    // Any porcelain output means dirty, even when the read was cut short by either
    // stream overflowing; an overflow with empty stdout is a failure.
    const stdout = failureField(error, "stdout");
    if (failureField(error, "code") !== "ENOBUFS" || typeof stdout !== "string" || stdout === "") {
      throw new Error(`cannot read git status at ${repoPath}: ${failureDetail(error)}`, {
        cause: error,
      });
    }
    status = stdout;
    dirty_paths_truncated = true;
  }
  return {
    commit,
    branch,
    dirty: status.length > 0,
    dirty_paths: collectDirtyPaths(status),
    dirty_paths_truncated,
  };
}

function collectDirtyPaths(status: string): string[] {
  const paths = new Set<string>();
  let offset = 0;
  while (offset < status.length) {
    const destinationEnd = status.indexOf("\0", offset);
    if (destinationEnd === -1) break;
    let recordEnd = destinationEnd;
    const indexStatus = status[offset];
    const worktreeStatus = status[offset + 1];
    if (
      indexStatus === "R" ||
      indexStatus === "C" ||
      worktreeStatus === "R" ||
      worktreeStatus === "C"
    ) {
      recordEnd = status.indexOf("\0", destinationEnd + 1);
      if (recordEnd === -1) break;
    }
    if (destinationEnd > offset + 3) paths.add(status.slice(offset + 3, destinationEnd));
    offset = recordEnd + 1;
  }
  return [...paths].sort(compareRepositoryPaths);
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
