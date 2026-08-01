import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CapabilityDescriptor,
  ContractCapabilities,
  DescriptorPrimitiveMediator
} from "../lib/capabilities";

type Target = "open_root" | "openat" | "fstat_sync" | "read_sync" | "close_sync";
type ProbeMode = "raw_error" | "post_return" | "post_throw" | "pre";
type ProbeEntry = "capability" | "ingress" | "checker";
type OpenAt = (parentDescriptor: number, path: Buffer, flags: number) => number;
type CapabilitiesModule = Readonly<{
  ContractCapabilities: new () => ContractCapabilities;
  DIRECTORY_OPEN_FLAGS: number;
  FILE_OPEN_FLAGS: number;
  installDescriptorPrimitiveMediator: (mediator: DescriptorPrimitiveMediator) => void;
}>;
type IngressModule = Readonly<{
  readBoundedFile: (path: string, maximum: number) => Promise<Uint8Array>;
}>;
type CheckerModule = Readonly<{
  runCheck: (
    args: readonly string[],
    io: Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>
  ) => Promise<number>;
}>;
type Fixture = Readonly<{ root: string; contents: Buffer; segments: readonly string[] }>;

const target = process.argv[2] as Target | undefined;
const mode = (process.argv[3] ?? "raw_error") as ProbeMode;
const entry = (process.argv[4] ?? "capability") as ProbeEntry;
const customCapabilitiesPath = process.argv[5];
const rawError = Object.assign(new Error("ROUND_THREE_RAW_SENTINEL"), {
  fd: 917,
  path: "/private/sentinel",
  sentinel: "UNCHANGED"
});
let callbackActive = false;
let targetRawCalls = 0;
const callbackSnapshots: boolean[] = [];
const unhandledRejections: string[] = [];
let invokeReturnedUndefined = false;
let mediatorCaught = false;
let repeatedError = "NO_ERROR";
let mutationAttempted = false;
let mutationSucceeded = false;

process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(reason instanceof Error ? reason.message : String(reason));
});

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

function recordTargetRawCall(): void {
  targetRawCalls += 1;
  callbackSnapshots.push(callbackActive);
}

function installRawProbe(selectedTarget: Target, rawThrows: boolean): void {
  const originalOpenSync = originalFs.openSync;
  const originalFstatSync = originalFs.fstatSync;
  const originalReadSync = originalFs.readSync;
  const originalCloseSync = originalFs.closeSync;
  mock.module("node:fs", () => ({
    ...originalFs,
    openSync(...args: Parameters<typeof originalOpenSync>) {
      if (selectedTarget === "open_root") {
        recordTargetRawCall();
        if (rawThrows) throw rawError;
      }
      return originalOpenSync(...args);
    },
    fstatSync(...args: Parameters<typeof originalFstatSync>) {
      if (selectedTarget === "fstat_sync") {
        recordTargetRawCall();
        if (rawThrows) throw rawError;
      }
      return originalFstatSync(...args);
    },
    readSync(...args: Parameters<typeof originalReadSync>) {
      if (selectedTarget === "read_sync") {
        recordTargetRawCall();
        if (rawThrows) throw rawError;
      }
      return originalReadSync(...args);
    },
    closeSync(...args: Parameters<typeof originalCloseSync>) {
      if (selectedTarget === "close_sync") {
        recordTargetRawCall();
        if (rawThrows) throw rawError;
      }
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
            if (selectedTarget === "openat") {
              recordTargetRawCall();
              if (rawThrows) throw rawError;
            }
            return nativeOpenAt(...openAtArgs);
          }
        }
      } as typeof library;
    }
  }));
}

function rejectedNativePromise(label: string): Promise<never> {
  return Promise.reject(new Error(label));
}

function installMediator(module: CapabilitiesModule, selectedTarget: Target, selectedMode: ProbeMode): void {
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    if (operation !== selectedTarget) return invoke();
    callbackActive = true;
    try {
      if (selectedMode === "pre") return rejectedNativePromise("ROUND_FOUR_PRE_INVOKE_REJECTION");
      let result: unknown;
      if (selectedMode === "raw_error") {
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
      } else {
        result = invoke();
      }
      invokeReturnedUndefined = result === undefined;
      if (selectedMode === "post_return" || selectedMode === "post_throw") {
        return rejectedNativePromise("ROUND_FOUR_POST_INVOKE_REJECTION");
      }
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
    const capabilities = new module.ContractCapabilities();
    let descriptor: CapabilityDescriptor | undefined;
    const outcome = captureOuter(() => {
      descriptor = capabilities.openRoot("/", "admission");
    });
    if (descriptor) capabilities.close(descriptor, "unretained");
    return outcome;
  }
  if (selectedTarget === "fstat_sync") {
    const capabilities = new module.ContractCapabilities();
    const descriptor = capabilities.openRoot("/", "admission");
    const outcome = captureOuter(() => capabilities.stat(descriptor));
    capabilities.close(descriptor, "unretained");
    return outcome;
  }
  if (selectedTarget === "openat") {
    const fixture = await createFixture();
    try {
      const retained = retainRoot(module);
      let child: CapabilityDescriptor | undefined;
      const outcome = captureOuter(() => {
        child = retained.capabilities.openRelative(
          retained.descriptor,
          fixture.segments[0]!,
          module.DIRECTORY_OPEN_FLAGS,
          "admission"
        );
      });
      if (child) retained.capabilities.close(child, "unretained");
      retained.capabilities.close(retained.descriptor, "retained");
      return outcome;
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
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

function validSourcePath(): string {
  return join(import.meta.dir, "..", "fixtures", "valid", "source-input-record-paired-surrogate.json");
}

async function exerciseIngress(ingress: IngressModule): Promise<OuterOutcome> {
  try {
    const bytes = await ingress.readBoundedFile(validSourcePath(), 1_000_000);
    return Object.freeze({ message: `BYTES:${bytes.byteLength}`, exactRaw: false });
  } catch (error) {
    return Object.freeze({
      message: error instanceof Error ? error.message : String(error),
      exactRaw: error === rawError
    });
  }
}

async function exerciseChecker(checker: CheckerModule): Promise<Readonly<{
  outcome: OuterOutcome;
  stdout: string;
  stderr: string;
}>> {
  let stdout = "";
  let stderr = "";
  const exit = await checker.runCheck(
    ["--input", validSourcePath(), "--kind", "source_input_record"],
    {
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; }
    }
  );
  return Object.freeze({
    outcome: Object.freeze({ message: `CHECK:${exit}`, exactRaw: false }),
    stdout,
    stderr
  });
}

try {
  const targets = ["open_root", "openat", "fstat_sync", "read_sync", "close_sync"] as const;
  const modes = ["raw_error", "post_return", "post_throw", "pre"] as const;
  const entries = ["capability", "ingress", "checker"] as const;
  if (!target || !targets.includes(target) || !modes.includes(mode) || !entries.includes(entry)) {
    throw new Error("round-three outcome child requires a supported target, mode, and entry");
  }
  if (entry !== "capability" && target !== "open_root") {
    throw new Error("public ingress probes require the open_root mediation target");
  }
  installRawProbe(target, mode === "raw_error" || mode === "post_throw");
  // Raw imports bind at module evaluation, so this test seam must load after the mocks above.
  const moduleSpecifier = customCapabilitiesPath ? pathToFileURL(customCapabilitiesPath).href : "../lib/capabilities";
  const module = await import(moduleSpecifier) as CapabilitiesModule;
  installMediator(module, target, mode);
  let outer: OuterOutcome;
  let checkerStdout = "";
  let checkerStderr = "";
  if (entry === "capability") {
    outer = await exercise(module, target);
  } else if (entry === "ingress") {
    const ingress = await import("../lib/ingress") as IngressModule;
    outer = await exerciseIngress(ingress);
  } else {
    const checker = await import("../lib/checker") as CheckerModule;
    const checkerResult = await exerciseChecker(checker);
    outer = checkerResult.outcome;
    checkerStdout = checkerResult.stdout;
    checkerStderr = checkerResult.stderr;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  console.log(JSON.stringify({
    target,
    mode,
    entry,
    outer: outer.message,
    outerIsExactRaw: outer.exactRaw,
    rawError: { message: rawError.message, fd: rawError.fd, path: rawError.path, sentinel: rawError.sentinel },
    targetRawCalls,
    callbackSnapshots,
    invokeReturnedUndefined,
    mediatorCaught,
    repeatedError,
    mutationAttempted,
    mutationSucceeded,
    unhandledRejections,
    checkerStdout,
    checkerStderr,
    eventLoopTurns: 1
  }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
