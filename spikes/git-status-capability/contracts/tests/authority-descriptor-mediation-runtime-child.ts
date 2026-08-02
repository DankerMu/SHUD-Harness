import { mock } from "bun:test";
import * as originalFs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CapabilityDescriptor,
  CapabilityHooks,
  CloseAttempt,
  ContractCapabilities,
  DescriptorPrimitiveMediator
} from "../lib/capabilities";

type ResponseMode = "ordinary" | "value" | "throw" | "sentinel" | "thenable" | "proxy";
type NoRawCloseMode = "omission" | "value" | "async" | "thenable" | "proxy" | "sentinel" | "hostile";
type Scenario =
  | "close_retry"
  | "direct_close"
  | "direct_no_raw_retry"
  | "reuse"
  | "ingress_raw_throw"
  | "capture_abuse";

const PRODUCTION_ROOT_ENV = "SHUD_DESCRIPTOR_PRODUCTION_ROOT";
const productionRoot = process.env[PRODUCTION_ROOT_ENV];
// Causal mutation rows select a copied production tree only after child startup.

function libraryModuleSpecifier(name: "capabilities" | "checker" | "ingress"): string {
  if (!productionRoot) return `../lib/${name}`;
  return pathToFileURL(join(productionRoot, "lib", `${name}.ts`)).href;
}

type CapabilitiesModule = Readonly<{
  ContractCapabilities: new (hooks?: CapabilityHooks) => ContractCapabilities;
  installDescriptorPrimitiveMediator: (mediator: DescriptorPrimitiveMediator) => void;
}>;

type Entry = "direct" | "checker";
type EntryReceipt = Readonly<{ outcome: string; stdout: string; stderr: string }>;
type IngressModule = Readonly<{
  readBoundedFile: (
    path: string,
    maximum: number,
    hooks?: CapabilityHooks
  ) => Promise<Uint8Array>;
}>;
type CheckerModule = Readonly<{
  runCheckForTest: (
    args: readonly string[],
    io: Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>,
    hooks: CapabilityHooks
  ) => Promise<number>;
}>;
type IngressRuntimeModules = Readonly<{ ingress: IngressModule; checker: CheckerModule }>;

const [scenario, responseModeArgument, entryArgument] = process.argv.slice(2) as [
  Scenario | undefined,
  string | undefined,
  "direct" | "checker" | undefined
];
const responseMode = (responseModeArgument ?? "ordinary") as ResponseMode;
const noRawCloseMode = (responseModeArgument ?? "omission") as NoRawCloseMode;
const rawError = Object.assign(new Error("MEDIATOR_RAW_SENTINEL"), { marker: "raw-private" });
const mediatorThrownSentinel = new Error("MEDIATOR_THROWN_SENTINEL");
let rawCloseCalls = 0;
let proxyTrapReads = 0;
const mediatorThrownProxy = new Proxy(Object.create(null), {
  get(): never {
    proxyTrapReads += 1;
    throw new Error("MEDIATOR_THROWN_PROXY_GET");
  },
  getPrototypeOf(): never {
    proxyTrapReads += 1;
    throw new Error("MEDIATOR_THROWN_PROXY_PROTOTYPE");
  },
  getOwnPropertyDescriptor(): never {
    proxyTrapReads += 1;
    throw new Error("MEDIATOR_THROWN_PROXY_DESCRIPTOR");
  },
  ownKeys(): never {
    proxyTrapReads += 1;
    throw new Error("MEDIATOR_THROWN_PROXY_OWN_KEYS");
  }
});

function errorMessage(action: () => unknown): Readonly<{ message: string; exactRaw: boolean }> {
  try {
    action();
    return Object.freeze({ message: "NO_ERROR", exactRaw: false });
  } catch (error) {
    if (error === mediatorThrownProxy) {
      return Object.freeze({ message: "MEDIATOR_THROWN_PROXY", exactRaw: false });
    }
    return Object.freeze({
      message: error instanceof Error ? error.message : String(error),
      exactRaw: error === rawError
    });
  }
}

function installCloseProbe(
  shouldThrow: boolean,
  throwOnlyOnce = false,
  onRawClose?: () => void
): void {
  const originalCloseSync = originalFs.closeSync;
  let thrown = false;
  mock.module("node:fs", () => ({
    ...originalFs,
    closeSync(...args: Parameters<typeof originalCloseSync>) {
      rawCloseCalls += 1;
      onRawClose?.();
      if (!shouldThrow || (throwOnlyOnce && thrown)) return originalCloseSync(...args);
      thrown = true;
      originalCloseSync(...args);
      throw rawError;
    }
  }));
}

async function loadCapabilities(): Promise<CapabilitiesModule> {
  // The child must install Bun's raw syscall mocks before this module binds its imports.
  return await import(libraryModuleSpecifier("capabilities")) as CapabilitiesModule;
}

async function loadIngressRuntimeModules(): Promise<IngressRuntimeModules> {
  const [ingress, checker] = await Promise.all([
    import(libraryModuleSpecifier("ingress")),
    import(libraryModuleSpecifier("checker"))
  ]);
  return Object.freeze({
    ingress: ingress as IngressModule,
    checker: checker as CheckerModule
  });
}

async function runIngressEntry(
  entry: Entry,
  modules: IngressRuntimeModules,
  hooks: CapabilityHooks
): Promise<EntryReceipt> {
  const input = join(import.meta.dir, "../fixtures/valid/source-input-record-paired-surrogate.json");
  if (entry === "checker") {
    let stdout = "";
    let stderr = "";
    const exit = await modules.checker.runCheckForTest(
      ["--input", input, "--kind", "source_input_record"],
      { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
      hooks
    );
    return Object.freeze({ outcome: `CHECK:${exit}`, stdout, stderr });
  }
  try {
    await modules.ingress.readBoundedFile(input, 8_192, hooks);
    return Object.freeze({ outcome: "NO_ERROR", stdout: "", stderr: "" });
  } catch (error) {
    return Object.freeze({
      outcome: error instanceof Error ? error.message : String(error),
      stdout: "",
      stderr: ""
    });
  }
}

type CapturedIngressOwner = Readonly<{ capabilities: ContractCapabilities }>;
let capturedIngressCapabilities: ContractCapabilities | undefined;

function isCapturedIngressOwner(value: unknown): value is CapturedIngressOwner {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return typeof candidate.capabilities === "object" && candidate.capabilities !== null;
}

function installCapabilityCapture(): void {
  const originalMapSet = Map.prototype.set;
  Map.prototype.set = (function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown
  ): Map<unknown, unknown> {
    if (!capturedIngressCapabilities && isCapturedIngressOwner(value)) {
      capturedIngressCapabilities = value.capabilities;
    }
    return Reflect.apply(originalMapSet, this, [key, value]) as Map<unknown, unknown>;
  }) as typeof Map.prototype.set;
}

function closeQuietly(
  capabilities: ContractCapabilities,
  descriptor: CapabilityDescriptor,
  owner: "unretained" | "retained"
): void {
  try {
    capabilities.close(descriptor, owner);
  } catch {
    // A raw throw can make the capability terminal while the test still cleans its real descriptor.
  }
}

async function runCloseRetry(): Promise<unknown> {
  installCloseProbe(false);
  const module = await loadCapabilities();
  let skippedCloseCalls = 0;
  module.installDescriptorPrimitiveMediator((operation, invoke): undefined => {
    if (operation === "close_sync" && skippedCloseCalls === 0) {
      skippedCloseCalls += 1;
      return undefined;
    }
    invoke();
    return undefined;
  });
  let hookCalls = 0;
  let closeFaultCalls = 0;
  let rawCallsWhenFirstCloseFault: number | null = null;
  const hooks = Object.freeze({
    onCloseAttempt: () => {
      hookCalls += 1;
      if (responseMode === "ordinary" && hookCalls === 1) {
        throw new Error("FIRST_CLOSE_HOOK_FAILURE");
      }
    },
    closeFault: () => {
      closeFaultCalls += 1;
      rawCallsWhenFirstCloseFault ??= rawCloseCalls;
      if (closeFaultCalls !== 1) return false;
      if (responseMode === "throw") throw new Error("FIRST_CLOSE_FAULT_FAILURE");
      return responseMode === "value" || responseMode === "sentinel";
    }
  });
  const input = join(import.meta.dir, "../fixtures/valid/source-input-record-paired-surrogate.json");
  const maximum = responseMode === "sentinel" ? 0 : 8_192;
  let outcome: string;
  let stdout = "";
  let stderr = "";
  if (entryArgument === "checker") {
    const checkerFixtureRoot = responseMode === "sentinel"
      ? await mkdtemp(join(tmpdir(), "shud-close-retry-"))
      : undefined;
    try {
      let checkerInput = input;
      if (checkerFixtureRoot) {
        checkerInput = join(checkerFixtureRoot, "source-input-record-over-limit.json");
        // Trailing JSON whitespace keeps the fixture valid while exceeding SOURCE_PROFILE.bytes.
        await writeFile(checkerInput, Buffer.concat([
          await readFile(input),
          Buffer.alloc(65_536, 0x20)
        ]));
      }
      const checker = await import(libraryModuleSpecifier("checker"));
      const exit = await checker.runCheckForTest(
        ["--input", checkerInput, "--kind", "source_input_record"],
        { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
        hooks
      );
      outcome = `CHECK:${exit}`;
    } finally {
      if (checkerFixtureRoot) await rm(checkerFixtureRoot, { recursive: true, force: true });
    }
  } else {
    const ingress = await import(libraryModuleSpecifier("ingress"));
    try {
      await ingress.readBoundedFile(input, maximum, hooks);
      outcome = "NO_ERROR";
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    entry: entryArgument ?? "direct",
    outcome,
    stdout,
    stderr,
    skippedCloseCalls,
    hookCalls,
    closeFaultCalls,
    rawCallsWhenFirstCloseFault,
    rawCalls: rawCloseCalls
  };
}

function noRawCloseResponse(mode: NoRawCloseMode): undefined {
  if (mode === "omission") return undefined;
  if (mode === "async") return Promise.resolve() as unknown as undefined;
  if (mode === "value") return 1 as undefined;
  if (mode === "thenable") {
    return Object.defineProperty({}, "then", { value: () => undefined }) as undefined;
  }
  if (mode === "proxy") return new Proxy({}, {}) as undefined;
  if (mode === "sentinel") throw mediatorThrownSentinel;
  throw mediatorThrownProxy;
}

async function runDirectNoRawRetry(): Promise<unknown> {
  installCloseProbe(false);
  const module = await loadCapabilities();
  let mediatedCloseCalls = 0;
  module.installDescriptorPrimitiveMediator((operation, invoke): undefined => {
    if (operation !== "close_sync") {
      invoke();
      return undefined;
    }
    mediatedCloseCalls += 1;
    if (mediatedCloseCalls === 1) return noRawCloseResponse(noRawCloseMode);
    invoke();
    return undefined;
  });
  const capabilities = new module.ContractCapabilities();
  const descriptor = capabilities.openRoot("/", "admission");
  let firstCaught: unknown;
  const firstOutcome = errorMessage(() => {
    try {
      capabilities.close(descriptor, "unretained");
    } catch (error) {
      firstCaught = error;
      throw error;
    }
  });
  const secondOutcome = errorMessage(() => { capabilities.close(descriptor, "unretained"); });
  return {
    mode: noRawCloseMode,
    firstOutcome: firstOutcome.message,
    firstSentinel: firstCaught === mediatorThrownSentinel,
    firstHostile: firstCaught === mediatorThrownProxy,
    secondOutcome: secondOutcome.message,
    mediatedCloseCalls,
    rawCalls: rawCloseCalls
  };
}

async function runDirectClose(): Promise<unknown> {
  installCloseProbe(false);
  const module = await loadCapabilities();
  module.installDescriptorPrimitiveMediator((operation, invoke): undefined => {
    if (operation !== "close_sync") {
      invoke();
      return undefined;
    }
    if (responseMode === "ordinary") return undefined;
    if (responseMode === "value") return 1 as undefined;
    if (responseMode === "throw") throw mediatorThrownProxy;
    throw mediatorThrownSentinel;
  });
  const capabilities = new module.ContractCapabilities();
  const descriptor = capabilities.openRoot("/", "admission");
  let caught: unknown;
  const outcome = errorMessage(() => {
    try {
      capabilities.close(descriptor, "unretained");
    } catch (error) {
      caught = error;
      throw error;
    }
  });
  return {
    responseMode,
    outcome,
    rawCalls: rawCloseCalls,
    proxyTrapReads,
    exactPreInvocationOutcome: responseMode === "throw"
      ? caught === mediatorThrownProxy
      : responseMode === "sentinel"
      ? caught === mediatorThrownSentinel
      : null
  };
}

async function runReuse(): Promise<unknown> {
  installCloseProbe(true, true);
  const module = await loadCapabilities();
  const denials: string[] = [];
  const capabilities = new module.ContractCapabilities({
    onDescriptorAuthorityDenial: (denial) => { denials.push(denial.reason); }
  });
  const oldDescriptor = capabilities.openRoot("/", "admission");
  const closeOutcome = errorMessage(() => { capabilities.close(oldDescriptor, "unretained"); });
  const currentDescriptor = capabilities.openRoot("/", "admission");
  const currentUsable = capabilities.stat(currentDescriptor).isDirectory();
  const oldOutcome = errorMessage(() => { capabilities.stat(oldDescriptor); });
  const rawCallsBeforeCurrentCleanup = rawCloseCalls;
  closeQuietly(capabilities, currentDescriptor, "unretained");
  return {
    closeOutcome: closeOutcome.message,
    oldOutcome: oldOutcome.message,
    currentUsable,
    denials,
    rawCalls: rawCallsBeforeCurrentCleanup
  };
}

type IngressTerminalFault = "raw_throw" | "close_fault_true" | "close_fault_throw";

async function runIngressTerminalFailure(
  fault: IngressTerminalFault,
  captureCapability: boolean
): Promise<unknown> {
  const entry = entryArgument;
  if (!entry) throw new Error("ingress terminal child requires a direct or checker entry");

  let targetAttempt: CloseAttempt | undefined;
  let activeTargetAttempt: CloseAttempt | undefined;
  let targetMediatedCloseCalls = 0;
  let targetRawCloseCalls = 0;
  let closedDescriptorDenials = 0;
  let targetPhase = true;
  let oldHelperOutcome = "NOT_ATTEMPTED";
  let oldHelperAttempts = 0;

  installCloseProbe(fault === "raw_throw", true, () => {
    if (activeTargetAttempt?.ordinal === targetAttempt?.ordinal) targetRawCloseCalls += 1;
  });
  if (captureCapability) installCapabilityCapture();

  const [capabilities, modules] = await Promise.all([
    loadCapabilities(),
    loadIngressRuntimeModules()
  ]);
  const hooks: CapabilityHooks = Object.freeze({
    onCloseAttempt: (attempt) => {
      if (!targetPhase) {
        activeTargetAttempt = undefined;
        return;
      }
      activeTargetAttempt = attempt;
      targetAttempt ??= attempt;
      if (!captureCapability || oldHelperAttempts !== 0) return;
      oldHelperAttempts += 1;
      if (!capturedIngressCapabilities) {
        oldHelperOutcome = "CAPTURE_MISSING";
        return;
      }
      const oldHelper = (modules.ingress as unknown as Readonly<Record<string, unknown>>)
        .allowsIngressRawClose;
      if (typeof oldHelper !== "function") {
        oldHelperOutcome = "ABSENT";
        return;
      }
      try {
        (oldHelper as (capabilities: ContractCapabilities) => unknown)(capturedIngressCapabilities);
        oldHelperOutcome = "CALLED";
      } catch (error) {
        oldHelperOutcome = error instanceof Error ? `THREW:${error.message}` : "THREW";
      }
    },
    closeFault: (attempt) => {
      if (fault === "raw_throw" || attempt.ordinal !== targetAttempt?.ordinal || !targetPhase) return false;
      if (fault === "close_fault_throw") throw new Error("POST_RAW_CLOSE_FAULT_SENTINEL");
      return true;
    },
    onDescriptorAuthorityDenial: (denial) => {
      if (denial.operation === "close_sync" && denial.reason === "closed_descriptor") {
        closedDescriptorDenials += 1;
      }
    }
  });
  capabilities.installDescriptorPrimitiveMediator((operation, invoke): undefined => {
    if (operation === "close_sync" && activeTargetAttempt?.ordinal === targetAttempt?.ordinal) {
      targetMediatedCloseCalls += 1;
    }
    invoke();
    return undefined;
  });

  const first = await runIngressEntry(entry, modules, hooks);
  targetPhase = false;
  activeTargetAttempt = undefined;
  const laterDirect = await runIngressEntry("direct", modules, hooks);
  const laterChecker = await runIngressEntry("checker", modules, hooks);
  return {
    entry,
    fault,
    first,
    laterDirect,
    laterChecker,
    target: targetAttempt ? { owner: targetAttempt.owner, ordinal: targetAttempt.ordinal } : null,
    targetMediatedCloseCalls,
    targetRawCloseCalls,
    closedDescriptorDenials,
    capturedCapability: Boolean(capturedIngressCapabilities),
    oldHelperOutcome,
    oldHelperAttempts,
    ingressExports: Object.keys(modules.ingress).sort()
  };
}


if (scenario === "capture_abuse" && responseModeArgument !== "true" && responseModeArgument !== "throw") {
  throw new Error("capture abuse child requires a true or throw closeFault mode");
}

const receipt = scenario === "close_retry"
  ? await runCloseRetry()
  : scenario === "direct_close"
  ? await runDirectClose()
  : scenario === "direct_no_raw_retry"
  ? await runDirectNoRawRetry()
  : scenario === "reuse"
  ? await runReuse()
  : scenario === "ingress_raw_throw"
  ? await runIngressTerminalFailure("raw_throw", false)
  : scenario === "capture_abuse"
  ? await runIngressTerminalFailure(
    responseModeArgument === "true" ? "close_fault_true" : "close_fault_throw",
    true
  )
  : (() => { throw new Error(`unsupported mediation runtime scenario: ${scenario ?? "missing"}`); })();
process.stdout.write(`${JSON.stringify(receipt)}\n`);
