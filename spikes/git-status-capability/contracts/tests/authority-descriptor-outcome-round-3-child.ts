import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type {
  BigIntStats,
  CapabilityDescriptor,
  ContractCapabilities,
  DescriptorOperation,
  DescriptorPrimitiveMediator
} from "../lib/capabilities";

type Target = "open_root" | "openat" | "fstat_sync" | "read_sync" | "close_sync";
type OpenAt = (parentDescriptor: number, path: Buffer, flags: number) => number;
type CapabilitiesModule = Readonly<{
  ContractCapabilities: new () => ContractCapabilities;
  DIRECTORY_OPEN_FLAGS: number;
  FILE_OPEN_FLAGS: number;
  installDescriptorPrimitiveMediator: (mediator: DescriptorPrimitiveMediator) => void;
}>;
type Fixture = Readonly<{ root: string; contents: Buffer; segments: readonly string[] }>;

const target = process.argv[2] as Target | undefined;
const rawError = Object.assign(new Error("ROUND_THREE_RAW_SENTINEL"), {
  fd: 917,
  path: "/private/sentinel",
  sentinel: "UNCHANGED"
});
let callbackActive = false;
let targetRawCalls = 0;
const callbackSnapshots: boolean[] = [];
let invokeReturnedUndefined = false;
let mediatorCaught = false;
let repeatedError = "NO_ERROR";
let mutationAttempted = false;
let mutationSucceeded = false;

function errorMessage(action: () => unknown): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

type OuterOutcome = Readonly<{ message: string; exactRaw: boolean }>;

function captureOuter(action: () => unknown): OuterOutcome {
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

async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shud-descriptor-outcome-")));
  const contents = Buffer.from("raw-outcome-private");
  await writeFile(join(root, "payload"), contents);
  return Object.freeze({ root, contents, segments: root.split(sep).filter(Boolean) });
}

function recordTargetThrow(): never {
  targetRawCalls += 1;
  callbackSnapshots.push(callbackActive);
  throw rawError;
}

function installRawThrowProbe(selectedTarget: Target): void {
  const originalOpenSync = originalFs.openSync;
  const originalFstatSync = originalFs.fstatSync;
  const originalReadSync = originalFs.readSync;
  const originalCloseSync = originalFs.closeSync;
  mock.module("node:fs", () => ({
    ...originalFs,
    openSync(...args: Parameters<typeof originalOpenSync>) {
      if (selectedTarget === "open_root") return recordTargetThrow();
      return originalOpenSync(...args);
    },
    fstatSync(...args: Parameters<typeof originalFstatSync>) {
      if (selectedTarget === "fstat_sync") return recordTargetThrow();
      return originalFstatSync(...args);
    },
    readSync(...args: Parameters<typeof originalReadSync>) {
      if (selectedTarget === "read_sync") return recordTargetThrow();
      return originalReadSync(...args);
    },
    closeSync(...args: Parameters<typeof originalCloseSync>) {
      if (selectedTarget === "close_sync") return recordTargetThrow();
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
            if (selectedTarget === "openat") return recordTargetThrow();
            return nativeOpenAt(...openAtArgs);
          }
        }
      } as typeof library;
    }
  }));
}

function installMediator(module: CapabilitiesModule, selectedTarget: Target): void {
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (operation !== selectedTarget) return invoke();
    callbackActive = true;
    try {
      let result: unknown;
      try {
        result = invoke();
      } catch (error) {
        mediatorCaught = true;
        mutationAttempted = true;
        try {
          Object.assign(error as object, { fd: 42, path: "/mutated", sentinel: "MUTATED" });
          mutationSucceeded = true;
        } catch {
          mutationSucceeded = false;
        }
        throw error;
      }
      invokeReturnedUndefined = result === undefined;
      repeatedError = errorMessage(() => invoke());
      mutationAttempted = true;
      try {
        Object.assign(result as object, { fd: 42, path: "/mutated", sentinel: "MUTATED" });
        mutationSucceeded = true;
      } catch {
        mutationSucceeded = false;
      }
      throw new Error("MEDIATOR_AFTER_RAW_OUTCOME");
    } finally {
      callbackActive = false;
    }
  });
}

function retainRoot(module: CapabilitiesModule): Readonly<{
  capabilities: ContractCapabilities;
  descriptor: CapabilityDescriptor;
}> {
  const capabilities = new module.ContractCapabilities();
  const descriptor = capabilities.openRoot("/", "admission");
  const stats = capabilities.stat(descriptor);
  if (!stats.isDirectory()) throw new Error("root descriptor is not a directory");
  capabilities.markRetained(descriptor, "directory");
  return Object.freeze({ capabilities, descriptor });
}

function closeDescriptors(
  capabilities: ContractCapabilities,
  descriptors: readonly CapabilityDescriptor[]
): void {
  for (const descriptor of [...descriptors].reverse()) capabilities.close(descriptor, "retained");
}

function retainFixtureFile(
  module: CapabilitiesModule,
  fixture: Fixture
): Readonly<{ capabilities: ContractCapabilities; descriptors: readonly CapabilityDescriptor[]; file: CapabilityDescriptor }> {
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
  if (!capabilities.stat(file).isFile()) throw new Error("fixture file is invalid");
  capabilities.markRetained(file, "file");
  capabilities.sealAdmission();
  return Object.freeze({ capabilities, descriptors: Object.freeze(descriptors), file });
}

async function exercise(module: CapabilitiesModule, selectedTarget: Target): Promise<OuterOutcome> {
  if (selectedTarget === "open_root") {
    return captureOuter(() => new module.ContractCapabilities().openRoot("/", "admission"));
  }
  if (selectedTarget === "fstat_sync") {
    const capabilities = new module.ContractCapabilities();
    const descriptor = capabilities.openRoot("/", "admission");
    const outcome = captureOuter(() => capabilities.stat(descriptor));
    capabilities.close(descriptor, "unretained");
    return outcome;
  }
  if (selectedTarget === "openat") {
    const retained = retainRoot(module);
    const outcome = captureOuter(() => retained.capabilities.openRelative(
      retained.descriptor,
      "tmp",
      module.DIRECTORY_OPEN_FLAGS,
      "admission"
    ));
    retained.capabilities.close(retained.descriptor, "retained");
    return outcome;
  }
  if (selectedTarget === "close_sync") {
    const retained = retainRoot(module);
    return captureOuter(() => retained.capabilities.close(retained.descriptor, "retained"));
  }
  const fixture = await createFixture();
  try {
    const retained = retainFixtureFile(module, fixture);
    const outcome = captureOuter(() => retained.capabilities.readRetained(
      retained.file,
      Buffer.alloc(fixture.contents.length),
      0,
      fixture.contents.length,
      0,
      "post_admission"
    ));
    closeDescriptors(retained.capabilities, retained.descriptors);
    return outcome;
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

try {
  if (!target || !["open_root", "openat", "fstat_sync", "read_sync", "close_sync"].includes(target)) {
    throw new Error("round-three outcome child requires a primitive target");
  }
  installRawThrowProbe(target);
  // Raw imports bind at module evaluation, so this test seam must load after the mocks above.
  const module = await import("../lib/capabilities") as CapabilitiesModule;
  installMediator(module, target);
  const outer = await exercise(module, target);
  console.log(JSON.stringify({
    target,
    outer: outer.message,
    outerIsExactRaw: outer.exactRaw,
    rawError: { message: rawError.message, fd: rawError.fd, path: rawError.path, sentinel: rawError.sentinel },
    targetRawCalls,
    callbackSnapshots,
    invokeReturnedUndefined,
    mediatorCaught,
    repeatedError,
    mutationAttempted,
    mutationSucceeded
  }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
