import { mock } from "bun:test";
import * as originalFs from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type CloseOwner = "unretained" | "retained" | "verification";
type CloseAttempt = Readonly<{ owner: CloseOwner; ordinal: number }>;
type CloseHooks = Readonly<{
  closeFault?: (attempt: CloseAttempt) => boolean;
  onCloseAttempt?: (attempt: CloseAttempt) => void;
}>;
type Entry = "ingress" | "checker";
type Scenario = "identity" | "retry" | "terminal_return" | "terminal_throw";
type EntryOutcome = Readonly<{ code: string | null; exit: number | null; stdout: string; stderr: string }>;
type CapabilityInstance = {
  close: (descriptor: object, owner: CloseOwner) => void;
  openRoot: (root: string, phase: "admission") => object;
};
type CapabilitiesModule = Readonly<{
  ContractCapabilities: {
    new (hooks?: CloseHooks): CapabilityInstance;
    prototype: CapabilityInstance;
  };
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

const [scenarioArgument, entryArgument] = process.argv.slice(2) as [Scenario | undefined, string | undefined];
if (!scenarioArgument || !entryArgument) throw new Error("close runtime child requires a scenario and entry");
const scenario = scenarioArgument;
const productionRoot = process.env.SHUD_DESCRIPTOR_PRODUCTION_ROOT;
const contractsRoot = resolve(import.meta.dir, "..");
const validInput = resolve(contractsRoot, "fixtures", "valid", "source-input-record-paired-surrogate.json");
const raw = { closeSync: 0 };
let throwNextClose = false;

function moduleSpecifier(name: "capabilities" | "checker" | "ingress"): string {
  if (!productionRoot) return `../lib/${name}`;
  return pathToFileURL(resolve(productionRoot, "lib", `${name}.ts`)).href;
}

function installRawProbe(): void {
  const originalCloseSync = originalFs.closeSync;
  mock.module("node:fs", () => ({
    ...originalFs,
    closeSync(...args: Parameters<typeof originalCloseSync>): void {
      raw.closeSync += 1;
      if (throwNextClose) {
        throwNextClose = false;
        throw new Error("CLOSE_RUNTIME_RAW_THROW");
      }
      originalCloseSync(...args);
    }
  }));
}

async function loadModules(): Promise<Readonly<{
  capabilities: CapabilitiesModule;
  ingress: IngressModule;
  checker: CheckerModule;
}>> {
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
  modules: Readonly<{ ingress: IngressModule; checker: CheckerModule }>,
  hooks: CloseHooks
): Promise<EntryOutcome> {
  if (entry === "ingress") {
    try {
      await modules.ingress.readBoundedFile(validInput, 64 * 1024, hooks);
      return Object.freeze({ code: null, exit: null, stdout: "", stderr: "" });
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

async function runIdentity(
  modules: Readonly<{ capabilities: CapabilitiesModule; ingress: IngressModule; checker: CheckerModule }>,
  entry: string
): Promise<unknown> {
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

async function runRetry(
  modules: Readonly<{ ingress: IngressModule; checker: CheckerModule }>,
  entry: Entry
): Promise<unknown> {
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

async function runTerminal(
  modules: Readonly<{ capabilities: CapabilitiesModule; ingress: IngressModule; checker: CheckerModule }>,
  entry: Entry,
  shouldThrow: boolean
): Promise<unknown> {
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

installRawProbe();
const modules = await loadModules();
const receipt = scenario === "identity"
  ? await runIdentity(modules, entryArgument)
  : scenario === "retry"
  ? await runRetry(modules, entryArgument as Entry)
  : scenario === "terminal_return"
  ? await runTerminal(modules, entryArgument as Entry, false)
  : scenario === "terminal_throw"
  ? await runTerminal(modules, entryArgument as Entry, true)
  : (() => { throw new Error(`unsupported close runtime scenario: ${scenario}`); })();
process.stdout.write(`${JSON.stringify(receipt)}\n`);
