import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type {
  CapabilityDescriptor,
  CapabilityHooks,
  ContractCapabilities,
  DescriptorPrimitiveMediator,
  DescriptorOperation
} from "../lib/capabilities";

type Target = "open_root" | "openat" | "fstat_sync" | "read_sync" | "close_sync";
type RawMode = "returned" | "threw" | "pre";
type PromiseResponse = "ordinary" | "constructor" | "species" | "sink";
type ResponseMode = PromiseResponse | "value" | "throw" | "thenable" | "proxy";
type Scenario = "installer" | "default" | "control" | "matrix" | "ingress";
type OpenAt = (parentDescriptor: number, path: Buffer, flags: number) => number;
type Fixture = Readonly<{ root: string; payload: Buffer; segments: readonly string[] }>;
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
  ResponseMode | undefined,
  "direct" | "checker" | undefined
];
const target = targetArgument ?? "open_root";
const rawMode = rawModeArgument ?? "returned";
const responseMode = responseModeArgument ?? "ordinary";
const rawError = Object.assign(new Error("MEDIATOR_RAW_SENTINEL"), { marker: "raw-private" });
const rawCounts: Record<Target, number> = {
  open_root: 0,
  openat: 0,
  fstat_sync: 0,
  read_sync: 0,
  close_sync: 0
};
const operations: DescriptorOperation[] = [];
let callbackReturnedUndefined = false;
let thenGetterReads = 0;
let proxyTrapReads = 0;
let nativeHostilityReads = 0;

function errorMessage(action: () => unknown): Readonly<{ message: string; exactRaw: boolean }> {
  try {
    action();
    return Object.freeze({ message: "NO_ERROR", exactRaw: false });
  } catch (error) {
    return Object.freeze({
      message: error instanceof Error ? error.message : String(error),
      exactRaw: error === rawError
    });
  }
}

function installRawProbe(selectedTarget: Target, shouldThrow: boolean): void {
  const originalOpenSync = originalFs.openSync;
  const originalFstatSync = originalFs.fstatSync;
  const originalReadSync = originalFs.readSync;
  const originalCloseSync = originalFs.closeSync;
  const failSelected = (operation: Target, close?: () => void): void => {
    if (operation !== selectedTarget) return;
    rawCounts[operation] += 1;
    if (!shouldThrow) return;
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
  return await import("../lib/capabilities") as CapabilitiesModule;
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
    if (selectedRawMode === "pre") return mediatorValue(selectedResponseMode) as undefined;
    const invocationResult = invoke();
    callbackReturnedUndefined = invocationResult === undefined;
    if (selectedResponseMode === "throw") throw new Error("MEDIATOR_POST_THROW");
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
  let outcome: Readonly<{ message: string; exactRaw: boolean }>;
  try {
    installRawProbe(target, rawMode === "threw");
    const module = await loadCapabilities();
    installMediator(module, target, rawMode, responseMode);
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
    callbackReturnedUndefined,
    thenGetterReads,
    proxyTrapReads,
    nativeHostilityReads,
    fdBefore,
    fdAfter
  };
}

async function runIngress(): Promise<unknown> {
  installRawProbe("open_root", false);
  const module = await loadCapabilities();
  installMediator(module, "open_root", rawMode, responseMode);
  const input = join(import.meta.dir, "../fixtures/valid/source-input-record-paired-surrogate.json");
  let outcome: string;
  let stdout = "";
  let stderr = "";
  if (entryArgument === "checker") {
    // This import must follow the mock-bound capability module so ingress shares that instance.
    const checker = await import("../lib/checker");
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
    const ingress = await import("../lib/ingress");
    try {
      const bytes = await ingress.readBoundedFile(input, 8_192);
      outcome = `BYTES:${bytes.byteLength}`;
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
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
    rawCalls: rawCounts.open_root,
    nativeHostilityReads
  };
}

async function runDefault(): Promise<unknown> {
  const module = await loadCapabilities();
  const capabilities = new module.ContractCapabilities();
  const descriptor = capabilities.openRoot("/", "admission");
  const directory = capabilities.stat(descriptor).isDirectory();
  capabilities.close(descriptor, "unretained");
  return {
    directory,
    hiddenExports: [
      "descriptorPrimitiveMediator",
      "getDescriptorPrimitiveMediator",
      "invokeDescriptorPrimitive",
      "resetDescriptorPrimitiveMediator",
      "uninstallDescriptorPrimitiveMediator"
    ].filter((name) => name in module)
  };
}

async function runInstaller(): Promise<unknown> {
  const module = await loadCapabilities();
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
    ].filter((name) => name in installer)
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

const receipt = scenario === "installer"
  ? await runInstaller()
  : scenario === "default"
  ? await runDefault()
  : scenario === "control"
  ? await runControl()
  : scenario === "ingress"
  ? await runIngress()
  : await runMatrix();
process.stdout.write(`${JSON.stringify(receipt)}\n`);
