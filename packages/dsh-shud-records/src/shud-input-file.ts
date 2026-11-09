import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";
import { readVerifiedDescriptor } from "./descriptor-read.ts";
import { readDescriptor } from "./hash-descriptor.ts";

export type ShudInputStage = "missing" | "unsafe" | "read" | "parse";
type Location = { column?: string; line?: number };

/** Controlled file/column diagnostics; never retain native errors or input payloads. */
export class ShudInputError extends Error {
  readonly stage: ShudInputStage;
  readonly path: string;
  readonly column?: string;
  readonly line?: number;

  constructor(stage: ShudInputStage, path: string, reason: string, location: Location = {}) {
    super(
      `SHUD input ${stage}: ${path}: ${reason}${location.column === undefined ? "" : `; column ${location.column}`}${location.line === undefined ? "" : `; line ${location.line}`}`,
    );
    this.name = "ShudInputError";
    this.stage = stage;
    this.path = path;
    if (location.column !== undefined) this.column = location.column;
    if (location.line !== undefined) this.line = location.line;
  }
}

/** Validate without IO and normalize only the relative request, never a caller's base. */
export function shudInputPath(relativePath: string): string {
  const diagnosticPath = typeof relativePath === "string" ? relativePath : "<invalid path>";
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\0") ||
    relativePath.includes("\\")
  ) {
    throw new ShudInputError("unsafe", diagnosticPath, "expected a relative POSIX file path");
  }
  const components: string[] = [];
  for (const component of relativePath.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (components.length === 0)
        throw new ShudInputError("unsafe", relativePath, "path escapes its base");
      components.pop();
    } else components.push(component);
  }
  if (components.length === 0)
    throw new ShudInputError("unsafe", relativePath, "expected a file path");
  return components.join("/");
}

function ioStage(error: unknown, absence: "missing" | "unsafe" | "read"): ShudInputStage {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOENT") return absence;
  if (code === "ELOOP" || code === "ENOTDIR") return "unsafe";
  return "read";
}

function inspectInput(path: string, relative: string, recheck = false): Stats {
  try {
    return lstatSync(path);
  } catch (error) {
    throw new ShudInputError(
      ioStage(error, recheck ? "unsafe" : "missing"),
      relative,
      "file inspection failed",
    );
  }
}

/**
 * Read a SHUD file from a caller-owned absolute base. The physical base preserves
 * alias/.. traversal. Relative ancestors must be real directories and the final target
 * must be a regular file. Identity is observed before/around a single no-follow,
 * nonblocking descriptor read; digest, size and parser bytes share that complete pass.
 *
 * These checks detect observed replacements, not an atomic filesystem snapshot or a
 * kernel sandbox. An adversarial ancestor swap-and-restore between observations and
 * concurrent same-inode writes remain outside this contract. No input is written and
 * no raw-directory discovery, file-size cap, scientific formula or unit conversion is
 * performed. A failed close is reported once with descriptor ownership unknown.
 * Returned bytes have owned backing storage; parsing begins only after closure.
 */
export function readShudInputFile(
  baseDir: string,
  relativePath: string,
): { path: string; bytes: Buffer; sha256: string; size_bytes: number } {
  const path = shudInputPath(relativePath);
  if (typeof baseDir !== "string" || !isAbsolute(baseDir) || baseDir.includes("\0")) {
    throw new ShudInputError("unsafe", path, "expected an absolute base directory");
  }
  let target: string;
  try {
    target = realpathSync.native(baseDir);
  } catch (error) {
    throw new ShudInputError(ioStage(error, "missing"), path, "base directory resolution failed");
  }
  const directories: Array<{ path: string; stat: Stats }> = [];
  for (const component of path.split("/")) {
    const stat = inspectInput(target, path);
    if (!stat.isDirectory())
      throw new ShudInputError("unsafe", path, "ancestor is not a real directory");
    directories.push({ path: target, stat });
    target += `/${component}`;
  }
  const inspected = inspectInput(target, path);
  if (!inspected.isFile()) throw new ShudInputError("unsafe", path, "target is not a regular file");
  const recheck = () => {
    for (const directory of directories) {
      const current = inspectInput(directory.path, path, true);
      if (
        !current.isDirectory() ||
        current.dev !== directory.stat.dev ||
        current.ino !== directory.stat.ino
      ) {
        throw new ShudInputError("unsafe", path, "ancestor identity changed");
      }
    }
    const current = inspectInput(target, path, true);
    if (!current.isFile() || current.dev !== inspected.dev || current.ino !== inspected.ino) {
      throw new ShudInputError("unsafe", path, "target identity changed");
    }
  };
  recheck();
  const observed = readVerifiedDescriptor(
    target,
    inspected,
    (fd) => {
      recheck();
      const result = readDescriptor(fd);
      recheck();
      return result;
    },
    (phase, error) => {
      if (error instanceof ShudInputError) return error;
      const stage =
        phase === "target" ? "unsafe" : phase === "open" ? ioStage(error, "missing") : "read";
      return new ShudInputError(stage, path, "descriptor operation failed");
    },
  );
  return { path, ...observed };
}
