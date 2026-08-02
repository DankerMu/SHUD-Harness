import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BigIntStats, DescriptorPrimitiveMediator } from "../lib/capabilities";

type Entry = "direct" | "checker";
type Scenario = "pre_raw" | "no_raw" | "post_raw" | "map_clear_no_raw";
type NoRawCloseMode = "omission" | "value" | "async" | "thenable" | "proxy" | "sentinel" | "hostile";
type NoRawBehavior = "once" | "persistent";
type CloseFaultMode = "false" | "true" | "throw";
type PrimaryMode = "none" | "prior_primary";
type CloseHooks = Readonly<{
  onCloseAttempt?: (attempt: CloseAttempt) => void;
  closeFault?: (attempt: CloseAttempt) => boolean;
}>;
type RawPrimitive = "open_sync" | "openat" | "fstat_sync" | "read_sync" | "close_sync";
type RawCounts = Record<RawPrimitive, number>;
type CloseAttempt = Readonly<{ owner: "unretained" | "retained" | "verification"; ordinal: number }>;
type OpenAt = (parentDescriptor: number, path: Buffer, flags: number) => number;
type EntryOutcome = Readonly<{ code: string; exit: number | null; stdout: string; stderr: string }>;
type CapabilitiesModule = Readonly<{
  installDescriptorPrimitiveMediator: (mediator: DescriptorPrimitiveMediator) => void;
}>;
type IngressModule = Readonly<{
  readBoundedFile: (
    path: string,
    maximum: number,
    hooks?: CloseHooks
  ) => Promise<Uint8Array>;
  __poisonRetainedOwnerCount?: () => number;
  __poisonRetainedOwnerDescriptorsForTest?: () => readonly unknown[];
  __poisonLiveOwnerDescriptorsForTest?: () => readonly unknown[];
  __poisonActiveOwnerDescriptorsForTest?: () => ReadonlyArray<readonly unknown[]>;
}>;
type CheckerModule = Readonly<{
  runCheckForTest: (
    args: readonly string[],
    io: Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>,
    hooks: CloseHooks
  ) => Promise<number>;
}>;

type ObservedLiveIngressOwner = Readonly<{
  capabilities: object;
  descriptor: object;
  owner: unknown;
}>;
const PRODUCTION_ROOT_ENV = "SHUD_DESCRIPTOR_PRODUCTION_ROOT";
const productionRoot = process.env[PRODUCTION_ROOT_ENV];
const observedLiveOwnerMaps = new Set<Map<unknown, unknown>>();
const observedObjectIds = new WeakMap<object, number>();
let nextObservedObjectId = 1;

// Causal mutation rows select a copied production tree only after child startup.
function libraryModuleSpecifier(name: "capabilities" | "checker" | "ingress"): string {
  if (!productionRoot) return `../lib/${name}`;
  return pathToFileURL(resolve(productionRoot, "lib", `${name}.ts`)).href;
}

function isObservedLiveIngressOwner(value: unknown): value is ObservedLiveIngressOwner {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return typeof candidate.capabilities === "object" &&
    candidate.capabilities !== null &&
    typeof candidate.descriptor === "object" &&
    candidate.descriptor !== null &&
    typeof candidate.owner === "string";
}

function installLiveOwnerProbe(): void {
  const originalMapSet = Map.prototype.set;
  Map.prototype.set = (function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown
  ): Map<unknown, unknown> {
    if (isObservedLiveIngressOwner(value)) observedLiveOwnerMaps.add(this);
    return Reflect.apply(originalMapSet, this, [key, value]) as Map<unknown, unknown>;
  }) as typeof Map.prototype.set;
}

function observedObjectId(value: object): number {
  const existing = observedObjectIds.get(value);
  if (existing !== undefined) return existing;
  const id = nextObservedObjectId;
  nextObservedObjectId += 1;
  observedObjectIds.set(value, id);
  return id;
}

function descriptorIds(descriptors: readonly unknown[]): readonly number[] {
  const ids: number[] = [];
  for (const descriptor of descriptors) {
    if (typeof descriptor === "object" && descriptor !== null) ids.push(observedObjectId(descriptor));
  }
  return ids.sort((left, right) => left - right);
}

function snapshotLiveOwnerIds(ingress: IngressModule): readonly number[] {
  return descriptorIds(ingress.__poisonLiveOwnerDescriptorsForTest?.() ?? []);
}

function snapshotActiveOwnerIds(ingress: IngressModule): readonly (readonly number[])[] {
  return (ingress.__poisonActiveOwnerDescriptorsForTest?.() ?? []).map(descriptorIds);
}

function retainedOwnerIds(ingress: IngressModule): readonly number[] | null {
  const descriptors = ingress.__poisonRetainedOwnerDescriptorsForTest?.();
  return descriptors ? descriptorIds(descriptors) : null;
}

const childArguments = process.argv.slice(2);
const scenario = (
  childArguments[0] === "no_raw" ||
  childArguments[0] === "post_raw" ||
  childArguments[0] === "map_clear_no_raw"
  ? childArguments[0]
  : "pre_raw"
) as Scenario;
const [outerEntryArgument, nestedEntryArgument] = scenario === "pre_raw"
  ? [childArguments[0], childArguments[1]]
  : scenario === "no_raw"
  ? [childArguments[3], undefined]
  : [childArguments[1], childArguments[2]];
const outerEntry = (outerEntryArgument ?? "direct") as Entry;
const nestedEntry = (nestedEntryArgument ?? "direct") as Entry;
const noRawCloseMode = childArguments[1] as NoRawCloseMode | undefined;
const noRawBehavior = childArguments[2] as NoRawBehavior | undefined;
const postRawFaultMode = childArguments[3] as CloseFaultMode | undefined;
const postRawPrimaryMode = childArguments[4] as PrimaryMode | undefined;
const contractsRoot = resolve(import.meta.dir, "..");
const validInput = resolve(contractsRoot, "fixtures", "valid", "source-input-record-paired-surrogate.json");
const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
const maximumBytes = 64 * 1024;
const raw: RawCounts = { open_sync: 0, openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 };
let nestedAdmission = false;
let nestedStarted = false;
let nestedMediatedCloseCalls = 0;
let outerCloseAttempts = 0;
const nestedCloseAttempts: CloseAttempt[] = [];
let nestedResult: Promise<EntryOutcome> | undefined;
let rawAtPoison: RawCounts | undefined;
let liveOwnerCountAtPoison = 0;

function nonDirectoryStats(): BigIntStats {
  return Object.freeze({
    dev: 1n,
    ino: 1n,
    size: 0n,
    isDirectory: () => false,
    isFile: () => false
  }) as unknown as BigIntStats;
}

function installRawProbe(): void {
  const originalOpenSync = originalFs.openSync;
  const originalFstatSync = originalFs.fstatSync;
  const originalReadSync = originalFs.readSync;
  const originalCloseSync = originalFs.closeSync;
  mock.module("node:fs", () => ({
    ...originalFs,
    openSync(...args: Parameters<typeof originalOpenSync>) {
      raw.open_sync += 1;
      return originalOpenSync(...args);
    },
    fstatSync(...args: Parameters<typeof originalFstatSync>) {
      raw.fstat_sync += 1;
      if (nestedAdmission) return nonDirectoryStats();
      return originalFstatSync(...args);
    },
    readSync(...args: Parameters<typeof originalReadSync>) {
      raw.read_sync += 1;
      return originalReadSync(...args);
    },
    closeSync(...args: Parameters<typeof originalCloseSync>) {
      raw.close_sync += 1;
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
          openat(...args: Parameters<OpenAt>): number {
            raw.openat += 1;
            return nativeOpenAt(...args);
          }
        }
      } as typeof library;
    }
  }));
}

async function loadModules(): Promise<Readonly<{
  capabilities: CapabilitiesModule;
  ingress: IngressModule;
  checker: CheckerModule;
}>> {
  // These modules bind raw imports at evaluation, so the test must load them after its probes.
  // The copied production tree is selected by the process-isolated mutation receipt.
  const [capabilities, ingress, checker] = await Promise.all([
    import(libraryModuleSpecifier("capabilities")),
    import(libraryModuleSpecifier("ingress")),
    import(libraryModuleSpecifier("checker"))
  ]);
  return Object.freeze({
    capabilities: capabilities as CapabilitiesModule,
    ingress: ingress as IngressModule,
    checker: checker as CheckerModule
  });
}

async function runEntry(
  entry: Entry,
  modules: Readonly<{ ingress: IngressModule; checker: CheckerModule }>,
  hooks: CloseHooks,
  input = validInput,
  maximum = maximumBytes
): Promise<EntryOutcome> {
  if (entry === "direct") {
    try {
      await modules.ingress.readBoundedFile(input, maximum, hooks);
      return Object.freeze({ code: "NO_ERROR", exit: null, stdout: "", stderr: "" });
    } catch (error) {
      return Object.freeze({
        code: error instanceof Error ? error.message : String(error),
        exit: null,
        stdout: "",
        stderr: ""
      });
    }
  }
  let stdout = "";
  let stderr = "";
  const exit = await modules.checker.runCheckForTest(
    ["--input", input, "--kind", "source_input_record"],
    { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    hooks
  );
  const parsed = stderr ? JSON.parse(stderr) as Readonly<{ code?: unknown }> : {};
  return Object.freeze({
    code: typeof parsed.code === "string" ? parsed.code : "NO_ERROR",
    exit,
    stdout,
    stderr
  });
}

async function descriptorCount(): Promise<number> {
  return (await readdir(descriptorDirectory)).length;
}

function rawDelta(after: RawCounts, before: RawCounts): RawCounts {
  return {
    open_sync: after.open_sync - before.open_sync,
    openat: after.openat - before.openat,
    fstat_sync: after.fstat_sync - before.fstat_sync,
    read_sync: after.read_sync - before.read_sync,
    close_sync: after.close_sync - before.close_sync
  };
}

function noRawCloseResponse(mode: NoRawCloseMode): undefined {
  if (mode === "omission") return undefined;
  if (mode === "value") return 1 as undefined;
  if (mode === "async") return Promise.resolve() as unknown as undefined;
  if (mode === "thenable") {
    return Object.defineProperty({}, "then", { get: (): (() => void) => () => undefined }) as unknown as undefined;
  }
  if (mode === "proxy") {
    return new Proxy(Object.create(null), {
      get(): never {
        throw new Error("NO_RAW_PROXY_INSPECTED");
      }
    }) as unknown as undefined;
  }
  if (mode === "sentinel") throw new Error("NO_RAW_SENTINEL");
  throw new Proxy(Object.create(null), {
    get(): never {
      throw new Error("NO_RAW_HOSTILE_INSPECTED");
    },
    getPrototypeOf(): never {
      throw new Error("NO_RAW_HOSTILE_PROTOTYPE");
    }
  });
}

async function runPreRawScenario(): Promise<unknown> {
  if (!(["direct", "checker"] as const).includes(outerEntry)) {
    throw new Error("ingress poison child requires a direct or checker outer entry");
  }
  if (!(["direct", "checker"] as const).includes(nestedEntry)) {
    throw new Error("ingress poison child requires a direct or checker nested entry");
  }
  installRawProbe();
  installLiveOwnerProbe();
  const modules = await loadModules();
  const fdBaseline = await descriptorCount();
  let hooks: CloseHooks;
  hooks = Object.freeze({
    onCloseAttempt: (attempt: CloseAttempt): void => {
      if (nestedAdmission) {
        nestedCloseAttempts.push(attempt);
        if (nestedCloseAttempts.length === 2) {
          rawAtPoison = { ...raw };
          liveOwnerCountAtPoison = snapshotLiveOwnerIds(modules.ingress).length;
        }
        return;
      }
      if (nestedStarted) {
        outerCloseAttempts += 1;
        return;
      }
      outerCloseAttempts += 1;
      nestedStarted = true;
      nestedAdmission = true;
      nestedResult = runEntry(nestedEntry, modules, hooks);
      nestedAdmission = false;
    }
  });
  modules.capabilities.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (operation === "close_sync" && nestedAdmission) {
      nestedMediatedCloseCalls += 1;
      return undefined;
    }
    invoke();
    return undefined;
  });
  // Nested work begins only from the outer close hook, so this is before any outer raw close.
  const outerCloseBaseline = { ...raw };

  const outer = await runEntry(outerEntry, modules, hooks);
  const nested = await nestedResult!;
  nestedResult = undefined;
  const retainedOwnerCountAfterContextDeletion =
    modules.ingress.__poisonRetainedOwnerCount?.() ?? null;
  const rawAfterOuter = { ...raw };
  const fdAfterPoison = await descriptorCount();
  const laterDirect = await runEntry("direct", modules, hooks);
  const laterChecker = await runEntry("checker", modules, hooks);
  const rawAfterLater = { ...raw };
  const fdAfterLater = await descriptorCount();
  const poisonSnapshot = rawAtPoison ?? { ...raw };
  return {
    outerEntry,
    nestedEntry,
    outer,
    nested,
    laterDirect,
    laterChecker,
    nestedStarted,
    nestedMediatedCloseCalls,
    outerCloseAttempts,
    nestedCloseAttempts: nestedCloseAttempts.map((attempt) => ({ owner: attempt.owner, ordinal: attempt.ordinal })),
    outerCloseBaseline,
    rawAtPoison: poisonSnapshot,
    rawAfterOuter,
    rawAfterLater,
    postPoisonRaw: rawDelta(rawAfterOuter, poisonSnapshot),
    laterRaw: rawDelta(rawAfterLater, rawAfterOuter),
    fdBaseline,
    fdAfterPoison,
    fdAfterLater,
    liveOwnerCountAtPoison,
    retainedOwnerCountAfterContextDeletion
  };
}

async function runMapClearNoRawScenario(): Promise<unknown> {
  if (
    !(["direct", "checker"] as const).includes(outerEntry) ||
    !(["direct", "checker"] as const).includes(nestedEntry)
  ) {
    throw new Error("map-clear no-raw poison child requires direct or checker entries");
  }
  installRawProbe();
  installLiveOwnerProbe();
  const modules = await loadModules();
  const fdBaseline = await descriptorCount();
  let capturedOuterOwnerMap: Map<unknown, unknown> | undefined;
  let mapClearCaptureAttempts = 0;
  let mapClearCapturedOwnerStore = false;
  let outerOwnerIdsBeforeClear: readonly number[] = [];
  let outerOwnerIdsAfterClear: readonly number[] = [];
  let nestedOwnerIdsBeforePoison: readonly number[] = [];
  let preCloseOwnerIds: readonly number[] = [];
  let hooks: CloseHooks;
  hooks = Object.freeze({
    onCloseAttempt: (attempt: CloseAttempt): void => {
      if (nestedAdmission) {
        nestedCloseAttempts.push(attempt);
        const activeOwnerIds = snapshotActiveOwnerIds(modules.ingress);
        if (nestedOwnerIdsBeforePoison.length === 0) {
          if (activeOwnerIds.length < 2) {
            throw new Error("map-clear probe lacks distinct nested and outer owner receipts");
          }
          nestedOwnerIdsBeforePoison = activeOwnerIds[0]!;
        }
        if (nestedCloseAttempts.length === 2) {
          const ownerIds: number[] = [];
          for (const contextOwnerIds of activeOwnerIds) ownerIds.push(...contextOwnerIds);
          preCloseOwnerIds = ownerIds.sort((left, right) => left - right);
          rawAtPoison = { ...raw };
        }
        return;
      }
      if (nestedStarted) {
        outerCloseAttempts += 1;
        return;
      }
      outerCloseAttempts += 1;
      mapClearCaptureAttempts += 1;
      capturedOuterOwnerMap ??= [...observedLiveOwnerMaps].find((ownerMap) => ownerMap.size > 0);
      mapClearCapturedOwnerStore ||= capturedOuterOwnerMap !== undefined;
      const activeOwnerIdsBeforeClear = snapshotActiveOwnerIds(modules.ingress);
      if (activeOwnerIdsBeforeClear.length !== 1) {
        throw new Error("map-clear probe observed an unexpected active context before the target close");
      }
      outerOwnerIdsBeforeClear = activeOwnerIdsBeforeClear[0]!;
      if (outerOwnerIdsBeforeClear.length === 0) {
        throw new Error("map-clear probe observed no outer owners before the target close");
      }
      capturedOuterOwnerMap?.clear();
      outerOwnerIdsAfterClear = snapshotActiveOwnerIds(modules.ingress)[0] ?? [];
      nestedStarted = true;
      nestedAdmission = true;
      nestedResult = runEntry(nestedEntry, modules, hooks);
      nestedAdmission = false;
    }
  });
  modules.capabilities.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (operation === "close_sync" && nestedAdmission) {
      nestedMediatedCloseCalls += 1;
      return noRawCloseResponse("omission");
    }
    invoke();
    return undefined;
  });

  const outerCloseBaseline = { ...raw };
  const outer = await runEntry(outerEntry, modules, hooks);
  if (!nestedResult) throw new Error("map-clear no-raw poison child did not start nested ingress");
  const nested = await nestedResult;
  nestedResult = undefined;
  const retainedOwnerIdsAfterContextDeletion = retainedOwnerIds(modules.ingress);
  const rawAfterOuter = { ...raw };
  const fdAfterPoison = await descriptorCount();
  const laterDirect = await runEntry("direct", modules, hooks);
  const laterChecker = await runEntry("checker", modules, hooks);
  const rawAfterLater = { ...raw };
  const fdAfterLater = await descriptorCount();
  const poisonSnapshot = rawAtPoison ?? rawAfterOuter;
  if (preCloseOwnerIds.length === 0) {
    throw new Error("map-clear no-raw proof lacks an exact pre-poison owner receipt");
  }
  return {
    outerEntry,
    nestedEntry,
    outer,
    nested,
    laterDirect,
    laterChecker,
    nestedStarted,
    nestedMediatedCloseCalls,
    outerCloseAttempts,
    nestedCloseAttempts: nestedCloseAttempts.map((attempt) => ({ owner: attempt.owner, ordinal: attempt.ordinal })),
    mapClearCaptureAttempts,
    mapClearCapturedOwnerStore,
    outerOwnerIdsBeforeClear,
    outerOwnerIdsAfterClear,
    nestedOwnerIdsBeforePoison,
    preCloseOwnerIds,
    retainedOwnerIdsAfterContextDeletion,
    outerCloseBaseline,
    rawAtPoison: poisonSnapshot,
    rawAfterOuter,
    rawAfterLater,
    postPoisonRaw: rawDelta(rawAfterOuter, poisonSnapshot),
    laterRaw: rawDelta(rawAfterLater, rawAfterOuter),
    fdBaseline,
    fdAfterPoison,
    fdAfterLater
  };
}

async function runNoRawScenario(): Promise<unknown> {
  if (!noRawCloseMode || !noRawBehavior || !(["direct", "checker"] as const).includes(outerEntry)) {
    throw new Error("no-raw poison child requires a mode, behavior, and direct or checker entry");
  }
  installRawProbe();
  installLiveOwnerProbe();
  const modules = await loadModules();
  let firstCloseOwnerIds: readonly number[] | undefined;
  let secondCloseOwnerIds: readonly number[] | undefined;
  let rawAtFirstAttempt: RawCounts | undefined;
  let rawAtSecondAttempt: RawCounts | undefined;
  let rawAtPoison: RawCounts | undefined;
  let rawAfterFirstRawClose: RawCounts | undefined;
  let mediatedCloseCallsAtPoison: number | undefined;
  let refusedCloseCalls = 0;
  let mediatedCloseCalls = 0;
  const hooks: CloseHooks = Object.freeze({
    onCloseAttempt: () => {
      const liveOwnerIds = snapshotLiveOwnerIds(modules.ingress);
      if (!firstCloseOwnerIds) {
        firstCloseOwnerIds = liveOwnerIds;
        rawAtFirstAttempt = { ...raw };
      } else if (noRawBehavior === "persistent" && refusedCloseCalls === 1 && !secondCloseOwnerIds) {
        secondCloseOwnerIds = liveOwnerIds;
        rawAtSecondAttempt = { ...raw };
        // Baseline production poisons synchronously after this second refusal, before the outer await resolves.
        queueMicrotask(() => {
          rawAtPoison = { ...raw };
          mediatedCloseCallsAtPoison = mediatedCloseCalls;
        });
      }
    },
    closeFault: () => {
      rawAfterFirstRawClose ??= { ...raw };
      return false;
    }
  });
  modules.capabilities.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (operation === "close_sync") {
      mediatedCloseCalls += 1;
      if (noRawBehavior === "persistent" || refusedCloseCalls === 0) {
        refusedCloseCalls += 1;
        return noRawCloseResponse(noRawCloseMode);
      }
    }
    invoke();
    return undefined;
  });

  const outer = await runEntry(outerEntry, modules, hooks);
  const rawAfterOuter = { ...raw };
  const retainedOwnerIdsAfterContextDeletion = retainedOwnerIds(modules.ingress);
  if (noRawBehavior === "once") {
    return {
      outerEntry,
      mode: noRawCloseMode,
      behavior: noRawBehavior,
      outer,
      refusedCloseCalls,
      mediatedCloseCalls,
      firstCloseOwnerIds: firstCloseOwnerIds ?? [],
      rawAtFirstAttempt: rawAtFirstAttempt ?? rawAfterOuter,
      rawAfterFirstRawClose: rawAfterFirstRawClose ?? null,
      rawAfterOuter,
      retainedOwnerIdsAfterContextDeletion
    };
  }

  const poisonSnapshot = rawAtPoison ?? rawAfterOuter;
  const mediationAtPoison = mediatedCloseCallsAtPoison ?? mediatedCloseCalls;
  const laterDirect = await runEntry("direct", modules, hooks);
  const laterChecker = await runEntry("checker", modules, hooks);
  const rawAfterLater = { ...raw };
  return {
    outerEntry,
    mode: noRawCloseMode,
    behavior: noRawBehavior,
    outer,
    laterDirect,
    laterChecker,
    refusedCloseCalls,
    mediatedCloseCallsAtPoison: mediationAtPoison,
    mediatedCloseCallsAfterLater: mediatedCloseCalls,
    firstCloseOwnerIds: firstCloseOwnerIds ?? [],
    secondCloseOwnerIds: secondCloseOwnerIds ?? [],
    rawAtFirstAttempt: rawAtFirstAttempt ?? rawAfterOuter,
    rawAtSecondAttempt,
    rawAtPoison: poisonSnapshot,
    rawAfterOuter,
    rawAfterLater,
    laterRaw: rawDelta(rawAfterLater, poisonSnapshot),
    retainedOwnerIdsAfterContextDeletion
  };
}

async function runPostRawScenario(): Promise<unknown> {
  if (!postRawFaultMode || !postRawPrimaryMode ||
      !(["direct", "checker"] as const).includes(outerEntry) ||
      !(["direct", "checker"] as const).includes(nestedEntry)) {
    throw new Error("post-raw poison child requires entries, fault mode, and primary mode");
  }
  installRawProbe();
  installLiveOwnerProbe();
  const modules = await loadModules();
  let targetAttempt: CloseAttempt | undefined;
  let targetPreCloseOwnerIds: readonly number[] = [];
  let targetRawBefore: RawCounts | undefined;
  let rawAtFault: RawCounts | undefined;
  let postRawNestedResult: Promise<EntryOutcome> | undefined;
  let postRawNestedStarted = false;
  let postRawNestedMediatedCloseCalls = 0;
  let postRawRawAtPoison: RawCounts | undefined;
  let liveOwnerIdsAtPoison: readonly number[] = [];
  const outerCloseAttemptRecords: CloseAttempt[] = [];
  const postRawNestedCloseAttempts: CloseAttempt[] = [];
  let hooks: CloseHooks;
  hooks = Object.freeze({
    onCloseAttempt: (attempt: CloseAttempt): void => {
      if (nestedAdmission) {
        postRawNestedCloseAttempts.push(attempt);
        if (postRawNestedCloseAttempts.length === 2) {
          postRawRawAtPoison = { ...raw };
          liveOwnerIdsAtPoison = snapshotLiveOwnerIds(modules.ingress);
        }
        return;
      }
      outerCloseAttemptRecords.push(attempt);
      const liveOwnerIds = snapshotLiveOwnerIds(modules.ingress);
      if (!targetAttempt && attempt.owner === "retained" && liveOwnerIds.length === 1) {
        targetAttempt = attempt;
        targetPreCloseOwnerIds = liveOwnerIds;
        targetRawBefore = { ...raw };
      }
    },
    closeFault: (attempt: CloseAttempt): boolean => {
      if (!targetAttempt || attempt.ordinal !== targetAttempt.ordinal) return false;
      rawAtFault ??= { ...raw };
      postRawNestedStarted = true;
      nestedAdmission = true;
      postRawNestedResult = runEntry(nestedEntry, modules, hooks);
      nestedAdmission = false;
      if (postRawFaultMode === "throw") throw new Error("POST_RAW_CLOSE_FAULT_SENTINEL");
      return postRawFaultMode === "true";
    }
  });
  modules.capabilities.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (operation === "close_sync" && nestedAdmission) {
      postRawNestedMediatedCloseCalls += 1;
      return undefined;
    }
    invoke();
    return undefined;
  });

  const temporaryRoot = postRawPrimaryMode === "prior_primary"
    ? await mkdtemp(join(tmpdir(), "shud-post-raw-poison-"))
    : undefined;
  const outerInput = temporaryRoot
    ? join(temporaryRoot, "source-input-record-over-limit.json")
    : validInput;
  if (temporaryRoot) {
    await writeFile(outerInput, Buffer.concat([await readFile(validInput), Buffer.alloc(maximumBytes, 0x20)]));
  }
  let outer: EntryOutcome | undefined;
  try {
    outer = await runEntry(
      outerEntry,
      modules,
      hooks,
      outerInput,
      postRawPrimaryMode === "prior_primary" ? 0 : maximumBytes
    );
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
  if (!outer || !targetAttempt || !targetRawBefore || !rawAtFault ||
      !postRawNestedResult || !postRawRawAtPoison) {
    throw new Error("post-raw poison child did not reach the final retained/root close checkpoint");
  }
  const nested = await postRawNestedResult;
  const retainedOwnerIdsAfterContextDeletion = retainedOwnerIds(modules.ingress);
  const rawAfterOuter = { ...raw };
  const laterDirect = await runEntry("direct", modules, hooks);
  const laterChecker = await runEntry("checker", modules, hooks);
  const rawAfterLater = { ...raw };
  return {
    outerEntry,
    nestedEntry,
    faultMode: postRawFaultMode,
    primaryMode: postRawPrimaryMode,
    outer,
    nested,
    laterDirect,
    laterChecker,
    target: { owner: targetAttempt.owner, ordinal: targetAttempt.ordinal },
    outerCloseAttempts: outerCloseAttemptRecords.map((attempt) => ({ owner: attempt.owner, ordinal: attempt.ordinal })),
    nestedCloseAttempts: postRawNestedCloseAttempts.map((attempt) => ({ owner: attempt.owner, ordinal: attempt.ordinal })),
    targetPreCloseOwnerIds,
    liveOwnerIdsAtPoison,
    retainedOwnerIdsAfterContextDeletion,
    targetRawBefore,
    rawAtFault,
    rawAtPoison: postRawRawAtPoison,
    rawAfterOuter,
    rawAfterLater,
    postPoisonRaw: rawDelta(rawAfterOuter, postRawRawAtPoison),
    laterRaw: rawDelta(rawAfterLater, rawAfterOuter),
    nestedStarted: postRawNestedStarted,
    nestedMediatedCloseCalls: postRawNestedMediatedCloseCalls
  };
}

try {
  const receipt = scenario === "no_raw"
    ? await runNoRawScenario()
    : scenario === "post_raw"
    ? await runPostRawScenario()
    : scenario === "map_clear_no_raw"
    ? await runMapClearNoRawScenario()
    : await runPreRawScenario();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
