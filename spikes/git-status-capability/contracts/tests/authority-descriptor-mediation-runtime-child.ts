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
  authorityFault?: "ambient_absolute_open" | "replacement_object_read" | "file_write" | "child_spawn";
  closeFault?: (attempt: CloseAttempt) => boolean;
  observe?: (operation: IngressOperation) => void;
  onAuthorityViolation?: (fault: string) => void;
  onCloseAttempt?: (attempt: CloseAttempt) => void;
  onDescriptorAuthorityDenial?: (denial: unknown) => void;
};
type Entry = "ingress" | "checker";
type Scenario =
  | "identity"
  | "retry"
  | "terminal_return"
  | "terminal_throw"
  | "hostile"
  | "falsy"
  | "inherited"
  | "sink"
  | "reentry"
  | "read";
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
  rejectForbidden: (fault: string, phase: string) => never;
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
  readBoundedFile: (path: string, maximum: number, hooks?: CloseHooks) => Promise<Uint8Array>;
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

const [scenarioArgument, entryArgument] = process.argv.slice(2) as [Scenario | undefined, string | undefined];
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
  onSettled?: () => void
): Promise<EntryOutcome> {
  if (entry === "ingress") {
    try {
      await modules.ingress.readBoundedFile(validInput, 64 * 1024, hooks);
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

type ReentryOrigin = "observe" | "close_attempt" | "close_fault" | "authority_violation" | "denial";
type ReentryRow = Readonly<{ method: string; outcome: string; rawDelta: number; denialCalls: number }>;

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

  for (const origin of ["observe", "close_attempt", "close_fault", "authority_violation"] as const) {
    let capabilities: CapabilityInstance | undefined;
    let rootDescriptor: object | undefined;
    let fileDescriptor: object | undefined;
    let token: object | undefined;
    let fired = false;
    let battery: readonly ReentryRow[] = [];
    let denialCalls = 0;
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
    const hooks: CloseHooks = Object.freeze({
      ...(origin === "authority_violation" ? { authorityFault: "file_write" as const } : {}),
      closeFault: (attempt) => {
        token ??= attempt;
        run("close_fault");
        return false;
      },
      // The read observation is the first ingress-owned callback that runs with
      // a captured capability, a retained file descriptor, and a sealed admission.
      observe: (operation) => { if (operation.operation === "read_retained") run("observe"); },
      onAuthorityViolation: () => { run("authority_violation"); },
      onCloseAttempt: (attempt) => {
        token ??= attempt;
        run("close_attempt");
      },
      onDescriptorAuthorityDenial: () => { denialCalls += 1; }
    });
    const outcome = await runEntry(entry, modules, hooks);
    const settled = await Promise.all(pending);
    results.push(Object.freeze({
      origin,
      fired,
      outcome,
      denialCalls,
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
  results.push(Object.freeze({
    origin: "denial" satisfies ReentryOrigin,
    fired: directFired,
    outcome: Object.freeze({ code: directOutcome, exit: null, stdout: "", stderr: "" }),
    denialCalls: denials.length,
    battery: Object.freeze([...directBattery, ...(await Promise.all(directPending))])
  }));
  return Object.freeze({ entry, origins: Object.freeze(results) });
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

installRawProbe();
installPrimitiveProbe();
installSinkProbe();
const modules = await loadModules();
installOpenAtProbe(modules);
const receipt = scenario === "identity"
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
  : (() => { throw new Error(`unsupported close runtime scenario: ${scenario}`); })();
process.stdout.write(`${JSON.stringify(receipt)}\n`);
