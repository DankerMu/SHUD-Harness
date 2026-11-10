import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { requireFact } from "./shud-restart-evidence.ts";
import { BUFFER_LIMIT, directoryNames } from "./shud-web-driver.ts";
import { regular } from "./shud-session-log.ts";

/** Shared byte budget for local-gate evidence hashing (replay preservation, sensitivity preparation). */
export const HASH_LIMIT = 512 * 1024 * 1024;
interface Budget {
  remaining: number;
}

export function digest(path: string, algorithm: "sha256" | "md5", budget: Budget) {
  regular(path, "digest source");
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd);
    requireFact(
      before.isFile() && before.size <= budget.remaining,
      `Hash byte budget exceeded: ${path}`,
    );
    budget.remaining -= before.size;
    const hash = createHash(algorithm);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, before.size));
    let offset = 0;
    while (offset < before.size) {
      const count = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      requireFact(count > 0, "Digest source truncated");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(fd),
      current = fs.lstatSync(path);
    requireFact(
      before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        current.ino === before.ino &&
        current.dev === before.dev &&
        !current.isSymbolicLink(),
      "Digest source changed",
    );
    return { sha256: hash.digest("hex"), size_bytes: before.size };
  } finally {
    fs.closeSync(fd);
  }
}

export function walk(
  directory: string,
  consume: (path: string) => void,
  budget: Budget,
  inventoryOnly = false,
): void {
  requireFact(
    fs.lstatSync(directory).isDirectory() && fs.realpathSync(directory) === directory,
    `Unsafe evidence directory: ${directory}`,
  );
  for (const name of directoryNames(directory, budget)) {
    const path = join(directory, name),
      stat = fs.lstatSync(path);
    requireFact(inventoryOnly || !stat.isSymbolicLink(), `Symbolic evidence path: ${path}`);
    if (stat.isDirectory()) walk(path, consume, budget, inventoryOnly);
    else {
      requireFact(inventoryOnly || stat.isFile(), `Special evidence path: ${path}`);
      consume(path);
    }
  }
}

/** Code-unit ordered copy, so persisted file maps are byte-stable. */
export function sortedEntries<T>(values: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

export function treeHashes(
  directory: string,
  algorithm: "sha256" | "md5",
  hashBudget: Budget,
  absolute = false,
) {
  const values: Record<string, string> = {};
  walk(
    directory,
    (path) => {
      values[absolute ? path : relative(directory, path)] = digest(
        path,
        algorithm,
        hashBudget,
      ).sha256;
    },
    { remaining: BUFFER_LIMIT },
  );
  return sortedEntries(values);
}

/** Only ENOENT means absent; every other inspection failure propagates. */
function entryExists(path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Harness and workspace `data/raw` md5 receipt; absence is `exists: false`, never an error. */
export function rawTreeMd5(root: string, workspace: string, hashBudget: Budget) {
  const raw = join(root, "data/raw"),
    workspaceRaw = join(workspace, "data/raw");
  const roots = { harness: entryExists(raw), workspace: entryExists(workspaceRaw) };
  const md5: Record<string, string> = {};
  for (const [label, path] of [
    ["harness", raw],
    ["workspace", workspaceRaw],
  ])
    if (entryExists(path)) {
      for (const [name, hash] of Object.entries(treeHashes(path, "md5", hashBudget)))
        md5[`${label}/${name}`] = hash;
    }
  return { exists: roots.harness || roots.workspace, md5, roots };
}
