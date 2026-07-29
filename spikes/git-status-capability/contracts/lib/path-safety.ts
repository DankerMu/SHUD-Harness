import { lstat } from "node:fs/promises";
import { parse, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

type PathIdentity = {
  path: string;
  device: bigint;
  inode: bigint;
  directory: boolean;
  file: boolean;
};

export type SafePathSnapshot = readonly PathIdentity[];

type OpenedFileStat = {
  dev: bigint;
  ino: bigint;
  isFile: () => boolean;
};

type TestInterlock = (phase: "after-capture" | "after-open", path: string) => Promise<void>;
const testInterlock = new AsyncLocalStorage<TestInterlock>();

function components(path: string): string[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const relative = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  const result = [root];
  for (const component of relative) result.push(resolve(result.at(-1)!, component));
  return result;
}

export async function captureNoSymlinkPath(path: string, terminal: "file" | "directory"): Promise<SafePathSnapshot> {
  const paths = components(path);
  const snapshot: PathIdentity[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const current = paths[index]!;
    const stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error("symlink path component");
    const last = index === paths.length - 1;
    if ((!last || terminal === "directory") && !stat.isDirectory()) throw new Error("non-directory path component");
    if (last && terminal === "file" && !stat.isFile()) throw new Error("non-regular terminal");
    snapshot.push({
      path: current,
      device: stat.dev,
      inode: stat.ino,
      directory: stat.isDirectory(),
      file: stat.isFile()
    });
  }
  return snapshot;
}

export async function verifyNoSymlinkPath(snapshot: SafePathSnapshot): Promise<void> {
  for (const expected of snapshot) {
    const stat = await lstat(expected.path, { bigint: true });
    if (stat.isSymbolicLink() || stat.dev !== expected.device || stat.ino !== expected.inode ||
        stat.isDirectory() !== expected.directory || stat.isFile() !== expected.file) {
      throw new Error("path component identity changed");
    }
  }
}

export function verifyOpenedRegularFile(snapshot: SafePathSnapshot, stat: OpenedFileStat): void {
  const terminal = snapshot.at(-1);
  if (!terminal || !terminal.file || !stat.isFile() || stat.dev !== terminal.device || stat.ino !== terminal.inode) {
    throw new Error("opened file identity differs from captured path");
  }
}

export async function runPathSafetyTestInterlock(phase: "after-capture" | "after-open", path: string): Promise<void> {
  await testInterlock.getStore()?.(phase, path);
}

/** @internal Deterministic filesystem-replacement seam used only by spike contract tests. */
export async function withPathSafetyTestInterlock<T>(interlock: TestInterlock, run: () => Promise<T>): Promise<T> {
  return await testInterlock.run(interlock, run);
}
