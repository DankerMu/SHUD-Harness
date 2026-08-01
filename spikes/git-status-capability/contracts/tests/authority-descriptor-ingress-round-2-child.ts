import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { BigIntStats, DescriptorOperation, DescriptorPrimitiveMediator } from "../lib/capabilities";

type Scenario = "transient" | "persistent";
type CloseMode = "omitted" | "throw" | "thenable" | "deferred";
type CleanupOwner = "root" | "child" | "verification" | "retained";
type Entry = "readBoundedFile" | "runCheckForTest";
type CapabilitiesModule = Readonly<{
  installDescriptorPrimitiveMediator: (mediator: DescriptorPrimitiveMediator) => void;
}>;
type IngressModule = Readonly<{
  ContractError: new (code: string) => Error & Readonly<{ code: string }>;
  readBoundedFile: (
    path: string,
    maximum: number,
    hooks?: Readonly<{
      onCloseAttempt?: (attempt: Readonly<{ owner: string; ordinal: number }>) => void;
      afterAdmission?: () => void | Promise<void>;
    }>,
    beforeCleanup?: (bytes: Uint8Array) => void
  ) => Promise<Uint8Array>;
}>;
type CheckerModule = Readonly<{
  runCheckForTest: (
    args: readonly string[],
    io: Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>,
    hooks: Readonly<{
      onCloseAttempt?: (attempt: Readonly<{ owner: string; ordinal: number }>) => void;
    }>
  ) => Promise<number>;
}>;
type ActiveRun = {
  mode: CloseMode;
  owner: CleanupOwner;
  closeDirective: "allow" | "failure" | "retry";
  selected: boolean;
  retryPending: boolean;
  targetAttemptOrdinals: number[];
  targetRawCloseCalls: number;
  closeCallbacks: number;
  deferredErrors: string[];
  forceRootMismatch: boolean;
  rootMismatchReturned: boolean;
};

const scenario = process.argv[2] as Scenario | undefined;
const contractsRoot = resolve(import.meta.dir, "..");
const validInput = resolve(contractsRoot, "fixtures", "valid", "source-input-record-paired-surrogate.json");
const directoryInput = resolve(contractsRoot, "fixtures", "valid");
const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
const maximumBytes = 64 * 1024;

function errorMessage(action: () => unknown): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}


function fakeNonDirectoryStats(): BigIntStats {
  return Object.freeze({
    dev: 1n,
    ino: 1n,
    size: 0n,
    isDirectory: () => false,
    isFile: () => false
  }) as unknown as BigIntStats;
}

let activeRun: ActiveRun | undefined;
let rawCloseCalls = 0;

function installRawCloseProbe(): void {
  const originalCloseSync = originalFs.closeSync;
  const originalFstatSync = originalFs.fstatSync;
  mock.module("node:fs", () => ({
    ...originalFs,
    closeSync(...args: Parameters<typeof originalCloseSync>) {
      rawCloseCalls += 1;
      if (activeRun?.closeDirective === "retry") activeRun.targetRawCloseCalls += 1;
      return originalCloseSync(...args);
    },
    fstatSync(...args: Parameters<typeof originalFstatSync>) {
      if (activeRun?.forceRootMismatch && !activeRun.rootMismatchReturned) {
        activeRun.rootMismatchReturned = true;
        return fakeNonDirectoryStats();
      }
      return originalFstatSync(...args);
    }
  }));
  mock.module("bun:ffi", () => ({ ...originalFfi }));
}

// Each child binds raw mocks before loading the capability owner, which is the point of this process seam.
async function loadModules(): Promise<Readonly<{
  capabilities: CapabilitiesModule;
  ingress: IngressModule;
  checker: CheckerModule;
}>> {
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

function matchingOwner(owner: CleanupOwner, attemptOwner: string): boolean {
  if (owner === "root" || owner === "child") return attemptOwner === "unretained";
  return owner === attemptOwner;
}

function createActiveRun(mode: CloseMode, owner: CleanupOwner): ActiveRun {
  return {
    mode,
    owner,
    closeDirective: "allow",
    selected: false,
    retryPending: false,
    targetAttemptOrdinals: [],
    targetRawCloseCalls: 0,
    closeCallbacks: 0,
    deferredErrors: [],
    forceRootMismatch: owner === "root",
    rootMismatchReturned: false
  };
}

function createHooks(run: ActiveRun): Readonly<{
  onCloseAttempt: (attempt: Readonly<{ owner: string; ordinal: number }>) => void;
}> {
  return Object.freeze({
    onCloseAttempt(attempt) {
      run.closeCallbacks += 1;
      if (run.retryPending) {
        run.retryPending = false;
        run.closeDirective = "retry";
        run.targetAttemptOrdinals.push(attempt.ordinal);
        return;
      }
      if (!run.selected && matchingOwner(run.owner, attempt.owner)) {
        run.selected = true;
        run.retryPending = true;
        run.closeDirective = "failure";
        run.targetAttemptOrdinals.push(attempt.ordinal);
        return;
      }
      run.closeDirective = "allow";
    }
  });
}

async function executeTransient(
  modules: Readonly<{ ingress: IngressModule; checker: CheckerModule }>,
  entry: Entry,
  owner: CleanupOwner,
  mode: CloseMode
): Promise<unknown> {
  const input = owner === "child" ? directoryInput : validInput;
  const run = createActiveRun(mode, owner);
  const hooks = createHooks(run);
  const rawBefore = rawCloseCalls;
  activeRun = run;
  let result: unknown;
  try {
    if (entry === "readBoundedFile") {
      const error = await modules.ingress.readBoundedFile(input, maximumBytes, hooks)
        .then(() => "NO_ERROR", (failure) => failure instanceof Error ? failure.message : String(failure));
      result = Object.freeze({ error });
    } else {
      let stdout = "";
      let stderr = "";
      const exit = await modules.checker.runCheckForTest(
        ["--input", input, "--kind", "source_input_record"],
        { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
        hooks
      );
      result = Object.freeze({ exit, stdout, stderr });
    }
    await Promise.resolve();
  } finally {
    activeRun = undefined;
  }
  return Object.freeze({
    mode,
    owner,
    entry,
    result,
    selected: run.selected,
    targetAttemptOrdinals: Object.freeze([...run.targetAttemptOrdinals]),
    targetRawCloseCalls: run.targetRawCloseCalls,
    closeCallbacks: run.closeCallbacks,
    rawCloseCalls: rawCloseCalls - rawBefore,
    deferredErrors: Object.freeze([...run.deferredErrors])
  });
}

async function runTransient(): Promise<unknown> {
  installRawCloseProbe();
  const modules = await loadModules();
  modules.capabilities.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (operation !== "close_sync" || !activeRun || activeRun.closeDirective === "allow" || activeRun.closeDirective === "retry") {
      return invoke();
    }
    if (activeRun.closeDirective !== "failure") throw new Error("unknown transient close directive");
    if (activeRun.mode === "omitted") return undefined;
    if (activeRun.mode === "throw") throw new Error("CLOSE_BEFORE_INVOKE");
    if (activeRun.mode === "thenable") return { then: () => undefined };
    const deferred = Promise.resolve().then(() => {
      activeRun?.deferredErrors.push(errorMessage(() => invoke()));
    });
    void deferred;
    return undefined;
  });

  const rows: unknown[] = [];
  for (const owner of ["root", "child", "verification", "retained"] as const) {
    for (const mode of ["omitted", "throw", "thenable", "deferred"] as const) {
      for (const entry of ["readBoundedFile", "runCheckForTest"] as const) {
        const before = await readdir(descriptorDirectory);
        const runs = [];
        for (let repeat = 0; repeat < 3; repeat += 1) {
          runs.push(await executeTransient(modules, entry, owner, mode));
        }
        Bun.gc(true);
        const after = await readdir(descriptorDirectory);
        rows.push(Object.freeze({ owner, mode, entry, runs: Object.freeze(runs), baselineRestored: after.length === before.length }));
      }
    }
  }
  return Object.freeze({ rows });
}

async function runPersistent(): Promise<unknown> {
  installRawCloseProbe();
  const modules = await loadModules();
  let persistentCallbacks = 0;
  modules.capabilities.installDescriptorPrimitiveMediator((operation, invoke) =>
    operation === "close_sync" ? undefined : invoke()
  );
  const hooks = Object.freeze({
    onCloseAttempt() {
      persistentCallbacks += 1;
    }
  });
  const expectedAttempts = 2;
  const primaryError = await modules.ingress.readBoundedFile(
    validInput,
    maximumBytes,
    Object.freeze({
      ...hooks,
      afterAdmission: () => { throw new modules.ingress.ContractError("CONTRACT_JSON_MALFORMED"); }
    })
  ).then(() => "NO_ERROR", (error) => error instanceof Error ? error.message : String(error));
  const primaryAttempts = persistentCallbacks;
  persistentCallbacks = 0;
  const cleanupOnlyError = await modules.ingress.readBoundedFile(validInput, maximumBytes, hooks)
    .then(() => "NO_ERROR", (error) => error instanceof Error ? error.message : String(error));
  const cleanupOnlyAttempts = persistentCallbacks;
  persistentCallbacks = 0;
  let stdout = "";
  let stderr = "";
  const checkerExit = await modules.checker.runCheckForTest(
    ["--input", validInput, "--kind", "source_input_record"],
    { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    hooks
  );
  const checkerAttempts = persistentCallbacks;
  return Object.freeze({
    expectedAttempts,
    primaryError,
    primaryAttempts,
    cleanupOnlyError,
    cleanupOnlyAttempts,
    checkerExit,
    checkerStdout: stdout,
    checkerStderr: stderr,
    checkerAttempts,
    rawCloseCalls
  });
}

try {
  let result: unknown;
  if (scenario === "transient") result = await runTransient();
  else if (scenario === "persistent") result = await runPersistent();
  else throw new Error("round-two ingress child requires a scenario");
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
