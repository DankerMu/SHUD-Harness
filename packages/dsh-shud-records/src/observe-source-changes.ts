import { isUtf8 } from "node:buffer";
import { lstatSync } from "node:fs";
import { ChangeRequestSchema, runGit } from "@shud-harness/dsh-shud-core";

/** Validate a complete NUL-delimited path without copying or decoding its bytes. */
function pathBytes(status: Buffer, start: number, end: number): Buffer {
  if (end <= start) throw new Error("Invalid git status path framing");
  const path = status.subarray(start, end);
  if (!isUtf8(path)) throw new Error("Invalid UTF-8 git status path");
  return path;
}

/**
 * Observe modifications of existing tracked files at a real source directory root.
 * Terminal slash/dot aliases cannot bypass the source-entry symlink check; ancestor
 * traversal, including '..', remains physical and Git receives the original spelling.
 * Core runGit owns root validation, child environment and Git hardening. No source,
 * index or workspace record is written. Unsupported states fail before diff.
 * Returned names are literal, codepoint-sorted paths; patch is the exact HEAD diff stdout.
 * An empty observation never invokes an unfiltered diff. Callers decide whether it is an error.
 */
export async function observeSourceChanges(
  sourceDir: string,
): Promise<{ files_changed: string[]; patch: Buffer }> {
  // POSIX lstat follows a final symlink when '/'/'.' suffixes force directory traversal.
  // Strip only that suffix for the entry check; retain root spellings and empty input.
  const sourceEntry = sourceDir.replace(/(?:\/\.?)+$/u, "") || sourceDir;
  try {
    if (!lstatSync(sourceEntry).isDirectory()) throw new Error();
  } catch {
    throw new Error("Source directory must be an existing real directory, not a symlink");
  }

  const { stdout: status } = await runGit(sourceDir, ["status"]);
  const modified: Buffer[] = [];
  const rejected: Buffer[] = [];
  let offset = 0;
  while (offset < status.length) {
    const end = status.indexOf(0, offset);
    if (end < offset + 4 || status[offset + 2] !== 0x20) {
      throw new Error("Invalid git status record framing");
    }
    const index = status[offset];
    const worktree = status[offset + 1];
    const path = pathBytes(status, offset + 3, end);
    offset = end + 1;
    if (
      (index === 0x20 && worktree === 0x4d) ||
      (index === 0x4d && worktree === 0x20) ||
      (index === 0x4d && worktree === 0x4d)
    ) {
      modified.push(path);
    } else {
      rejected.push(path);
      // R/C records carry destination then source; neither is a quoted display name.
      if (index === 0x52 || index === 0x43 || worktree === 0x52 || worktree === 0x43) {
        const sourceEnd = status.indexOf(0, offset);
        rejected.push(pathBytes(status, offset, sourceEnd));
        offset = sourceEnd + 1;
      }
    }
  }

  if (rejected.length > 0) {
    const paths = rejected.map((path) => path.toString("utf8"));
    if (
      !paths.every(
        (path) => ChangeRequestSchema.shape.files_changed.element.safeParse(path).success,
      )
    ) {
      throw new Error("Invalid git status repository path");
    }
    throw new Error(`Unsupported source changes: ${paths.join(", ")}`);
  }
  if (modified.length === 0) return { files_changed: [], patch: Buffer.alloc(0) };

  // Valid UTF-8 byte order equals Unicode scalar order; no per-comparison encoding.
  modified.sort((left, right) => Buffer.compare(left, right));
  const paths = modified.map((path) => path.toString("utf8"));
  const validated = ChangeRequestSchema.shape.files_changed.safeParse(paths);
  if (!validated.success) throw new Error("Invalid git status changed paths");
  const files_changed = validated.data;
  const { stdout: patch } = await runGit(sourceDir, [
    "diff",
    "HEAD",
    "--",
    ...files_changed.map((path) => `:(literal)${path}`),
  ]);
  return { files_changed, patch };
}
