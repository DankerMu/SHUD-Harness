import { mock } from "bun:test";
import * as actualChildProcess from "node:child_process";
import * as actualFs from "node:fs";
import * as actualFsPromises from "node:fs/promises";
import * as actualFfi from "bun:ffi";
import { fileURLToPath } from "node:url";

const originalOpenSync = actualFs.openSync;
const originalReadFileSync = actualFs.readFileSync;
const originalWriteFileSync = actualFs.writeFileSync;
const originalPromisesOpen = actualFsPromises.open;
const originalPromisesReadFile = actualFsPromises.readFile;
const originalPromisesWriteFile = actualFsPromises.writeFile;
const originalDlopen = actualFfi.dlopen;
const originalNodeSpawn = actualChildProcess.spawn;
const originalNodeSpawnSync = actualChildProcess.spawnSync;

type GuardState = { phase: "admission" | "post_admission"; events: string[] };
const state: GuardState = { phase: "admission", events: [] };
(globalThis as Record<PropertyKey, unknown>)[Symbol.for("shud.contract.authorityGuard")] = state;

function normalizedAbsolutePath(value: unknown): string | undefined {
  let path: string | undefined;
  if (typeof value === "string") path = value;
  else if (Buffer.isBuffer(value)) path = value.toString("utf8");
  else if (value instanceof URL && value.protocol === "file:") {
    try {
      path = fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return path?.startsWith("/") ? path : undefined;
}

function decodedCString(value: unknown): string | undefined {
  if (!Buffer.isBuffer(value)) return undefined;
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8");
}

function deny(operation: string, target?: unknown): never {
  state.events.push(`${operation}:${typeof target === "string" ? target : ""}`);
  throw new Error(`CONTRACT_TEST_AUTHORITY_DENIED:${operation}`);
}

function guardAbsolute(operation: string, target: unknown): void {
  const path = normalizedAbsolutePath(target);
  if (state.phase === "post_admission" && path) deny(operation, path);
}

const guardedFsPromises = {
  ...actualFsPromises,
  async open(path: Parameters<typeof actualFsPromises.open>[0], ...args: unknown[]) {
    guardAbsolute("node_promises_open", path);
    return await (originalPromisesOpen as (...values: unknown[]) => Promise<unknown>)(path, ...args);
  },
  async readFile(path: Parameters<typeof actualFsPromises.readFile>[0], ...args: unknown[]) {
    guardAbsolute("node_promises_read", path);
    return await (originalPromisesReadFile as (...values: unknown[]) => Promise<unknown>)(path, ...args);
  },
  async writeFile(path: Parameters<typeof actualFsPromises.writeFile>[0], ...args: unknown[]) {
    if (state.phase === "post_admission") deny("node_promises_write", normalizedAbsolutePath(path));
    return await (originalPromisesWriteFile as (...values: unknown[]) => Promise<void>)(path, ...args);
  }
};

const guardedFs = {
  ...actualFs,
  promises: guardedFsPromises,
  openSync(path: Parameters<typeof actualFs.openSync>[0], ...args: unknown[]) {
    guardAbsolute("node_open", path);
    return (originalOpenSync as (...values: unknown[]) => number)(path, ...args);
  },
  readFileSync(path: Parameters<typeof actualFs.readFileSync>[0], ...args: unknown[]) {
    guardAbsolute("node_read", path);
    return (originalReadFileSync as (...values: unknown[]) => unknown)(path, ...args);
  },
  writeFileSync(path: Parameters<typeof actualFs.writeFileSync>[0], ...args: unknown[]) {
    if (state.phase === "post_admission") deny("node_write", normalizedAbsolutePath(path));
    return (originalWriteFileSync as (...values: unknown[]) => void)(path, ...args);
  }
};
const guardedChildProcess = {
  ...actualChildProcess,
  spawn(...args: unknown[]) {
    if (state.phase === "post_admission") deny("node_spawn");
    return (originalNodeSpawn as (...values: unknown[]) => unknown)(...args);
  },
  spawnSync(...args: unknown[]) {
    if (state.phase === "post_admission") deny("node_spawn");
    return (originalNodeSpawnSync as (...values: unknown[]) => unknown)(...args);
  },
  exec: () => deny("node_exec"),
  execSync: () => deny("node_exec"),
  execFile: () => deny("node_exec_file"),
  execFileSync: () => deny("node_exec_file"),
  fork: () => deny("node_fork")
};

const guardedDlopen = (path: string, symbols: Record<string, unknown>) => {
  const library = (originalDlopen as (...args: unknown[]) => any)(path, symbols);
  const guardedSymbols: Record<string, (...args: unknown[]) => unknown> = {};
  for (const [name, symbol] of Object.entries(library.symbols as Record<string, (...args: unknown[]) => unknown>)) {
    guardedSymbols[name] = (...args: unknown[]) => {
      if (state.phase === "post_admission" && (name === "open" || name === "openat")) {
        const candidate = decodedCString(args[name === "open" ? 0 : 1]);
        if (candidate?.startsWith("/")) deny(`ffi_${name}`, candidate);
      }
      return symbol(...args);
    };
  }
  return new Proxy(library, {
    get(target, property, receiver) {
      return property === "symbols" ? guardedSymbols : Reflect.get(target, property, receiver);
    }
  });
};

mock.module("node:fs", () => ({ ...guardedFs, default: guardedFs }));
mock.module("fs", () => ({ ...guardedFs, default: guardedFs }));
mock.module("node:fs/promises", () => ({ ...guardedFsPromises, default: guardedFsPromises }));
mock.module("fs/promises", () => ({ ...guardedFsPromises, default: guardedFsPromises }));
mock.module("node:child_process", () => ({ ...guardedChildProcess, default: guardedChildProcess }));
mock.module("child_process", () => ({ ...guardedChildProcess, default: guardedChildProcess }));
mock.module("bun:ffi", () => ({ ...actualFfi, dlopen: guardedDlopen }));

const originalBunFile = Bun.file.bind(Bun);
const originalBunWrite = Bun.write.bind(Bun);
const originalBunSpawn = Bun.spawn.bind(Bun);
const originalBunSpawnSync = Bun.spawnSync.bind(Bun);

(Bun as any).file = (path: Parameters<typeof Bun.file>[0], ...args: unknown[]) => {
  guardAbsolute("bun_file", path);
  return (originalBunFile as (...values: unknown[]) => ReturnType<typeof Bun.file>)(path, ...args);
};
(Bun as any).write = (path: Parameters<typeof Bun.write>[0], ...args: unknown[]) => {
  if (state.phase === "post_admission") deny("bun_write", normalizedAbsolutePath(path));
  return (originalBunWrite as (...values: unknown[]) => ReturnType<typeof Bun.write>)(path, ...args);
};
(Bun as any).spawn = (...args: unknown[]) => {
  if (state.phase === "post_admission") deny("bun_spawn");
  return (originalBunSpawn as (...values: unknown[]) => ReturnType<typeof Bun.spawn>)(...args);
};
(Bun as any).spawnSync = (...args: unknown[]) => {
  if (state.phase === "post_admission") deny("bun_spawn");
  return (originalBunSpawnSync as (...values: unknown[]) => ReturnType<typeof Bun.spawnSync>)(...args);
};
