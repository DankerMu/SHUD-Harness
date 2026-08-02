import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CapabilityDescriptor,
  CapabilityHooks,
  CloseAttempt,
  ContractAuthorityFault,
  ContractCapabilities,
  DescriptorPrimitiveMediator,
  DescriptorOperation
} from "../lib/capabilities";

type Target = "open_root" | "openat" | "fstat_sync" | "read_sync" | "close_sync";
type RawMode = "returned" | "threw" | "pre";
type PromiseResponse = "ordinary" | "constructor" | "species" | "sink";
type ResponseMode = PromiseResponse | "value" | "throw" | "sentinel" | "thenable" | "proxy";
type NoRawCloseMode = "omission" | "value" | "async" | "thenable" | "proxy" | "sentinel" | "hostile";
type Scenario =
  | "installer"
  | "default"
  | "control"
  | "matrix"
  | "ingress"
  | "third_arg"
  | "close_retry"
  | "direct_close"
  | "direct_no_raw_retry"
  | "hook_forwarding"
  | "hostile_hooks"
  | "gc"
  | "reuse";
type OpenAt = (parentDescriptor: number, path: Buffer, flags: number) => number;
type Fixture = Readonly<{ root: string; payload: Buffer; segments: readonly string[] }>;
const PRODUCTION_ROOT_ENV = "SHUD_DESCRIPTOR_PRODUCTION_ROOT";
const productionRoot = process.env[PRODUCTION_ROOT_ENV];
// Causal mutation rows select a copied production tree only after child startup.

function libraryModuleSpecifier(name: "capabilities" | "checker" | "ingress"): string {
  if (!productionRoot) return `../lib/${name}`;
  return pathToFileURL(join(productionRoot, "lib", `${name}.ts`)).href;
}

type CapabilitiesModule = Readonly<{
  ContractCapabilities: new (hooks?: CapabilityHooks) => ContractCapabilities;
  DIRECTORY_OPEN_FLAGS: number;
  FILE_OPEN_FLAGS: number;
  installDescriptorPrimitiveMediator: (mediator: DescriptorPrimitiveMediator) => void;
}>;

const [scenario, targetArgument, rawModeArgument, responseModeArgument, entryArgument] = process.argv.slice(2) as [
  Scenario | undefined,
  Target | undefined,
  RawMode | undefined,
  string | undefined,
  "direct" | "checker" | undefined
];
const target = targetArgument ?? "open_root";
const rawMode = rawModeArgument ?? "returned";
const responseMode = (responseModeArgument ?? "ordinary") as ResponseMode;
const noRawCloseMode = (responseModeArgument ?? "omission") as NoRawCloseMode;
const rawError = Object.assign(new Error("MEDIATOR_RAW_SENTINEL"), { marker: "raw-private" });
const mediatorThrownSentinel = new Error("MEDIATOR_THROWN_SENTINEL");
const rawCounts: Record<Target, number> = {
  open_root: 0,
  openat: 0,
  fstat_sync: 0,
  read_sync: 0,
  close_sync: 0
};
const rawThrows: Record<Target, number> = {
  open_root: 0,
  openat: 0,
  fstat_sync: 0,
  read_sync: 0,
  close_sync: 0
};
const operations: DescriptorOperation[] = [];
const rawOperations: Target[] = [];
let callbackReturnedUndefined = false;
let thenGetterReads = 0;
let proxyTrapReads = 0;
const mediatorThrownProxy = new Proxy(Object.create(null), {
  get(): never {
    proxyTrapReads += 1;
    throw new Error("MEDIATOR_THROWN_PROXY_GET");
  },
  getPrototypeOf(): never {
    proxyTrapReads += 1;
    throw new Error("MEDIATOR_THROWN_PROXY_PROTOTYPE");
  },
  getOwnPropertyDescriptor(): never {
    proxyTrapReads += 1;
    throw new Error("MEDIATOR_THROWN_PROXY_DESCRIPTOR");
  },
  ownKeys(): never {
    proxyTrapReads += 1;
    throw new Error("MEDIATOR_THROWN_PROXY_OWN_KEYS");
  }
});
let nativeHostilityReads = 0;
function errorMessage(action: () => unknown): Readonly<{ message: string; exactRaw: boolean }> {
  try {
    action();
    return Object.freeze({ message: "NO_ERROR", exactRaw: false });
  } catch (error) {
    if (error === mediatorThrownProxy) {
      return Object.freeze({ message: "MEDIATOR_THROWN_PROXY", exactRaw: false });
    }
    return Object.freeze({
      message: error instanceof Error ? error.message : String(error),
      exactRaw: error === rawError
    });
  }
}

function installRawProbe(selectedTarget: Target, shouldThrow: boolean, throwOnlyOnce = false): void {
  const originalOpenSync = originalFs.openSync;
  const originalFstatSync = originalFs.fstatSync;
  const originalReadSync = originalFs.readSync;
  const originalCloseSync = originalFs.closeSync;
  let thrown = false;
  const failSelected = (operation: Target, close?: () => void): void => {
    rawOperations.push(operation);
    if (operation !== selectedTarget) return;
    rawCounts[operation] += 1;
    if (!shouldThrow || (throwOnlyOnce && thrown)) return;
    thrown = true;
    rawThrows[operation] += 1;
    close?.();
    throw rawError;
  };
  mock.module("node:fs", () => ({
    ...originalFs,
    openSync(...args: Parameters<typeof originalOpenSync>) {
      failSelected("open_root");
      return originalOpenSync(...args);
    },
    fstatSync(...args: Parameters<typeof originalFstatSync>) {
      failSelected("fstat_sync");
      return originalFstatSync(...args);
    },
    readSync(...args: Parameters<typeof originalReadSync>) {
      failSelected("read_sync");
      return originalReadSync(...args);
    },
    closeSync(...args: Parameters<typeof originalCloseSync>) {
      failSelected("close_sync", () => { originalCloseSync(...args); });
      return originalCloseSync(...args);
    }
  }));

  const originalDlopen = originalFfi.dlopen;
  mock.module("bun:ffi", () => ({
    ...originalFfi,
    dlopen(...args: Parameters<typeof originalDlopen>) {
      const library = originalDlopen(...args);
      const nativeOpenAt = (library.symbols as unknown as Readonly<{ openat: OpenAt }>).openat;
      return {
        ...library,
        symbols: {
          ...library.symbols,
          openat(...openAtArgs: Parameters<OpenAt>): number {
            failSelected("openat");
            return nativeOpenAt(...openAtArgs);
          }
        }
      } as typeof library;
    }
  }));
}

async function loadCapabilities(): Promise<CapabilitiesModule> {
  // The child must install Bun's raw syscall mocks before this module binds its imports.
  return await import(libraryModuleSpecifier("capabilities")) as CapabilitiesModule;
}

async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shud-mediator-runtime-")));
  const payload = Buffer.from("descriptor-primitive-mediator");
  await writeFile(join(root, "payload"), payload);
  return Object.freeze({ root, payload, segments: root.split(sep).filter(Boolean) });
}

function closeQuietly(
  capabilities: ContractCapabilities,
  descriptor: CapabilityDescriptor,
  owner: "unretained" | "retained"
): void {
  try {
    capabilities.close(descriptor, owner);
  } catch {
    // A raw throw can make the capability terminal while the test still cleans its real descriptor.
  }
}

function openFixtureFile(module: CapabilitiesModule, fixture: Fixture): Readonly<{
  capabilities: ContractCapabilities;
  descriptors: readonly CapabilityDescriptor[];
  file: CapabilityDescriptor;
}> {
  const capabilities = new module.ContractCapabilities();
  let directory = capabilities.openRoot("/", "admission");
  const descriptors: CapabilityDescriptor[] = [directory];
  for (const segment of fixture.segments) {
    if (!capabilities.stat(directory).isDirectory()) throw new Error("fixture directory is invalid");
    capabilities.markRetained(directory, "directory");
    directory = capabilities.openRelative(directory, segment, module.DIRECTORY_OPEN_FLAGS, "admission");
    descriptors.push(directory);
  }
  if (!capabilities.stat(directory).isDirectory()) throw new Error("fixture root is invalid");
  capabilities.markRetained(directory, "directory");
  const file = capabilities.openRelative(directory, "payload", module.FILE_OPEN_FLAGS, "admission");
  descriptors.push(file);
  if (!capabilities.stat(file).isFile()) throw new Error("fixture payload is invalid");
  capabilities.markRetained(file, "file");
  capabilities.sealAdmission();
  return Object.freeze({ capabilities, descriptors: Object.freeze(descriptors), file });
}

function closeRetained(capabilities: ContractCapabilities, descriptors: readonly CapabilityDescriptor[]): void {
  for (const descriptor of [...descriptors].reverse()) closeQuietly(capabilities, descriptor, "retained");
}

function targetOutcome(
  module: CapabilitiesModule,
  fixture: Fixture,
  selectedTarget: Target
): Readonly<{ message: string; exactRaw: boolean }> {
  if (selectedTarget === "open_root") {
    const capabilities = new module.ContractCapabilities();
    let descriptor: CapabilityDescriptor | undefined;
    const outcome = errorMessage(() => { descriptor = capabilities.openRoot("/", "admission"); });
    if (descriptor) closeQuietly(capabilities, descriptor, "unretained");
    return outcome;
  }
  if (selectedTarget === "openat") {
    const capabilities = new module.ContractCapabilities();
    const root = capabilities.openRoot("/", "admission");
    capabilities.stat(root);
    capabilities.markRetained(root, "directory");
    let child: CapabilityDescriptor | undefined;
    const outcome = errorMessage(() => {
      child = capabilities.openRelative(
        root,
        process.platform === "darwin" ? "private" : "tmp",
        module.DIRECTORY_OPEN_FLAGS,
        "admission"
      );
    });
    if (child) closeQuietly(capabilities, child, "unretained");
    closeQuietly(capabilities, root, "retained");
    return outcome;
  }
  if (selectedTarget === "fstat_sync") {
    const capabilities = new module.ContractCapabilities();
    const descriptor = capabilities.openRoot("/", "admission");
    const outcome = errorMessage(() => { capabilities.stat(descriptor); });
    closeQuietly(capabilities, descriptor, "unretained");
    return outcome;
  }
  if (selectedTarget === "read_sync") {
    const retained = openFixtureFile(module, fixture);
    const outcome = errorMessage(() => {
      retained.capabilities.readRetained(
        retained.file,
        Buffer.alloc(fixture.payload.byteLength),
        0,
        fixture.payload.byteLength,
        0,
        "post_admission"
      );
    });
    closeRetained(retained.capabilities, retained.descriptors);
    return outcome;
  }
  const capabilities = new module.ContractCapabilities();
  const descriptor = capabilities.openRoot("/", "admission");
  return errorMessage(() => { capabilities.close(descriptor, "unretained"); });
}

function prehandledRejectedPromise(message: string): Promise<never> {
  const promise = Promise.reject(new Error(message));
  Promise.prototype.then.call(promise, undefined, () => undefined);
  return promise;
}

function nativePromise(kind: PromiseResponse): unknown {
  if (kind === "ordinary") return prehandledRejectedPromise("MEDIATOR_ORDINARY_REJECTION");
  if (kind === "constructor") {
    const promise = prehandledRejectedPromise("MEDIATOR_CONSTRUCTOR_REJECTION");
    Object.defineProperty(promise, "constructor", {
      configurable: true,
      get(): never {
        nativeHostilityReads += 1;
        throw new Error("MEDIATOR_HOSTILE_CONSTRUCTOR");
      }
    });
    return promise;
  }
  if (kind === "species") {
    let hostile = false;
    class HostileSpeciesPromise<T> extends Promise<T> {
      static get [Symbol.species](): PromiseConstructor {
        if (hostile) {
          nativeHostilityReads += 1;
          throw new Error("MEDIATOR_HOSTILE_SPECIES");
        }
        return Promise;
      }
    }
    const promise = new HostileSpeciesPromise<never>((_resolve, reject) => {
      reject(new Error("MEDIATOR_SPECIES_REJECTION"));
    });
    Promise.prototype.then.call(promise, undefined, () => undefined);
    hostile = true;
    return promise;
  }
  const promise = prehandledRejectedPromise("MEDIATOR_SINK_REJECTION");
  Object.defineProperty(promise, "constructor", {
    configurable: true,
    value: Object.defineProperty({}, Symbol.species, {
      get(): never {
        nativeHostilityReads += 1;
        throw new Error("MEDIATOR_HOSTILE_SINK");
      }
    })
  });
  return promise;
}

function mediatorValue(kind: ResponseMode): unknown {
  if (kind === "value") return 1;
  if (kind === "thenable") {
    return Object.defineProperty({}, "then", {
      get(): () => void {
        thenGetterReads += 1;
        return () => undefined;
      }
    });
  }
  if (kind === "proxy") {
    return new Proxy({}, {
      get(): unknown {
        proxyTrapReads += 1;
        return () => undefined;
      },
      getOwnPropertyDescriptor(): undefined {
        proxyTrapReads += 1;
        return undefined;
      }
    });
  }
  if (kind === "throw") return undefined;
  if (kind === "sentinel") return mediatorThrownSentinel;
  return nativePromise(kind);
}

function installMediator(
  module: CapabilitiesModule,
  selectedTarget: Target,
  selectedRawMode: RawMode,
  selectedResponseMode: ResponseMode
): void {
  module.installDescriptorPrimitiveMediator((operation, invoke): undefined => {
    operations.push(operation);
    if (operation !== selectedTarget) {
      invoke();
      return undefined;
    }
    if (selectedRawMode === "pre") {
      if (selectedResponseMode === "throw") throw mediatorThrownProxy;
      if (selectedResponseMode === "sentinel") throw mediatorThrownSentinel;
      return mediatorValue(selectedResponseMode) as undefined;
    }
    const invocationResult = invoke();
    callbackReturnedUndefined = invocationResult === undefined;
    if (selectedResponseMode === "throw") throw mediatorThrownProxy;
    return mediatorValue(selectedResponseMode) as undefined;
  });
}

async function eventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

async function descriptorCount(): Promise<number | null> {
  try {
    return (await readdir("/dev/fd")).length;
  } catch {
    return null;
  }
}

async function runMatrix(): Promise<unknown> {
  const fixture = await createFixture();
  const fdBefore = await descriptorCount();
  let rejectionListenersBeforeOperation = rejectionListenerSnapshot();
  let outcome: Readonly<{ message: string; exactRaw: boolean }>;
  try {
    installRawProbe(target, rawMode === "threw");
    const module = await loadCapabilities();
    installMediator(module, target, rawMode, responseMode);
    rejectionListenersBeforeOperation = rejectionListenerSnapshot();
    outcome = targetOutcome(module, fixture, target);
    await eventLoopTurn();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
  const fdAfter = await descriptorCount();
  return {
    target,
    rawMode,
    responseMode,
    outcome: outcome!,
    rawCalls: rawCounts[target],
    operations,
    rawOperations,
    callbackReturnedUndefined,
    thenGetterReads,
    proxyTrapReads,
    nativeHostilityReads,
    rejectionListenersBeforeOperation,
    rejectionListenersAfterOperation: rejectionListenerSnapshot(),
    fdBefore,
    fdAfter
  };
}

async function runIngress(): Promise<unknown> {
  installRawProbe(target, rawMode === "threw", target === "close_sync");
  const module = await loadCapabilities();
  installMediator(module, target, rawMode, responseMode);
  const input = join(import.meta.dir, "../fixtures/valid/source-input-record-paired-surrogate.json");
  let outcome: string;
  let stdout = "";
  let stderr = "";
  if (entryArgument === "checker") {
    // This import must follow the mock-bound capability module so ingress shares that instance.
    const checker = await import(libraryModuleSpecifier("checker"));
    const exit = await checker.runCheck(
      ["--input", input, "--kind", "source_input_record"],
      {
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; }
      }
    );
    outcome = `CHECK:${exit}`;
  } else {
    // This import must also follow the mock-bound capability module for the same reason.
    const ingress = await import(libraryModuleSpecifier("ingress"));
    try {
      const bytes = await ingress.readBoundedFile(input, 8_192);
      outcome = `BYTES:${bytes.byteLength}`;
    } catch (error) {
      outcome = error === mediatorThrownProxy
        ? "MEDIATOR_THROWN_PROXY"
        : error instanceof Error ? error.message : String(error);
    }
  }
  let laterOutcome: string | null = null;
  if (target === "close_sync" && rawMode === "threw") {
    const ingress = await import(libraryModuleSpecifier("ingress"));
    try {
      const bytes = await ingress.readBoundedFile(input, 8_192);
      laterOutcome = `BYTES:${bytes.byteLength}`;
    } catch (error) {
      laterOutcome = error instanceof Error ? error.message : String(error);
    }
  }
  await eventLoopTurn();
  return {
    entry: entryArgument ?? "direct",
    rawMode,
    responseMode,
    outcome,
    stdout,
    stderr,
    rawCalls: rawCounts[target],
    rawThrows: rawThrows[target],
    laterOutcome,
    thenGetterReads,
    proxyTrapReads,
    nativeHostilityReads
  };
}

function rejectionListenerSnapshot(): Readonly<{ unhandledRejection: number; rejectionHandled: number }> {
  return Object.freeze({
    unhandledRejection: process.listenerCount("unhandledRejection"),
    rejectionHandled: process.listenerCount("rejectionHandled")
  });
}

async function runDefault(): Promise<unknown> {
  const rejectionListenersBefore = rejectionListenerSnapshot();
  const module = await loadCapabilities();
  const rejectionListenersAfter = rejectionListenerSnapshot();
  const capabilities = new module.ContractCapabilities();
  const descriptor = capabilities.openRoot("/", "admission");
  const directory = capabilities.stat(descriptor).isDirectory();
  capabilities.close(descriptor, "unretained");
  return {
    directory,
    moduleExports: Object.keys(module).sort(),
    rejectionListenersBefore,
    rejectionListenersAfter
  };
}

async function runInstaller(): Promise<unknown> {
  const rejectionListenersBefore = rejectionListenerSnapshot();
  const module = await loadCapabilities();
  const rejectionListenersAfterImport = rejectionListenerSnapshot();
  const installer = module.installDescriptorPrimitiveMediator;
  const invalid = errorMessage(() => { installer({} as DescriptorPrimitiveMediator); });
  const validMediator: DescriptorPrimitiveMediator = (_operation, _invoke) => undefined;
  const first = errorMessage(() => { installer(validMediator); });
  const repeated = errorMessage(() => { installer(validMediator); });
  const constructible = (() => {
    try {
      Reflect.construct(installer, [validMediator]);
      return true;
    } catch {
      return false;
    }
  })();
  return {
    invalid: invalid.message,
    first: first.message,
    repeated: repeated.message,
    frozen: Object.isFrozen(installer),
    constructible,
    ownNames: Object.getOwnPropertyNames(installer).sort(),
    ownSymbols: Object.getOwnPropertySymbols(installer),
    prototypeIsFunction: Object.getPrototypeOf(installer) === Function.prototype,
    hiddenProperties: [
      "descriptorPrimitiveMediator",
      "raw",
      "reset",
      "uninstall",
      "registry"
    ].filter((name) => name in installer),
    rejectionListenersBefore,
    rejectionListenersAfterImport,
    rejectionListenersAfterInstall: rejectionListenerSnapshot()
  };
}

async function runControl(): Promise<unknown> {
  installRawProbe("open_root", false);
  const module = await loadCapabilities();
  let retainedInvoke: (() => unknown) | undefined;
  let repeated = "NO_ERROR";
  let reentry = "NO_ERROR";
  const capabilities = new module.ContractCapabilities();
  module.installDescriptorPrimitiveMediator((operation, invoke): undefined => {
    if (operation !== "open_root") {
      invoke();
      return undefined;
    }
    if (responseMode === "ordinary") return undefined;
    if (responseMode === "constructor") {
      retainedInvoke = invoke;
      return undefined;
    }
    if (responseMode === "species") return nativePromise("ordinary") as undefined;
    if (responseMode === "thenable" || responseMode === "proxy") return mediatorValue(responseMode) as undefined;
    reentry = errorMessage(() => { capabilities.sealAdmission(); }).message;
    const result = invoke();
    callbackReturnedUndefined = result === undefined;
    repeated = errorMessage(() => invoke()).message;
    if (responseMode === "throw") throw mediatorThrownProxy;
    return undefined;
  });
  let descriptor: CapabilityDescriptor | undefined;
  const outcome = errorMessage(() => { descriptor = capabilities.openRoot("/", "admission"); });
  if (descriptor) closeQuietly(capabilities, descriptor, "unretained");
  const expired = retainedInvoke ? errorMessage(retainedInvoke).message : "NO_ERROR";
  await eventLoopTurn();
  return {
    control: responseMode,
    outcome: outcome.message,
    rawCalls: rawCounts.open_root,
    repeated,
    expired,
    reentry,
    callbackReturnedUndefined,
    thenGetterReads,
    proxyTrapReads,
    nativeHostilityReads
  };
}

async function runThirdArg(): Promise<unknown> {
  installRawProbe("close_sync", false);
  const module = await loadCapabilities();
  const capabilities = new module.ContractCapabilities();
  const descriptor = capabilities.openRoot("/", "admission");
  let thirdArgumentCalls = 0;
  const outcome = errorMessage(() => {
    (capabilities.close as unknown as (
      descriptor: CapabilityDescriptor,
      owner: "unretained",
      ignored: () => boolean
    ) => void)(descriptor, "unretained", () => {
      thirdArgumentCalls += 1;
      throw new Error("THIRD_RUNTIME_CLOSE_ARGUMENT_EXECUTED");
    });
  });
  return { rawCalls: rawCounts.close_sync, thirdArgumentCalls, outcome: outcome.message };
}

async function runCloseRetry(): Promise<unknown> {
  installRawProbe("close_sync", false);
  const module = await loadCapabilities();
  let skippedCloseCalls = 0;
  module.installDescriptorPrimitiveMediator((operation, invoke): undefined => {
    if (operation === "close_sync" && skippedCloseCalls === 0) {
      skippedCloseCalls += 1;
      return undefined;
    }
    invoke();
    return undefined;
  });
  let hookCalls = 0;
  let closeFaultCalls = 0;
  let rawCallsWhenFirstCloseFault: number | null = null;
  const hooks = Object.freeze({
    onCloseAttempt: () => {
      hookCalls += 1;
      if (responseMode === "ordinary" && hookCalls === 1) {
        throw new Error("FIRST_CLOSE_HOOK_FAILURE");
      }
    },
    closeFault: () => {
      closeFaultCalls += 1;
      rawCallsWhenFirstCloseFault ??= rawCounts.close_sync;
      if (closeFaultCalls !== 1) return false;
      if (responseMode === "throw") throw new Error("FIRST_CLOSE_FAULT_FAILURE");
      return responseMode === "value" || responseMode === "sentinel";
    }
  });
  const input = join(import.meta.dir, "../fixtures/valid/source-input-record-paired-surrogate.json");
  const maximum = responseMode === "sentinel" ? 0 : 8_192;
  let outcome: string;
  let stdout = "";
  let stderr = "";
  if (entryArgument === "checker") {
    const checkerFixtureRoot = responseMode === "sentinel"
      ? await mkdtemp(join(tmpdir(), "shud-close-retry-"))
      : undefined;
    try {
      let checkerInput = input;
      if (checkerFixtureRoot) {
        checkerInput = join(checkerFixtureRoot, "source-input-record-over-limit.json");
        // Trailing JSON whitespace keeps the fixture valid while exceeding SOURCE_PROFILE.bytes.
        await writeFile(checkerInput, Buffer.concat([
          await readFile(input),
          Buffer.alloc(65_536, 0x20)
        ]));
      }
      const checker = await import(libraryModuleSpecifier("checker"));
      const exit = await checker.runCheckForTest(
        ["--input", checkerInput, "--kind", "source_input_record"],
        { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
        hooks
      );
      outcome = `CHECK:${exit}`;
    } finally {
      if (checkerFixtureRoot) await rm(checkerFixtureRoot, { recursive: true, force: true });
    }
  } else {
    const ingress = await import(libraryModuleSpecifier("ingress"));
    try {
      await ingress.readBoundedFile(input, maximum, hooks);
      outcome = "NO_ERROR";
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    entry: entryArgument ?? "direct",
    outcome,
    stdout,
    stderr,
    skippedCloseCalls,
    hookCalls,
    closeFaultCalls,
    rawCallsWhenFirstCloseFault,
    rawCalls: rawCounts.close_sync
  };
}

function noRawCloseResponse(mode: NoRawCloseMode): undefined {
  if (mode === "omission") return undefined;
  if (mode === "async") return Promise.resolve() as unknown as undefined;
  if (mode === "value" || mode === "thenable" || mode === "proxy") {
    return mediatorValue(mode) as undefined;
  }
  if (mode === "sentinel") throw mediatorThrownSentinel;
  throw mediatorThrownProxy;
}

async function runDirectNoRawRetry(): Promise<unknown> {
  installRawProbe("close_sync", false);
  const module = await loadCapabilities();
  let mediatedCloseCalls = 0;
  module.installDescriptorPrimitiveMediator((operation, invoke): undefined => {
    if (operation !== "close_sync") {
      invoke();
      return undefined;
    }
    mediatedCloseCalls += 1;
    if (mediatedCloseCalls === 1) return noRawCloseResponse(noRawCloseMode);
    invoke();
    return undefined;
  });
  const capabilities = new module.ContractCapabilities();
  const descriptor = capabilities.openRoot("/", "admission");
  let firstCaught: unknown;
  const firstOutcome = errorMessage(() => {
    try {
      capabilities.close(descriptor, "unretained");
    } catch (error) {
      firstCaught = error;
      throw error;
    }
  });
  const secondOutcome = errorMessage(() => { capabilities.close(descriptor, "unretained"); });
  return {
    mode: noRawCloseMode,
    firstOutcome: firstOutcome.message,
    firstSentinel: firstCaught === mediatorThrownSentinel,
    firstHostile: firstCaught === mediatorThrownProxy,
    secondOutcome: secondOutcome.message,
    mediatedCloseCalls,
    rawCalls: rawCounts.close_sync
  };
}

async function runDirectClose(): Promise<unknown> {
  installRawProbe("close_sync", false);
  const module = await loadCapabilities();
  module.installDescriptorPrimitiveMediator((operation, invoke): undefined => {
    if (operation !== "close_sync") {
      invoke();
      return undefined;
    }
    if (responseMode === "ordinary") return undefined;
    if (responseMode === "value") return 1 as undefined;
    if (responseMode === "throw") throw mediatorThrownProxy;
    throw mediatorThrownSentinel;
  });
  const capabilities = new module.ContractCapabilities();
  const descriptor = capabilities.openRoot("/", "admission");
  let caught: unknown;
  const outcome = errorMessage(() => {
    try {
      capabilities.close(descriptor, "unretained");
    } catch (error) {
      caught = error;
      throw error;
    }
  });
  return {
    responseMode,
    outcome,
    rawCalls: rawCounts.close_sync,
    proxyTrapReads,
    exactPreInvocationOutcome: responseMode === "throw"
      ? caught === mediatorThrownProxy
      : responseMode === "sentinel"
      ? caught === mediatorThrownSentinel
      : null
  };
}

async function runHookForwarding(): Promise<unknown> {
  const input = join(import.meta.dir, "../fixtures/valid/source-input-record-paired-surrogate.json");
  const ingress = await import(libraryModuleSpecifier("ingress"));
  let expectedReceiver: unknown;
  class PrototypeHooks {
    authorityFault: ContractAuthorityFault | undefined;
    closeFaultGetterReads = 0;
    closeFaultGetterReadsAtAdmission = -1;
    closeFaultCalls = 0;
    closeFaultReceiverMatches = false;
    closeAttemptCalls = 0;
    closeAttemptReceiverMatches = false;
    authorityCalls = 0;
    authorityReceiverMatches = false;

    get closeFault(): (attempt: CloseAttempt) => boolean {
      this.closeFaultGetterReads += 1;
      return (_attempt) => {
        this.closeFaultCalls += 1;
        return true;
      };
    }

    onCloseAttempt(_attempt: CloseAttempt): void {
      this.closeAttemptCalls += 1;
      this.closeAttemptReceiverMatches ||= this === expectedReceiver;
    }

    onAuthorityViolation(_fault: ContractAuthorityFault): void {
      this.authorityCalls += 1;
      this.authorityReceiverMatches ||= this === expectedReceiver;
    }

    afterAdmission(): void {
      this.closeFaultGetterReadsAtAdmission = this.closeFaultGetterReads;
    }
  }
  const cleanupHooks = new PrototypeHooks();
  Object.defineProperty(cleanupHooks, "closeFault", {
    enumerable: true,
    get(): (attempt: CloseAttempt) => boolean {
      cleanupHooks.closeFaultGetterReads += 1;
      return function (this: PrototypeHooks, _attempt: CloseAttempt): boolean {
        this.closeFaultCalls += 1;
        this.closeFaultReceiverMatches ||= this === expectedReceiver;
        return true;
      };
    }
  });
  expectedReceiver = cleanupHooks;
  const cleanupOutcome = await (async (): Promise<string> => {
    try {
      await ingress.readBoundedFile(input, 8_192, cleanupHooks);
      return "NO_ERROR";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();

  const authorityHooks = new PrototypeHooks();
  authorityHooks.authorityFault = "file_write";
  expectedReceiver = authorityHooks;
  const authorityOutcome = await (async (): Promise<string> => {
    try {
      await ingress.readBoundedFile(input, 8_192, authorityHooks);
      return "NO_ERROR";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  return {
    cleanupOutcome,
    closeFaultGetterReadsAtAdmission: cleanupHooks.closeFaultGetterReadsAtAdmission,
    closeFaultGetterReads: cleanupHooks.closeFaultGetterReads,
    closeFaultCalls: cleanupHooks.closeFaultCalls,
    closeFaultReceiverMatches: cleanupHooks.closeFaultReceiverMatches,
    closeAttemptCalls: cleanupHooks.closeAttemptCalls,
    closeAttemptReceiverMatches: cleanupHooks.closeAttemptReceiverMatches,
    authorityOutcome,
    authorityCalls: authorityHooks.authorityCalls,
    authorityReceiverMatches: authorityHooks.authorityReceiverMatches
  };
}

async function runHostileHooks(): Promise<unknown> {
  const input = join(import.meta.dir, "../fixtures/valid/source-input-record-paired-surrogate.json");
  let ownKeysReads = 0;
  let getReads = 0;
  let getPrototypeReads = 0;
  const hostileHooks = new Proxy(Object.create(null), {
    ownKeys(): never {
      ownKeysReads += 1;
      throw new Error("HOSTILE_HOOK_OWN_KEYS");
    },
    get(_target, property): unknown {
      getReads += 1;
      if (property === "onCloseAttempt") throw new Error("HOSTILE_HOOK_GET");
      return undefined;
    },
    getPrototypeOf(): never {
      getPrototypeReads += 1;
      throw new Error("HOSTILE_HOOK_PROTOTYPE");
    }
  });
  const ingress = await import(libraryModuleSpecifier("ingress"));
  const directOutcome = await (async (): Promise<string> => {
    try {
      await ingress.readBoundedFile(input, 8_192, hostileHooks);
      return "NO_ERROR";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  const checker = await import(libraryModuleSpecifier("checker"));
  let stdout = "";
  let stderr = "";
  const checkerExit = await checker.runCheckForTest(
    ["--input", input, "--kind", "source_input_record"],
    { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    hostileHooks
  );
  return {
    directOutcome,
    checkerExit,
    stdout,
    stderr,
    ownKeysReads,
    getReads,
    getPrototypeReads
  };
}

function issueRetainedRead(
  capabilities: ContractCapabilities,
  descriptor: CapabilityDescriptor,
  bytes: number
): WeakRef<Buffer> {
  const buffer = Buffer.alloc(bytes);
  const reference = new WeakRef(buffer);
  capabilities.readRetained(descriptor, buffer, 0, bytes, 0, "post_admission");
  return reference;
}

async function runGc(): Promise<unknown> {
  const fixture = await createFixture();
  try {
    const module = await loadCapabilities();
    let retainedInvoke: (() => unknown) | undefined;
    module.installDescriptorPrimitiveMediator((operation, invoke): undefined => {
      if (operation === "read_sync") retainedInvoke = invoke;
      invoke();
      return undefined;
    });
    const retained = openFixtureFile(module, fixture);
    const reference = issueRetainedRead(retained.capabilities, retained.file, fixture.payload.byteLength);
    const expired = retainedInvoke ? errorMessage(retainedInvoke).message : "NO_RETAINED_INVOKE";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      Bun.gc(true);
      await eventLoopTurn();
    }
    closeRetained(retained.capabilities, retained.descriptors);
    return { expired, collected: reference.deref() === undefined };
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function runReuse(): Promise<unknown> {
  installRawProbe("close_sync", true, true);
  const module = await loadCapabilities();
  const denials: string[] = [];
  const capabilities = new module.ContractCapabilities({
    onDescriptorAuthorityDenial: (denial) => { denials.push(denial.reason); }
  });
  const oldDescriptor = capabilities.openRoot("/", "admission");
  const closeOutcome = errorMessage(() => { capabilities.close(oldDescriptor, "unretained"); });
  const currentDescriptor = capabilities.openRoot("/", "admission");
  const currentUsable = capabilities.stat(currentDescriptor).isDirectory();
  const oldOutcome = errorMessage(() => { capabilities.stat(oldDescriptor); });
  const rawCallsBeforeCurrentCleanup = rawCounts.close_sync;
  closeQuietly(capabilities, currentDescriptor, "unretained");
  return {
    closeOutcome: closeOutcome.message,
    oldOutcome: oldOutcome.message,
    currentUsable,
    denials,
    rawCalls: rawCallsBeforeCurrentCleanup
  };
}

const receipt = scenario === "installer"
  ? await runInstaller()
  : scenario === "default"
  ? await runDefault()
  : scenario === "control"
  ? await runControl()
  : scenario === "ingress"
  ? await runIngress()
  : scenario === "third_arg"
  ? await runThirdArg()
  : scenario === "close_retry"
  ? await runCloseRetry()
  : scenario === "direct_close"
  ? await runDirectClose()
  : scenario === "direct_no_raw_retry"
  ? await runDirectNoRawRetry()
  : scenario === "hook_forwarding"
  ? await runHookForwarding()
  : scenario === "hostile_hooks"
  ? await runHostileHooks()
  : scenario === "gc"
  ? await runGc()
  : scenario === "reuse"
  ? await runReuse()
  : await runMatrix();
process.stdout.write(`${JSON.stringify(receipt)}\n`);
