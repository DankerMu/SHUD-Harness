import { mock } from "bun:test";
import * as originalFs from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type CloseOwner = "unretained" | "retained" | "verification";
type CloseAttempt = Readonly<{ owner: CloseOwner; ordinal: number }>;
type IngressOperation = Readonly<{
  phase: "admission" | "post_admission";
  operation: "open_root" | "open_relative" | "read_retained";
  path: string;
}>;
type CloseHooks = {
  afterAdmission?: (path: string) => void | Promise<void>;
  /** Widened past the production literal union so hostile values can be injected. */
  authorityFault?: unknown;
  closeFault?: (attempt: CloseAttempt) => boolean;
  observe?: (operation: IngressOperation) => void;
  onAuthorityViolation?: (fault: string) => void;
  onCloseAttempt?: (attempt: CloseAttempt) => void;
  onDescriptorAuthorityDenial?: (denial: unknown) => void;
};
type Entry = "ingress" | "checker";
type Scenario =
  | "authority_fault"
  | "identity"
  | "retry"
  | "terminal_return"
  | "terminal_throw"
  | "hostile"
  | "falsy"
  | "inherited"
  | "sink"
  | "reentry"
  | "read"
  | "thenable"
  | "concurrency";
type EntryOutcome = Readonly<{ code: string | null; exit: number | null; stdout: string; stderr: string }>;
type Counters = Readonly<{ openRoot: number; openat: number; fstat: number; read: number; close: number }>;
type CapabilityInstance = {
  close: (descriptor: object, owner: CloseOwner) => void;
  markRetained: (descriptor: object, kind: "file" | "directory") => void;
  openRelative: (parent: object, childName: string, flags: number, phase: string) => object;
  openRoot: (root: string, phase: string) => object;
  readRetained: (
    descriptor: object,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    phase: string
  ) => number;
  rejectForbidden: (fault: unknown, phase: string) => never;
  sealAdmission: () => void;
  stat: (descriptor: object) => unknown;
};
type CapabilitiesModule = Readonly<{
  ContractCapabilities: {
    new (hooks?: CloseHooks): CapabilityInstance;
    prototype: CapabilityInstance;
  };
  DIRECTORY_OPEN_FLAGS: number;
  FILE_OPEN_FLAGS: number;
}>;
type IngressModule = Readonly<{
  readBoundedFile: (
    path: string,
    maximum: number,
    hooks?: CloseHooks,
    beforeCleanup?: (bytes: Uint8Array) => void
  ) => Promise<Uint8Array>;
}>;
type CheckerModule = Readonly<{
  runCheckForTest: (
    args: readonly string[],
    io: Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>,
    hooks: CloseHooks
  ) => Promise<number>;
}>;
type Modules = Readonly<{
  capabilities: CapabilitiesModule;
  ingress: IngressModule;
  checker: CheckerModule;
}>;

const [scenarioArgument, entryArgument, originArgument] = process.argv.slice(2) as [
  Scenario | undefined,
  string | undefined,
  string | undefined
];
if (!scenarioArgument || !entryArgument) throw new Error("close runtime child requires a scenario and entry");
const scenario = scenarioArgument;
const productionRoot = process.env.SHUD_DESCRIPTOR_PRODUCTION_ROOT;
const contractsRoot = resolve(import.meta.dir, "..");
const validInput = resolve(contractsRoot, "fixtures", "valid", "source-input-record-paired-surrogate.json");
const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
const raw = { closeSync: 0, openSync: 0, fstatSync: 0, readSync: 0, openat: 0 };
let throwNextClose = false;

const PROXY_TRAPS = [
  "apply", "construct", "defineProperty", "deleteProperty", "get", "getOwnPropertyDescriptor",
  "getPrototypeOf", "has", "isExtensible", "ownKeys", "preventExtensions", "set", "setPrototypeOf"
] as const;
const PRIMITIVE_PROBE_KEYS = ["code", "message", "name"] as const;
const LISTENER_METHODS = [
  "addListener", "off", "on", "once", "prependListener", "prependOnceListener",
  "removeAllListeners", "removeListener"
] as const;
const REJECTION_EVENTS = ["rejectionHandled", "unhandledRejection"] as const;

const proxyTraps: Record<string, number> = {};
const primitiveProbes: Record<string, number> = {};
const sinkTrace = { listenerCalls: 0, peekCalls: 0 };

function moduleSpecifier(name: "capabilities" | "checker" | "ingress"): string {
  if (!productionRoot) return `../lib/${name}`;
  return pathToFileURL(resolve(productionRoot, "lib", `${name}.ts`)).href;
}

function snapshotRaw(): Counters {
  return Object.freeze({
    openRoot: raw.openSync,
    openat: raw.openat,
    fstat: raw.fstatSync,
    read: raw.readSync,
    close: raw.closeSync
  });
}

function descriptorCount(): number {
  return originalFs.readdirSync(descriptorDirectory).length;
}

function installRawProbe(): void {
  const original = Object.freeze({
    closeSync: originalFs.closeSync,
    fstatSync: originalFs.fstatSync,
    openSync: originalFs.openSync,
    readSync: originalFs.readSync
  });
  mock.module("node:fs", () => ({
    ...originalFs,
    closeSync(...args: Parameters<typeof original.closeSync>): void {
      raw.closeSync += 1;
      if (throwNextClose) {
        throwNextClose = false;
        throw new Error("CLOSE_RUNTIME_RAW_THROW");
      }
      original.closeSync(...args);
    },
    fstatSync(...args: Parameters<typeof original.fstatSync>): unknown {
      raw.fstatSync += 1;
      return (original.fstatSync as (...values: unknown[]) => unknown)(...args);
    },
    openSync(...args: Parameters<typeof original.openSync>): number {
      raw.openSync += 1;
      return original.openSync(...args);
    },
    readSync(...args: Parameters<typeof original.readSync>): number {
      raw.readSync += 1;
      return (original.readSync as (...values: unknown[]) => number)(...args);
    }
  }));
}

/**
 * `openat` has no mockable Node seam, so the mediated entry that owns it is the
 * counting point: `openRelative` returns a descriptor only after its one raw
 * `openat` succeeded.
 */
function installOpenAtProbe(modules: Modules): void {
  const prototype = modules.capabilities.ContractCapabilities.prototype;
  const original = prototype.openRelative;
  prototype.openRelative = function(this: CapabilityInstance, parent, childName, flags, phase): object {
    const descriptor = Reflect.apply(original, this, [parent, childName, flags, phase]) as object;
    raw.openat += 1;
    return descriptor;
  };
}

function installPrimitiveProbe(): void {
  for (const prototype of [Number.prototype, String.prototype, Boolean.prototype]) {
    for (const key of PRIMITIVE_PROBE_KEYS) {
      Object.defineProperty(prototype, key, {
        configurable: true,
        enumerable: false,
        get(): undefined {
          primitiveProbes[key] = (primitiveProbes[key] ?? 0) + 1;
          return undefined;
        }
      });
    }
  }
}

function installSinkProbe(): void {
  const emitter = process as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of LISTENER_METHODS) {
    const original = emitter[method]!;
    emitter[method] = function(this: unknown, ...args: unknown[]): unknown {
      sinkTrace.listenerCalls += 1;
      return Reflect.apply(original, this, args);
    };
  }
  const peek = (Bun as unknown as Record<string, (...args: unknown[]) => unknown>).peek;
  (Bun as unknown as Record<string, unknown>).peek = function(this: unknown, ...args: unknown[]): unknown {
    sinkTrace.peekCalls += 1;
    return Reflect.apply(peek, this, args);
  };
}

/** All-trap hostile mediator value: every Proxy trap records one observation. */
function hostileValue(): object {
  const target = function hostileMediatorValue(): void { /* observable target */ };
  const handler: ProxyHandler<typeof target> = {};
  for (const trap of PROXY_TRAPS) {
    (handler as Record<string, unknown>)[trap] = (...args: unknown[]): unknown => {
      proxyTraps[trap] = (proxyTraps[trap] ?? 0) + 1;
      return (Reflect as unknown as Record<string, (...values: unknown[]) => unknown>)[trap]!(...args);
    };
  }
  return new Proxy(target, handler);
}

function observedTraps(): Readonly<Record<string, number>> {
  return Object.freeze({ ...proxyTraps });
}

function totalTraps(observed: Readonly<Record<string, number>>): number {
  return Object.values(observed).reduce((total, count) => total + count, 0);
}

async function loadModules(): Promise<Modules> {
  const [capabilities, ingress, checker] = await Promise.all([
    import(moduleSpecifier("capabilities")),
    import(moduleSpecifier("ingress")),
    import(moduleSpecifier("checker"))
  ]);
  return Object.freeze({
    capabilities: capabilities as CapabilitiesModule,
    ingress: ingress as IngressModule,
    checker: checker as CheckerModule
  });
}

async function runEntry(
  entry: Entry,
  modules: Modules,
  hooks: CloseHooks,
  onSettled?: () => void,
  beforeCleanup?: (bytes: Uint8Array) => void
): Promise<EntryOutcome> {
  if (entry === "ingress") {
    try {
      await modules.ingress.readBoundedFile(validInput, 64 * 1024, hooks, beforeCleanup);
      onSettled?.();
      return Object.freeze({ code: null, exit: null, stdout: "", stderr: "" });
    } catch (error) {
      onSettled?.();
      return Object.freeze({
        code: error instanceof Error ? error.message : "NON_ERROR_THROWN",
        exit: null,
        stdout: "",
        stderr: ""
      });
    }
  }
  let stdout = "";
  let stderr = "";
  const exit = await modules.checker.runCheckForTest(
    ["--input", validInput, "--kind", "source_input_record"],
    { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    hooks
  );
  onSettled?.();
  const parsed = stderr ? JSON.parse(stderr) as Readonly<{ code?: unknown }> : {};
  return Object.freeze({
    code: typeof parsed.code === "string" ? parsed.code : null,
    exit,
    stdout,
    stderr
  });
}

function identityHooks(): Readonly<{
  hooks: CloseHooks;
  receipt: () => Readonly<{
    allFrozen: boolean; closeFaultCalls: number; onCloseCalls: number; sameAttempt: boolean;
  }>;
}> {
  const seen = new WeakSet<object>();
  let allFrozen = true;
  let closeFaultCalls = 0;
  let onCloseCalls = 0;
  let sameAttempt = true;
  const hooks: CloseHooks = Object.freeze({
    closeFault: (attempt) => {
      closeFaultCalls += 1;
      allFrozen &&= Object.isFrozen(attempt);
      sameAttempt &&= seen.has(attempt);
      return false;
    },
    onCloseAttempt: (attempt) => {
      onCloseCalls += 1;
      allFrozen &&= Object.isFrozen(attempt);
      seen.add(attempt);
    }
  });
  return Object.freeze({
    hooks,
    receipt: () => Object.freeze({ allFrozen, closeFaultCalls, onCloseCalls, sameAttempt })
  });
}

async function runIdentity(modules: Modules, entry: string): Promise<unknown> {
  const probe = identityHooks();
  let outcome: EntryOutcome;
  if (entry === "capability") {
    const capabilities = new modules.capabilities.ContractCapabilities(probe.hooks);
    const descriptor = capabilities.openRoot("/", "admission");
    capabilities.close(descriptor, "unretained");
    outcome = Object.freeze({ code: null, exit: null, stdout: "", stderr: "" });
  } else {
    outcome = await runEntry(entry as Entry, modules, probe.hooks);
  }
  return Object.freeze({ entry, outcome, rawCloseCalls: raw.closeSync, ...probe.receipt() });
}

async function runRetry(modules: Modules, entry: Entry): Promise<unknown> {
  const attempts: CloseAttempt[] = [];
  const probe = identityHooks();
  const hooks: CloseHooks = Object.freeze({
    closeFault: (attempt) => probe.hooks.closeFault!(attempt),
    onCloseAttempt: (attempt) => {
      attempts.push(attempt);
      probe.hooks.onCloseAttempt!(attempt);
    }
  });
  const outcome = await runEntry(entry, modules, hooks);
  const first = attempts[0];
  const second = attempts[1];
  return Object.freeze({
    entry,
    outcome,
    rawCloseCalls: raw.closeSync,
    firstAndSecondDistinct: first !== undefined && second !== undefined && first !== second,
    firstAndSecondFrozen: Boolean(first && second && Object.isFrozen(first) && Object.isFrozen(second)),
    firstTwoAttempts: attempts.length >= 2,
    ...probe.receipt()
  });
}

async function runTerminal(modules: Modules, entry: Entry, shouldThrow: boolean): Promise<unknown> {
  const probe = identityHooks();
  const originalClose = modules.capabilities.ContractCapabilities.prototype.close;
  let target: object | undefined;
  let targetCloseCalls = 0;
  let targetRawStarts = 0;
  modules.capabilities.ContractCapabilities.prototype.close = function(
    this: CapabilityInstance,
    descriptor: object,
    owner: CloseOwner
  ): void {
    if (target === undefined) target = descriptor;
    if (descriptor !== target) return Reflect.apply(originalClose, this, [descriptor, owner]);
    targetCloseCalls += 1;
    const before = raw.closeSync;
    try {
      return Reflect.apply(originalClose, this, [descriptor, owner]);
    } finally {
      targetRawStarts += raw.closeSync - before;
    }
  };
  throwNextClose = shouldThrow;
  const outcome = await runEntry(entry, modules, probe.hooks);
  return Object.freeze({ entry, outcome, targetCloseCalls, targetRawStarts, ...probe.receipt() });
}

const FALSY_SITES = ["observe_open_relative_1", "after_admission_1", "close_attempt_1"] as const;
const HOSTILE_SITES = [
  "after_admission_1",
  "observe_open_root",
  "observe_open_relative_1",
  "observe_open_relative_2",
  "observe_read_1",
  "observe_read_2",
  "close_attempt_1",
  "close_fault_1"
] as const;
type HostileSite = typeof HOSTILE_SITES[number] | typeof FALSY_SITES[number];

function hostileInjection(
  site: HostileSite,
  makeValue: () => unknown,
  valueMode: "thrown" | "returned"
): Readonly<{ hooks: CloseHooks; state: { injected: boolean; rawAtInjection: Counters | null } }> {
  const occurrences = new Map<string, number>();
  const state = { injected: false, rawAtInjection: null as Counters | null };
  const indexed = (base: string): string => {
    const index = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, index);
    return `${base}_${index}`;
  };
  const fire = (candidate: string): unknown => {
    if (state.injected || candidate !== site) return undefined;
    state.injected = true;
    state.rawAtInjection = snapshotRaw();
    const value = makeValue();
    if (valueMode === "thrown") throw value;
    return value;
  };
  const hooks: CloseHooks = Object.freeze({
    afterAdmission: (() => fire(indexed("after_admission"))) as unknown as (path: string) => void,
    closeFault: (() => fire(indexed("close_fault")) ?? false) as unknown as (attempt: CloseAttempt) => boolean,
    observe: ((operation: IngressOperation) => fire(
      operation.operation === "open_root"
        ? "observe_open_root"
        : operation.operation === "read_retained"
        ? indexed("observe_read")
        : operation.phase === "admission"
        ? indexed("observe_open_relative")
        : indexed("observe_verify_relative")
    )) as unknown as (operation: IngressOperation) => void,
    onCloseAttempt: (() => fire(indexed("close_attempt"))) as unknown as (attempt: CloseAttempt) => void
  });
  return Object.freeze({ hooks, state });
}

function rawDelta(before: Counters, after: Counters): Counters {
  return Object.freeze({
    openRoot: after.openRoot - before.openRoot,
    openat: after.openat - before.openat,
    fstat: after.fstat - before.fstat,
    read: after.read - before.read,
    close: after.close - before.close
  });
}

function resetObservations(): void {
  for (const key of Object.keys(proxyTraps)) delete proxyTraps[key];
  for (const key of Object.keys(primitiveProbes)) delete primitiveProbes[key];
}

async function hostileRow(
  modules: Modules,
  entry: Entry,
  site: HostileSite,
  valueMode: "thrown" | "returned",
  makeValue: () => unknown
): Promise<unknown> {
  const injection = hostileInjection(site, makeValue, valueMode);
  resetObservations();
  const fdBefore = descriptorCount();
  const rawBefore = snapshotRaw();
  let trapsAtSettlement: Readonly<Record<string, number>> | undefined;
  let probesAtSettlement: Readonly<Record<string, number>> | undefined;
  const outcome = await runEntry(entry, modules, injection.hooks, () => {
    trapsAtSettlement = observedTraps();
    probesAtSettlement = Object.freeze({ ...primitiveProbes });
  });
  return Object.freeze({
    entry,
    site,
    valueMode,
    injected: injection.state.injected,
    rawAtInjection: injection.state.rawAtInjection === null
      ? null
      : rawDelta(rawBefore, injection.state.rawAtInjection),
    rawFinal: rawDelta(rawBefore, snapshotRaw()),
    outcome,
    traps: totalTraps(trapsAtSettlement ?? {}),
    trapNames: Object.keys(trapsAtSettlement ?? {}).sort(),
    primitiveProbes: totalTraps(probesAtSettlement ?? {}),
    fdBefore,
    fdAfter: descriptorCount()
  });
}

async function runHostile(modules: Modules, entry: Entry): Promise<unknown> {
  const baselineFd = descriptorCount();
  const baselineRawBefore = snapshotRaw();
  const baseline = await runEntry(entry, modules, Object.freeze({}));
  const baselineRaw = rawDelta(baselineRawBefore, snapshotRaw());
  const rows: unknown[] = [];
  for (const valueMode of ["thrown", "returned"] as const) {
    for (const site of HOSTILE_SITES) {
      rows.push(await hostileRow(modules, entry, site, valueMode, hostileValue));
    }
  }
  return Object.freeze({
    entry,
    baseline: Object.freeze({ outcome: baseline, raw: baselineRaw, fdBefore: baselineFd, fdAfter: descriptorCount() }),
    rows: Object.freeze(rows)
  });
}

const FALSY_VALUES = ["undefined", "null", "zero", "empty_string", "false"] as const;
const FALSY_BY_NAME: Readonly<Record<typeof FALSY_VALUES[number], unknown>> = Object.freeze({
  undefined: undefined,
  null: null,
  zero: 0,
  empty_string: "",
  false: false
});

async function runFalsy(modules: Modules, entry: Entry): Promise<unknown> {
  const rows: unknown[] = [];
  for (const name of FALSY_VALUES) {
    for (const site of FALSY_SITES) {
      const row = await hostileRow(modules, entry, site, "thrown", () => FALSY_BY_NAME[name]);
      rows.push(Object.freeze({ ...(row as object), falsyValue: name }));
    }
  }
  return Object.freeze({ entry, rows: Object.freeze(rows) });
}

class InheritedIngressHooks {
  closeFaultCalls = 0;
  closeAttemptCalls = 0;
  afterAdmissionCalls = 0;
  getterReads = 0;
  getterReadsAtAdmission = 0;
  getterReceiverMatches = true;
  faultReceiverMatches = true;
  closeAttemptReceiverMatches = true;
  afterAdmissionReceiverMatches = true;

  onCloseAttempt(this: InheritedIngressHooks): void {
    this.closeAttemptCalls += 1;
    this.closeAttemptReceiverMatches &&= this instanceof InheritedIngressHooks;
  }

  afterAdmission(this: InheritedIngressHooks): void {
    this.afterAdmissionCalls += 1;
    this.afterAdmissionReceiverMatches &&= this instanceof InheritedIngressHooks;
    this.getterReadsAtAdmission = this.getterReads;
  }
}

Object.defineProperty(InheritedIngressHooks.prototype, "closeFault", {
  configurable: true,
  enumerable: false,
  get(this: InheritedIngressHooks): () => boolean {
    this.getterReads += 1;
    this.getterReceiverMatches &&= this instanceof InheritedIngressHooks;
    return function inheritedCloseFault(this: InheritedIngressHooks): boolean {
      this.closeFaultCalls += 1;
      this.faultReceiverMatches &&= this instanceof InheritedIngressHooks;
      return false;
    };
  }
});

async function runInherited(modules: Modules, entry: Entry): Promise<unknown> {
  const hooks = new InheritedIngressHooks();
  const outcome = await runEntry(entry, modules, hooks as unknown as CloseHooks);
  return Object.freeze({
    entry,
    outcome,
    afterAdmissionCalls: hooks.afterAdmissionCalls,
    afterAdmissionReceiverMatches: hooks.afterAdmissionReceiverMatches,
    closeAttemptCalls: hooks.closeAttemptCalls,
    closeAttemptReceiverMatches: hooks.closeAttemptReceiverMatches,
    closeFaultCalls: hooks.closeFaultCalls,
    faultReceiverMatches: hooks.faultReceiverMatches,
    getterReads: hooks.getterReads,
    getterReadsAtAdmission: hooks.getterReadsAtAdmission,
    getterReceiverMatches: hooks.getterReceiverMatches,
    ownHookProperties: Object.getOwnPropertyNames(hooks).filter(
      (name) => name === "closeFault" || name === "onCloseAttempt" || name === "afterAdmission"
    ),
    prototypeHookProperties: ["afterAdmission", "closeFault", "onCloseAttempt"].filter(
      (name) => Object.hasOwn(InheritedIngressHooks.prototype, name)
    )
  });
}

function rejectionListenerCounts(): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const event of REJECTION_EVENTS) counts[event] = process.listenerCount(event);
  return Object.freeze(counts);
}

async function runSink(modules: Modules, entry: Entry): Promise<unknown> {
  const promiseBefore = globalThis.Promise;
  const thenBefore = globalThis.Promise.prototype.then;
  const listenersBefore = rejectionListenerCounts();
  const listenerCallsBefore = sinkTrace.listenerCalls;
  const peekCallsBefore = sinkTrace.peekCalls;
  const outcome = await runEntry(entry, modules, Object.freeze({}));
  return Object.freeze({
    entry,
    outcome,
    listenerCalls: sinkTrace.listenerCalls - listenerCallsBefore,
    listenersBefore,
    listenersAfter: rejectionListenerCounts(),
    peekCalls: sinkTrace.peekCalls - peekCallsBefore,
    promiseIdentityStable: globalThis.Promise === promiseBefore,
    promiseThenStable: globalThis.Promise.prototype.then === thenBefore
  });
}

type ReentryOrigin =
  | "observe"
  | "close_attempt"
  | "close_fault"
  | "authority_violation"
  | "after_admission"
  | "after_admission_async"
  | "admission_promise_adoption"
  | "accessor_observe"
  | "accessor_authority_fault"
  | "authority_fault_coercion"
  | "before_cleanup"
  | "denial";
type ReentryRow = Readonly<{ method: string; outcome: string; rawDelta: number; denialCalls: number }>;

/** The receipt an operation that never settled reports instead of an outcome. */
const UNSETTLED_OUTCOME: EntryOutcome = Object.freeze({
  code: "UNSETTLED_OPERATION",
  exit: null,
  stdout: "",
  stderr: ""
});

/** Origins driven through the shared ingress hooks object, in receipt order. */
const HOOK_REENTRY_ORIGINS: readonly ReentryOrigin[] = [
  "observe",
  "close_attempt",
  "close_fault",
  "authority_violation",
  "after_admission",
  "after_admission_async",
  "admission_promise_adoption",
  "accessor_observe",
  "accessor_authority_fault",
  "authority_fault_coercion",
  "before_cleanup"
];

type AdoptionShape = "genuine_promise_hostile_constructor" | "promise_subclass_hostile_then";
const ADOPTION_SHAPES: readonly AdoptionShape[] = [
  "genuine_promise_hostile_constructor",
  "promise_subclass_hostile_then"
];

/**
 * Adoption-identity mediator values for `afterAdmission`. Both are promises by
 * internal slot, so an internal-slot test alone admits them, and both have a
 * foreign identity, so `await` would resolve them through the generic promise
 * path: it reads `constructor` and then `then` off the first, and calls the
 * overridden `then` of the second. Each of those reads is a mediator control
 * point that runs during promise resolution - after the latch that invoked the
 * hook has returned - and each hands back a value that never settles, so an
 * adopting boundary also strands every descriptor the operation still holds.
 */
function hostileIdentityPromise(
  shape: AdoptionShape,
  onRead: (key: "constructor" | "then") => void
): unknown {
  if (shape === "genuine_promise_hostile_constructor") {
    // A genuine, already-resolved promise carrying two own accessors. Its
    // prototype is untouched, so only the own-key test can tell it apart.
    const admitted = Promise.resolve();
    const hijack = (key: "constructor" | "then", value: unknown): void => {
      Object.defineProperty(admitted, key, {
        configurable: true,
        enumerable: false,
        get(): unknown {
          onRead(key);
          return value;
        }
      });
    };
    hijack("constructor", function HijackedPromiseConstructor(): void { /* not the intrinsic */ });
    hijack("then", (): void => { /* the adopted value never settles */ });
    return admitted;
  }
  // A `Promise` subclass instance with no own key at all, so only the prototype
  // test can tell it apart. `then` is redefined on the subclass prototype, so
  // the instance itself stays indistinguishable by own keys.
  class HostileIdentityPromise extends Promise<void> {}
  Object.defineProperty(HostileIdentityPromise.prototype, "then", {
    configurable: true,
    enumerable: false,
    writable: true,
    value(): Promise<void> {
      onRead("then");
      return new Promise<void>(() => { /* the adopted value never settles */ });
    }
  });
  return HostileIdentityPromise.resolve();
}

/**
 * Accessor-form hooks: `observe` and `authorityFault` are prototype getters, so
 * the reentry attempt originates in the property lookup itself rather than in a
 * hook call. The `authorityFault` getter also reports a different fault on a
 * second read, so any double lookup is visible in the violation receipt.
 */
class AccessorIngressHooks {
  armed = false;
  authorityFaultReads = 0;
  observeReads = 0;
  readonly faults: string[] = [];

  constructor(
    readonly origin: ReentryOrigin,
    readonly run: (candidate: ReentryOrigin) => void,
    readonly countDenial: () => void
  ) {}

  afterAdmission(this: AccessorIngressHooks): void {
    this.armed = true;
  }

  onAuthorityViolation(this: AccessorIngressHooks, fault: string): void {
    this.faults.push(fault);
  }

  onDescriptorAuthorityDenial(this: AccessorIngressHooks): void {
    this.countDenial();
  }
}

Object.defineProperty(AccessorIngressHooks.prototype, "observe", {
  configurable: true,
  enumerable: false,
  get(this: AccessorIngressHooks): (operation: IngressOperation) => void {
    this.observeReads += 1;
    if (this.armed) this.run("accessor_observe");
    return (): void => undefined;
  }
});

Object.defineProperty(AccessorIngressHooks.prototype, "authorityFault", {
  configurable: true,
  enumerable: false,
  get(this: AccessorIngressHooks): string | undefined {
    this.authorityFaultReads += 1;
    if (this.origin !== "accessor_authority_fault") return undefined;
    this.run("accessor_authority_fault");
    return this.authorityFaultReads === 1 ? "file_write" : "child_spawn";
  }
});

/**
 * Value-shaped hostile mediator seam. `authorityFault` is a value, not a
 * callback, so the only control it can seize is an implicit coercion of itself.
 * Every string conversion route runs the injected attempt and then returns a
 * valid fault literal, so a boundary that coerces the value records the attempt
 * twice: in the coercion count and in the reentry battery it was able to run.
 */
function coercingAuthorityFault(onCoercion: () => void): object {
  const coerce = (): string => {
    onCoercion();
    return "file_write";
  };
  return Object.freeze({
    [Symbol.toPrimitive]: coerce,
    toString: coerce,
    valueOf: coerce
  });
}

function reentryBattery(
  modules: Modules,
  capabilities: CapabilityInstance | undefined,
  descriptors: Readonly<{ root: object | undefined; file: object | undefined; token: object | undefined }>,
  denialCount: () => number,
  pending: Array<Promise<ReentryRow>>
): readonly ReentryRow[] {
  const rows: ReentryRow[] = [];
  const prototype = modules.capabilities.ContractCapabilities.prototype;
  const root = descriptors.root ?? Object.freeze({});
  const file = descriptors.file ?? Object.freeze({});
  const token = descriptors.token ?? Object.freeze({});
  const attempt = (method: string, action: () => void): void => {
    const before = snapshotRaw();
    const denialsBefore = denialCount();
    let outcome = "NO_ERROR";
    try {
      action();
    } catch (error) {
      outcome = error instanceof Error ? error.message : "NON_ERROR_THROWN";
    }
    const after = snapshotRaw();
    rows.push(Object.freeze({
      method,
      outcome,
      rawDelta: (after.openRoot - before.openRoot) + (after.openat - before.openat) +
        (after.fstat - before.fstat) + (after.read - before.read) + (after.close - before.close),
      denialCalls: denialCount() - denialsBefore
    }));
  };
  if (!capabilities) throw new Error("reentry battery lacks a captured capability");
  attempt("sealAdmission", () => { capabilities.sealAdmission(); });
  attempt("openRoot", () => { capabilities.openRoot("/", "admission"); });
  attempt("openRelative", () => {
    capabilities.openRelative(root, "etc", modules.capabilities.DIRECTORY_OPEN_FLAGS, "post_admission");
  });
  attempt("markRetained", () => { capabilities.markRetained(file, "file"); });
  attempt("stat", () => { capabilities.stat(file); });
  attempt("readRetained", () => {
    capabilities.readRetained(file, Buffer.alloc(8), 0, 8, 0, "post_admission");
  });
  attempt("close", () => { capabilities.close(file, "retained"); });
  attempt("rejectForbidden", () => { capabilities.rejectForbidden("file_write", "post_admission"); });
  attempt("prototype_close", () => {
    Reflect.apply(prototype.close, capabilities, [file, "retained"]);
  });
  attempt("captured_token_stat", () => { capabilities.stat(token); });
  const before = snapshotRaw();
  const nested = modules.ingress.readBoundedFile(validInput, 64 * 1024, Object.freeze({}));
  const after = snapshotRaw();
  // The public ingress entry rejects synchronously, so its synchronous-phase raw
  // delta is the whole reentrant descriptor effect of the nested call.
  const synchronousDelta = (after.openRoot - before.openRoot) + (after.openat - before.openat) +
    (after.fstat - before.fstat) + (after.read - before.read) + (after.close - before.close);
  pending.push(nested.then(
    () => Object.freeze({
      method: "ingress_read_bounded_file",
      outcome: "NO_ERROR",
      rawDelta: synchronousDelta,
      denialCalls: 0
    }),
    (error: unknown) => Object.freeze({
      method: "ingress_read_bounded_file",
      outcome: error instanceof Error ? error.message : "NON_ERROR_THROWN",
      rawDelta: synchronousDelta,
      denialCalls: 0
    })
  ));
  return Object.freeze(rows);
}

async function runReentry(modules: Modules, entry: Entry): Promise<unknown> {
  const prototype = modules.capabilities.ContractCapabilities.prototype;
  const originalOpenRoot = prototype.openRoot;
  const originalOpenRelative = prototype.openRelative;
  const results: unknown[] = [];
  // `beforeCleanup` is an ingress-entry parameter, so the checker cannot install
  // a hostile one: that origin belongs to the ingress receipt only. A single
  // origin can also be selected, because one unlatched origin poisons the
  // process-global ingress for every origin that would follow it.
  const origins = HOOK_REENTRY_ORIGINS.filter((candidate) =>
    (candidate !== "before_cleanup" || entry === "ingress") &&
    (originArgument === undefined || candidate === originArgument));
  if (originArgument !== undefined && origins.length === 0) {
    throw new Error(`unsupported reentry origin selection: ${originArgument}`);
  }

  for (const origin of origins) {
    let capabilities: CapabilityInstance | undefined;
    let rootDescriptor: object | undefined;
    let fileDescriptor: object | undefined;
    let token: object | undefined;
    let fired = false;
    let battery: readonly ReentryRow[] = [];
    let denialCalls = 0;
    let authorityFaultCoercions = 0;
    const pending: Array<Promise<ReentryRow>> = [];
    prototype.openRoot = function(this: CapabilityInstance, root, phase): object {
      const descriptor = Reflect.apply(originalOpenRoot, this, [root, phase]) as object;
      capabilities ??= this;
      rootDescriptor ??= descriptor;
      return descriptor;
    };
    prototype.openRelative = function(this: CapabilityInstance, parent, childName, flags, phase): object {
      const descriptor = Reflect.apply(originalOpenRelative, this, [parent, childName, flags, phase]) as object;
      capabilities ??= this;
      if (phase === "admission") fileDescriptor = descriptor;
      return descriptor;
    };
    const run = (candidate: ReentryOrigin): void => {
      if (fired || candidate !== origin) return;
      fired = true;
      battery = reentryBattery(
        modules,
        capabilities,
        { root: rootDescriptor, file: fileDescriptor, token },
        () => denialCalls,
        pending
      );
    };
    const accessor = origin === "accessor_observe" || origin === "accessor_authority_fault"
      ? new AccessorIngressHooks(origin, run, () => { denialCalls += 1; })
      : undefined;
    const coercingFault = coercingAuthorityFault(() => {
      authorityFaultCoercions += 1;
      run("authority_fault_coercion");
    });
    const faults: string[] = [];
    const hooks: CloseHooks = accessor
      ? accessor as unknown as CloseHooks
      : Object.freeze({
        ...(origin === "authority_violation" ? { authorityFault: "file_write" as const } : {}),
        ...(origin === "authority_fault_coercion" ? { authorityFault: coercingFault } : {}),
        ...(origin === "after_admission" ? { afterAdmission: (): void => { run("after_admission"); } } : {}),
        ...(origin === "after_admission_async"
          ? {
            afterAdmission: async (): Promise<void> => {
              await null;
              run("after_admission_async");
            }
          }
          : {}),
        // The adoption seam: the hook returns a value that is a promise by
        // internal slot but foreign by identity, so every property read promise
        // resolution would perform on it is a reentry attempt.
        ...(origin === "admission_promise_adoption"
          ? {
            afterAdmission: ((): unknown => hostileIdentityPromise(
              "genuine_promise_hostile_constructor",
              () => { run("admission_promise_adoption"); }
            )) as unknown as (path: string) => void
          }
          : {}),
        closeFault: (attempt) => {
          token ??= attempt;
          run("close_fault");
          return false;
        },
        // The read observation is the first ingress-owned callback that runs with
        // a captured capability, a retained file descriptor, and a sealed admission.
        observe: (operation) => { if (operation.operation === "read_retained") run("observe"); },
        onAuthorityViolation: (fault) => {
          // Reported without coercing it: a non-literal fault is named, not read.
          faults.push(typeof fault === "string" ? fault : "NON_STRING_FAULT");
          run("authority_violation");
        },
        onCloseAttempt: (attempt) => {
          token ??= attempt;
          run("close_attempt");
        },
        onDescriptorAuthorityDenial: () => { denialCalls += 1; }
      });
    // A boundary that adopts a foreign-identity promise never settles, so the
    // adoption origin is probed under a bound and reports the hang as its
    // outcome instead of hanging the receipt with it.
    const outcome: EntryOutcome = origin === "admission_promise_adoption"
      ? (await boundedEntry(entry, modules, hooks)).outcome ?? UNSETTLED_OUTCOME
      : await runEntry(
        entry,
        modules,
        hooks,
        undefined,
        origin === "before_cleanup" ? (): void => { run("before_cleanup"); } : undefined
      );
    const settled = await Promise.all(pending);
    const followOnIngress = await runEntry("ingress", modules, Object.freeze({}));
    const followOnChecker = await runEntry("checker", modules, Object.freeze({}));
    results.push(Object.freeze({
      origin,
      fired,
      outcome,
      denialCalls,
      authorityFaultReads: accessor?.authorityFaultReads ?? null,
      authorityFaultCoercions,
      faultsReportedToHook: Object.freeze([...(accessor ? accessor.faults : faults)]),
      followOnIngress,
      followOnChecker,
      battery: Object.freeze([...battery, ...settled])
    }));
  }
  prototype.openRoot = originalOpenRoot;
  prototype.openRelative = originalOpenRelative;

  const denials: unknown[] = [];
  let directBattery: readonly ReentryRow[] = [];
  let directFired = false;
  const directPending: Array<Promise<ReentryRow>> = [];
  const directCapabilities = new modules.capabilities.ContractCapabilities(Object.freeze({
    onDescriptorAuthorityDenial: (denial: unknown) => {
      denials.push(denial);
      if (!directFired) {
        directFired = true;
        directBattery = reentryBattery(
          modules,
          directCapabilities,
          { root: undefined, file: undefined, token: undefined },
          () => denials.length,
          directPending
        );
      }
    }
  }));
  let directOutcome = "NO_ERROR";
  try {
    directCapabilities.stat(Object.freeze({}));
  } catch (error) {
    directOutcome = error instanceof Error ? error.message : "NON_ERROR_THROWN";
  }
  const directBatteryRows = Object.freeze([...directBattery, ...(await Promise.all(directPending))]);
  results.push(Object.freeze({
    origin: "denial" satisfies ReentryOrigin,
    fired: directFired,
    outcome: Object.freeze({ code: directOutcome, exit: null, stdout: "", stderr: "" }),
    denialCalls: denials.length,
    authorityFaultReads: null,
    authorityFaultCoercions: null,
    faultsReportedToHook: Object.freeze([]),
    followOnIngress: await runEntry("ingress", modules, Object.freeze({})),
    followOnChecker: await runEntry("checker", modules, Object.freeze({})),
    battery: directBatteryRows
  }));
  return Object.freeze({ entry, origins: Object.freeze(results) });
}

const BOUNDED_SETTLEMENT_MS = 2000;

/**
 * Bounded settlement probe. A mediation boundary that adopts a foreign thenable
 * never settles, so the row must be able to report the hang instead of hanging
 * the suite with it.
 */
async function boundedEntry(
  entry: Entry,
  modules: Modules,
  hooks: CloseHooks
): Promise<Readonly<{ settled: boolean; outcome: EntryOutcome | null }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<Readonly<{ settled: false; outcome: null }>>((resolve) => {
    timer = setTimeout(() => resolve(Object.freeze({ settled: false, outcome: null })), BOUNDED_SETTLEMENT_MS);
  });
  const settlement = runEntry(entry, modules, hooks).then(
    (outcome) => Object.freeze({ settled: true as const, outcome })
  );
  const result = await Promise.race([settlement, bound]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

/**
 * Returned-value rows for `afterAdmission`: a never-settling thenable must be
 * ignored without a single property read, and a genuine promise must still be
 * awaited to completion before any post-admission verification work starts.
 */
async function runThenable(modules: Modules, entry: Entry): Promise<unknown> {
  const rows: unknown[] = [];

  let thenReads = 0;
  const neverSettling = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(neverSettling, "then", {
    configurable: true,
    enumerable: false,
    get(): (resolve: () => void) => void {
      thenReads += 1;
      return (): void => { /* the adopted thenable never settles */ };
    }
  });
  resetObservations();
  const neverSettlingFdBefore = descriptorCount();
  const neverSettlingRawBefore = snapshotRaw();
  const neverSettlingResult = await boundedEntry(entry, modules, Object.freeze({
    afterAdmission: (() => neverSettling) as unknown as (path: string) => void
  }));
  rows.push(Object.freeze({
    kind: "never_settling_thenable",
    settled: neverSettlingResult.settled,
    outcome: neverSettlingResult.outcome,
    thenReads,
    constructorReads: 0,
    traps: totalTraps(observedTraps()),
    trapNames: Object.keys(observedTraps()).sort(),
    primitiveProbes: totalTraps(Object.freeze({ ...primitiveProbes })),
    rawFinal: rawDelta(neverSettlingRawBefore, snapshotRaw()),
    rawAtHookCompletion: null,
    batteryFired: false,
    battery: Object.freeze([]),
    denialCalls: 0,
    fdBefore: neverSettlingFdBefore,
    fdAfter: descriptorCount()
  }));

  let rawAtHookCompletion: Counters | null = null;
  resetObservations();
  const nativeFdBefore = descriptorCount();
  const nativeRawBefore = snapshotRaw();
  const nativeResult = await boundedEntry(entry, modules, Object.freeze({
    afterAdmission: (async (): Promise<void> => {
      await null;
      rawAtHookCompletion = rawDelta(nativeRawBefore, snapshotRaw());
    }) as unknown as (path: string) => void
  }));
  rows.push(Object.freeze({
    kind: "native_promise",
    settled: nativeResult.settled,
    outcome: nativeResult.outcome,
    thenReads: 0,
    constructorReads: 0,
    traps: totalTraps(observedTraps()),
    trapNames: Object.keys(observedTraps()).sort(),
    primitiveProbes: totalTraps(Object.freeze({ ...primitiveProbes })),
    rawFinal: rawDelta(nativeRawBefore, snapshotRaw()),
    rawAtHookCompletion,
    batteryFired: false,
    battery: Object.freeze([]),
    denialCalls: 0,
    fdBefore: nativeFdBefore,
    fdAfter: descriptorCount()
  }));

  for (const shape of ADOPTION_SHAPES) rows.push(await adoptionRow(modules, entry, shape));

  return Object.freeze({ entry, rows: Object.freeze(rows) });
}

/**
 * Adoption-identity row. The hook returns a foreign-identity promise whose every
 * resolution-time property read runs the full reentry battery with the sealed
 * operation's capability and its retained file descriptor in hand, so the row
 * carries both halves of the proof: that the reads never happened, and that a
 * read which did happen would have found no authority to use.
 */
async function adoptionRow(modules: Modules, entry: Entry, shape: AdoptionShape): Promise<unknown> {
  const prototype = modules.capabilities.ContractCapabilities.prototype;
  const originalOpenRoot = prototype.openRoot;
  const originalOpenRelative = prototype.openRelative;
  let capabilities: CapabilityInstance | undefined;
  let rootDescriptor: object | undefined;
  let fileDescriptor: object | undefined;
  prototype.openRoot = function(this: CapabilityInstance, root, phase): object {
    const descriptor = Reflect.apply(originalOpenRoot, this, [root, phase]) as object;
    capabilities ??= this;
    rootDescriptor ??= descriptor;
    return descriptor;
  };
  prototype.openRelative = function(this: CapabilityInstance, parent, childName, flags, phase): object {
    const descriptor = Reflect.apply(originalOpenRelative, this, [parent, childName, flags, phase]) as object;
    capabilities ??= this;
    if (phase === "admission") fileDescriptor = descriptor;
    return descriptor;
  };

  const reads = { constructor: 0, then: 0 };
  const pending: Array<Promise<ReentryRow>> = [];
  let fired = false;
  let battery: readonly ReentryRow[] = [];
  let denialCalls = 0;
  const onRead = (key: "constructor" | "then"): void => {
    reads[key] += 1;
    if (fired) return;
    fired = true;
    battery = reentryBattery(
      modules,
      capabilities,
      { root: rootDescriptor, file: fileDescriptor, token: undefined },
      () => denialCalls,
      pending
    );
  };

  resetObservations();
  const fdBefore = descriptorCount();
  const rawBefore = snapshotRaw();
  const result = await boundedEntry(entry, modules, Object.freeze({
    afterAdmission: ((): unknown => hostileIdentityPromise(shape, onRead)) as unknown as (path: string) => void,
    onDescriptorAuthorityDenial: (): void => { denialCalls += 1; }
  }));
  const batteryRows = Object.freeze([...battery, ...(await Promise.all(pending))]);
  prototype.openRoot = originalOpenRoot;
  prototype.openRelative = originalOpenRelative;
  return Object.freeze({
    kind: shape,
    settled: result.settled,
    outcome: result.outcome,
    thenReads: reads.then,
    constructorReads: reads.constructor,
    traps: totalTraps(observedTraps()),
    trapNames: Object.keys(observedTraps()).sort(),
    primitiveProbes: totalTraps(Object.freeze({ ...primitiveProbes })),
    rawFinal: rawDelta(rawBefore, snapshotRaw()),
    rawAtHookCompletion: null,
    batteryFired: fired,
    battery: batteryRows,
    denialCalls,
    fdBefore,
    fdAfter: descriptorCount()
  });
}

/**
 * Non-interference row: while operation A is suspended inside its own
 * asynchronous `afterAdmission`, operation B is started independently of every
 * callback and must complete normally.
 */
async function runConcurrency(modules: Modules, entry: Entry): Promise<unknown> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let suspended = false;
  let firstSettled = false;
  const fdBefore = descriptorCount();
  const first = runEntry(entry, modules, Object.freeze({
    afterAdmission: (async (): Promise<void> => {
      await null;
      suspended = true;
      await gate;
    }) as unknown as (path: string) => void
  })).then((outcome) => {
    firstSettled = true;
    return outcome;
  });
  await null;
  await null;
  const suspendedBeforeSecond = suspended;
  const secondRawBefore = snapshotRaw();
  const second = await runEntry(entry, modules, Object.freeze({}));
  const secondRaw = rawDelta(secondRawBefore, snapshotRaw());
  const firstPendingWhileSecondRan = !firstSettled;
  release();
  const firstOutcome = await first;
  return Object.freeze({
    entry,
    first: firstOutcome,
    firstPendingWhileSecondRan,
    second,
    secondRaw,
    suspendedBeforeSecond,
    fdBefore,
    fdAfter: descriptorCount()
  });
}

async function runRead(modules: Modules, entry: Entry): Promise<unknown> {
  const prototype = modules.capabilities.ContractCapabilities.prototype;
  const originalRead = prototype.readRetained;
  const mediatedReturns: number[] = [];
  const chunks: Uint8Array[] = [];
  let readCalls = 0;
  prototype.readRetained = function(
    this: CapabilityInstance,
    descriptor,
    buffer,
    offset,
    length,
    position,
    phase
  ): number {
    const returned = Reflect.apply(originalRead, this, [
      descriptor, buffer, offset, length, position, phase
    ]) as number;
    readCalls += 1;
    if (readCalls <= 4) {
      mediatedReturns.push(returned);
      chunks.push(Uint8Array.from(buffer.subarray(offset, offset + Math.max(returned, 0))));
    }
    return returned;
  };
  const outcome = await runEntry(entry, modules, Object.freeze({}));
  prototype.readRetained = originalRead;
  const assembled = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return Object.freeze({
    entry,
    outcome,
    mediatedReturns: Object.freeze(mediatedReturns),
    readCalls,
    rawReadCalls: raw.readSync,
    assembledBytes: assembled.length,
    assembledDigest: new Bun.CryptoHasher("sha256").update(assembled).digest("hex")
  });
}

const AUTHORITY_FAULT_LITERALS = [
  "ambient_absolute_open",
  "replacement_object_read",
  "file_write",
  "child_spawn"
] as const;
type AuthorityFaultRow = Readonly<{
  label: string;
  outcome: EntryOutcome;
  violations: readonly string[];
  coercions: number;
  rawFinal: Counters;
  fdBefore: number;
  fdAfter: number;
}>;
type DirectFaultRow = Readonly<{
  label: string;
  outcome: string;
  violations: readonly string[];
  coercions: number;
}>;

async function authorityFaultRow(
  modules: Modules,
  entry: Entry,
  label: string,
  makeValue: (onCoercion: () => void) => unknown
): Promise<AuthorityFaultRow> {
  let coercions = 0;
  const violations: string[] = [];
  const fdBefore = descriptorCount();
  const rawBefore = snapshotRaw();
  const outcome = await runEntry(entry, modules, Object.freeze({
    authorityFault: makeValue(() => { coercions += 1; }),
    onAuthorityViolation: (fault: string): void => {
      violations.push(typeof fault === "string" ? fault : "NON_STRING_FAULT");
    }
  }));
  return Object.freeze({
    label,
    outcome,
    violations: Object.freeze([...violations]),
    coercions,
    rawFinal: rawDelta(rawBefore, snapshotRaw()),
    fdBefore,
    fdAfter: descriptorCount()
  });
}

/** The public capability method reached directly, without the ingress seam. */
function directFaultRow(
  modules: Modules,
  label: string,
  makeValue: (onCoercion: () => void) => unknown,
  phase: string
): DirectFaultRow {
  let coercions = 0;
  const violations: string[] = [];
  const capabilities = new modules.capabilities.ContractCapabilities(Object.freeze({
    onAuthorityViolation: (fault: string): void => {
      violations.push(typeof fault === "string" ? fault : "NON_STRING_FAULT");
    }
  }));
  let outcome = "NO_ERROR";
  try {
    capabilities.rejectForbidden(makeValue(() => { coercions += 1; }), phase);
  } catch (error) {
    outcome = error instanceof Error ? error.message : "NON_ERROR_THROWN";
  }
  return Object.freeze({ label, outcome, violations: Object.freeze([...violations]), coercions });
}

async function runAuthorityFault(modules: Modules, entry: Entry): Promise<unknown> {
  const rows: AuthorityFaultRow[] = [];
  for (const literal of AUTHORITY_FAULT_LITERALS) {
    rows.push(await authorityFaultRow(modules, entry, `literal_${literal}`, () => literal));
  }
  rows.push(await authorityFaultRow(modules, entry, "absent", () => undefined));
  rows.push(await authorityFaultRow(modules, entry, "bogus_string", () => "bogus"));
  rows.push(await authorityFaultRow(modules, entry, "empty_string", () => ""));
  rows.push(await authorityFaultRow(modules, entry, "plain_object", () => Object.freeze({})));
  rows.push(await authorityFaultRow(modules, entry, "coercing_object", coercingAuthorityFault));

  const direct: DirectFaultRow[] = [];
  for (const literal of AUTHORITY_FAULT_LITERALS) {
    direct.push(directFaultRow(modules, `literal_${literal}`, () => literal, "post_admission"));
  }
  direct.push(directFaultRow(modules, "bogus_string", () => "bogus", "post_admission"));
  direct.push(directFaultRow(modules, "coercing_object", coercingAuthorityFault, "post_admission"));
  direct.push(directFaultRow(modules, "literal_admission_phase", () => "file_write", "admission"));
  return Object.freeze({ entry, rows: Object.freeze(rows), direct: Object.freeze(direct) });
}

installRawProbe();
installPrimitiveProbe();
installSinkProbe();
const modules = await loadModules();
installOpenAtProbe(modules);
const receipt = scenario === "authority_fault"
  ? await runAuthorityFault(modules, entryArgument as Entry)
  : scenario === "identity"
  ? await runIdentity(modules, entryArgument)
  : scenario === "retry"
  ? await runRetry(modules, entryArgument as Entry)
  : scenario === "terminal_return"
  ? await runTerminal(modules, entryArgument as Entry, false)
  : scenario === "terminal_throw"
  ? await runTerminal(modules, entryArgument as Entry, true)
  : scenario === "hostile"
  ? await runHostile(modules, entryArgument as Entry)
  : scenario === "falsy"
  ? await runFalsy(modules, entryArgument as Entry)
  : scenario === "inherited"
  ? await runInherited(modules, entryArgument as Entry)
  : scenario === "sink"
  ? await runSink(modules, entryArgument as Entry)
  : scenario === "reentry"
  ? await runReentry(modules, entryArgument as Entry)
  : scenario === "read"
  ? await runRead(modules, entryArgument as Entry)
  : scenario === "thenable"
  ? await runThenable(modules, entryArgument as Entry)
  : scenario === "concurrency"
  ? await runConcurrency(modules, entryArgument as Entry)
  : (() => { throw new Error(`unsupported close runtime scenario: ${scenario}`); })();
process.stdout.write(`${JSON.stringify(receipt)}\n`);
