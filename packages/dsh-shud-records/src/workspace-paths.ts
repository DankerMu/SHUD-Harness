import { lstatSync, mkdirSync, realpathSync, type Stats } from "node:fs";

/** Return whether this call created the directory; readonly inspection never creates a missing path. */
export function ensureDirectory(path: string, label: string, readonly = false): boolean {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (readonly && !existing) return false;
  const created = existing ? false : mkdirSync(path, { recursive: true }) !== undefined;
  if (!(existing ?? lstatSync(path)).isDirectory()) {
    throw new Error(`${label} path is not a real directory: ${path}`);
  }
  return created;
}

/** Resolve a preflighted managed root without lexically collapsing the trusted session cwd. */
export function resolveManagedRoot(
  cwd: string,
  directory: string,
  label: string,
  readonly?: false,
): string;
export function resolveManagedRoot(
  cwd: string,
  directory: string,
  label: string,
  readonly: boolean,
): string | undefined;
export function resolveManagedRoot(
  cwd: string,
  directory: string,
  label: string,
  readonly = false,
): string | undefined {
  if (typeof cwd !== "string") throw new TypeError("Workspace cwd must be a string");
  const path = `${cwd || "."}/${directory}`;
  ensureDirectory(path, label, readonly);
  if (readonly) {
    const observed = lstatSync(path, { throwIfNoEntry: false });
    if (!observed) return undefined;
    if (!observed.isDirectory()) {
      throw new Error(`${label} path is not a real directory: ${path}`);
    }
  }
  return realpathSync.native(path);
}

/** lstat, rather than stat, also rejects dangling links without following them. */
export function regularTarget(path: string, label: string): Stats | undefined {
  const target = lstatSync(path, { throwIfNoEntry: false });
  if (target && !target.isFile()) {
    throw new Error(`${label} target is not a regular file: ${path}`);
  }
  return target;
}
