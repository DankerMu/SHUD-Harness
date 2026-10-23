import { sep } from "node:path";

/** Component-boundary containment, including a filesystem root. Inputs are already canonical. */
export function containsPath(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}
