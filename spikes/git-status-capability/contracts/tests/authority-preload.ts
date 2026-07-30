import { mock } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type GuardState = { phase: "admission" | "post_admission"; events: string[]; rawEvents: string[] };
type MutableModule = Record<string, unknown>;
type DynamicLibrary = Readonly<{
  symbols: Record<string, (...args: unknown[]) => unknown>;
  close: () => void;
}>;
type BunAuthority = {
  file: (path: unknown, ...args: unknown[]) => unknown;
  write: (path: unknown, ...args: unknown[]) => unknown;
  spawn: (...args: unknown[]) => unknown;
  spawnSync: (...args: unknown[]) => unknown;
};
type RawInversionCanary = Readonly<{
  readBeforeDeny: (path: string) => never;
  ffiBeforeDeny: (path: string) => never;
}>;

const state: GuardState = { phase: "admission", events: [], rawEvents: [] };
(globalThis as Record<PropertyKey, unknown>)[Symbol.for("shud.contract.authorityGuard")] = state;

function normalizedPathLike(value: unknown): string | undefined {
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
  if (!path) return undefined;
  const resolved = resolve(path);
  if (process.platform === "darwin") {
    for (const alias of ["/etc", "/tmp", "/var"] as const) {
      if (resolved === alias || resolved.startsWith(`${alias}/`)) return `/private${resolved}`;
    }
  }
  return resolved;
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

function rawOperation(operation: string, target?: unknown): void {
  state.rawEvents.push(`raw:${operation}:${typeof target === "string" ? target : ""}`);
}

function firstPathLike(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const path = normalizedPathLike(value);
    if (path) return path;
  }
  return undefined;
}

function builtinModule(name: string): MutableModule {
  const value = process.getBuiltinModule(name);
  if (!value || typeof value !== "object") throw new Error(`MISSING_BUILTIN_MODULE:${name}`);
  return value as MutableModule;
}

const RETAINED_DESCRIPTOR_OPERATIONS: Readonly<Record<string, true>> = {
  closeSync: true,
  fstatSync: true,
  readSync: true
};

function patchPathFunctions(module: MutableModule, operationPrefix: string): void {
  for (const name of Object.getOwnPropertyNames(module)) {
    if (RETAINED_DESCRIPTOR_OPERATIONS[name]) continue;
    const descriptor = Object.getOwnPropertyDescriptor(module, name);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(module, name, {
      ...descriptor,
      value: function guardedPathFunction(this: unknown, ...args: unknown[]) {
        const path = firstPathLike(args);
        if (state.phase === "post_admission" && path) deny(`${operationPrefix}_${name}`, path);
        if (state.phase === "post_admission" && path) rawOperation(`${operationPrefix}_${name}`, path);
        return original.apply(this, args);
      }
    });
  }
}

function patchConstructor(module: MutableModule, name: string, operation: string): Function {
  const descriptor = Object.getOwnPropertyDescriptor(module, name);
  if (!descriptor || typeof descriptor.value !== "function") throw new Error(`MISSING_CONSTRUCTOR:${name}`);
  const original = descriptor.value as Function;
  const guarded = new Proxy(original, {
    apply(target, thisArgument, argumentsList) {
      if (state.phase === "post_admission") deny(operation);
      if (state.phase === "post_admission") rawOperation(operation);
      return Reflect.apply(target, thisArgument, argumentsList);
    },
    construct(target, argumentsList, newTarget) {
      if (state.phase === "post_admission") deny(operation);
      if (state.phase === "post_admission") rawOperation(operation);
      return Reflect.construct(target, argumentsList, newTarget);
    }
  });
  Object.defineProperty(module, name, { ...descriptor, value: guarded });
  return guarded;
}

const guardedFs = builtinModule("node:fs");
const guardedFsPromises = builtinModule("node:fs/promises");
const rawReadFileSyncDescriptor = Object.getOwnPropertyDescriptor(guardedFs, "readFileSync");
if (!rawReadFileSyncDescriptor || typeof rawReadFileSyncDescriptor.value !== "function") {
  throw new Error("MISSING_NODE_FS_READ_FILE_SYNC");
}
const rawReadFileSync = rawReadFileSyncDescriptor.value as (path: string) => unknown;
patchPathFunctions(guardedFsPromises, "node_fs_promises");
patchPathFunctions(guardedFs, "node_fs");

const guardedChildProcess = builtinModule("node:child_process");
for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(guardedChildProcess, name);
  if (!descriptor || typeof descriptor.value !== "function") throw new Error(`MISSING_CHILD_PROCESS_EXPORT:${name}`);
  const original = descriptor.value as (...args: unknown[]) => unknown;
  Object.defineProperty(guardedChildProcess, name, {
    ...descriptor,
    value: function guardedProcessCreation(this: unknown, ...args: unknown[]) {
      if (state.phase === "post_admission") deny(`node_child_process_${name}`);
      if (state.phase === "post_admission") rawOperation(`node_child_process_${name}`);
      return original.apply(this, args);
    }
  });
}

const guardedFfi = import.meta.require("bun:ffi") as MutableModule;
const ffiDescriptor = Object.getOwnPropertyDescriptor(guardedFfi, "dlopen");
if (!ffiDescriptor || typeof ffiDescriptor.value !== "function") throw new Error("MISSING_BUN_FFI_DLOPEN");
const originalDlopen = ffiDescriptor.value as (path: string, symbols: Record<string, unknown>) => DynamicLibrary;
const guardedDlopen = (path: string, symbols: Record<string, unknown>): DynamicLibrary => {
  if (state.phase === "post_admission") deny("ffi_dlopen", path);
  if (state.phase === "post_admission") rawOperation("ffi_dlopen", path);
  const library = originalDlopen(path, symbols);
  const guardedSymbols: Record<string, (...args: unknown[]) => unknown> = {};
  for (const [name, symbol] of Object.entries(library.symbols)) {
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
Object.defineProperty(guardedFfi, "dlopen", { ...ffiDescriptor, value: guardedDlopen });

const rawInversion: RawInversionCanary = Object.freeze({
  readBeforeDeny(path: string): never {
    const normalized = normalizedPathLike(path);
    if (!normalized) throw new Error("RAW_READ_CANARY_PATH_INVALID");
    rawOperation("node_fs_readFileSync", normalized);
    rawReadFileSync(path);
    return deny("node_fs_readFileSync", normalized);
  },
  ffiBeforeDeny(path: string): never {
    rawOperation("ffi_dlopen", path);
    const library = originalDlopen(path, { getpid: { args: [], returns: "i32" } });
    try {
      const getpid = library.symbols.getpid;
      if (typeof getpid !== "function") throw new Error("RAW_FFI_CANARY_SYMBOL_MISSING");
      getpid();
    } finally {
      library.close();
      rawOperation("ffi_close", path);
    }
    return deny("ffi_dlopen", path);
  }
});
(globalThis as Record<PropertyKey, unknown>)[Symbol.for("shud.contract.authorityRawInversion")] = rawInversion;

const globalAuthority = globalThis as Record<string, unknown>;
const globalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalAuthority, "Worker");
if (!globalWorkerDescriptor || typeof globalWorkerDescriptor.value !== "function") {
  throw new Error("MISSING_GLOBAL_WORKER");
}
const guardedGlobalWorker = patchConstructor(globalAuthority, "Worker", "global_worker");
const guardedNodeWorkerThreads = builtinModule("node:worker_threads");
const guardedNodeWorker = patchConstructor(guardedNodeWorkerThreads, "Worker", "node_worker");

mock.module("node:fs", () => ({ ...guardedFs, default: guardedFs }));
mock.module("fs", () => ({ ...guardedFs, default: guardedFs }));
mock.module("node:fs/promises", () => ({ ...guardedFsPromises, default: guardedFsPromises }));
mock.module("fs/promises", () => ({ ...guardedFsPromises, default: guardedFsPromises }));
mock.module("node:child_process", () => ({ ...guardedChildProcess, default: guardedChildProcess }));
mock.module("child_process", () => ({ ...guardedChildProcess, default: guardedChildProcess }));
mock.module("bun:ffi", () => ({ ...guardedFfi, dlopen: guardedDlopen }));
mock.module("node:worker_threads", () => ({
  ...guardedNodeWorkerThreads,
  Worker: guardedNodeWorker,
  default: guardedNodeWorkerThreads
}));
mock.module("worker_threads", () => ({
  ...guardedNodeWorkerThreads,
  Worker: guardedNodeWorker,
  default: guardedNodeWorkerThreads
}));

const guardedBun = Bun as unknown as BunAuthority;
const originalBunFile = guardedBun.file.bind(Bun);
const originalBunWrite = guardedBun.write.bind(Bun);
const originalBunSpawn = guardedBun.spawn.bind(Bun);
const originalBunSpawnSync = guardedBun.spawnSync.bind(Bun);

guardedBun.file = (path, ...args) => {
  const normalized = normalizedPathLike(path);
  if (state.phase === "post_admission" && normalized) deny("bun_file", normalized);
  if (state.phase === "post_admission" && normalized) rawOperation("bun_file", normalized);
  return originalBunFile(path, ...args);
};
guardedBun.write = (path, ...args) => {
  const normalized = normalizedPathLike(path);
  if (state.phase === "post_admission") deny("bun_write", normalized);
  if (state.phase === "post_admission") rawOperation("bun_write", normalized);
  return originalBunWrite(path, ...args);
};
guardedBun.spawn = (...args) => {
  if (state.phase === "post_admission") deny("bun_spawn");
  if (state.phase === "post_admission") rawOperation("bun_spawn");
  return originalBunSpawn(...args);
};
guardedBun.spawnSync = (...args) => {
  if (state.phase === "post_admission") deny("bun_spawn");
  if (state.phase === "post_admission") rawOperation("bun_spawn");
  return originalBunSpawnSync(...args);
};

void guardedGlobalWorker;
