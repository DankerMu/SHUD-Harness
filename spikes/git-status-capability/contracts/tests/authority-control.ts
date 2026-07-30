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

type RawInversionMode = "node_fs_readFileSync" | "ffi_dlopen";
type GuardState = {
  phase: "admission" | "post_admission";
  events: string[];
  rawEvents: string[];
  rawInversion: RawInversionMode | null;
};
type WorkerConstructor = new (source: URL) => unknown;
type DynamicConstructor = (...parameters: string[]) => (...arguments_: unknown[]) => unknown;
type IteratorStep = Readonly<{ value: unknown }>;
type WorkerChannel = "global" | "parent_port";
type WorkerLivenessRoute = "global_direct" | "node_worker_threads" | "bare_worker_threads";
type WorkerEntryReceipt = Readonly<{
  entry: typeof AUTHORITY_WORKER_ENTRY;
  inputBytes: number;
  transport: "message";
  channel: WorkerChannel;
}>;
type WorkerLivenessRouteReceipt = Readonly<{
  route: WorkerLivenessRoute;
  transport: "message";
  channel: WorkerChannel;
  entry: typeof AUTHORITY_WORKER_ENTRY;
  inputBytes: number;
  sentinelBytes: string;
}>;
type WorkerLivenessReceipt = Readonly<{
  phase: "admission";
  routes: readonly WorkerLivenessRouteReceipt[];
}>;
type WorkerConfiguration = Readonly<{
  input: string;
  sentinel: string;
  channel: WorkerChannel;
}>;
type WorkerReadyReceipt = Readonly<{ state: "ready"; channel: WorkerChannel }>;
type WorkerLike = {
  addEventListener?: (...arguments_: unknown[]) => unknown;
  removeEventListener?: (...arguments_: unknown[]) => unknown;
  on?: (...arguments_: unknown[]) => unknown;
  off?: (...arguments_: unknown[]) => unknown;
  terminate?: (...arguments_: unknown[]) => unknown;
  postMessage?: (value: unknown) => unknown;
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

function runRawReadInversionCanary(path: string): never {
  state.rawInversion = "node_fs_readFileSync";
  try {
    staticNodeFs.readFileSync(path);
  } finally {
    state.rawInversion = null;
  }
  throw new Error("CONTRACT_TEST_AUTHORITY_RAW_INVERSION_NOT_DENIED");
}

function runRawFfiInversionCanary(path: string): never {
  state.rawInversion = "ffi_dlopen";
  try {
    const ffi = import.meta.require("bun:ffi");
    ffi.dlopen(path, { getpid: { args: [], returns: "i32" } });
  } finally {
    state.rawInversion = null;
  }
  throw new Error("CONTRACT_TEST_AUTHORITY_RAW_INVERSION_NOT_DENIED");
}

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

const WORKER_FIXTURE_URL = new URL("./authority-worker.ts", import.meta.url);

const WORKER_ENTRY_TIMEOUT_MS = 5_000;
const WORKER_READY_RETRY_MS = 25;

const WORKER_LIVENESS_ROUTES = [
  { route: "global_direct", channel: "global" },
  { route: "node_worker_threads", channel: "parent_port" },
  { route: "bare_worker_threads", channel: "parent_port" }
] as const;


function workerChannelForControl(selected: AuthorityControl): WorkerChannel | undefined {
  switch (selected) {
    case "worker_global_direct":
    case "worker_global_cached":
    case "dynamic_eval":
    case "dynamic_function":
    case "dynamic_object_double_constructor":
    case "dynamic_function_constructor":
    case "dynamic_arrow_constructor":
    case "dynamic_async_constructor":
    case "dynamic_generator_constructor":
    case "dynamic_async_generator_constructor":
    case "dynamic_computed_constructor":
    case "dynamic_cached_constructor":
    case "dynamic_async_prototype_constructor":
    case "dynamic_generator_prototype_constructor":
    case "dynamic_async_generator_prototype_constructor":
    case "dynamic_reflective_descriptor_constructor":
    case "dynamic_key_constructor":
    case "dynamic_destructured_constructor":
      return "global";
    case "worker_node_static_import":
    case "worker_node_dynamic_import":
    case "worker_node_get_builtin":
    case "worker_node_create_require":
    case "worker_node_cached_module":
    case "worker_bare_static_import":
    case "worker_bare_dynamic_import":
    case "worker_bare_get_builtin":
    case "worker_bare_create_require":
    case "worker_bare_cached_module":
      return "parent_port";
    default:
      return undefined;
  }
}

function workerReceipt(value: unknown): WorkerEntryReceipt | undefined {
  const message = typeof value === "object" && value !== null && "data" in value
    ? value.data
    : value;
  if (
    typeof message !== "object" ||
    message === null ||
    !("entry" in message) ||
    !("inputBytes" in message) ||
    !("transport" in message) ||
    !("channel" in message)
  ) {
    return undefined;
  }
  const entry = message.entry;
  const inputBytes = message.inputBytes;
  const transport = message.transport;
  const channel = message.channel;
  if (
    entry !== AUTHORITY_WORKER_ENTRY ||
    typeof inputBytes !== "number" ||
    !Number.isSafeInteger(inputBytes) ||
    inputBytes < 0 ||
    transport !== "message" ||
    (channel !== "global" && channel !== "parent_port")
  ) {
    return undefined;
  }
  return { entry: AUTHORITY_WORKER_ENTRY, inputBytes, transport: "message", channel };
}
function workerReady(value: unknown): WorkerReadyReceipt | undefined {
  const message = typeof value === "object" && value !== null && "data" in value
    ? value.data
    : value;
  if (typeof message !== "object" || message === null || !("state" in message) || !("channel" in message)) {
    return undefined;
  }
  const state = message.state;
  const channel = message.channel;
  if (state !== "ready" || (channel !== "global" && channel !== "parent_port")) return undefined;
  return { state: "ready", channel };
}


function workerConstructorFrom(module: unknown): WorkerConstructor {
  if (typeof module !== "object" || module === null || !("Worker" in module) || typeof module.Worker !== "function") {
    throw new Error("AUTHORITY_WORKER_MODULE_INVALID");
  }
  const worker = module.Worker;
  return worker as WorkerConstructor;
}

async function awaitWorkerEntry(
  worker: unknown,
  inputPath: string,
  workerEntrySentinel: string,
  channel: WorkerChannel | undefined
): Promise<WorkerEntryReceipt> {
  const candidate = worker as WorkerLike;
  const terminate = candidate.terminate;
  const postMessage = candidate.postMessage;
  if (typeof terminate !== "function") throw new Error("AUTHORITY_WORKER_TERMINATION_UNAVAILABLE");
  if (!channel || typeof postMessage !== "function") throw new Error("AUTHORITY_WORKER_CONFIGURATION_UNAVAILABLE");
  const configuration: WorkerConfiguration = { input: inputPath, sentinel: workerEntrySentinel, channel };
  try {
    return await new Promise<WorkerEntryReceipt>((resolve, reject) => {
      let settled = false;
      let ready = false;
      const timeout = setTimeout(() => rejectOnce(new Error("AUTHORITY_WORKER_ENTRY_TIMEOUT")), WORKER_ENTRY_TIMEOUT_MS);
      function cleanup(): void {
        clearTimeout(timeout);
        clearInterval(retry);
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
      function sendProbe(): void {
        if (settled || ready) return;
        try {
          postMessage.call(candidate, { state: "probe", channel });
        } catch (error) {
          rejectOnce(error instanceof Error ? error : new Error("AUTHORITY_WORKER_PROBE_FAILED"));
        }
      }
      function accept(event: unknown): void {
        const readyReceipt = workerReady(event);
        if (readyReceipt) {
          if (readyReceipt.channel !== channel || ready) return;
          ready = true;
          clearInterval(retry);
          try {
            postMessage.call(candidate, configuration);
          } catch (error) {
            rejectOnce(error instanceof Error ? error : new Error("AUTHORITY_WORKER_CONFIGURATION_FAILED"));
          }
          return;
        }
        const receipt = workerReceipt(event);
        if (!receipt) {
          rejectOnce(new Error("AUTHORITY_WORKER_RECEIPT_INVALID"));
        } else if (!ready) {
          rejectOnce(new Error("AUTHORITY_WORKER_RECEIPT_BEFORE_READY"));
        } else if (receipt.channel !== channel) {
          rejectOnce(new Error("AUTHORITY_WORKER_RECEIPT_ROUTE_INVALID"));
        } else {
          resolveOnce(receipt);
        }
      }
      function rejectWorker(event: unknown): void {
        rejectOnce(event instanceof Error ? event : new Error("AUTHORITY_WORKER_FAILED"));
      }
      const retry = setInterval(sendProbe, WORKER_READY_RETRY_MS);
      if (typeof candidate.addEventListener === "function") {
        candidate.addEventListener("message", accept, { once: false });
        candidate.addEventListener("error", rejectWorker, { once: true });
      } else if (typeof candidate.on === "function") {
        candidate.on("message", accept);
        candidate.on("error", rejectWorker);
      } else {
        rejectOnce(new Error("AUTHORITY_WORKER_INTERFACE_INVALID"));
        return;
      }
      sendProbe();
    });
  } finally {
    await terminate.call(candidate);
  }
}

async function runWorkerLivenessCanary(
  inputPath: string,
  workerEntrySentinel: string
): Promise<WorkerLivenessReceipt> {
  if (state.phase !== "admission") throw new Error("AUTHORITY_WORKER_LIVENESS_PHASE_INVALID");
  const expectedInputBytes = staticNodeFs.statSync(inputPath).size;
  const routes: WorkerLivenessRouteReceipt[] = [];
  for (const { route, channel } of WORKER_LIVENESS_ROUTES) {
    try {
      const worker = route === "global_direct"
        ? new (globalThis as { Worker: WorkerConstructor }).Worker(WORKER_FIXTURE_URL)
        : route === "node_worker_threads"
        ? new StaticNodeWorker(WORKER_FIXTURE_URL)
        : new StaticBareWorker(WORKER_FIXTURE_URL);
      const receipt = await awaitWorkerEntry(worker, inputPath, workerEntrySentinel, channel);
      const sentinelBytes = await Bun.file(workerEntrySentinel).text();
      if (receipt.inputBytes !== expectedInputBytes) throw new Error("AUTHORITY_WORKER_INPUT_READ_INVALID");
      if (receipt.transport !== "message" || receipt.channel !== channel) {
        throw new Error("AUTHORITY_WORKER_RECEIPT_ROUTE_INVALID");
      }
      if (sentinelBytes !== AUTHORITY_WORKER_ENTRY) throw new Error("AUTHORITY_WORKER_SENTINEL_INVALID");
      routes.push({
        route,
        transport: receipt.transport,
        channel: receipt.channel,
        entry: receipt.entry,
        inputBytes: receipt.inputBytes,
        sentinelBytes
      });
    } finally {
      staticNodeFs.rmSync(workerEntrySentinel, { force: true });
    }
  }
  return { phase: "admission", routes };
}

async function attemptForbiddenOperation(
  selected: AuthorityControl,
  inputPath: string,
  replacementPath: string,
  workerEntrySentinel: string,
  writePath: string,
  spawnPath: string
): Promise<void> {
  const workerUrl = WORKER_FIXTURE_URL;
  const workerChannel = workerChannelForControl(selected);
  async function awaitConfiguredWorkerEntry(worker: unknown): Promise<WorkerEntryReceipt> {
    return await awaitWorkerEntry(worker, inputPath, workerEntrySentinel, workerChannel);
  }
  const childScript = `require("node:fs").writeFileSync(${JSON.stringify(spawnPath)}, "spawned")`;
  switch (selected) {
    case "worker_global_direct":
      await awaitConfiguredWorkerEntry(new (globalThis as { Worker: WorkerConstructor }).Worker(workerUrl));
      return;
    case "worker_global_cached":
      await awaitConfiguredWorkerEntry(new (cachedGlobalWorker as WorkerConstructor)(workerUrl));
      return;
    case "worker_node_static_import":
      await awaitConfiguredWorkerEntry(new StaticNodeWorker(workerUrl));
      return;
    case "worker_node_dynamic_import": {
      const workerThreads = await import("node:worker_threads");
      await awaitConfiguredWorkerEntry(new workerThreads.Worker(workerUrl));
      return;
    }
    case "worker_node_get_builtin": {
      const workerThreads = process.getBuiltinModule("node:worker_threads") as { Worker: WorkerConstructor };
      await awaitConfiguredWorkerEntry(new workerThreads.Worker(workerUrl));
      return;
    }
    case "worker_node_create_require": {
      const workerThreads = createRequire(import.meta.url)("node:worker_threads") as { Worker: WorkerConstructor };
      await awaitConfiguredWorkerEntry(new workerThreads.Worker(workerUrl));
      return;
    }
    case "worker_node_cached_module":
      await awaitConfiguredWorkerEntry(new cachedNodeWorker(workerUrl));
      return;
    case "worker_bare_static_import":
      await awaitConfiguredWorkerEntry(new StaticBareWorker(workerUrl));
      return;
    case "worker_bare_dynamic_import": {
      // Intentional dynamic-loader control for the registered bare `worker_threads` spelling.
      const workerThreads = await import("worker_threads");
      await awaitConfiguredWorkerEntry(new workerThreads.Worker(workerUrl));
      return;
    }
    case "worker_bare_get_builtin":
      await awaitConfiguredWorkerEntry(new (workerConstructorFrom(process.getBuiltinModule("worker_threads")))(workerUrl));
      return;
    case "worker_bare_create_require":
      await awaitConfiguredWorkerEntry(new (workerConstructorFrom(createRequire(import.meta.url)("worker_threads")))(workerUrl));
      return;
    case "worker_bare_cached_module":
      await awaitConfiguredWorkerEntry(new cachedBareWorker(workerUrl));
      return;
    case "dynamic_eval": {
      const worker = eval("new Worker(workerUrl)") as unknown;
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_function": {
      const worker = Function("url", "return new Worker(url)")(workerUrl) as unknown;
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_object_double_constructor": {
      const constructor = ({}).constructor.constructor as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_function_constructor": {
      const constructor = (function authorityFunction() {}).constructor as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_arrow_constructor": {
      const constructor = (() => {}).constructor as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_async_constructor": {
      const constructor = (async function authorityAsync() {}).constructor as DynamicConstructor;
      const worker = await constructor("url", "return new Worker(url)")(workerUrl);
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_generator_constructor": {
      const constructor = (function* authorityGenerator() {}).constructor as DynamicConstructor;
      const iterator = constructor("url", "yield new Worker(url)")(workerUrl) as { next: () => IteratorStep };
      const worker = (await iterator.next()).value;
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_async_generator_constructor": {
      const constructor = (async function* authorityAsyncGenerator() {}).constructor as DynamicConstructor;
      const iterator = constructor("url", "yield new Worker(url)")(workerUrl) as {
        next: () => Promise<IteratorStep>;
      };
      const worker = (await iterator.next()).value;
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_computed_constructor": {
      const constructor = (function authorityComputed() {})["constructor"] as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_cached_constructor": {
      const worker = cachedDynamicConstructor("url", "return new Worker(url)")(workerUrl);
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_async_prototype_constructor": {
      const constructor = Object.getPrototypeOf(async function authorityAsyncPrototype() {}).constructor as DynamicConstructor;
      const worker = await constructor("url", "return new Worker(url)")(workerUrl);
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_generator_prototype_constructor": {
      const constructor = Object.getPrototypeOf(function* authorityGeneratorPrototype() {}).constructor as DynamicConstructor;
      const iterator = constructor("url", "yield new Worker(url)")(workerUrl) as { next: () => IteratorStep };
      const worker = (await iterator.next()).value;
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_async_generator_prototype_constructor": {
      const constructor = Object.getPrototypeOf(async function* authorityAsyncGeneratorPrototype() {}).constructor as DynamicConstructor;
      const iterator = constructor("url", "yield new Worker(url)")(workerUrl) as {
        next: () => Promise<IteratorStep>;
      };
      const worker = (await iterator.next()).value;
      await awaitConfiguredWorkerEntry(worker);
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
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_key_constructor": {
      const dynamicKey = ["con", "structor"].join("") as "constructor";
      const dynamicConstructor = (function authorityDynamicKey() {})[dynamicKey];
      const constructor = dynamicConstructor as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitConfiguredWorkerEntry(worker);
      return;
    }
    case "dynamic_destructured_constructor": {
      const { constructor: destructuredConstructor } = function authorityDestructured() {};
      const constructor = destructuredConstructor as DynamicConstructor;
      const worker = constructor("url", "return new Worker(url)")(workerUrl);
      await awaitConfiguredWorkerEntry(worker);
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
          runRawReadInversionCanary(replacement);
        } else if (control === "raw_ffi_inversion_canary") {
          runRawFfiInversionCanary(systemLibraryPath);
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
