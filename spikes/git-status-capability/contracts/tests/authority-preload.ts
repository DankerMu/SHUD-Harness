import { mock } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type GuardState = { phase: "admission" | "post_admission"; events: string[] };
const state: GuardState = { phase: "admission", events: [] };
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

function firstPathLike(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const path = normalizedPathLike(value);
    if (path) return path;
  }
  return undefined;
}

type MutableModule = Record<string, unknown>;
const retainedDescriptorOperations = new Set(["closeSync", "fstatSync", "readSync"]);

function patchPathFunctions(module: MutableModule, operationPrefix: string): void {
  for (const name of Object.getOwnPropertyNames(module)) {
    if (retainedDescriptorOperations.has(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(module, name);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(module, name, {
      ...descriptor,
      value: function guardedPathFunction(this: unknown, ...args: unknown[]) {
        if (state.phase === "post_admission") {
          const path = firstPathLike(args);
          if (path) deny(`${operationPrefix}_${name}`, path);
        }
        return original.apply(this, args);
      }
    });
  }
}

const guardedFs = process.getBuiltinModule("node:fs") as MutableModule;
const guardedFsPromises = process.getBuiltinModule("node:fs/promises") as MutableModule;
patchPathFunctions(guardedFsPromises, "node_fs_promises");
patchPathFunctions(guardedFs, "node_fs");
const guardedChildProcess = process.getBuiltinModule("node:child_process") as MutableModule;
for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(guardedChildProcess, name);
  if (!descriptor || typeof descriptor.value !== "function") throw new Error(`MISSING_CHILD_PROCESS_EXPORT:${name}`);
  const original = descriptor.value as (...args: unknown[]) => unknown;
  Object.defineProperty(guardedChildProcess, name, {
    ...descriptor,
    value: function guardedProcessCreation(this: unknown, ...args: unknown[]) {
      if (state.phase === "post_admission") deny(`node_child_process_${name}`);
      return original.apply(this, args);
    }
  });
}

const guardedFfi = import.meta.require("bun:ffi") as MutableModule;
const originalDlopen = guardedFfi.dlopen as (...args: unknown[]) => any;

const guardedDlopen = (path: string, symbols: Record<string, unknown>) => {
  if (state.phase === "post_admission") deny("ffi_dlopen", path);
  const library = originalDlopen(path, symbols);
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
Object.defineProperty(guardedFfi, "dlopen", {
  ...Object.getOwnPropertyDescriptor(guardedFfi, "dlopen"),
  value: guardedDlopen
});

mock.module("node:fs", () => ({ ...guardedFs, default: guardedFs }));
mock.module("fs", () => ({ ...guardedFs, default: guardedFs }));
mock.module("node:fs/promises", () => ({ ...guardedFsPromises, default: guardedFsPromises }));
mock.module("fs/promises", () => ({ ...guardedFsPromises, default: guardedFsPromises }));
mock.module("node:child_process", () => ({ ...guardedChildProcess, default: guardedChildProcess }));
mock.module("child_process", () => ({ ...guardedChildProcess, default: guardedChildProcess }));
mock.module("bun:ffi", () => ({ ...guardedFfi, dlopen: guardedDlopen }));

const originalBunFile = Bun.file.bind(Bun);
const originalBunWrite = Bun.write.bind(Bun);
const originalBunSpawn = Bun.spawn.bind(Bun);
const originalBunSpawnSync = Bun.spawnSync.bind(Bun);

(Bun as any).file = (path: Parameters<typeof Bun.file>[0], ...args: unknown[]) => {
  const normalized = normalizedPathLike(path);
  if (state.phase === "post_admission" && normalized) deny("bun_file", normalized);
  return (originalBunFile as (...values: unknown[]) => ReturnType<typeof Bun.file>)(path, ...args);
};
(Bun as any).write = (path: Parameters<typeof Bun.write>[0], ...args: unknown[]) => {
  if (state.phase === "post_admission") deny("bun_write", normalizedPathLike(path));
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
