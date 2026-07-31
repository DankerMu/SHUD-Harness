import { mock } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type RawInversionMode = "node_fs_readFileSync" | "ffi_dlopen";
type GuardState = {
  phase: "admission" | "post_admission";
  events: string[];
  rawEvents: string[];
  rawInversion: RawInversionMode | null;
};
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

const state: GuardState = { phase: "admission", events: [], rawEvents: [], rawInversion: null };
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

function delegatePathFunction(
  original: (...args: unknown[]) => unknown,
  thisArgument: unknown,
  argumentsList: unknown[],
  operation: string,
  path: string | undefined
): unknown {
  if (state.phase === "post_admission" && path) rawOperation(operation, path);
  return original.apply(thisArgument, argumentsList);
}

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
        const operation = `${operationPrefix}_${name}`;
        if (state.phase === "post_admission" && path) {
          if (state.rawInversion === operation) {
            delegatePathFunction(original, this, args, operation, path);
          }
          deny(operation, path);
        }
        return delegatePathFunction(original, this, args, operation, path);
      }
    });
  }
}

function delegateWorkerApply(
  target: Function,
  thisArgument: unknown,
  argumentsList: unknown[],
  operation: string
): unknown {
  if (state.phase === "post_admission") rawOperation(operation);
  return Reflect.apply(target, thisArgument, argumentsList);
}

function delegateWorkerConstruct(
  target: Function,
  argumentsList: unknown[],
  newTarget: Function,
  operation: string
): object {
  if (state.phase === "post_admission") rawOperation(operation);
  return Reflect.construct(target, argumentsList, newTarget);
}

function patchConstructor(module: MutableModule, name: string, operation: string): Function {
  const descriptor = Object.getOwnPropertyDescriptor(module, name);
  if (!descriptor || typeof descriptor.value !== "function") throw new Error(`MISSING_CONSTRUCTOR:${name}`);
  const original = descriptor.value as Function;
  const guarded = new Proxy(original, {
    apply(target, thisArgument, argumentsList) {
      if (state.phase === "post_admission") deny(operation);
      return delegateWorkerApply(target, thisArgument, argumentsList, operation);
    },
    construct(target, argumentsList, newTarget) {
      if (state.phase === "post_admission") deny(operation);
      return delegateWorkerConstruct(target, argumentsList, newTarget, operation);
    }
  });
  Object.defineProperty(module, name, { ...descriptor, value: guarded });
  return guarded;
}

const guardedFs = builtinModule("node:fs");
const guardedFsPromises = builtinModule("node:fs/promises");
patchPathFunctions(guardedFsPromises, "node_fs_promises");
patchPathFunctions(guardedFs, "node_fs");

function delegateChildProcess(
  original: (...args: unknown[]) => unknown,
  thisArgument: unknown,
  argumentsList: unknown[],
  operation: string
): unknown {
  if (state.phase === "post_admission") rawOperation(operation);
  return original.apply(thisArgument, argumentsList);
}

const guardedChildProcess = builtinModule("node:child_process");
for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(guardedChildProcess, name);
  if (!descriptor || typeof descriptor.value !== "function") throw new Error(`MISSING_CHILD_PROCESS_EXPORT:${name}`);
  const original = descriptor.value as (...args: unknown[]) => unknown;
  Object.defineProperty(guardedChildProcess, name, {
    ...descriptor,
    value: function guardedProcessCreation(this: unknown, ...args: unknown[]) {
      const operation = `node_child_process_${name}`;
      if (state.phase === "post_admission") deny(operation);
      return delegateChildProcess(original, this, args, operation);
    }
  });
}

const guardedFfi = import.meta.require("bun:ffi") as MutableModule;
const ffiDescriptor = Object.getOwnPropertyDescriptor(guardedFfi, "dlopen");
if (!ffiDescriptor || typeof ffiDescriptor.value !== "function") throw new Error("MISSING_BUN_FFI_DLOPEN");
const originalDlopen = ffiDescriptor.value as (path: string, symbols: Record<string, unknown>) => DynamicLibrary;

function delegateFfiDlopen(path: string, symbols: Record<string, unknown>): DynamicLibrary {
  if (state.phase === "post_admission") rawOperation("ffi_dlopen", path);
  return originalDlopen(path, symbols);
}

function delegateFfiClose(library: DynamicLibrary, path: string): void {
  if (state.phase === "post_admission") rawOperation("ffi_close", path);
  library.close();
}

function delegateFfiSymbol(
  symbol: (...args: unknown[]) => unknown,
  argumentsList: unknown[],
  operation: string,
  target: string | undefined
): unknown {
  if (state.phase === "post_admission" && target?.startsWith("/")) rawOperation(operation, target);
  return symbol(...argumentsList);
}

function guardedFfiClose(library: DynamicLibrary, path: string): void {
  if (state.phase === "post_admission") deny("ffi_close", path);
  return delegateFfiClose(library, path);
}

function guardedFfiSymbol(
  symbol: (...args: unknown[]) => unknown,
  name: string
): (...args: unknown[]) => unknown {
  const operation = `ffi_${name}`;
  return (...args: unknown[]) => {
    const candidate = decodedCString(args[name === "open" ? 0 : 1]);
    if (state.phase === "post_admission" && (name === "open" || name === "openat") &&
        candidate?.startsWith("/")) {
      deny(operation, candidate);
    }
    return delegateFfiSymbol(symbol, args, operation, candidate);
  };
}

function guardedDlopen(path: string, symbols: Record<string, unknown>): DynamicLibrary {
  if (state.phase === "post_admission") {
    if (state.rawInversion === "ffi_dlopen") {
      const library = delegateFfiDlopen(path, symbols);
      try {
        return deny("ffi_dlopen", path);
      } finally {
        delegateFfiClose(library, path);
      }
    }
    deny("ffi_dlopen", path);
  }
  const library = delegateFfiDlopen(path, symbols);
  const guardedSymbols: Record<string, (...args: unknown[]) => unknown> = {};
  for (const [name, symbol] of Object.entries(library.symbols)) {
    guardedSymbols[name] = guardedFfiSymbol(symbol, name);
  }
  return new Proxy(library, {
    get(target, property, receiver) {
      if (property === "symbols") return guardedSymbols;
      if (property === "close") return () => guardedFfiClose(target, path);
      return Reflect.get(target, property, receiver);
    }
  });
}
Object.defineProperty(guardedFfi, "dlopen", { ...ffiDescriptor, value: guardedDlopen });

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

function delegateBunFile(path: unknown, argumentsList: unknown[], normalized: string | undefined): unknown {
  if (state.phase === "post_admission" && normalized) rawOperation("bun_file", normalized);
  return originalBunFile(path, ...argumentsList);
}

function delegateBunWrite(path: unknown, argumentsList: unknown[], normalized: string | undefined): unknown {
  if (state.phase === "post_admission") rawOperation("bun_write", normalized);
  return originalBunWrite(path, ...argumentsList);
}

function delegateBunSpawn(argumentsList: unknown[]): unknown {
  if (state.phase === "post_admission") rawOperation("bun_spawn");
  return originalBunSpawn(...argumentsList);
}

function delegateBunSpawnSync(argumentsList: unknown[]): unknown {
  if (state.phase === "post_admission") rawOperation("bun_spawn_sync");
  return originalBunSpawnSync(...argumentsList);
}

function guardedBunFile(path: unknown, ...args: unknown[]): unknown {
  const normalized = normalizedPathLike(path);
  if (state.phase === "post_admission" && normalized) deny("bun_file", normalized);
  return delegateBunFile(path, args, normalized);
}

function guardedBunWrite(path: unknown, ...args: unknown[]): unknown {
  const normalized = normalizedPathLike(path);
  if (state.phase === "post_admission") deny("bun_write", normalized);
  return delegateBunWrite(path, args, normalized);
}

function guardedBunSpawn(...args: unknown[]): unknown {
  if (state.phase === "post_admission") deny("bun_spawn");
  return delegateBunSpawn(args);
}

function guardedBunSpawnSync(...args: unknown[]): unknown {
  if (state.phase === "post_admission") deny("bun_spawn_sync");
  return delegateBunSpawnSync(args);
}

guardedBun.file = guardedBunFile;
guardedBun.write = guardedBunWrite;
guardedBun.spawn = guardedBunSpawn;
guardedBun.spawnSync = guardedBunSpawnSync;

void guardedGlobalWorker;
