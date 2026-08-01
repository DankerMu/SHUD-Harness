import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";
import type {
  BigIntStats,
  CapabilityDescriptor,
  CapabilityHooks,
  ContractCapabilities,
  DescriptorOperation,
  DescriptorPrimitiveMediator
} from "../lib/capabilities";

type Scenario =
  | "thenable_matrix"
  | "installer_surface"
  | "proxy_reflection"
  | "invocation_surface"
  | "invalid_denials"
  | "reentry_windows"
  | "openat_tuple";
type CapabilitiesModule = Readonly<{
  ContractCapabilities: new (hooks?: CapabilityHooks) => ContractCapabilities;
  DIRECTORY_OPEN_FLAGS: number;
  FILE_OPEN_FLAGS: number;
  installDescriptorPrimitiveMediator: (mediator: DescriptorPrimitiveMediator) => void;
}>;
type RawCalls = {
  openSync: Array<readonly unknown[]>;
  openAt: Array<Readonly<{ parent: number; path: readonly number[]; flags: number; result: number }>>;
  fstat: number[];
  read: number[];
  close: number[];
};
type SyntheticProbe = Readonly<{ rawCalls: RawCalls; reset: () => void }>;
type RawCountReceipt = Readonly<{
  open_sync: number;
  openat: number;
  fstat_sync: number;
  read_sync: number;
  close_sync: number;
}>;
type RetainedFileChain = Readonly<{
  root: CapabilityDescriptor;
  directory: CapabilityDescriptor;
  file: CapabilityDescriptor;
}>;

// Each child installs local Bun mocks, so this test seam must bind the production module afterwards.
async function loadCapabilities(): Promise<CapabilitiesModule> {
  return await import("../lib/capabilities") as CapabilitiesModule;
}

const scenario = process.argv[2] as Scenario | undefined;

function errorMessage(action: () => unknown): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function freshRawCalls(): RawCalls {
  return { openSync: [], openAt: [], fstat: [], read: [], close: [] };
}

function resetRawCalls(rawCalls: RawCalls): void {
  rawCalls.openSync.length = 0;
  rawCalls.openAt.length = 0;
  rawCalls.fstat.length = 0;
  rawCalls.read.length = 0;
  rawCalls.close.length = 0;
}

function rawCounts(rawCalls: RawCalls): RawCountReceipt {
  return Object.freeze({
    open_sync: rawCalls.openSync.length,
    openat: rawCalls.openAt.length,
    fstat_sync: rawCalls.fstat.length,
    read_sync: rawCalls.read.length,
    close_sync: rawCalls.close.length
  });
}

function fakeStats(kind: "directory" | "file", descriptor: number): BigIntStats {
  return Object.freeze({
    dev: 1n,
    ino: BigInt(descriptor),
    size: 1n,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file"
  }) as unknown as BigIntStats;
}

function installSyntheticProbe(): SyntheticProbe {
  const rawCalls = freshRawCalls();
  let nextDescriptor = 40;
  const statsByDescriptor = new Map<number, BigIntStats>();
  const originalOpenSync = originalFs.openSync;
  const originalFstatSync = originalFs.fstatSync;
  const originalReadSync = originalFs.readSync;
  const originalCloseSync = originalFs.closeSync;

  mock.module("node:fs", () => ({
    ...originalFs,
    openSync(...args: Parameters<typeof originalOpenSync>) {
      const descriptor = nextDescriptor++;
      rawCalls.openSync.push([...args]);
      statsByDescriptor.set(descriptor, fakeStats("directory", descriptor));
      return descriptor;
    },
    fstatSync(...args: Parameters<typeof originalFstatSync>) {
      const descriptor = args[0] as number;
      rawCalls.fstat.push(descriptor);
      const stats = statsByDescriptor.get(descriptor);
      if (!stats) throw new Error(`unexpected synthetic fstat descriptor: ${descriptor}`);
      return stats;
    },
    readSync(...args: Parameters<typeof originalReadSync>) {
      const descriptor = args[0] as number;
      const buffer = args[1] as Buffer;
      const offset = args[2] as number;
      rawCalls.read.push(descriptor);
      if (buffer.byteLength > offset) buffer[offset] = 0x78;
      return 1;
    },
    closeSync(...args: Parameters<typeof originalCloseSync>) {
      rawCalls.close.push(args[0] as number);
    }
  }));

  mock.module("bun:ffi", () => ({
    ...originalFfi,
    dlopen(..._args: Parameters<typeof originalFfi.dlopen>) {
      return {
        symbols: {
          openat(parent: number, path: Buffer, flags: number): number {
            const descriptor = nextDescriptor++;
            rawCalls.openAt.push(Object.freeze({
              parent,
              path: Object.freeze([...path]),
              flags,
              result: descriptor
            }));
            const directoryFlag = originalFs.constants.O_DIRECTORY ?? 0;
            const kind = (
              (directoryFlag !== 0 && (flags & directoryFlag) !== 0) ||
              path.toString("utf8") === "__unmediated__\0"
            ) ? "directory" : "file";
            statsByDescriptor.set(descriptor, fakeStats(kind, descriptor));
            return descriptor;
          }
        }
      } as never;
    }
  }));

  return Object.freeze({ rawCalls, reset: () => resetRawCalls(rawCalls) });
}

function prepareRetainedFile(
  module: CapabilitiesModule,
  capabilities: ContractCapabilities
): RetainedFileChain {
  const root = capabilities.openRoot("/", "admission");
  if (!capabilities.stat(root).isDirectory()) throw new Error("synthetic root is not a directory");
  capabilities.markRetained(root, "directory");
  const directory = capabilities.openRelative(root, "__unmediated__", module.DIRECTORY_OPEN_FLAGS, "admission");
  if (!capabilities.stat(directory).isDirectory()) throw new Error("synthetic child is not a directory");
  capabilities.markRetained(directory, "directory");
  const file = capabilities.openRelative(directory, "payload", module.FILE_OPEN_FLAGS, "admission");
  if (!capabilities.stat(file).isFile()) throw new Error("synthetic file is not a file");
  capabilities.markRetained(file, "file");
  capabilities.sealAdmission();
  return Object.freeze({ root, directory, file });
}

function closeRetained(
  capabilities: ContractCapabilities,
  descriptors: readonly CapabilityDescriptor[]
): void {
  for (const descriptor of [...descriptors].reverse()) capabilities.close(descriptor, "retained");
}

function functionSurface(value: Function): Readonly<{
  frozen: boolean;
  prototypeIsFunctionPrototype: boolean;
  keys: readonly string[];
  descriptors: readonly Readonly<{
    key: string;
    value: string | number;
    writable: boolean;
    enumerable: boolean;
    configurable: boolean;
  }>[];
}> {
  const descriptors = Reflect.ownKeys(value).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || typeof key !== "string") {
      throw new Error("function surface must contain only string data properties");
    }
    return Object.freeze({
      key,
      value: descriptor.value as string | number,
      writable: descriptor.writable,
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable
    });
  }).sort((left, right) => left.key.localeCompare(right.key));
  return Object.freeze({
    frozen: Object.isFrozen(value),
    prototypeIsFunctionPrototype: Object.getPrototypeOf(value) === Function.prototype,
    keys: Object.freeze(descriptors.map((descriptor) => descriptor.key)),
    descriptors: Object.freeze(descriptors)
  });
}

function invocationSurface(invoke: Function): Readonly<{
  frozen: boolean;
  prototypeIsFunctionPrototype: boolean;
  keys: readonly string[];
  descriptors: readonly Readonly<{
    key: string;
    writable: boolean;
    enumerable: boolean;
    configurable: boolean;
  }>[];
  rawResultReachable: boolean;
  rawResultDescriptor: boolean;
  forbiddenSymbolReachable: boolean;
  forbiddenSymbolDescriptor: boolean;
  symbols: readonly string[];
}> {
  const descriptors = Reflect.ownKeys(invoke).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(invoke, key);
    if (!descriptor || typeof key !== "string") throw new Error("unexpected invocation descriptor");
    return Object.freeze({
      key,
      writable: "value" in descriptor ? descriptor.writable : false,
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable
    });
  }).sort((left, right) => left.key.localeCompare(right.key));
  return Object.freeze({
    frozen: Object.isFrozen(invoke),
    prototypeIsFunctionPrototype: Object.getPrototypeOf(invoke) === Function.prototype,
    keys: Object.freeze(descriptors.map((descriptor) => descriptor.key)),
    descriptors: Object.freeze(descriptors),
    rawResultReachable: "rawResult" in invoke || Reflect.get(invoke, "rawResult") !== undefined,
    rawResultDescriptor: Boolean(Object.getOwnPropertyDescriptor(invoke, "rawResult")),
    forbiddenSymbolReachable: Symbol.toStringTag in invoke ||
      Reflect.get(invoke, Symbol.toStringTag) !== undefined,
    forbiddenSymbolDescriptor: Boolean(Object.getOwnPropertyDescriptor(invoke, Symbol.toStringTag)),
    symbols: Object.freeze(Object.getOwnPropertySymbols(invoke).map((symbol) => symbol.toString()).sort())
  });
}

function mutationRejected(action: () => unknown): boolean {
  try {
    return action() === false;
  } catch {
    return true;
  }
}

async function runThenableMatrix(): Promise<unknown> {
  const probe = installSyntheticProbe();
  const module = await loadCapabilities();
  type Shape = "getter" | "proxy";
  type ActiveCase = {
    operation: DescriptorOperation;
    shape: Shape;
    capabilities: ContractCapabilities;
    callbackExited: boolean;
    getterRan: boolean;
    getterSawCallbackExited: boolean;
    expired: string;
    reentry: string;
    denials: string[];
  };
  let active: ActiveCase | undefined;
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (!active || active.operation !== operation) return invoke();
    try {
      const inspectThen = (): (() => undefined) => {
        active!.getterRan = true;
        active!.getterSawCallbackExited = active!.callbackExited;
        active!.expired = errorMessage(() => invoke());
        active!.reentry = errorMessage(() => active!.capabilities.openRoot("not-root", "admission"));
        return () => undefined;
      };
      if (active.shape === "getter") {
        return Object.defineProperty(Object.create(null), "then", { get: inspectThen });
      }
      return new Proxy(Object.create(null), {
        get(_target, key) {
          return key === "then" ? inspectThen() : undefined;
        }
      });
    } finally {
      active.callbackExited = true;
    }
  });

  const rows: unknown[] = [];
  for (const operation of ["open_root", "openat", "fstat_sync", "read_sync", "close_sync"] as const) {
    for (const shape of ["getter", "proxy"] as const) {
      const denials: string[] = [];
      const capabilities = new module.ContractCapabilities({
        onDescriptorAuthorityDenial() {
          denials.push("denial");
        }
      });
      let root: CapabilityDescriptor | undefined;
      let fileChain: RetainedFileChain | undefined;
      if (operation === "openat") {
        root = capabilities.openRoot("/", "admission");
        capabilities.stat(root);
        capabilities.markRetained(root, "directory");
      } else if (operation === "fstat_sync" || operation === "close_sync") {
        root = capabilities.openRoot("/", "admission");
      } else if (operation === "read_sync") {
        fileChain = prepareRetainedFile(module, capabilities);
      }
      probe.reset();
      active = {
        operation,
        shape,
        capabilities,
        callbackExited: false,
        getterRan: false,
        getterSawCallbackExited: false,
        expired: "",
        reentry: "",
        denials
      };
      const outer = errorMessage(() => {
        if (operation === "open_root") return capabilities.openRoot("/", "admission");
        if (operation === "openat") {
          if (!root) throw new Error("openat target lacks root");
          return capabilities.openRelative(root, "target", module.FILE_OPEN_FLAGS, "admission");
        }
        if (operation === "fstat_sync") {
          if (!root) throw new Error("stat target lacks root");
          return capabilities.stat(root);
        }
        if (operation === "read_sync") {
          if (!fileChain) throw new Error("read target lacks retained file");
          return capabilities.readRetained(fileChain.file, Buffer.alloc(1), 0, 1, 0, "post_admission");
        }
        if (!root) throw new Error("close target lacks root");
        return capabilities.close(root, "unretained");
      });
      const noRawCounts = rawCounts(probe.rawCalls);
      const receipt = active;
      active = undefined;
      let retry = "NOT_APPLICABLE";
      let retryRawCounts = rawCounts(probe.rawCalls);
      if (operation === "close_sync") {
        probe.reset();
        if (!root) throw new Error("close retry lacks root");
        retry = errorMessage(() => capabilities.close(root!, "unretained"));
        retryRawCounts = rawCounts(probe.rawCalls);
      } else if (fileChain) {
        closeRetained(capabilities, [fileChain.root, fileChain.directory, fileChain.file]);
      } else if (root) {
        capabilities.close(root, operation === "openat" ? "retained" : "unretained");
      }
      rows.push(Object.freeze({
        operation,
        shape,
        outer,
        callbackExited: receipt.callbackExited,
        getterRan: receipt.getterRan,
        getterSawCallbackExited: receipt.getterSawCallbackExited,
        expired: receipt.expired,
        reentry: receipt.reentry,
        denials: Object.freeze([...receipt.denials]),
        raw: noRawCounts,
        retry,
        retryRaw: retryRawCounts
      }));
    }
  }
  return Object.freeze({ rows });
}

async function runInstallerSurface(): Promise<unknown> {
  const module = await loadCapabilities();
  const installer = module.installDescriptorPrimitiveMediator;
  const forbidden = ["reset", "getMediator", "uninstall", "replaceMediator", "rawCallable", "rawResult"] as const;
  const forbiddenSurface = forbidden.map((name) => Object.freeze({
    name,
    reachable: name in installer,
    type: typeof Reflect.get(installer, name),
    callable: typeof Reflect.get(installer, name) === "function"
  }));
  const invalidInstallation = errorMessage(() => {
    (installer as unknown as (candidate: unknown) => void)(null);
  });
  const firstInstallation = errorMessage(() => installer((_operation, invoke) => invoke()));
  return Object.freeze({
    surface: functionSurface(installer),
    forbiddenSurface: Object.freeze(forbiddenSurface),
    setPrototypeRejected: mutationRejected(() => Object.setPrototypeOf(installer, { reset: () => undefined })),
    definePropertyRejected: mutationRejected(() => Reflect.defineProperty(installer, "reset", { value: () => undefined })),
    invalidInstallation,
    firstInstallation,
    secondInstallation: errorMessage(() => installer((_operation, invoke) => invoke()))
  });
}

async function runProxyReflection(): Promise<unknown> {
  const probe = installSyntheticProbe();
  const module = await loadCapabilities();
  const operations: DescriptorOperation[] = [];
  const operationReads = { constructor: 0, tag: 0, prototype: 0, branding: 0 };
  let control: keyof typeof operationReads | undefined;
  const mediator = new Proxy(
    ((operation: DescriptorOperation, invoke: () => unknown) => {
      operations.push(operation);
      return invoke();
    }) as DescriptorPrimitiveMediator,
    {
      get(target, key, receiver) {
        if (key === "constructor") {
          if (control === "constructor") operationReads.constructor += 1;
          else operationReads.constructor += 1;
          throw new Error("PROXY_CONSTRUCTOR_REFLECTION");
        }
        if (key === Symbol.toStringTag) {
          if (control === "branding") operationReads.branding += 1;
          else operationReads.tag += 1;
          throw new Error("PROXY_TAG_REFLECTION");
        }
        return Reflect.get(target, key, receiver);
      },
      getPrototypeOf() {
        operationReads.prototype += 1;
        throw new Error("PROXY_PROTOTYPE_REFLECTION");
      }
    }
  );
  module.installDescriptorPrimitiveMediator(mediator);
  const capabilities = new module.ContractCapabilities();
  const root = capabilities.openRoot("/", "admission");
  capabilities.close(root, "unretained");
  const beforeControls = Object.freeze({ ...operationReads });
  control = "constructor";
  const constructorControl = errorMessage(() => Reflect.get(mediator, "constructor"));
  control = "tag";
  const tagControl = errorMessage(() => Reflect.get(mediator, Symbol.toStringTag));
  control = "prototype";
  const prototypeControl = errorMessage(() => Object.getPrototypeOf(mediator));
  control = "branding";
  const brandingControl = errorMessage(() => Object.prototype.toString.call(mediator));
  control = undefined;
  return Object.freeze({
    operations: Object.freeze(operations),
    raw: rawCounts(probe.rawCalls),
    beforeControls,
    controls: Object.freeze({ constructorControl, tagControl, prototypeControl, brandingControl }),
    afterControls: Object.freeze({ ...operationReads })
  });
}

async function runInvocationSurface(): Promise<unknown> {
  const probe = installSyntheticProbe();
  const module = await loadCapabilities();
  const captures: unknown[] = [];
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    const before = invocationSurface(invoke);
    const returned = invoke();
    const after = invocationSurface(invoke);
    captures.push(Object.freeze({
      operation,
      returnedUndefined: returned === undefined,
      before,
      after,
      mutations: Object.freeze({
        rawResult: mutationRejected(() => Object.defineProperty(invoke, "rawResult", { value: "leak" })),
        getter: mutationRejected(() => Object.defineProperty(invoke, "rawGetter", { get: () => "leak" })),
        symbol: mutationRejected(() => Object.defineProperty(invoke, Symbol("raw"), { value: "leak" })),
        tagSymbol: mutationRejected(() => Object.defineProperty(invoke, Symbol.toStringTag, { value: "leak" })),
        prototype: mutationRejected(() => Reflect.setPrototypeOf(invoke, Object.create(null)))
      })
    }));
    return returned;
  });
  const capabilities = new module.ContractCapabilities();
  const chain = prepareRetainedFile(module, capabilities);
  const bytes = capabilities.readRetained(chain.file, Buffer.alloc(1), 0, 1, 0, "post_admission");
  closeRetained(capabilities, [chain.root, chain.directory, chain.file]);
  return Object.freeze({ bytes, captures: Object.freeze(captures), raw: rawCounts(probe.rawCalls) });
}

async function runInvalidDenials(): Promise<unknown> {
  const probe = installSyntheticProbe();
  const module = await loadCapabilities();
  const denials: unknown[] = [];
  const operations: DescriptorOperation[] = [];
  const capabilities = new module.ContractCapabilities({
    onDescriptorAuthorityDenial(denial) {
      denials.push(denial);
    }
  });
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    operations.push(operation);
    return invoke();
  });
  const root = capabilities.openRoot("/", "admission");
  capabilities.stat(root);
  capabilities.markRetained(root, "directory");
  const file = capabilities.openRelative(root, "payload", module.FILE_OPEN_FLAGS, "admission");
  capabilities.stat(file);
  capabilities.markRetained(file, "file");
  const rows: unknown[] = [];
  const record = (name: string, action: () => unknown): void => {
    const start = denials.length;
    const error = errorMessage(action);
    const events = denials.slice(start).map((event) => Object.freeze({ event, frozen: Object.isFrozen(event) }));
    rows.push(Object.freeze({ name, error, events: Object.freeze(events) }));
  };
  probe.reset();
  operations.length = 0;
  record("root", () => capabilities.openRoot("not-root", "admission"));
  capabilities.sealAdmission();
  record("phase", () => capabilities.openRoot("/", "admission"));
  record("parent", () => capabilities.openRelative(Object.freeze(Object.create(null)) as CapabilityDescriptor, "payload", module.FILE_OPEN_FLAGS, "post_admission"));
  record("flags", () => capabilities.openRelative(root, "payload", 0, "post_admission"));
  record("stat", () => capabilities.stat(0 as never));
  record("read_phase", () => capabilities.readRetained(file, Buffer.alloc(1), 0, 1, 0, "admission"));
  record("read_range", () => capabilities.readRetained(file, Buffer.alloc(1), 1, 1, 0, "post_admission"));
  record("close", () => capabilities.close(file, "verification"));
  const snapshot = Object.freeze({
    rows: Object.freeze(rows),
    operations: Object.freeze([...operations]),
    raw: rawCounts(probe.rawCalls)
  });
  closeRetained(capabilities, [root, file]);
  return snapshot;
}

async function runReentryWindows(): Promise<unknown> {
  const probe = installSyntheticProbe();
  const module = await loadCapabilities();
  type ActiveWindow = {
    operation: DescriptorOperation;
    capabilities: ContractCapabilities;
    probe: CapabilityDescriptor;
    errors: Record<string, string>;
    during: Readonly<{ denials: number; closeAttempts: number; authorityViolations: number; raw: RawCountReceipt }>;
    counts: { denials: number; closeAttempts: number; authorityViolations: number };
  };
  let active: ActiveWindow | undefined;
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (!active || active.operation !== operation) return invoke();
    const before = {
      denials: active.counts.denials,
      closeAttempts: active.counts.closeAttempts,
      authorityViolations: active.counts.authorityViolations
    };
    const reentries: Readonly<Record<string, () => unknown>> = {
      sealAdmission: () => active!.capabilities.sealAdmission(),
      openRoot: () => active!.capabilities.openRoot("not-root", "admission"),
      openRelative: () => active!.capabilities.openRelative(active!.probe, "child", module.FILE_OPEN_FLAGS, "post_admission"),
      markRetained: () => active!.capabilities.markRetained(active!.probe, "directory"),
      stat: () => active!.capabilities.stat(active!.probe),
      readRetained: () => active!.capabilities.readRetained(active!.probe, Buffer.alloc(1), 0, 1, 0, "post_admission"),
      close: () => active!.capabilities.close(active!.probe, "retained"),
      rejectForbidden: () => active!.capabilities.rejectForbidden("file_write", "admission")
    };
    for (const [name, reentry] of Object.entries(reentries)) active.errors[name] = errorMessage(reentry);
    active.during = Object.freeze({
      denials: active.counts.denials - before.denials,
      closeAttempts: active.counts.closeAttempts - before.closeAttempts,
      authorityViolations: active.counts.authorityViolations - before.authorityViolations,
      raw: rawCounts(probe.rawCalls)
    });
    return invoke();
  });

  const rows: unknown[] = [];
  for (const operation of ["open_root", "openat", "fstat_sync", "read_sync", "close_sync"] as const) {
    const counts = { denials: 0, closeAttempts: 0, authorityViolations: 0 };
    const capabilities = new module.ContractCapabilities({
      onDescriptorAuthorityDenial() { counts.denials += 1; },
      onCloseAttempt() { counts.closeAttempts += 1; },
      onAuthorityViolation() { counts.authorityViolations += 1; }
    });
    const lifecycleProbe = capabilities.openRoot("/", "admission");
    capabilities.stat(lifecycleProbe);
    let root: CapabilityDescriptor | undefined;
    let chain: RetainedFileChain | undefined;
    if (operation === "openat") {
      root = capabilities.openRoot("/", "admission");
      capabilities.stat(root);
      capabilities.markRetained(root, "directory");
    } else if (operation === "fstat_sync" || operation === "close_sync") {
      root = capabilities.openRoot("/", "admission");
    } else if (operation === "read_sync") {
      chain = prepareRetainedFile(module, capabilities);
    }
    const window: ActiveWindow = {
      operation,
      capabilities,
      probe: lifecycleProbe,
      errors: Object.create(null),
      during: Object.freeze({ denials: -1, closeAttempts: -1, authorityViolations: -1, raw: rawCounts(probe.rawCalls) }),
      counts
    };
    probe.reset();
    active = window;
    let opened: CapabilityDescriptor | undefined;
    if (operation === "open_root") {
      opened = capabilities.openRoot("/", "admission");
    } else if (operation === "openat") {
      if (!root) throw new Error("openat reentry target lacks root");
      opened = capabilities.openRelative(root, "child", module.FILE_OPEN_FLAGS, "admission");
    } else if (operation === "fstat_sync") {
      if (!root) throw new Error("stat reentry target lacks root");
      capabilities.stat(root);
    } else if (operation === "read_sync") {
      if (!chain) throw new Error("read reentry target lacks file");
      capabilities.readRetained(chain.file, Buffer.alloc(1), 0, 1, 0, "post_admission");
    } else {
      if (!root) throw new Error("close reentry target lacks root");
      capabilities.close(root, "unretained");
    }
    active = undefined;
    const outerRaw = rawCounts(probe.rawCalls);
    const pendingStable = errorMessage(() => capabilities.close(lifecycleProbe, "unretained")) === "NO_ERROR";
    let admissionStable: boolean | null = null;
    if (operation !== "read_sync") {
      const admissionProbe = errorMessage(() => {
        const descriptor = capabilities.openRoot("/", "admission");
        capabilities.close(descriptor, "unretained");
      });
      admissionStable = admissionProbe === "NO_ERROR";
    }
    if (opened) capabilities.close(opened, "unretained");
    if (chain) closeRetained(capabilities, [chain.root, chain.directory, chain.file]);
    if (root && operation !== "close_sync") {
      capabilities.close(root, operation === "openat" ? "retained" : "unretained");
    }
    rows.push(Object.freeze({
      operation,
      errors: Object.freeze({ ...window.errors }),
      during: window.during,
      pendingStable,
      admissionStable,
      outerRaw
    }));
  }
  return Object.freeze({ rows });
}

async function runOpenAtTuple(): Promise<unknown> {
  const probe = installSyntheticProbe();
  const module = await loadCapabilities();
  const operations: DescriptorOperation[] = [];
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    operations.push(operation);
    return invoke();
  });
  const capabilities = new module.ContractCapabilities();
  const chain = prepareRetainedFile(module, capabilities);
  const openAt = Object.freeze([...probe.rawCalls.openAt]);
  const descriptorsClosedBefore = probe.rawCalls.close.length;
  closeRetained(capabilities, [chain.root, chain.directory, chain.file]);
  return Object.freeze({
    operations: Object.freeze(operations),
    openAt,
    closeDescriptors: Object.freeze(probe.rawCalls.close.slice(descriptorsClosedBefore)),
    raw: rawCounts(probe.rawCalls)
  });
}

try {
  let result: unknown;
  switch (scenario) {
    case "thenable_matrix":
      result = await runThenableMatrix();
      break;
    case "installer_surface":
      result = await runInstallerSurface();
      break;
    case "proxy_reflection":
      result = await runProxyReflection();
      break;
    case "invocation_surface":
      result = await runInvocationSurface();
      break;
    case "invalid_denials":
      result = await runInvalidDenials();
      break;
    case "reentry_windows":
      result = await runReentryWindows();
      break;
    case "openat_tuple":
      result = await runOpenAtTuple();
      break;
    default:
      throw new Error("round-two mediation child requires a scenario");
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
