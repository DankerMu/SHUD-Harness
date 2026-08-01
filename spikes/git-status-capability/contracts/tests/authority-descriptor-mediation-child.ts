import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
  open_sync: number;
  open_sync_args: unknown[][];
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
  | "caught_repeated"
  | "late"
  | "async"
  | "ordinary_thenable"
  | "deferred"
  | "primitive"
  | "post_invoke"
  | "close_settlement"
  | "reentry"
  | "raw_capture"
  | "proxy"
  | "invalid"
  | "same_fd"
  | "hooks"
  | "ingress_hooks";

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

function resetRawCalls(rawCalls: RawCallCounts): void {
  rawCalls.open_sync = 0;
  rawCalls.open_sync_args.length = 0;
  rawCalls.openat = 0;
  rawCalls.fstat_sync = 0;
  rawCalls.read_sync = 0;
  rawCalls.close_sync = 0;
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
      rawCalls.open_sync += 1;
      rawCalls.open_sync_args.push([...args]);
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
  const rawCalls: RawCallCounts = {
    open_sync: 0,
    open_sync_args: [],
    openat: 0,
    fstat_sync: 0,
    read_sync: 0,
    close_sync: 0
  };
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
      rawCalls: {
        ...rawCalls,
        open_sync_args: rawCalls.open_sync_args.map((args) => [...args])
      },
      segments: fixture.segments.length,
      loaderObservations: [...loaderObservations]
    };
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function runInstall(): Promise<unknown> {
  const module = await import("../lib/capabilities");
  const installer = module.installDescriptorPrimitiveMediator;
  const ownProperties = Reflect.ownKeys(installer).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(installer, key);
    if (!descriptor || !("value" in descriptor)) throw new Error("installer own property must be data-only");
    return {
      key: typeof key === "symbol" ? key.toString() : key,
      value: descriptor.value,
      writable: descriptor.writable,
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
  let constructible = true;
  try {
    Reflect.construct(installer, [(_operation: DescriptorOperation, invoke: () => unknown) => invoke()]);
  } catch {
    constructible = false;
  }
  const mutationRejections = Object.fromEntries(
    ([
      ["reset", () => Object.defineProperty(installer, "reset", { value: () => undefined })],
      ["getter", () => Object.defineProperty(installer, "getMediator", { get: () => undefined })],
      ["uninstall", () => Reflect.defineProperty(installer, "uninstall", { value: () => undefined })],
      ["replacement", () => Reflect.set(installer, "replaceMediator", () => undefined)],
      ["raw_callable", () => Object.defineProperty(installer, "rawCallable", { value: () => undefined })]
    ] as const).map(([name, attempt]) => {
      try {
        return [name, attempt() === false];
      } catch {
        return [name, true];
      }
    })
  );
  const invalidInstallation = errorMessage(() => {
    (module.installDescriptorPrimitiveMediator as unknown as (candidate: unknown) => void)(null);
  });
  const firstInstallation = errorMessage(() => {
    module.installDescriptorPrimitiveMediator((_operation, invoke) => invoke());
  });
  return {
    frozen: Object.isFrozen(installer),
    constructible,
    ownProperties,
    mutationRejections,
    invalidInstallation,
    firstInstallation,
    secondInstallation: errorMessage(() => module.installDescriptorPrimitiveMediator((_operation, invoke) => invoke())),
    restrictedExports: [
      "descriptorPrimitiveMediator",
      "descriptorPrimitiveMediatorInstalled",
      "descriptorPrimitiveMediationState",
      "getDescriptorPrimitiveMediator",
      "resetDescriptorPrimitiveMediator",
      "uninstallDescriptorPrimitiveMediator"
    ].filter((name) => name in module)
  };
}

async function runOmitted(): Promise<unknown> {
  const rawCalls = { open_sync: 0 };
  const originalOpenSync = originalFs.openSync;
  mock.module("node:fs", () => ({
    ...originalFs,
    openSync(...args: Parameters<typeof originalOpenSync>) {
      rawCalls.open_sync += 1;
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
  let repeatedError = "";
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
    try {
      return invoke();
    } catch (error) {
      repeatedError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  });
  const returned = capabilities.stat(root);
  capabilities.close(root, "unretained");
  return { returnedDirectory: returned.isDirectory(), repeatedError, rawCalls };
}

async function runCaughtRepeated(): Promise<unknown> {
  let rawCalls = 0;
  let repeatedError = "";
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
    try {
      invoke();
    } catch (error) {
      repeatedError = error instanceof Error ? error.message : String(error);
    }
    return "MEDIATOR_REPLACED_RETURN";
  });
  const returned = capabilities.stat(root);
  capabilities.close(root, "unretained");
  return { returnedDirectory: returned.isDirectory(), repeatedError, rawCalls };
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
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (operation !== "fstat_sync") return invoke();
    stored = invoke;
    return undefined;
  });
  const missing = errorMessage(() => capabilities.stat(root));
  const expired = errorMessage(() => {
    if (!stored) throw new Error("stored primitive invocation is absent");
    return stored();
  });
  capabilities.close(root, "unretained");
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
  module.installDescriptorPrimitiveMediator(async (operation, invoke) =>
    operation === "fstat_sync" ? undefined : invoke()
  );
  const error = errorMessage(() => capabilities.stat(root));
  capabilities.close(root, "unretained");
  return { error, rawCalls };
}

async function runOrdinaryThenable(): Promise<unknown> {
  let rawCalls = 0;
  const originalFstatSync = originalFs.fstatSync;
  installFstatProbe((...args) => {
    rawCalls += 1;
    return originalFstatSync(...args);
  });
  const module = await import("../lib/capabilities");
  const capabilities = new module.ContractCapabilities();
  const root = capabilities.openRoot("/", "admission");
  module.installDescriptorPrimitiveMediator((operation, invoke) =>
    operation === "fstat_sync" ? { then: () => undefined } : invoke()
  );
  const error = errorMessage(() => capabilities.stat(root));
  capabilities.close(root, "unretained");
  return { error, rawCalls };
}

async function runDeferred(): Promise<unknown> {
  let rawCalls = 0;
  let deferredError = "";
  let deferred: Promise<void> | undefined;
  const originalFstatSync = originalFs.fstatSync;
  installFstatProbe((...args) => {
    rawCalls += 1;
    return originalFstatSync(...args);
  });
  const module = await import("../lib/capabilities");
  const capabilities = new module.ContractCapabilities();
  const root = capabilities.openRoot("/", "admission");
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (operation !== "fstat_sync") return invoke();
    deferred = Promise.resolve().then(() => {
      deferredError = errorMessage(() => invoke());
    });
    return undefined;
  });
  const missing = errorMessage(() => capabilities.stat(root));
  if (!deferred) throw new Error("deferred invocation was not scheduled");
  await deferred;
  capabilities.close(root, "unretained");
  return { missing, deferredError, rawCalls };
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
  const error = errorMessage(() => capabilities.stat(root));
  capabilities.close(root, "unretained");
  return {
    returnedSame: returned === sentinel,
    error,
    rawCalls,
    operations
  };
}

async function runPostInvoke(): Promise<unknown> {
  const fixture = await createFixture();
  const rawCalls: RawCallCounts = {
    open_sync: 0,
    open_sync_args: [],
    openat: 0,
    fstat_sync: 0,
    read_sync: 0,
    close_sync: 0
  };
  const handledOperations: Partial<Record<DescriptorOperation, true>> = Object.create(null);
  const outcomes: string[] = [];
  const repeatedErrors: string[] = [];
  installRawSequenceProbe(rawCalls, () => undefined);
  try {
    const module = await import("../lib/capabilities");
    readFixture(module, fixture);
    resetRawCalls(rawCalls);
    const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    const baseline = (await readdir(descriptorDirectory)).length;
    module.installDescriptorPrimitiveMediator((operation, invoke) => {
      invoke();
      if (handledOperations[operation]) return undefined;
      handledOperations[operation] = true;
      if (operation === "open_root") {
        outcomes.push("open_root:throw");
        throw new Error("MEDIATOR_AFTER_INVOKE");
      }
      if (operation === "openat") {
        outcomes.push("openat:thenable");
        return { then: () => undefined };
      }
      if (operation === "fstat_sync") {
        outcomes.push("fstat_sync:uncaught_repeat");
        try {
          invoke();
        } catch (error) {
          repeatedErrors.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      }
      if (operation === "read_sync") {
        outcomes.push("read_sync:caught_repeat");
        try {
          invoke();
        } catch (error) {
          repeatedErrors.push(error instanceof Error ? error.message : String(error));
        }
        return { then: () => undefined };
      }
      outcomes.push("close_sync:throw");
      throw new Error("CLOSE_AFTER_INVOKE");
    });
    const result = readFixture(module, fixture);
    const settled = (await readdir(descriptorDirectory)).length;
    return {
      ...result,
      segments: fixture.segments.length,
      outcomes,
      repeatedErrors,
      fdBaselineRestored: settled === baseline,
      rawCalls: {
        ...rawCalls,
        open_sync_args: rawCalls.open_sync_args.map((args) => [...args])
      }
    };
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function runCloseSettlement(): Promise<unknown> {
  let rawCloseCalls = 0;
  let mode: "allow" | "omitted" | "throw" | "thenable" = "allow";
  const originalCloseSync = originalFs.closeSync;
  mock.module("node:fs", () => ({
    ...originalFs,
    closeSync(...args: Parameters<typeof originalCloseSync>) {
      rawCloseCalls += 1;
      return originalCloseSync(...args);
    }
  }));
  const module = await import("../lib/capabilities");
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (operation !== "close_sync" || mode === "allow") return invoke();
    if (mode === "omitted") return undefined;
    if (mode === "throw") throw new Error("CLOSE_BEFORE_INVOKE");
    return { then: () => undefined };
  });
  const capabilities = new module.ContractCapabilities();
  const settlements: Array<Readonly<{
    mode: "omitted" | "throw" | "thenable";
    firstError: string;
    firstRawCalls: number;
    retry: string;
    retryRawCalls: number;
  }>> = [];
  for (const failedMode of ["omitted", "throw", "thenable"] as const) {
    const root = capabilities.openRoot("/", "admission");
    mode = failedMode;
    const beforeFirst = rawCloseCalls;
    const firstError = errorMessage(() => capabilities.close(root, "unretained"));
    const firstRawCalls = rawCloseCalls - beforeFirst;
    mode = "allow";
    const beforeRetry = rawCloseCalls;
    const retry = errorMessage(() => capabilities.close(root, "unretained"));
    settlements.push(Object.freeze({
      mode: failedMode,
      firstError,
      firstRawCalls,
      retry,
      retryRawCalls: rawCloseCalls - beforeRetry
    }));
  }
  return { settlements, rawCloseCalls };
}

async function runReentry(): Promise<unknown> {
  let rawCalls = 0;
  const originalFstatSync = originalFs.fstatSync;
  installFstatProbe((...args) => {
    rawCalls += 1;
    return originalFstatSync(...args);
  });
  const module = await import("../lib/capabilities");
  const denials: string[] = [];
  const capabilities = new module.ContractCapabilities({
    onDescriptorAuthorityDenial() {
      denials.push("denial");
    }
  });
  const root = capabilities.openRoot("/", "admission");
  const errors: Record<string, string> = Object.create(null);
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (operation === "fstat_sync") {
      const reentries: Readonly<Record<string, () => unknown>> = {
        sealAdmission: () => capabilities.sealAdmission(),
        openRoot: () => capabilities.openRoot("not-root", "admission"),
        openRelative: () => capabilities.openRelative(root, "payload", module.FILE_OPEN_FLAGS, "post_admission"),
        markRetained: () => capabilities.markRetained(root, "directory"),
        stat: () => capabilities.stat(root),
        readRetained: () => capabilities.readRetained(root, Buffer.alloc(1), 0, 1, 0, "post_admission"),
        close: () => capabilities.close(root, "retained"),
        rejectForbidden: () => capabilities.rejectForbidden("file_write", "admission")
      };
      for (const [name, action] of Object.entries(reentries)) errors[name] = errorMessage(action);
    }
    return invoke();
  });
  const returned = capabilities.stat(root);
  capabilities.close(root, "unretained");
  return { errors, denials, returnedDirectory: returned.isDirectory(), rawCalls };
}

async function runRawCapture(): Promise<unknown> {
  const fixture = await createFixture();
  try {
    const module = await import("../lib/capabilities");
    const captures: Array<Readonly<{ operation: DescriptorOperation; type: string; undefined: boolean }>> = [];
    module.installDescriptorPrimitiveMediator((operation, invoke) => {
      const value = invoke();
      captures.push(Object.freeze({ operation, type: typeof value, undefined: value === undefined }));
      return value;
    });
    return { ...readFixture(module, fixture), segments: fixture.segments.length, captures };
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function runProxy(): Promise<unknown> {
  const module = await import("../lib/capabilities");
  const operations: DescriptorOperation[] = [];
  let tagReads = 0;
  const mediator = new Proxy(
    ((operation: DescriptorOperation, invoke: () => unknown) => {
      operations.push(operation);
      return invoke();
    }) as DescriptorPrimitiveMediator,
    {
      get(target, key, receiver) {
        if (key === Symbol.toStringTag) {
          tagReads += 1;
          throw new Error("PROXY_TAG_TRAP");
        }
        return Reflect.get(target, key, receiver);
      }
    }
  );
  module.installDescriptorPrimitiveMediator(mediator);
  const capabilities = new module.ContractCapabilities();
  const root = capabilities.openRoot("/", "admission");
  capabilities.close(root, "unretained");
  return { operations, tagReads, descriptorIsOpaque: typeof root === "object" && root !== null };
}

async function runInvalid(): Promise<unknown> {
  const fixture = await createFixture();
  const rawCalls: RawCallCounts = {
    open_sync: 0,
    open_sync_args: [],
    openat: 0,
    fstat_sync: 0,
    read_sync: 0,
    close_sync: 0
  };
  installRawSequenceProbe(rawCalls, () => undefined);
  try {
    const module = await import("../lib/capabilities");
    const operations: DescriptorOperation[] = [];
    module.installDescriptorPrimitiveMediator((operation, invoke) => {
      operations.push(operation);
      return invoke();
    });
    const capabilities = new module.ContractCapabilities();
    let directory = capabilities.openRoot("/", "admission");
    const descriptors: CapabilityDescriptor[] = [directory];
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
    resetRawCalls(rawCalls);
    operations.length = 0;
    const rows = [
      ["root", errorMessage(() => capabilities.openRoot("not-root", "admission"))],
      ["phase", errorMessage(() => capabilities.openRoot("/", "admission"))],
      [
        "parent",
        errorMessage(() =>
          capabilities.openRelative(Object.freeze(Object.create(null)) as CapabilityDescriptor, "payload", module.FILE_OPEN_FLAGS, "post_admission")
        )
      ],
      ["flags", errorMessage(() => capabilities.openRelative(directory, "payload", 0, "post_admission"))],
      ["stat", errorMessage(() => capabilities.stat(0 as never))],
      [
        "read_phase",
        errorMessage(() => capabilities.readRetained(file, Buffer.alloc(1), 0, 1, 0, "admission"))
      ],
      [
        "read_range",
        errorMessage(() => capabilities.readRetained(file, Buffer.alloc(1), 1, 1, 0, "post_admission"))
      ],
      ["close", errorMessage(() => capabilities.close(file, "verification"))]
    ];
    const snapshot = {
      rows,
      operations: [...operations],
      rawCalls: {
        ...rawCalls,
        open_sync_args: rawCalls.open_sync_args.map((args) => [...args])
      }
    };
    for (const descriptor of [...descriptors].reverse()) capabilities.close(descriptor, "retained");
    return snapshot;
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function runSameFd(): Promise<unknown> {
  const sentinel = Object.freeze({ isDirectory: () => true, isFile: () => false }) as unknown as BigIntStats;
  let openCalls = 0;
  let statCalls = 0;
  let closeCalls = 0;
  mock.module("node:fs", () => ({
    ...originalFs,
    openSync() {
      openCalls += 1;
      return 73;
    },
    fstatSync() {
      statCalls += 1;
      return sentinel;
    },
    closeSync() {
      closeCalls += 1;
    }
  }));
  const module = await import("../lib/capabilities");
  module.installDescriptorPrimitiveMediator((_operation, invoke) => invoke());
  const capabilities = new module.ContractCapabilities();
  const first = capabilities.openRoot("/", "admission");
  capabilities.close(first, "unretained");
  const replacement = capabilities.openRoot("/", "admission");
  const replacementIsDirectory = capabilities.stat(replacement).isDirectory();
  const stale = errorMessage(() => capabilities.stat(first));
  capabilities.close(replacement, "unretained");
  return { openCalls, statCalls, closeCalls, replacementIsDirectory, stale };
}

async function runIngressHooks(): Promise<unknown> {
  const module = await import("../lib/capabilities");
  const ingress = await import("../lib/ingress");
  const checker = await import("../lib/checker");
  const callbackEntries: string[] = [];
  const nestedCallbacks: string[] = [];
  let mediationActive = false;
  let hookLabel: string | undefined;
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (hookLabel) nestedCallbacks.push(`${hookLabel}:${operation}:${mediationActive}`);
    mediationActive = true;
    try {
      return invoke();
    } finally {
      mediationActive = false;
    }
  });
  const startEligibleWork = (label: string): void => {
    const priorLabel = hookLabel;
    hookLabel = label;
    try {
      const capabilities = new module.ContractCapabilities();
      const root = capabilities.openRoot("/", "admission");
      capabilities.close(root, "unretained");
    } finally {
      hookLabel = priorLabel;
    }
  };
  const input = join(import.meta.dir, "..", "fixtures", "valid", "source-input-record-paired-surrogate.json");
  let observed = false;
  const directHooks = {
    afterAdmission() {
      callbackEntries.push(`direct:afterAdmission:${mediationActive}`);
      startEligibleWork("direct:afterAdmission");
    },
    observe() {
      if (observed) return;
      observed = true;
      callbackEntries.push(`direct:observe:${mediationActive}`);
      startEligibleWork("direct:observe");
    }
  };
  const direct = await ingress.readBoundedFile(input, 64 * 1024, directHooks, () => {
    callbackEntries.push(`direct:beforeCleanup:${mediationActive}`);
    startEligibleWork("direct:beforeCleanup");
  });
  let checkerObserved = false;
  let stdout = "";
  let stderr = "";
  const checkerExit = await checker.runCheckForTest(
    ["--input", input, "--kind", "source_input_record"],
    {
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; }
    },
    {
      afterAdmission() {
        callbackEntries.push(`checker:afterAdmission:${mediationActive}`);
        startEligibleWork("checker:afterAdmission");
      },
      observe() {
        if (checkerObserved) return;
        checkerObserved = true;
        callbackEntries.push(`checker:observe:${mediationActive}`);
        startEligibleWork("checker:observe");
      }
    }
  );
  return {
    directBytes: direct.byteLength,
    callbackEntries,
    nestedCallbacks,
    checkerExit,
    checkerStdout: stdout,
    checkerStderr: stderr
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
  let result: unknown;
  switch (scenario) {
    case "default":
      result = await runDefault();
      break;
    case "sequence":
      result = await runSequence();
      break;
    case "install":
      result = await runInstall();
      break;
    case "omitted":
      result = await runOmitted();
      break;
    case "repeated":
      result = await runRepeated();
      break;
    case "caught_repeated":
      result = await runCaughtRepeated();
      break;
    case "late":
      result = await runLate();
      break;
    case "async":
      result = await runAsync();
      break;
    case "ordinary_thenable":
      result = await runOrdinaryThenable();
      break;
    case "deferred":
      result = await runDeferred();
      break;
    case "primitive":
      result = await runPrimitive();
      break;
    case "post_invoke":
      result = await runPostInvoke();
      break;
    case "close_settlement":
      result = await runCloseSettlement();
      break;
    case "reentry":
      result = await runReentry();
      break;
    case "raw_capture":
      result = await runRawCapture();
      break;
    case "proxy":
      result = await runProxy();
      break;
    case "invalid":
      result = await runInvalid();
      break;
    case "same_fd":
      result = await runSameFd();
      break;
    case "hooks":
      result = await runHooks();
      break;
    case "ingress_hooks":
      result = await runIngressHooks();
      break;
    default:
      throw new Error("descriptor mediation child requires a scenario");
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
