import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BigIntStats, DescriptorPrimitiveMediator } from "../lib/capabilities";

type Entry = "direct" | "checker";
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
    hooks?: Readonly<{ onCloseAttempt?: (attempt: CloseAttempt) => void }>
  ) => Promise<Uint8Array>;
  __poisonRetainedOwnerCount?: () => number;
}>;
type CheckerModule = Readonly<{
  runCheckForTest: (
    args: readonly string[],
    io: Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>,
    hooks: Readonly<{ onCloseAttempt?: (attempt: CloseAttempt) => void }>
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

function snapshotLiveOwnerCount(): number {
  const owners = new Set<ObservedLiveIngressOwner>();
  for (const ownerMap of observedLiveOwnerMaps) {
    for (const value of ownerMap.values()) {
      if (isObservedLiveIngressOwner(value)) owners.add(value);
    }
  }
  return owners.size;
}


const [outerEntryArgument, nestedEntryArgument] = process.argv.slice(2) as [Entry | undefined, Entry | undefined];
const outerEntry = outerEntryArgument ?? "direct";
const nestedEntry = nestedEntryArgument ?? "direct";
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
  hooks: Readonly<{ onCloseAttempt?: (attempt: CloseAttempt) => void }>
): Promise<EntryOutcome> {
  if (entry === "direct") {
    try {
      await modules.ingress.readBoundedFile(validInput, maximumBytes, hooks);
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
    ["--input", validInput, "--kind", "source_input_record"],
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

try {
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
  let hooks: Readonly<{ onCloseAttempt?: (attempt: CloseAttempt) => void }>;
  hooks = Object.freeze({
    onCloseAttempt: (attempt: CloseAttempt): void => {
      if (nestedAdmission) {
        nestedCloseAttempts.push(attempt);
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
      rawAtPoison = { ...raw };
      liveOwnerCountAtPoison = snapshotLiveOwnerCount();
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
  process.stdout.write(`${JSON.stringify({
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
    rawAtPoison: poisonSnapshot,
    rawAfterOuter,
    rawAfterLater,
    postPoisonRaw: {
      open_sync: rawAfterOuter.open_sync - poisonSnapshot.open_sync,
      openat: rawAfterOuter.openat - poisonSnapshot.openat,
      fstat_sync: rawAfterOuter.fstat_sync - poisonSnapshot.fstat_sync,
      read_sync: rawAfterOuter.read_sync - poisonSnapshot.read_sync,
      close_sync: rawAfterOuter.close_sync - poisonSnapshot.close_sync
    },
    laterRaw: {
      open_sync: rawAfterLater.open_sync - rawAfterOuter.open_sync,
      openat: rawAfterLater.openat - rawAfterOuter.openat,
      fstat_sync: rawAfterLater.fstat_sync - rawAfterOuter.fstat_sync,
      read_sync: rawAfterLater.read_sync - rawAfterOuter.read_sync,
      close_sync: rawAfterLater.close_sync - rawAfterOuter.close_sync
    },
    fdBaseline,
    fdAfterPoison,
    fdAfterLater,
    liveOwnerCountAtPoison,
    retainedOwnerCountAfterContextDeletion
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
