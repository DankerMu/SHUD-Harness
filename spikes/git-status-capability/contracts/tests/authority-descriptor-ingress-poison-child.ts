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
type Scenario = "sibling" | "two_no_raw";
type EntryOutcome = Readonly<{ code: string | null; exit: number | null; stdout: string; stderr: string }>;
type CapabilityInstance = {
  close: (descriptor: object, owner: CloseOwner) => void;
  openRelative: (parent: object, childName: string, flags: number, phase: "admission" | "post_admission") => object;
  openRoot: (root: string, phase: "admission" | "post_admission") => object;
  stat: (descriptor: object) => unknown;
};
type CapabilitiesModule = Readonly<{
  ContractCapabilities: {
    prototype: CapabilityInstance;
  };
}>;
type CloseState = Readonly<{ activeContextCount: number; retainedDescriptors: readonly object[] }>;
type IngressModule = Readonly<{
  __testIngressCloseState?: () => CloseState;
  readBoundedFile: (path: string, maximum: number, hooks?: CloseHooks) => Promise<Uint8Array>;
}>;
type CheckerModule = Readonly<{
  runCheckForTest: (
    args: readonly string[],
    io: Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>,
    hooks: CloseHooks
  ) => Promise<number>;
}>;

const [scenarioArgument, entryArgument] = process.argv.slice(2) as [Scenario | undefined, Entry | undefined];
if (!scenarioArgument || !entryArgument) throw new Error("ingress poison child requires a scenario and entry");
const scenario = scenarioArgument;
const entry = entryArgument;
const productionRoot = process.env.SHUD_DESCRIPTOR_PRODUCTION_ROOT;
if (!productionRoot) throw new Error("ingress poison child requires a copied production root");
const contractsRoot = resolve(import.meta.dir, "..");
const validInput = resolve(contractsRoot, "fixtures", "valid", "source-input-record-paired-surrogate.json");
const raw = { closeSync: 0 };

function moduleSpecifier(name: "capabilities" | "checker" | "ingress"): string {
  return pathToFileURL(resolve(productionRoot, "lib", `${name}.ts`)).href;
}

function installRawProbe(): void {
  const originalCloseSync = originalFs.closeSync;
  mock.module("node:fs", () => ({
    ...originalFs,
    closeSync(...args: Parameters<typeof originalCloseSync>): void {
      raw.closeSync += 1;
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
  selected: Entry,
  modules: Readonly<{ ingress: IngressModule; checker: CheckerModule }>,
  hooks: CloseHooks
): Promise<EntryOutcome> {
  if (selected === "ingress") {
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

function closeState(ingress: IngressModule): CloseState {
  const state = ingress.__testIngressCloseState?.();
  if (!state) throw new Error("copied ingress state probe is absent");
  return state;
}

async function runSibling(
  modules: Readonly<{ capabilities: CapabilitiesModule; ingress: IngressModule; checker: CheckerModule }>
): Promise<unknown> {
  const prototype = modules.capabilities.ContractCapabilities.prototype;
  const originalOpenRoot = prototype.openRoot;
  const originalOpenRelative = prototype.openRelative;
  const admitted: object[] = [];
  let capabilities: CapabilityInstance | undefined;
  prototype.openRoot = function(this: CapabilityInstance, root, phase): object {
    const descriptor = Reflect.apply(originalOpenRoot, this, [root, phase]) as object;
    capabilities ??= this;
    if (phase === "admission") admitted.push(descriptor);
    return descriptor;
  };
  prototype.openRelative = function(this: CapabilityInstance, parent, childName, flags, phase): object {
    const descriptor = Reflect.apply(originalOpenRelative, this, [parent, childName, flags, phase]) as object;
    capabilities ??= this;
    if (phase === "admission") admitted.push(descriptor);
    return descriptor;
  };

  let rawBeforeTarget = -1;
  let target: object | undefined;
  let targetAttempts = 0;
  let totalAttempts = 0;
  let closingSibling = false;
  const hooks: CloseHooks = Object.freeze({
    closeFault: () => false,
    onCloseAttempt: (attempt) => {
      totalAttempts += 1;
      const candidate = admitted.at(-1);
      if (attempt.owner !== "retained" || candidate === undefined) return;
      if (target === undefined) {
        target = candidate;
        targetAttempts += 1;
        const sibling = admitted[0];
        if (!sibling || !capabilities) throw new Error("sibling close lacks admitted capabilities");
        rawBeforeTarget = raw.closeSync;
        process.env.SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE = "invoke_then_omit";
        closingSibling = true;
        try {
          capabilities.close(sibling, "retained");
        } finally {
          closingSibling = false;
        }
        return;
      }
      if (!closingSibling) targetAttempts += 1;
    }
  });
  const outcome = await runEntry(entry, modules, hooks);
  if (!target || !capabilities || rawBeforeTarget < 0) throw new Error("sibling row did not reach target cleanup");
  const state = closeState(modules.ingress);
  let targetStillUsable = false;
  try {
    capabilities.stat(target);
    targetStillUsable = true;
  } catch {
    targetStillUsable = false;
  }
  const rawAfterTarget = raw.closeSync;
  const attemptsBeforeLater = totalAttempts;
  const rawBeforeLater = raw.closeSync;
  const laterIngress = await runEntry("ingress", modules, hooks);
  const laterChecker = await runEntry("checker", modules, hooks);
  return Object.freeze({
    activeContextCount: state.activeContextCount,
    entry,
    laterChecker,
    laterIngress,
    laterRawCloseCalls: raw.closeSync - rawBeforeLater,
    laterAttemptCalls: totalAttempts - attemptsBeforeLater,
    outcome,
    rawCloseCallsAfterTarget: rawAfterTarget - rawBeforeTarget,
    targetAttempts,
    targetRetainedAfterContextDeletion: state.retainedDescriptors.includes(target),
    targetStillUsable,
    totalAttempts
  });
}

async function runTwoNoRaw(
  modules: Readonly<{ capabilities: CapabilitiesModule; ingress: IngressModule; checker: CheckerModule }>
): Promise<unknown> {
  const prototype = modules.capabilities.ContractCapabilities.prototype;
  const originalClose = prototype.close;
  let capabilities: CapabilityInstance | undefined;
  let target: object | undefined;
  prototype.close = function(this: CapabilityInstance, descriptor, owner): void {
    capabilities ??= this;
    target ??= descriptor;
    return Reflect.apply(originalClose, this, [descriptor, owner]);
  };

  const attempts: CloseAttempt[] = [];
  let closeFaultCalls = 0;
  const hooks: CloseHooks = Object.freeze({
    closeFault: () => {
      closeFaultCalls += 1;
      return false;
    },
    onCloseAttempt: (attempt) => { attempts.push(attempt); }
  });
  const outcome = await runEntry(entry, modules, hooks);
  if (!target || !capabilities) throw new Error("two-no-raw row did not reach a close target");
  const state = closeState(modules.ingress);
  let targetStillUsable = false;
  try {
    capabilities.stat(target);
    targetStillUsable = true;
  } catch {
    targetStillUsable = false;
  }
  const rawBeforeLater = raw.closeSync;
  const attemptsBeforeLater = attempts.length;
  const laterIngress = await runEntry("ingress", modules, hooks);
  const laterChecker = await runEntry("checker", modules, hooks);
  return Object.freeze({
    activeContextCount: state.activeContextCount,
    attempts: attempts.length,
    closeFaultCalls,
    entry,
    firstAndSecondDistinct: attempts[0] !== undefined && attempts[1] !== undefined && attempts[0] !== attempts[1],
    firstAndSecondFrozen: Boolean(attempts[0] && attempts[1] && Object.isFrozen(attempts[0]) && Object.isFrozen(attempts[1])),
    laterAttemptCalls: attempts.length - attemptsBeforeLater,
    laterChecker,
    laterIngress,
    laterRawCloseCalls: raw.closeSync - rawBeforeLater,
    outcome,
    rawCloseCalls: raw.closeSync,
    targetRetainedAfterContextDeletion: state.retainedDescriptors.includes(target),
    targetStillUsable
  });
}

installRawProbe();
const modules = await loadModules();
const receipt = scenario === "sibling"
  ? await runSibling(modules)
  : scenario === "two_no_raw"
  ? await runTwoNoRaw(modules)
  : (() => { throw new Error(`unsupported ingress poison scenario: ${scenario}`); })();
process.stdout.write(`${JSON.stringify(receipt)}\n`);
