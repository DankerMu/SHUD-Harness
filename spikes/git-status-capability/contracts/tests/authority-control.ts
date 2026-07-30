import * as staticFfi from "bun:ffi";
import * as staticNodeFs from "node:fs";
import { createRequire } from "node:module";
import { Worker as StaticNodeWorker } from "node:worker_threads";
import type { SourceInputKind } from "../lib/schemas";
import {
  AUTHORITY_PROOF_ROWS,
  AUTHORITY_WORKER_ENTRY
} from "./authority-vocabulary";
import type { AuthorityControl } from "./authority-vocabulary";

type GuardState = { phase: "admission" | "post_admission"; events: string[] };
type WorkerConstructor = new (source: URL) => unknown;
type DynamicConstructor = (...parameters: string[]) => (...arguments_: unknown[]) => unknown;
type IteratorStep = Readonly<{ value: unknown }>;
type WorkerLike = {
  addEventListener?: (...arguments_: unknown[]) => unknown;
  on?: (...arguments_: unknown[]) => unknown;
  terminate?: (...arguments_: unknown[]) => unknown;
};
type ControlInvocation = AuthorityControl | "direct_success";

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
if (selectedControl !== "direct_success" && !AUTHORITY_PROOF_ROWS.some((row) => row.control === selectedControl)) {
  throw new Error("AUTHORITY_CONTROL_UNKNOWN");
}
const control = selectedControl as ControlInvocation;

function workerFixtureUrl(inputPath: string, sentinelPath: string): URL {
  const url = new URL("./authority-worker.ts", import.meta.url);
  url.searchParams.set("input", inputPath);
  url.searchParams.set("sentinel", sentinelPath);
  return url;
}

function workerReceipt(value: unknown): string | undefined {
  const message = typeof value === "object" && value !== null && "data" in value
    ? (value as { data: unknown }).data
    : value;
  return typeof message === "string" ? message : undefined;
}

async function awaitWorkerEntry(worker: unknown): Promise<void> {
  const candidate = worker as WorkerLike;
  await new Promise<void>((resolve, reject) => {
    const accept = (event: unknown) => {
      if (workerReceipt(event) === AUTHORITY_WORKER_ENTRY) resolve();
      else reject(new Error("AUTHORITY_WORKER_RECEIPT_INVALID"));
    };
    const rejectWorker = (event: unknown) => {
      reject(event instanceof Error ? event : new Error("AUTHORITY_WORKER_FAILED"));
    };
    if (typeof candidate.addEventListener === "function") {
      candidate.addEventListener("message", accept, { once: true });
      candidate.addEventListener("error", rejectWorker, { once: true });
    } else if (typeof candidate.on === "function") {
      candidate.on("message", accept);
      candidate.on("error", rejectWorker);
    } else {
      reject(new Error("AUTHORITY_WORKER_INTERFACE_INVALID"));
    }
  });
  if (typeof candidate.terminate === "function") await candidate.terminate();
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
const { runCheckForTest } = await import("../lib/checker");
const exit = await runCheckForTest(
  ["--input", input, "--kind", kind as SourceInputKind],
  { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
  {
    afterAdmission: async () => {
      state.phase = "post_admission";
      if (control === "direct_success") return;
      try {
        await attemptForbiddenOperation(control, input, replacement, workerSentinel, writeSentinel, spawnSentinel);
      } catch (error) {
        state.events.push(`control_error:${error instanceof Error ? error.message : "unknown"}`);
        throw error;
      }
    }
  }
);

process.stdout.write(`${JSON.stringify({ exit, stdout, stderr, events: state.events })}\n`);
