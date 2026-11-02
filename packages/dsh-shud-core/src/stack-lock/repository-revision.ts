import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { delimiter, isAbsolute } from "node:path";
import { containsPath } from "../path-containment.ts";
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

const PATH_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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
    const output = run(["rev-parse", "--show-toplevel"]);
    topLevel = output.endsWith("\n") ? output.slice(0, -1) : output;
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

  let status: Buffer;
  let dirty_paths_truncated = false;
  try {
    status = execFileSync(
      "git",
      [
        "-C",
        repoPath,
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain",
        "-z",
        "--untracked-files=normal",
        "--ignore-submodules=none",
      ],
      { encoding: "buffer", env, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    // Any porcelain output means dirty, even when the read was cut short by either
    // stream overflowing; an overflow with empty stdout is a failure.
    const stdout = failureField(error, "stdout");
    if (
      failureField(error, "code") !== "ENOBUFS" ||
      !Buffer.isBuffer(stdout) ||
      stdout.length === 0
    ) {
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
    dirty_paths: collectDirtyPaths(status, repoPath),
    dirty_paths_truncated,
  };
}

function collectDirtyPaths(status: Buffer, repoPath: string): string[] {
  const paths = new Set<string>();
  let offset = 0;
  while (offset < status.length) {
    const destinationEnd = status.indexOf(0, offset);
    if (destinationEnd === -1) break;
    let recordEnd = destinationEnd;
    const indexStatus = status[offset];
    const worktreeStatus = status[offset + 1];
    // ASCII R/C in either status column means a second NUL-terminated source path.
    if (
      indexStatus === 0x52 ||
      indexStatus === 0x43 ||
      worktreeStatus === 0x52 ||
      worktreeStatus === 0x43
    ) {
      recordEnd = status.indexOf(0, destinationEnd + 1);
      if (recordEnd === -1) break;
    }
    if (destinationEnd > offset + 3) {
      // Decode only complete records; an overflow tail may split a UTF-8 character.
      let path: string;
      try {
        path = PATH_DECODER.decode(status.subarray(offset + 3, destinationEnd));
      } catch (error) {
        throw new Error(`cannot read git status at ${repoPath}: invalid UTF-8 repository path`, {
          cause: error,
        });
      }
      paths.add(path);
    }
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
  const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
  const firstLine = typeof text === "string" ? (text.trim().split("\n")[0] ?? "") : "";
  if (firstLine !== "") return firstLine;
  return error instanceof Error ? error.message : "unknown git failure";
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_STDERR_TAIL_BYTES = 4096;

/**
 * Execute a new-workflow Git command without inheriting host configuration or secrets.
 * Status, diff, archive and apply require the physical repository root.
 * Status returns raw NUL-delimited paths; diff disables external programs and color.
 * Only applyCeiling permits apply in a nonrepository directory beneath that physical ancestor.
 * Output is bounded; subprocess failures never expose partial stdout or the original error.
 * No stdin is supplied: each child receives EOF immediately.
 */
export async function runGit(
  sourceDir: string,
  args: readonly string[],
  options: { maxBuffer?: number; applyCeiling?: string } = {},
): Promise<{ stdout: Buffer }> {
  const { PATH, HOME } = process.env;
  if (PATH === undefined || HOME === undefined) {
    throw new Error("git requires host PATH and HOME");
  }
  const maxBuffer = options.maxBuffer ?? GIT_MAX_BUFFER;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0) {
    throw new Error("git maxBuffer must be a positive safe integer");
  }
  const command = args[0];
  if (command === undefined || command === "" || command.startsWith("-")) {
    throw new Error("git requires a subcommand before options");
  }
  const env: NodeJS.ProcessEnv = {
    PATH,
    HOME,
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (options.applyCeiling !== undefined) {
    if (command !== "apply") {
      throw new Error("applyCeiling is only supported for git apply");
    }
    if (!isAbsolute(options.applyCeiling)) {
      throw new Error("applyCeiling must be an absolute existing ancestor directory");
    }
    let ceiling: string;
    let source: string;
    try {
      ceiling = realpathSync.native(options.applyCeiling);
      source = realpathSync.native(sourceDir);
    } catch {
      throw new Error("applyCeiling and sourceDir must resolve to existing paths");
    }
    if (ceiling === source || !containsPath(ceiling, source)) {
      throw new Error("applyCeiling must be a strict physical ancestor of sourceDir");
    }
    if (ceiling.includes(delimiter)) {
      throw new Error("applyCeiling cannot contain the environment path-list delimiter");
    }
    env.GIT_CEILING_DIRECTORIES = ceiling;
  }
  const run = (commandArgs: readonly string[]): Promise<{ stdout: Buffer }> =>
    new Promise<{ stdout: Buffer }>((resolve, reject) => {
      try {
        const child = execFile(
          "git",
          ["-C", sourceDir, "-c", "core.fsmonitor=false", ...commandArgs],
          { encoding: "buffer", env, maxBuffer },
          (error, stdout, stderr) => {
            if (error !== null) reject(controlledGitFailure(error, stderr));
            else resolve({ stdout });
          },
        );
        child.stdin?.end();
      } catch (error) {
        reject(controlledGitFailure(error));
      }
    });

  const commandArgs = [...args];
  if (
    command === "status" ||
    command === "diff" ||
    command === "archive" ||
    (command === "apply" && options.applyCeiling === undefined)
  ) {
    const { stdout } = await run(["rev-parse", "--show-toplevel"]);
    const output = stdout.toString("utf8");
    const topLevel = output.endsWith("\n") ? output.slice(0, -1) : output;
    let sameRoot: boolean;
    try {
      sameRoot = realpathSync.native(sourceDir) === realpathSync.native(topLevel);
    } catch (error) {
      throw controlledGitFailure(error);
    }
    if (!sameRoot) throw new Error("not a git repository root");
  }
  if (command === "status" || command === "diff") {
    const flags =
      command === "status"
        ? ["--porcelain", "-z", "--untracked-files=all"]
        : ["--no-ext-diff", "--no-textconv", "--no-color"];
    const separator = commandArgs.indexOf("--");
    commandArgs.splice(separator === -1 ? commandArgs.length : separator, 0, ...flags);
  }
  return run(commandArgs);
}

function controlledGitFailure(error: unknown, stderr?: Buffer): Error {
  const code = failureField(error, "code");
  const detail =
    typeof code === "number"
      ? `exit ${code}`
      : typeof code === "string"
        ? `code ${code}`
        : "code unknown";
  const truncated = stderr !== undefined && stderr.length > GIT_STDERR_TAIL_BYTES;
  const tail = stderr?.subarray(-GIT_STDERR_TAIL_BYTES).toString("utf8") ?? "";
  return new Error(
    `git failed (${detail})${truncated ? " [stderr truncated]" : ""}${tail ? `: ${tail}` : ""}`,
  );
}
