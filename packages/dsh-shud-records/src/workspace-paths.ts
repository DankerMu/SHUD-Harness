import { lstatSync, mkdirSync, type Stats } from "node:fs";

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

/** lstat, rather than stat, also rejects dangling links without following them. */
export function regularTarget(path: string, label: string): Stats | undefined {
  const target = lstatSync(path, { throwIfNoEntry: false });
  if (target && !target.isFile()) {
    throw new Error(`${label} target is not a regular file: ${path}`);
  }
  return target;
}
