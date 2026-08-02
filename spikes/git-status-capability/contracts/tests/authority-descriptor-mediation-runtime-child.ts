import { mock } from "bun:test";
import * as originalFs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CapabilityDescriptor,
  CapabilityHooks,
  ContractCapabilities,
  DescriptorPrimitiveMediator
} from "../lib/capabilities";

type ResponseMode = "ordinary" | "value" | "throw" | "sentinel" | "thenable" | "proxy";
type NoRawCloseMode = "omission" | "value" | "async" | "thenable" | "proxy" | "sentinel" | "hostile";
type Scenario = "close_retry" | "direct_close" | "direct_no_raw_retry" | "reuse";

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

function installCloseProbe(shouldThrow: boolean, throwOnlyOnce = false): void {
  const originalCloseSync = originalFs.closeSync;
  let thrown = false;
  mock.module("node:fs", () => ({
    ...originalFs,
    closeSync(...args: Parameters<typeof originalCloseSync>) {
      rawCloseCalls += 1;
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

const receipt = scenario === "close_retry"
  ? await runCloseRetry()
  : scenario === "direct_close"
  ? await runDirectClose()
  : scenario === "direct_no_raw_retry"
  ? await runDirectNoRawRetry()
  : scenario === "reuse"
  ? await runReuse()
  : (() => { throw new Error(`unsupported mediation runtime scenario: ${scenario ?? "missing"}`); })();
process.stdout.write(`${JSON.stringify(receipt)}\n`);
