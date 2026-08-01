import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Scenario =
  | "default"
  | "sequence"
  | "install"
  | "omitted"
  | "repeated"
  | "late"
  | "async"
  | "primitive"
  | "hooks";
type RawCallCounts = Readonly<{
  open_root: number;
  openat: number;
  fstat_sync: number;
  read_sync: number;
  close_sync: number;
}>;
type DefaultReceipt = Readonly<{
  bytes: number;
  text: string;
  publicExports: readonly string[];
  restrictedExports: readonly string[];
  restrictedInstanceProperties: readonly string[];
}>;
type SequenceReceipt = Readonly<{
  bytes: number;
  text: string;
  operations: readonly string[];
  invocations: number;
  rawCalls: RawCallCounts;
  segments: number;
}>;
type InstallationReceipt = Readonly<{ secondInstallation: string; restrictedExports: readonly string[] }>;
type OmittedReceipt = Readonly<{ error: string; rawCalls: Readonly<{ open_root: number }> }>;
type RepeatedReceipt = Readonly<{ error: string; rawCalls: number }>;
type LateReceipt = Readonly<{ missing: string; expired: string; rawCalls: number }>;
type AsyncReceipt = Readonly<{ error: string; rawCalls: number }>;
type PrimitiveReceipt = Readonly<{
  returnedSame: boolean;
  error: string;
  rawCalls: number;
  operations: readonly string[];
}>;
type HookReceipt = Readonly<{
  events: readonly string[];
  hookOperationActive: readonly boolean[];
  closeError: string;
}>;

const mediationChildPath = join(import.meta.dir, "authority-descriptor-mediation-child.ts");
const FIXTURE_TEXT = "descriptor-mediation";
const MEDIATION_ERRORS = Object.freeze({
  alreadyInstalled: "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_ALREADY_INSTALLED",
  asyncMediator: "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_ASYNC",
  expiredInvocation: "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_EXPIRED",
  missingInvocation: "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_MISSING",
  repeatedInvocation: "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_REPEATED"
});

async function runScenario<Receipt>(scenario: Scenario): Promise<Receipt> {
  const child = Bun.spawn([process.execPath, mediationChildPath, scenario], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as Receipt;
}

describe("descriptor primitive mediation", () => {
  test("default descriptor behavior stays direct and exposes no ambient mediation controls", async () => {
    const receipt = await runScenario<DefaultReceipt>("default");
    expect(receipt.bytes).toBe(Buffer.byteLength(FIXTURE_TEXT));
    expect(receipt.text).toBe(FIXTURE_TEXT);
    expect(receipt.publicExports).toEqual([
      "ContractCapabilities",
      "DESCRIPTOR_OPERATION_POLICY",
      "DIRECTORY_OPEN_FLAGS",
      "FILE_OPEN_FLAGS",
      "installDescriptorPrimitiveMediator"
    ]);
    expect(receipt.restrictedExports).toEqual([]);
    expect(receipt.restrictedInstanceProperties).toEqual([]);
  });

  test("a synchronous mediator sees the exact raw operation sequence and invokes every primitive once", async () => {
    const receipt = await runScenario<SequenceReceipt>("sequence");
    const expectedOperations = [
      "open_root",
      ...Array.from({ length: receipt.segments }, () => ["fstat_sync", "openat"]).flat(),
      "fstat_sync",
      "openat",
      "fstat_sync",
      "read_sync",
      ...Array.from({ length: receipt.segments + 2 }, () => "close_sync")
    ];
    expect(receipt.segments).toBeGreaterThan(0);
    expect(receipt.operations).toEqual(expectedOperations);
    expect(receipt.invocations).toBe(expectedOperations.length);
    expect(receipt.rawCalls).toEqual({
      open_root: 1,
      openat: receipt.segments + 1,
      fstat_sync: receipt.segments + 2,
      read_sync: 1,
      close_sync: receipt.segments + 2
    });
    expect(receipt.bytes).toBe(Buffer.byteLength(FIXTURE_TEXT));
    expect(receipt.text).toBe(FIXTURE_TEXT);
  });

  test("installation is module-instance one-shot and does not reveal an active mediator", async () => {
    const receipt = await runScenario<InstallationReceipt>("install");
    expect(receipt.secondInstallation).toBe(MEDIATION_ERRORS.alreadyInstalled);
    expect(receipt.restrictedExports).toEqual([]);
  });

  test("an omitted invocation fails closed before openSync", async () => {
    const receipt = await runScenario<OmittedReceipt>("omitted");
    expect(receipt).toEqual({
      error: MEDIATION_ERRORS.missingInvocation,
      rawCalls: { open_root: 0 }
    });
  });

  test("a repeated invocation fails closed after one primitive call", async () => {
    const receipt = await runScenario<RepeatedReceipt>("repeated");
    expect(receipt).toEqual({ error: MEDIATION_ERRORS.repeatedInvocation, rawCalls: 1 });
  });

  test("a retained invocation expires when its mediator callback returns", async () => {
    const receipt = await runScenario<LateReceipt>("late");
    expect(receipt).toEqual({
      missing: MEDIATION_ERRORS.missingInvocation,
      expired: MEDIATION_ERRORS.expiredInvocation,
      rawCalls: 0
    });
  });

  test("an async mediator fails closed before its deferred invocation can reach fstatSync", async () => {
    const receipt = await runScenario<AsyncReceipt>("async");
    expect(receipt).toEqual({ error: MEDIATION_ERRORS.asyncMediator, rawCalls: 0 });
  });

  test("mediated primitives preserve their raw return identity and thrown error", async () => {
    const receipt = await runScenario<PrimitiveReceipt>("primitive");
    expect(receipt).toEqual({
      returnedSame: true,
      error: "MEDIATED_RAW_FSTAT_ERROR",
      rawCalls: 2,
      operations: ["fstat_sync", "fstat_sync"]
    });
  });

  test("denial and lifecycle hooks run with mediation inactive, including injected close faults and hook-started work", async () => {
    const receipt = await runScenario<HookReceipt>("hooks");
    expect(receipt.events).toEqual([
      "denial:false",
      "close_attempt:false",
      "close_fault:false",
      "authority_violation:false"
    ]);
    expect(receipt.hookOperationActive).toEqual([false]);
    expect(receipt.closeError).toBe("CONTRACT_CAPABILITY_CLOSE_FAILED");
  });
});
