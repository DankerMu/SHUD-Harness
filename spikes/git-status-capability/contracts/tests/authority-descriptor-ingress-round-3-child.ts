import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";
import { readdir } from "node:fs/promises";
import { parse, resolve, sep } from "node:path";
import type { BigIntStats, DescriptorPrimitiveMediator } from "../lib/capabilities";

type CleanupSurface = "root" | "child" | "verification" | "retained";
type Entry = "direct" | "checker";
type OpenAt = (parentDescriptor: number, path: Buffer, flags: number) => number;
type RawCounts = {
  open_sync: number;
  openat: number;
  fstat_sync: number;
  read_sync: number;
  close_sync: number;
};
type CloseAttempt = Readonly<{ owner: string; ordinal: number }>;
type CapabilitiesModule = Readonly<{
  installDescriptorPrimitiveMediator: (mediator: DescriptorPrimitiveMediator) => void;
}>;
type IngressModule = Readonly<{
  readBoundedFile: (path: string, maximum: number, hooks?: Readonly<{
    onCloseAttempt?: (attempt: CloseAttempt) => void;
  }>) => Promise<Uint8Array>;
}>;
type CheckerModule = Readonly<{
  runCheckForTest: (
    args: readonly string[],
    io: Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>,
    hooks: Readonly<{ onCloseAttempt?: (attempt: CloseAttempt) => void }>
  ) => Promise<number>;
}>;
type EntryOutcome = Readonly<{
  code: string;
  exit: number | null;
  stdout: string;
  stderr: string;
}>;

const surface = process.argv[2] as CleanupSurface | undefined;
const entry = process.argv[3] as Entry | undefined;
const contractsRoot = resolve(import.meta.dir, "..");
const validInput = resolve(contractsRoot, "fixtures", "valid", "source-input-record-paired-surrogate.json");
const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
const maximumBytes = 64 * 1024;
const raw: RawCounts = { open_sync: 0, openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 };
let fstatCalls = 0;

function descriptorComponents(path: string): number {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  return 1 + absolute.slice(root.length).split(sep).filter(Boolean).length;
}

function nonDirectoryStats(): BigIntStats {
  return Object.freeze({
    dev: 1n,
    ino: 1n,
    size: 0n,
    isDirectory: () => false,
    isFile: () => false
  }) as unknown as BigIntStats;
}

function rawOpenCount(): number {
  return raw.open_sync + raw.openat;
}

function expectedTargetAttempts(owner: CleanupSurface): number {
  const components = descriptorComponents(validInput);
  if (owner === "root" || owner === "child") return 2;
  if (owner === "verification") return 4 * (components - 1);
  return 2 * components;
}


function installRawProbe(owner: CleanupSurface): void {
  const originalOpenSync = originalFs.openSync;
  const originalFstatSync = originalFs.fstatSync;
  const originalReadSync = originalFs.readSync;
  const originalCloseSync = originalFs.closeSync;
  const forcedFstat = owner === "root" ? 1 : owner === "child" ? 2 : 0;
  mock.module("node:fs", () => ({
    ...originalFs,
    openSync(...args: Parameters<typeof originalOpenSync>) {
      raw.open_sync += 1;
      return originalOpenSync(...args);
    },
    fstatSync(...args: Parameters<typeof originalFstatSync>) {
      raw.fstat_sync += 1;
      fstatCalls += 1;
      if (fstatCalls === forcedFstat) return nonDirectoryStats();
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
          openat(...openAtArgs: Parameters<OpenAt>): number {
            raw.openat += 1;
            return nativeOpenAt(...openAtArgs);
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
  // Raw imports bind at evaluation, so these modules load only after this process installs its probes.
  const [capabilities, ingress, checker] = await Promise.all([
    import("../lib/capabilities"),
    import("../lib/ingress"),
    import("../lib/checker")
  ]);
  return Object.freeze({
    capabilities: capabilities as CapabilitiesModule,
    ingress: ingress as IngressModule,
    checker: checker as CheckerModule
  });
}

async function runEntry(
  selectedEntry: Entry,
  modules: Readonly<{ ingress: IngressModule; checker: CheckerModule }>,
  hooks: Readonly<{ onCloseAttempt?: (attempt: CloseAttempt) => void }>
): Promise<EntryOutcome> {
  if (selectedEntry === "direct") {
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

function pairedAttemptOrdinals(attempts: readonly number[]): boolean {
  return attempts.length > 0 && attempts.length % 2 === 0 && attempts.every(
    (ordinal, index) => index % 2 === 0 || ordinal === attempts[index - 1]! + 1
  );
}

try {
  if (!surface || !["root", "child", "verification", "retained"].includes(surface)) {
    throw new Error("round-three ingress child requires a cleanup surface");
  }
  if (!entry || !["direct", "checker"].includes(entry)) {
    throw new Error("round-three ingress child requires an entry path");
  }
  installRawProbe(surface);
  const modules = await loadModules();
  modules.capabilities.installDescriptorPrimitiveMediator((operation, invoke) =>
    operation === "close_sync" ? undefined : invoke()
  );
  const attempts: CloseAttempt[] = [];
  const hooks = Object.freeze({
    onCloseAttempt: (attempt: CloseAttempt): void => { attempts.push(attempt); }
  });
  Bun.gc(true);
  const baseline = await descriptorCount();
  const first = await runEntry(entry, modules, hooks);
  const firstRawOpens = rawOpenCount();
  const targetAttempts = attempts.filter(
    (attempt) => attempt.owner === (surface === "root" || surface === "child" ? "unretained" : surface)
  );
  Bun.gc(true);
  const afterFirst = await descriptorCount();
  const attemptsAfterFirst = attempts.length;
  const rawOpensAfterFirst = rawOpenCount();
  const laterDirect = await runEntry("direct", modules, hooks);
  const laterChecker = await runEntry("checker", modules, hooks);
  Bun.gc(true);
  const afterLater = await descriptorCount();
  console.log(JSON.stringify({
    surface,
    entry,
    baseline,
    afterFirst,
    afterLater,
    first,
    laterDirect,
    laterChecker,
    firstRawOpens,
    laterRawOpens: rawOpenCount() - rawOpensAfterFirst,
    rawCloseCalls: raw.close_sync,
    firstCloseAttemptCount: attemptsAfterFirst,
    laterCloseAttemptCount: attempts.length - attemptsAfterFirst,
    targetAttemptOrdinals: targetAttempts.map((attempt) => attempt.ordinal),
    targetAttemptsPaired: pairedAttemptOrdinals(targetAttempts.map((attempt) => attempt.ordinal)),
    expectedTargetAttempts: expectedTargetAttempts(surface)
  }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
