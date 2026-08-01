import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type {
  BigIntStats,
  CapabilityHooks,
  CapabilityDescriptor,
  ContractCapabilities,
  DescriptorOperation,
  DescriptorPrimitiveMediator
} from "../lib/capabilities";

type CapabilitiesModule = Readonly<{
  ContractCapabilities: new (hooks?: CapabilityHooks) => ContractCapabilities;
  DIRECTORY_OPEN_FLAGS: number;
  FILE_OPEN_FLAGS: number;
  installDescriptorPrimitiveMediator: (mediator: DescriptorPrimitiveMediator) => void;
}>;
type FstatSyncProbe = (descriptor: number, options: { bigint: true }) => BigIntStats;
type OpenAt = (parentDescriptor: number, path: Buffer, flags: number) => number;
type OpenAtResolutionStep = "loader" | "symbol";
type RawCallCounts = {
  open_root: number;
  openat: number;
  fstat_sync: number;
  read_sync: number;
  close_sync: number;
};
type Fixture = Readonly<{ root: string; contents: Buffer; segments: readonly string[] }>;
type Scenario =
  | "default"
  | "sequence"
  | "install"
  | "omitted"
  | "repeated"
  | "late"
  | "async"
  | "primitive"
  | "hooks";

const FIXTURE_TEXT = "descriptor-mediation";
const scenario = process.argv[2] as Scenario | undefined;

function errorMessage(action: () => unknown): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function createFixture(): Promise<Fixture> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "shud-descriptor-mediation-"));
  const root = await realpath(temporaryRoot);
  const contents = Buffer.from(FIXTURE_TEXT);
  await writeFile(join(root, "payload"), contents);
  return Object.freeze({ root, contents, segments: root.split(sep).filter(Boolean) });
}

function readFixture(module: CapabilitiesModule, fixture: Fixture): Readonly<{ bytes: number; text: string }> {
  const capabilities = new module.ContractCapabilities();
  let directory = capabilities.openRoot("/", "admission");
  const descriptors = [directory];
  for (const segment of fixture.segments) {
    if (!capabilities.stat(directory).isDirectory()) throw new Error("fixture directory is not a directory");
    capabilities.markRetained(directory, "directory");
    directory = capabilities.openRelative(directory, segment, module.DIRECTORY_OPEN_FLAGS, "admission");
    descriptors.push(directory);
  }
  if (!capabilities.stat(directory).isDirectory()) throw new Error("fixture root is not a directory");
  capabilities.markRetained(directory, "directory");
  const file = capabilities.openRelative(directory, "payload", module.FILE_OPEN_FLAGS, "admission");
  descriptors.push(file);
  if (!capabilities.stat(file).isFile()) throw new Error("fixture payload is not a file");
  capabilities.markRetained(file, "file");
  capabilities.sealAdmission();
  const buffer = Buffer.alloc(fixture.contents.length);
  const bytes = capabilities.readRetained(file, buffer, 0, buffer.length, 0, "post_admission");
  for (const descriptor of [...descriptors].reverse()) capabilities.close(descriptor, "retained");
  return Object.freeze({ bytes, text: buffer.subarray(0, bytes).toString() });
}

function installRawSequenceProbe(
  rawCalls: RawCallCounts,
  onOpenAtResolution: (step: OpenAtResolutionStep) => void
): void {
  const originalOpenSync = originalFs.openSync;
  const originalFstatSync = originalFs.fstatSync;
  const originalReadSync = originalFs.readSync;
  const originalCloseSync = originalFs.closeSync;
  mock.module("node:fs", () => ({
    ...originalFs,
    openSync(...args: Parameters<typeof originalOpenSync>) {
      if (args[0] === "/") rawCalls.open_root += 1;
      return originalOpenSync(...args);
    },
    fstatSync(...args: Parameters<typeof originalFstatSync>) {
      rawCalls.fstat_sync += 1;
      return originalFstatSync(...args);
    },
    readSync(...args: Parameters<typeof originalReadSync>) {
      rawCalls.read_sync += 1;
      return originalReadSync(...args);
    },
    closeSync(...args: Parameters<typeof originalCloseSync>) {
      rawCalls.close_sync += 1;
      return originalCloseSync(...args);
    }
  }));

  const originalDlopen = originalFfi.dlopen;
  mock.module("bun:ffi", () => ({
    ...originalFfi,
    dlopen(...args: Parameters<typeof originalDlopen>) {
      onOpenAtResolution("loader");
      const library = originalDlopen(...args);
      const nativeOpenAt = (library.symbols as unknown as Readonly<{ openat: OpenAt }>).openat;
      return {
        ...library,
        symbols: {
          ...library.symbols,
          get openat(): OpenAt {
            onOpenAtResolution("symbol");
            return (...openAtArgs: Parameters<OpenAt>): number => {
              rawCalls.openat += 1;
              return nativeOpenAt(...openAtArgs);
            };
          }
        }
      } as typeof library;
    }
  }));
}

function installFstatProbe(fstatSync: FstatSyncProbe): void {
  mock.module("node:fs", () => ({ ...originalFs, fstatSync }));
}

// Scenarios dynamically import after their local Bun mocks so the capability module binds each raw probe.
async function runDefault(): Promise<unknown> {
  const fixture = await createFixture();
  try {
    const module = await import("../lib/capabilities");
    const restrictedExports = [
      "descriptorPrimitiveMediator",
      "descriptorPrimitiveMediatorInstalled",
      "getDescriptorPrimitiveMediator",
      "invokeDescriptorPrimitive",
      "openAt",
      "resetDescriptorPrimitiveMediator",
      "uninstallDescriptorPrimitiveMediator"
    ].filter((name) => name in module);
    const capabilityInstance = new module.ContractCapabilities();
    const restrictedInstanceProperties = [
      "currentGenerationByDescriptor",
      "descriptorOwners",
      "descriptorPrimitiveMediator",
      "descriptorPrimitiveMediatorInstalled",
      "getDescriptorPrimitiveMediator",
      "invokeDescriptorPrimitive",
      "openAt",
      "registry",
      "resetDescriptorPrimitiveMediator",
      "uninstallDescriptorPrimitiveMediator"
    ].filter((name) => name in capabilityInstance);
    return {
      ...readFixture(module, fixture),
      publicExports: Object.keys(module).sort(),
      restrictedExports,
      restrictedInstanceProperties
    };
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function runSequence(): Promise<unknown> {
  const fixture = await createFixture();
  const rawCalls: RawCallCounts = { open_root: 0, openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 };
  const loaderObservations: string[] = [];
  let mediationActive = false;
  installRawSequenceProbe(rawCalls, (step) => loaderObservations.push(`${step}:${mediationActive}`));
  try {
    const module = await import("../lib/capabilities");
    const operations: DescriptorOperation[] = [];
    let invocations = 0;
    module.installDescriptorPrimitiveMediator((operation, invoke) => {
      operations.push(operation);
      invocations += 1;
      mediationActive = true;
      try {
        return invoke();
      } finally {
        mediationActive = false;
      }
    });
    return {
      ...readFixture(module, fixture),
      operations,
      invocations,
      rawCalls: { ...rawCalls },
      segments: fixture.segments.length,
      loaderObservations: [...loaderObservations]
    };
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function runInstall(): Promise<unknown> {
  const module = await import("../lib/capabilities");
  module.installDescriptorPrimitiveMediator((_operation, invoke) => invoke());
  return {
    secondInstallation: errorMessage(() => module.installDescriptorPrimitiveMediator((_operation, invoke) => invoke())),
    restrictedExports: [
      "descriptorPrimitiveMediator",
      "getDescriptorPrimitiveMediator",
      "resetDescriptorPrimitiveMediator",
      "uninstallDescriptorPrimitiveMediator"
    ].filter((name) => name in module)
  };
}

async function runOmitted(): Promise<unknown> {
  const rawCalls = { open_root: 0 };
  const originalOpenSync = originalFs.openSync;
  mock.module("node:fs", () => ({
    ...originalFs,
    openSync(...args: Parameters<typeof originalOpenSync>) {
      if (args[0] === "/") rawCalls.open_root += 1;
      return originalOpenSync(...args);
    }
  }));
  const module = await import("../lib/capabilities");
  module.installDescriptorPrimitiveMediator((_operation, _invoke) => undefined);
  const capabilities = new module.ContractCapabilities();
  return { error: errorMessage(() => capabilities.openRoot("/", "admission")), rawCalls };
}

async function runRepeated(): Promise<unknown> {
  let rawCalls = 0;
  const originalFstatSync = originalFs.fstatSync;
  installFstatProbe((...args) => {
    rawCalls += 1;
    return originalFstatSync(...args);
  });
  const module = await import("../lib/capabilities");
  const capabilities = new module.ContractCapabilities();
  const root = capabilities.openRoot("/", "admission");
  module.installDescriptorPrimitiveMediator((_operation, invoke) => {
    invoke();
    return invoke();
  });
  return { error: errorMessage(() => capabilities.stat(root)), rawCalls };
}

async function runLate(): Promise<unknown> {
  let rawCalls = 0;
  const originalFstatSync = originalFs.fstatSync;
  installFstatProbe((...args) => {
    rawCalls += 1;
    return originalFstatSync(...args);
  });
  const module = await import("../lib/capabilities");
  const capabilities = new module.ContractCapabilities();
  const root = capabilities.openRoot("/", "admission");
  let stored: (() => unknown) | undefined;
  module.installDescriptorPrimitiveMediator((_operation, invoke) => {
    stored = invoke;
  });
  const missing = errorMessage(() => capabilities.stat(root));
  const expired = errorMessage(() => {
    if (!stored) throw new Error("stored primitive invocation is absent");
    return stored();
  });
  return { missing, expired, rawCalls };
}

async function runAsync(): Promise<unknown> {
  let rawCalls = 0;
  const originalFstatSync = originalFs.fstatSync;
  installFstatProbe((...args) => {
    rawCalls += 1;
    return originalFstatSync(...args);
  });
  const module = await import("../lib/capabilities");
  const capabilities = new module.ContractCapabilities();
  const root = capabilities.openRoot("/", "admission");
  module.installDescriptorPrimitiveMediator(async (_operation, invoke) => invoke());
  return { error: errorMessage(() => capabilities.stat(root)), rawCalls };
}

async function runPrimitive(): Promise<unknown> {
  const sentinel = Object.freeze({ isDirectory: () => true, isFile: () => false }) as unknown as BigIntStats;
  const rawError = new Error("MEDIATED_RAW_FSTAT_ERROR");
  let rawCalls = 0;
  installFstatProbe((..._args) => {
    rawCalls += 1;
    if (rawCalls === 1) return sentinel;
    throw rawError;
  });
  const module = await import("../lib/capabilities");
  const capabilities = new module.ContractCapabilities();
  const root = capabilities.openRoot("/", "admission");
  const operations: DescriptorOperation[] = [];
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    operations.push(operation);
    try {
      invoke();
      return "MEDIATOR_REPLACED_RETURN";
    } catch {
      return "MEDIATOR_SWALLOWED_ERROR";
    }
  });
  const returned = capabilities.stat(root);
  return {
    returnedSame: returned === sentinel,
    error: errorMessage(() => capabilities.stat(root)),
    rawCalls,
    operations
  };
}

async function runHooks(): Promise<unknown> {
  const module = await import("../lib/capabilities");
  const events: string[] = [];
  const hookOperationActive: boolean[] = [];
  let mediationActive = false;
  let insideCloseAttempt = false;
  let clearingNestedDescriptor = false;
  let nestedDescriptor: CapabilityDescriptor | undefined;
  let capabilities: ContractCapabilities | undefined;
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (insideCloseAttempt) hookOperationActive.push(mediationActive);
    mediationActive = true;
    try {
      return invoke();
    } finally {
      mediationActive = false;
    }
  });
  capabilities = new module.ContractCapabilities({
    onDescriptorAuthorityDenial() {
      events.push(`denial:${mediationActive}`);
    },
    onCloseAttempt() {
      if (!clearingNestedDescriptor) events.push(`close_attempt:${mediationActive}`);
      if (clearingNestedDescriptor) return;
      if (!capabilities) throw new Error("capabilities are unavailable to close hook");
      insideCloseAttempt = true;
      try {
        nestedDescriptor = capabilities.openRoot("/", "admission");
      } finally {
        insideCloseAttempt = false;
      }
    },
    closeFault() {
      if (!clearingNestedDescriptor) events.push(`close_fault:${mediationActive}`);
      return !clearingNestedDescriptor;
    },
    onAuthorityViolation() {
      events.push(`authority_violation:${mediationActive}`);
    }
  });
  errorMessage(() => capabilities.openRoot("not-root", "admission"));
  const root = capabilities.openRoot("/", "admission");
  const closeError = errorMessage(() => capabilities.close(root, "unretained"));
  if (!nestedDescriptor) throw new Error("close hook did not start its mediated operation");
  clearingNestedDescriptor = true;
  try {
    capabilities.close(nestedDescriptor, "unretained");
  } finally {
    clearingNestedDescriptor = false;
  }
  errorMessage(() => capabilities.rejectForbidden("file_write", "post_admission"));
  return { events, hookOperationActive, closeError };
}

try {
  if (
    scenario !== "default" && scenario !== "sequence" && scenario !== "install" && scenario !== "omitted" &&
    scenario !== "repeated" && scenario !== "late" && scenario !== "async" && scenario !== "primitive" &&
    scenario !== "hooks"
  ) {
    throw new Error("descriptor mediation child requires a scenario");
  }
  const result = scenario === "default"
    ? await runDefault()
    : scenario === "sequence"
    ? await runSequence()
    : scenario === "install"
    ? await runInstall()
    : scenario === "omitted"
    ? await runOmitted()
    : scenario === "repeated"
    ? await runRepeated()
    : scenario === "late"
    ? await runLate()
    : scenario === "async"
    ? await runAsync()
    : scenario === "primitive"
    ? await runPrimitive()
    : await runHooks();
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
