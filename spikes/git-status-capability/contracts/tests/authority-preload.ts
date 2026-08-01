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

const authorityGuardSymbol = Symbol.for("shud.contract.authorityGuard");
const selectedControl = Bun.argv.slice(2)[2];
const selectedRawInversion: RawInversionMode | null = selectedControl === "raw_read_inversion_canary"
  ? "node_fs_readFileSync"
  : selectedControl === "raw_ffi_inversion_canary"
  ? "ffi_dlopen"
  : null;
const state: GuardState = { phase: "admission", events: [], rawEvents: [], rawInversion: null };
const observedState = Object.create(null) as GuardState;
Object.defineProperties(observedState, {
  phase: {
    enumerable: true,
    get: (): GuardState["phase"] => state.phase,
    set: (value: unknown): void => {
      if (value === "post_admission") state.phase = "post_admission";
    }
  },
  events: { enumerable: true, get: (): string[] => state.events },
  rawEvents: { enumerable: true, get: (): string[] => state.rawEvents },
  rawInversion: {
    enumerable: true,
    get: (): RawInversionMode | null => state.rawInversion,
    set: (value: unknown): void => {
      if (value === selectedRawInversion) {
        state.rawInversion = selectedRawInversion;
      } else if (value === null && state.rawInversion === selectedRawInversion) {
        state.rawInversion = null;
      }
    }
  }
});
Object.freeze(observedState);
Object.defineProperty(globalThis, authorityGuardSymbol, {
  value: observedState,
  writable: false,
  configurable: false,
  enumerable: false
});
let capabilityOperationDepth = 0;

function isPublicPostAdmission(): boolean {
  return state.phase === "post_admission" && capabilityOperationDepth === 0;
}
// Initialize Bun's lazy stdio streams before Bun.file is guarded.
void process.stdout.write;
void process.stderr.write;

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

const RAW_DESCRIPTOR_OPERATIONS: Readonly<Record<string, true>> = {
  closeSync: true,
  fstatSync: true,
  readSync: true
};
const FILE_HANDLE_CONSUMER_METHODS: Readonly<Record<string, true>> = {
  appendFile: true,
  chmod: true,
  chown: true,
  close: true,
  createReadStream: true,
  createWriteStream: true,
  datasync: true,
  read: true,
  readFile: true,
  readLines: true,
  readableWebStream: true,
  readv: true,
  stat: true,
  sync: true,
  truncate: true,
  utimes: true,
  write: true,
  writeFile: true,
  writev: true
};

function guardedFileHandle(handle: unknown): unknown {
  if (handle === null || typeof handle !== "object" && typeof handle !== "function") return handle;
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (typeof property === "string" && FILE_HANDLE_CONSUMER_METHODS[property] &&
          isPublicPostAdmission()) {
        deny("node_fs_filehandle_read");
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string" || !FILE_HANDLE_CONSUMER_METHODS[property]) {
        return value;
      }
      return function guardedFileHandleConsumer(this: unknown, ...argumentsList: unknown[]) {
        if (isPublicPostAdmission()) deny("node_fs_filehandle_read");
        return Reflect.apply(value, target, argumentsList);
      };
    }
  });
}

function delegatePathFunction(
  original: (...args: unknown[]) => unknown,
  thisArgument: unknown,
  argumentsList: unknown[],
  operation: string,
  path: string | undefined
): unknown {
  if (isPublicPostAdmission() && path) rawOperation(operation, path);
  return original.apply(thisArgument, argumentsList);
}

function patchPathFunctions(module: MutableModule, operationPrefix: string): void {
  for (const name of Object.getOwnPropertyNames(module)) {
    const descriptor = Object.getOwnPropertyDescriptor(module, name);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(module, name, {
      ...descriptor,
      value: function guardedPathFunction(this: unknown, ...args: unknown[]) {
        const descriptorOperation = RAW_DESCRIPTOR_OPERATIONS[name] === true;
        const path = descriptorOperation ? undefined : firstPathLike(args);
        const operation = `${operationPrefix}_${name}`;
        if (isPublicPostAdmission()) {
          if (!descriptorOperation && state.rawInversion === "node_fs_readFileSync" &&
              operation === "node_fs_readFileSync") {
            if (path !== undefined && args.length === 1) {
              delegatePathFunction(original, this, args, operation, path);
            }
          }
          deny(operation, path);
        }
        const result = delegatePathFunction(original, this, args, operation, path);
        return operationPrefix === "node_fs_promises" && name === "open"
          ? Promise.resolve(result).then((fileHandle) => guardedFileHandle(fileHandle))
          : result;
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
  if (isPublicPostAdmission()) rawOperation(operation);
  return Reflect.apply(target, thisArgument, argumentsList);
}

function delegateWorkerConstruct(
  target: Function,
  argumentsList: unknown[],
  newTarget: Function,
  operation: string
): object {
  if (isPublicPostAdmission()) rawOperation(operation);
  return Reflect.construct(target, argumentsList, newTarget);
}

function guardedWorkerPrototype(original: Function, guarded: Function): object {
  const descriptor = Object.getOwnPropertyDescriptor(original, "prototype");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "object" ||
      descriptor.value === null) {
    throw new Error("MISSING_WORKER_PROTOTYPE");
  }
  const originalPrototype = descriptor.value;
  const constructorDescriptor = Object.getOwnPropertyDescriptor(originalPrototype, "constructor");
  if (!constructorDescriptor || !("value" in constructorDescriptor) ||
      constructorDescriptor.value !== original ||
      (!constructorDescriptor.configurable && !constructorDescriptor.writable)) {
    throw new Error("MISSING_WORKER_PROTOTYPE_CONSTRUCTOR");
  }
  Object.defineProperty(originalPrototype, "constructor", {
    ...constructorDescriptor,
    value: guarded
  });
  return originalPrototype;
}

function patchConstructor(module: MutableModule, name: string, operation: string): Function {
  const descriptor = Object.getOwnPropertyDescriptor(module, name);
  if (!descriptor || typeof descriptor.value !== "function") throw new Error(`MISSING_CONSTRUCTOR:${name}`);
  const original = descriptor.value as Function;
  let guardedPrototype: object = Object.create(null);
  const guarded = new Proxy(original, {
    get(target, property, receiver) {
      if (property === "prototype") return guardedPrototype;
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      const propertyDescriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property === "prototype" && propertyDescriptor && "value" in propertyDescriptor) {
        return { ...propertyDescriptor, value: guardedPrototype };
      }
      return propertyDescriptor;
    },
    apply(target, thisArgument, argumentsList) {
      if (isPublicPostAdmission()) deny(operation);
      return delegateWorkerApply(target, thisArgument, argumentsList, operation);
    },
    construct(target, argumentsList, newTarget) {
      if (isPublicPostAdmission()) deny(operation);
      return delegateWorkerConstruct(target, argumentsList, newTarget, operation);
    }
  });
  guardedPrototype = guardedWorkerPrototype(original, guarded);
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
  if (isPublicPostAdmission()) rawOperation(operation);
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
      if (isPublicPostAdmission()) deny(operation);
      return delegateChildProcess(original, this, args, operation);
    }
  });
}

const guardedFfi = import.meta.require("bun:ffi") as MutableModule;
const ffiDescriptor = Object.getOwnPropertyDescriptor(guardedFfi, "dlopen");
if (!ffiDescriptor || typeof ffiDescriptor.value !== "function") throw new Error("MISSING_BUN_FFI_DLOPEN");
const originalDlopen = ffiDescriptor.value as (path: string, symbols: Record<string, unknown>) => DynamicLibrary;

function delegateFfiDlopen(path: string, symbols: Record<string, unknown>): DynamicLibrary {
  if (isPublicPostAdmission()) rawOperation("ffi_dlopen", path);
  return originalDlopen(path, symbols);
}

function delegateFfiClose(library: DynamicLibrary, path: string): void {
  if (isPublicPostAdmission()) rawOperation("ffi_close", path);
  library.close();
}

function delegateFfiSymbol(
  symbol: (...args: unknown[]) => unknown,
  argumentsList: unknown[],
  operation: string,
  target: string | undefined
): unknown {
  if (isPublicPostAdmission() && target?.startsWith("/")) rawOperation(operation, target);
  return symbol(...argumentsList);
}
function guardedFfiClose(library: DynamicLibrary, path: string): void {
  if (isPublicPostAdmission()) deny("ffi_close", path);
  return delegateFfiClose(library, path);
}

function guardedFfiSymbol(
  symbol: (...args: unknown[]) => unknown,
  name: string
): (...args: unknown[]) => unknown {
  const operation = `ffi_${name}`;
  return (...args: unknown[]) => {
    const candidate = decodedCString(args[name === "open" ? 0 : 1]);
    if (isPublicPostAdmission()) deny(operation, candidate);
    return delegateFfiSymbol(symbol, args, operation, candidate);
  };
}

function guardedDlopen(path: string, symbols: Record<string, unknown>): DynamicLibrary {
  if (isPublicPostAdmission()) {
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
  return Object.freeze({
    symbols: Object.freeze(guardedSymbols),
    close: () => guardedFfiClose(library, path)
  }) as DynamicLibrary;
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

type CapabilityMethod = (this: unknown, ...argumentsList: unknown[]) => unknown;
const CAPABILITY_METHOD_NAMES = ["close", "openRelative", "readRetained", "stat"] as const;

async function installCapabilityMediation(): Promise<void> {
  const { ContractCapabilities } = await import("../lib/capabilities");
  for (const name of CAPABILITY_METHOD_NAMES) {
    const descriptor = Object.getOwnPropertyDescriptor(ContractCapabilities.prototype, name);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.writable || !descriptor.configurable) {
      throw new Error(`MISSING_CAPABILITY_METHOD:${name}`);
    }
    const original = descriptor.value as CapabilityMethod;
    Object.defineProperty(ContractCapabilities.prototype, name, {
      ...descriptor,
      configurable: false,
      writable: false,
      value: function guardedCapabilityOperation(this: unknown, ...argumentsList: unknown[]) {
        capabilityOperationDepth += 1;
        try {
          return original.apply(this, argumentsList);
        } finally {
          capabilityOperationDepth -= 1;
        }
      }
    });
  }
}
await installCapabilityMediation();

const guardedBun = Bun as unknown as BunAuthority;
const originalBunFile = guardedBun.file.bind(Bun);
const originalBunWrite = guardedBun.write.bind(Bun);
const originalBunSpawn = guardedBun.spawn.bind(Bun);
const originalBunSpawnSync = guardedBun.spawnSync.bind(Bun);

const BUN_FILE_CONSUMER_PROPERTIES: Readonly<Record<string, true>> = {
  arrayBuffer: true,
  bytes: true,
  delete: true,
  exists: true,
  formData: true,
  json: true,
  lastModified: true,
  size: true,
  stat: true,
  slice: true,
  stream: true,
  text: true,
  type: true,
  unlink: true,
  write: true,
  writer: true
};

function guardedBunFileStream(stream: unknown, normalized: string | undefined): unknown {
  if (stream === null || typeof stream !== "object" && typeof stream !== "function") return stream;
  return new Proxy(stream, {
    get(target, property, receiver) {
      const consumes = property === Symbol.asyncIterator || property === "getReader" ||
        property === "pipeTo" || property === "tee";
      if (consumes && isPublicPostAdmission()) deny("bun_file", normalized);
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || !consumes) return value;
      return function guardedBunFileStreamConsumer(this: unknown, ...argumentsList: unknown[]) {
        if (isPublicPostAdmission()) deny("bun_file", normalized);
        return Reflect.apply(value, target, argumentsList);
      };
    }
  });
}

function guardedBunFileValue(file: unknown, normalized: string | undefined): unknown {
  if (file === null || typeof file !== "object" && typeof file !== "function") return file;
  return new Proxy(file, {
    get(target, property, receiver) {
      const consumes = typeof property === "string" && BUN_FILE_CONSUMER_PROPERTIES[property];
      if (consumes && isPublicPostAdmission()) deny("bun_file", normalized);
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || !consumes) return value;
      return function guardedBunFileConsumer(this: unknown, ...argumentsList: unknown[]) {
        if (isPublicPostAdmission()) deny("bun_file", normalized);
        const result = Reflect.apply(value, target, argumentsList);
        if (property === "slice") return guardedBunFileValue(result, normalized);
        return property === "stream" ? guardedBunFileStream(result, normalized) : result;
      };
    }
  });
}

function delegateBunFile(path: unknown, argumentsList: unknown[], normalized: string | undefined): unknown {
  if (isPublicPostAdmission() && normalized) rawOperation("bun_file", normalized);
  return originalBunFile(path, ...argumentsList);
}

function delegateBunWrite(path: unknown, argumentsList: unknown[], normalized: string | undefined): unknown {
  if (isPublicPostAdmission()) rawOperation("bun_write", normalized);
  return originalBunWrite(path, ...argumentsList);
}

function delegateBunSpawn(argumentsList: unknown[]): unknown {
  if (isPublicPostAdmission()) rawOperation("bun_spawn");
  return originalBunSpawn(...argumentsList);
}

function delegateBunSpawnSync(argumentsList: unknown[]): unknown {
  if (isPublicPostAdmission()) rawOperation("bun_spawn_sync");
  return originalBunSpawnSync(...argumentsList);
}

function guardedBunFile(path: unknown, ...args: unknown[]): unknown {
  const normalized = normalizedPathLike(path);
  if (isPublicPostAdmission()) deny("bun_file", normalized);
  return guardedBunFileValue(delegateBunFile(path, args, normalized), normalized);
}

function guardedBunWrite(path: unknown, ...args: unknown[]): unknown {
  const normalized = normalizedPathLike(path);
  if (isPublicPostAdmission()) deny("bun_write", normalized);
  return delegateBunWrite(path, args, normalized);
}

function guardedBunSpawn(...args: unknown[]): unknown {
  if (isPublicPostAdmission()) deny("bun_spawn");
  return delegateBunSpawn(args);
}

function guardedBunSpawnSync(...args: unknown[]): unknown {
  if (isPublicPostAdmission()) deny("bun_spawn_sync");
  return delegateBunSpawnSync(args);
}

guardedBun.file = guardedBunFile;
guardedBun.write = guardedBunWrite;
guardedBun.spawn = guardedBunSpawn;
guardedBun.spawnSync = guardedBunSpawnSync;

void guardedGlobalWorker;
