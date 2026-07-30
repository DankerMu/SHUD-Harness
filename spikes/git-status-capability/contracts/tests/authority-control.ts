import * as staticFfi from "bun:ffi";
import * as staticNodeFs from "node:fs";
import { createRequire } from "node:module";
import { Worker as StaticNodeWorker } from "node:worker_threads";
import { Worker as StaticBareWorker } from "worker_threads";
import type { SourceInputKind } from "../lib/schemas";
import {
  AUTHORITY_PROOF_ROWS,
  AUTHORITY_WORKER_ENTRY
} from "./authority-vocabulary";
import type { AuthorityControl } from "./authority-vocabulary";

type GuardState = { phase: "admission" | "post_admission"; events: string[]; rawEvents: string[] };
type WorkerConstructor = new (source: URL) => unknown;
type DynamicConstructor = (...parameters: string[]) => (...arguments_: unknown[]) => unknown;
type IteratorStep = Readonly<{ value: unknown }>;
type WorkerEntryReceipt = Readonly<{ entry: typeof AUTHORITY_WORKER_ENTRY; inputBytes: number }>;
type WorkerLivenessReceipt = Readonly<{
  phase: "admission";
  entry: typeof AUTHORITY_WORKER_ENTRY;
  inputBytes: number;
  sentinelBytes: string;
}>;
type RawInversionCanary = Readonly<{
  readBeforeDeny: (path: string) => never;
  ffiBeforeDeny: (path: string) => never;
}>;
type WorkerLike = {
  addEventListener?: (...arguments_: unknown[]) => unknown;
  removeEventListener?: (...arguments_: unknown[]) => unknown;
  on?: (...arguments_: unknown[]) => unknown;
  off?: (...arguments_: unknown[]) => unknown;
  terminate?: (...arguments_: unknown[]) => unknown;
};
type CanaryControl = "worker_liveness_canary" | "raw_read_inversion_canary" | "raw_ffi_inversion_canary";
type ControlInvocation = AuthorityControl | CanaryControl | "direct_success";
const CANARY_CONTROLS: Readonly<Record<CanaryControl, true>> = Object.freeze({
  worker_liveness_canary: true,
  raw_read_inversion_canary: true,
  raw_ffi_inversion_canary: true
});

const state = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("shud.contract.authorityGuard")
] as GuardState | undefined;
if (!state) throw new Error("CONTRACT_TEST_AUTHORITY_PRELOAD_MISSING");
const rawInversion = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("shud.contract.authorityRawInversion")
] as RawInversionCanary | undefined;
if (!rawInversion) throw new Error("CONTRACT_TEST_AUTHORITY_RAW_INVERSION_MISSING");

const cachedGlobalWorker = (globalThis as { Worker?: unknown }).Worker;
if (typeof cachedGlobalWorker !== "function") throw new Error("MISSING_CACHED_GLOBAL_WORKER");
const cachedNodeWorkerModule = process.getBuiltinModule("node:worker_threads") as { Worker?: unknown };
if (!cachedNodeWorkerModule || typeof cachedNodeWorkerModule.Worker !== "function") {
  throw new Error("MISSING_CACHED_NODE_WORKER");
}
const cachedNodeWorker = cachedNodeWorkerModule.Worker as WorkerConstructor;
const cachedBareWorkerModule = process.getBuiltinModule("worker_threads") as { Worker?: unknown };
if (!cachedBareWorkerModule || typeof cachedBareWorkerModule.Worker !== "function") {
  throw new Error("MISSING_CACHED_BARE_WORKER");
}
const cachedBareWorker = cachedBareWorkerModule.Worker as WorkerConstructor;
const cachedFsPromises = process.getBuiltinModule("node:fs/promises") as {
  readFile?: (path: string | URL | Buffer) => Promise<unknown>;
};
if (!cachedFsPromises || typeof cachedFsPromises.readFile !== "function") {
  throw new Error("MISSING_CACHED_FS_PROMISES_READ_FILE");
}
const cachedDynamicConstructor = (function authorityCachedConstructor() {}).constructor as DynamicConstructor;
const systemLibraryPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";

const [kind, input, selectedControl, replacement, workerSentinel, writeSentinel, spawnSentinel] = Bun.argv.slice(2);
if (kind !== "source_input_record" && kind !== "source_identity_projection") {
  throw new Error("AUTHORITY_CONTROL_KIND_INVALID");
}
if (!input || !replacement || !workerSentinel || !writeSentinel || !spawnSentinel) {
  throw new Error("AUTHORITY_CONTROL_ARGUMENTS_MISSING");
}
if (
  selectedControl !== "direct_success" &&
  !AUTHORITY_PROOF_ROWS.some((row) => row.control === selectedControl) &&
  !CANARY_CONTROLS[selectedControl as CanaryControl]
) {
  throw new Error("AUTHORITY_CONTROL_UNKNOWN");
}
const control = selectedControl as ControlInvocation;

function workerFixtureUrl(inputPath: string, sentinelPath: string): URL {
  const url = new URL("./authority-worker.ts", import.meta.url);
  url.searchParams.set("input", inputPath);
  url.searchParams.set("sentinel", sentinelPath);
  return url;
}

const WORKER_ENTRY_TIMEOUT_MS = 5_000;

function workerReceipt(value: unknown): WorkerEntryReceipt | undefined {
  const message = typeof value === "object" && value !== null && "data" in value
    ? value.data
    : value;
  if (typeof message !== "object" || message === null || !("entry" in message) || !("inputBytes" in message)) {
    return undefined;
  }
  const entry = message.entry;
  const inputBytes = message.inputBytes;
  if (
    entry !== AUTHORITY_WORKER_ENTRY ||
    typeof inputBytes !== "number" ||
    !Number.isSafeInteger(inputBytes) ||
    inputBytes < 0
  ) {
    return undefined;
  }
  return { entry: AUTHORITY_WORKER_ENTRY, inputBytes };
}

function workerConstructorFrom(module: unknown): WorkerConstructor {
  if (typeof module !== "object" || module === null || !("Worker" in module) || typeof module.Worker !== "function") {
    throw new Error("AUTHORITY_WORKER_MODULE_INVALID");
  }
  const worker = module.Worker;
  return worker as WorkerConstructor;
}

async function awaitWorkerEntry(worker: unknown): Promise<WorkerEntryReceipt> {
  const candidate = worker as WorkerLike;
  if (typeof candidate.terminate !== "function") throw new Error("AUTHORITY_WORKER_TERMINATION_UNAVAILABLE");
  try {
    return await new Promise<WorkerEntryReceipt>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => rejectOnce(new Error("AUTHORITY_WORKER_ENTRY_TIMEOUT")), WORKER_ENTRY_TIMEOUT_MS);
      function cleanup(): void {
        clearTimeout(timeout);
        if (typeof candidate.removeEventListener === "function") {
          candidate.removeEventListener("message", accept);
          candidate.removeEventListener("error", rejectWorker);
        }
        if (typeof candidate.off === "function") {
          candidate.off("message", accept);
          candidate.off("error", rejectWorker);
        }
      }
      function resolveOnce(receipt: WorkerEntryReceipt): void {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(receipt);
      }
      function rejectOnce(error: Error): void {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
      function accept(event: unknown): void {
        const receipt = workerReceipt(event);
        if (!receipt) rejectOnce(new Error("AUTHORITY_WORKER_RECEIPT_INVALID"));
        else resolveOnce(receipt);
      }
      function rejectWorker(event: unknown): void {
        rejectOnce(event instanceof Error ? event : new Error("AUTHORITY_WORKER_FAILED"));
      }
      if (typeof candidate.addEventListener === "function") {
        candidate.addEventListener("message", accept, { once: true });
        candidate.addEventListener("error", rejectWorker, { once: true });
      } else if (typeof candidate.on === "function") {
        candidate.on("message", accept);
        candidate.on("error", rejectWorker);
      } else {
        rejectOnce(new Error("AUTHORITY_WORKER_INTERFACE_INVALID"));
      }
    });
  } finally {
    await candidate.terminate();
  }
}

async function runWorkerLivenessCanary(
  inputPath: string,
  workerEntrySentinel: string
): Promise<WorkerLivenessReceipt> {
  if (state.phase !== "admission") throw new Error("AUTHORITY_WORKER_LIVENESS_PHASE_INVALID");
  const expectedInputBytes = staticNodeFs.statSync(inputPath).size;
  try {
    const receipt = await awaitWorkerEntry(new StaticNodeWorker(
      workerFixtureUrl(inputPath, workerEntrySentinel),
      { workerData: { input: inputPath, sentinel: workerEntrySentinel } }
    ));
    const sentinelBytes = await Bun.file(workerEntrySentinel).text();
    if (receipt.inputBytes !== expectedInputBytes) throw new Error("AUTHORITY_WORKER_INPUT_READ_INVALID");
    if (sentinelBytes !== AUTHORITY_WORKER_ENTRY) throw new Error("AUTHORITY_WORKER_SENTINEL_INVALID");
    return {
      phase: "admission",
      entry: receipt.entry,
      inputBytes: receipt.inputBytes,
      sentinelBytes
    };
  } finally {
    staticNodeFs.rmSync(workerEntrySentinel, { force: true });
  }
}

async function attemptForbiddenOperation(
  selected: AuthorityControl,
  inputPath: string,
  replacementPath: string,
  workerEntrySentinel: string,
  writePath: string,
  spawnPath: string
): Promise<void> {
  const workerUrl = workerFixtureUrl(inputPath, workerEntrySentinel);
  const childScript = `require("node:fs").writeFileSync(${JSON.stringify(spawnPath)}, "spawned")`;
  switch (selected) {
    case "worker_global_direct":
      await awaitWorkerEntry(new (globalThis as { Worker: WorkerConstructor }).Worker(workerUrl));
      return;
    case "worker_global_cached":
      await awaitWorkerEntry(new (cachedGlobalWorker as WorkerConstructor)(workerUrl));
      return;
    case "worker_node_static_import":
      await awaitWorkerEntry(new StaticNodeWorker(workerUrl));
      return;
    case "worker_node_dynamic_import": {
      const workerThreads = await import("node:worker_threads");
      await awaitWorkerEntry(new workerThreads.Worker(workerUrl));
      return;
    }
    case "worker_node_get_builtin": {
      const workerThreads = process.getBuiltinModule("node:worker_threads") as { Worker: WorkerConstructor };
      await awaitWorkerEntry(new workerThreads.Worker(workerUrl));
      return;
    }
    case "worker_node_create_require": {
      const workerThreads = createRequire(import.meta.url)("node:worker_threads") as { Worker: WorkerConstructor };
      await awaitWorkerEntry(new workerThreads.Worker(workerUrl));
      return;
    }
    case "worker_node_cached_module":
      await awaitWorkerEntry(new cachedNodeWorker(workerUrl));
      return;
    case "worker_bare_static_import":
      await awaitWorkerEntry(new StaticBareWorker(workerUrl));
      return;
    case "worker_bare_dynamic_import": {
      // Intentional dynamic-loader control for the registered bare `worker_threads` spelling.
      const workerThreads = await import("worker_threads");
      await awaitWorkerEntry(new workerThreads.Worker(workerUrl));
      return;
    }
    case "worker_bare_get_builtin":
      await awaitWorkerEntry(new (workerConstructorFrom(process.getBuiltinModule("worker_threads")))(workerUrl));
      return;
    case "worker_bare_create_require":
      await awaitWorkerEntry(new (workerConstructorFrom(createRequire(import.meta.url)("worker_threads")))(workerUrl));
      return;
    case "worker_bare_cached_module":
      await awaitWorkerEntry(new cachedBareWorker(workerUrl));
      return;
    case "dynamic_eval": {
      const worker = eval("new Worker(workerUrl)") as unknown;
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_function": {
      const worker = Function("url", "return new Worker(url)")(workerUrl) as unknown;
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_object_double_constructor": {
      const constructor = ({}).constructor.constructor as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_function_constructor": {
      const constructor = (function authorityFunction() {}).constructor as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_arrow_constructor": {
      const constructor = (() => {}).constructor as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_async_constructor": {
      const constructor = (async function authorityAsync() {}).constructor as DynamicConstructor;
      const worker = await constructor("url", "return new Worker(url)")(workerUrl);
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_generator_constructor": {
      const constructor = (function* authorityGenerator() {}).constructor as DynamicConstructor;
      const iterator = constructor("url", "yield new Worker(url)")(workerUrl) as { next: () => IteratorStep };
      const worker = (await iterator.next()).value;
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_async_generator_constructor": {
      const constructor = (async function* authorityAsyncGenerator() {}).constructor as DynamicConstructor;
      const iterator = constructor("url", "yield new Worker(url)")(workerUrl) as {
        next: () => Promise<IteratorStep>;
      };
      const worker = (await iterator.next()).value;
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_computed_constructor": {
      const constructor = (function authorityComputed() {})["constructor"] as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_cached_constructor": {
      const worker = cachedDynamicConstructor("url", "return new Worker(url)")(workerUrl);
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_async_prototype_constructor": {
      const constructor = Object.getPrototypeOf(async function authorityAsyncPrototype() {}).constructor as DynamicConstructor;
      const worker = await constructor("url", "return new Worker(url)")(workerUrl);
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_generator_prototype_constructor": {
      const constructor = Object.getPrototypeOf(function* authorityGeneratorPrototype() {}).constructor as DynamicConstructor;
      const iterator = constructor("url", "yield new Worker(url)")(workerUrl) as { next: () => IteratorStep };
      const worker = (await iterator.next()).value;
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_async_generator_prototype_constructor": {
      const constructor = Object.getPrototypeOf(async function* authorityAsyncGeneratorPrototype() {}).constructor as DynamicConstructor;
      const iterator = constructor("url", "yield new Worker(url)")(workerUrl) as {
        next: () => Promise<IteratorStep>;
      };
      const worker = (await iterator.next()).value;
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_reflective_descriptor_constructor": {
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(function authorityDescriptor() {}),
        "constructor"
      );
      if (!descriptor || typeof descriptor.value !== "function") {
        throw new Error("AUTHORITY_DESCRIPTOR_CONSTRUCTOR_MISSING");
      }
      const constructor = descriptor.value as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_key_constructor": {
      const dynamicKey = ["con", "structor"].join("") as "constructor";
      const dynamicConstructor = (function authorityDynamicKey() {})[dynamicKey];
      const constructor = dynamicConstructor as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitWorkerEntry(worker);
      return;
    }
    case "dynamic_destructured_constructor": {
      const { constructor: destructuredConstructor } = function authorityDestructured() {};
      const constructor = destructuredConstructor as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitWorkerEntry(worker);
      return;
    }
    case "static_node_fs_read":
      staticNodeFs.readFileSync(replacementPath);
      return;
    case "node_absolute_open": {
      const fs = await import("node:fs");
      const descriptor = fs.openSync(inputPath, fs.constants.O_RDONLY);
      fs.closeSync(descriptor);
      return;
    }
    case "node_url_open": {
      const fs = await import("node:fs");
      const { pathToFileURL } = await import("node:url");
      const descriptor = fs.openSync(pathToFileURL(inputPath), fs.constants.O_RDONLY);
      fs.closeSync(descriptor);
      return;
    }
    case "node_buffer_open": {
      const fs = await import("node:fs");
      const descriptor = fs.openSync(Buffer.from(inputPath), fs.constants.O_RDONLY);
      fs.closeSync(descriptor);
      return;
    }
    case "fs_alias_url_open": {
      const fs = await import("fs");
      const { pathToFileURL } = await import("node:url");
      const descriptor = fs.openSync(pathToFileURL(inputPath), fs.constants.O_RDONLY);
      fs.closeSync(descriptor);
      return;
    }
    case "ffi_absolute_open": {
      const library = staticFfi.dlopen(systemLibraryPath, {
        open: { args: ["cstring", "i32"], returns: "i32" }
      });
      try {
        const descriptor = library.symbols.open(Buffer.from(`${inputPath}\0`), staticNodeFs.constants.O_RDONLY);
        if (descriptor >= 0) staticNodeFs.closeSync(descriptor);
      } finally {
        library.close();
      }
      return;
    }
    case "node_replacement_read": {
      const fs = await import("node:fs");
      fs.readFileSync(replacementPath);
      return;
    }
    case "node_promises_read": {
      const fs = await import("node:fs/promises");
      await fs.readFile(replacementPath);
      return;
    }
    case "fs_promises_read": {
      const fs = await import("fs/promises");
      await fs.readFile(replacementPath);
      return;
    }
    case "node_promises_property_read": {
      const fs = await import("node:fs");
      await fs.promises.readFile(replacementPath);
      return;
    }
    case "fs_promises_property_read": {
      const fs = await import("fs");
      await fs.promises.readFile(replacementPath);
      return;
    }
    case "cached_fs_promises_read":
      await cachedFsPromises.readFile(replacementPath);
      return;
    case "bun_replacement_read":
      await Bun.file(replacementPath).text();
      return;
    case "bun_url_read": {
      const { pathToFileURL } = await import("node:url");
      await Bun.file(pathToFileURL(replacementPath)).text();
      return;
    }
    case "node_write": {
      const fs = await import("node:fs");
      fs.writeFileSync(writePath, "written");
      return;
    }
    case "bun_write":
      await Bun.write(writePath, "written");
      return;
    case "node_spawn": {
      const childProcess = await import("node:child_process");
      childProcess.spawnSync(process.execPath, ["-e", childScript]);
      return;
    }
    case "bun_spawn":
      await Bun.spawn([process.execPath, "-e", childScript]).exited;
      return;
    case "builtin_computed_read_absolute": {
      const fs = process.getBuiltinModule("node:" + "fs");
      fs.readFileSync(replacementPath);
      return;
    }
    case "builtin_computed_stat_relative": {
      const { relative } = await import("node:path");
      const fs = process.getBuiltinModule(["node", "fs"].join(":"));
      fs.statSync(relative(process.cwd(), replacementPath));
      return;
    }
    case "meta_computed_stream_url": {
      const { pathToFileURL } = await import("node:url");
      const fs = import.meta.require("node:" + "fs");
      fs.createReadStream(pathToFileURL(replacementPath));
      return;
    }
    case "meta_computed_open_buffer": {
      const fs = import.meta.require(["n", "ode:fs"].join(""));
      const descriptor = fs.openSync(Buffer.from(replacementPath), fs.constants.O_RDONLY);
      fs.closeSync(descriptor);
      return;
    }
    case "meta_bracket_require_read": {
      const fs = import.meta["require"]("node:fs");
      fs.readFileSync(replacementPath);
      return;
    }
    case "create_require_computed_write_relative": {
      const { relative } = await import("node:path");
      const loader = createRequire(import.meta.url);
      const fs = loader("node:" + "fs");
      fs.writeFileSync(relative(process.cwd(), writePath), "written");
      return;
    }
    case "create_require_promises_read_url": {
      const { pathToFileURL } = await import("node:url");
      const loader = createRequire(import.meta.url);
      const fs = loader(["node:fs", "promises"].join("/"));
      await fs.readFile(pathToFileURL(replacementPath));
      return;
    }
    case "meta_computed_ffi_dlopen": {
      const ffi = import.meta.require("bun:" + "ffi");
      const library = ffi.dlopen(systemLibraryPath, { getpid: { args: [], returns: "i32" } });
      library.close();
      return;
    }
    case "builtin_computed_child_exec_file": {
      const childProcess = process.getBuiltinModule(["node", "child_process"].join(":"));
      childProcess.execFileSync(process.execPath, ["-e", childScript]);
      return;
    }
  }
}

let stdout = "";
let stderr = "";
let workerLiveness: WorkerLivenessReceipt | null = null;
if (control === "worker_liveness_canary") {
  workerLiveness = await runWorkerLivenessCanary(input, workerSentinel);
}
const { runCheckForTest } = await import("../lib/checker");
const exit = await runCheckForTest(
  ["--input", input, "--kind", kind as SourceInputKind],
  { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
  {
    afterAdmission: async () => {
      state.phase = "post_admission";
      if (control === "direct_success" || control === "worker_liveness_canary") return;
      try {
        if (control === "raw_read_inversion_canary") {
          rawInversion.readBeforeDeny(replacement);
        } else if (control === "raw_ffi_inversion_canary") {
          rawInversion.ffiBeforeDeny(systemLibraryPath);
        } else {
          await attemptForbiddenOperation(control, input, replacement, workerSentinel, writeSentinel, spawnSentinel);
        }
      } catch (error) {
        state.events.push(`control_error:${error instanceof Error ? error.message : "unknown"}`);
        throw error;
      }
    }
  }
);

process.stdout.write(`${JSON.stringify({
  exit,
  stdout,
  stderr,
  events: state.events,
  rawEvents: state.rawEvents,
  workerLiveness
})}\n`);
