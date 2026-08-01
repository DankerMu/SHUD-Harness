import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DIRECTORY_OPEN_FLAGS } from "../lib/capabilities";

type Scenario =
  | "default"
  | "sequence"
  | "install"
  | "omitted"
  | "repeated"
  | "caught_repeated"
  | "late"
  | "async"
  | "ordinary_thenable"
  | "deferred"
  | "primitive"
  | "post_invoke"
  | "close_settlement"
  | "reentry"
  | "raw_capture"
  | "proxy"
  | "invalid"
  | "same_fd"
  | "hooks"
  | "ingress_hooks";
type RawCallCounts = Readonly<{
  open_sync: number;
  open_sync_args: readonly (readonly unknown[])[];
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
  loaderObservations: readonly string[];
}>;
type InstallationReceipt = Readonly<{
  frozen: boolean;
  constructible: boolean;
  ownProperties: readonly Readonly<{
    key: string;
    value: string | number;
    writable: boolean;
    enumerable: boolean;
    configurable: boolean;
  }>[];
  mutationRejections: Readonly<Record<string, boolean>>;
  invalidInstallation: string;
  firstInstallation: string;
  secondInstallation: string;
  restrictedExports: readonly string[];
}>;
type OmittedReceipt = Readonly<{ error: string; rawCalls: Readonly<{ open_sync: number }> }>;
type RepeatedReceipt = Readonly<{ returnedDirectory: boolean; repeatedError: string; rawCalls: number }>;
type LateReceipt = Readonly<{ missing: string; expired: string; rawCalls: number }>;
type AsyncReceipt = Readonly<{ error: string; rawCalls: number }>;
type DeferredReceipt = Readonly<{ missing: string; deferredError: string; rawCalls: number }>;
type PrimitiveReceipt = Readonly<{
  returnedSame: boolean;
  error: string;
  rawCalls: number;
  operations: readonly string[];
}>;
type PostInvokeReceipt = Readonly<{
  bytes: number;
  text: string;
  segments: number;
  outcomes: readonly string[];
  repeatedErrors: readonly string[];
  fdBaselineRestored: boolean;
  rawCalls: RawCallCounts;
}>;
type CloseSettlementReceipt = Readonly<{
  settlements: readonly Readonly<{
    mode: string;
    firstError: string;
    firstRawCalls: number;
    retry: string;
    retryRawCalls: number;
  }>[];
  rawCloseCalls: number;
}>;
type ReentryReceipt = Readonly<{
  errors: Readonly<Record<string, string>>;
  denials: readonly string[];
  returnedDirectory: boolean;
  rawCalls: number;
}>;
type RawCaptureReceipt = Readonly<{
  bytes: number;
  text: string;
  segments: number;
  captures: readonly Readonly<{ operation: string; type: string; undefined: boolean }>[];
}>;
type ProxyReceipt = Readonly<{
  operations: readonly string[];
  tagReads: number;
  descriptorIsOpaque: boolean;
}>;
type InvalidReceipt = Readonly<{
  rows: readonly (readonly string[])[];
  operations: readonly string[];
  rawCalls: RawCallCounts;
}>;
type SameFdReceipt = Readonly<{
  openCalls: number;
  statCalls: number;
  closeCalls: number;
  replacementIsDirectory: boolean;
  stale: string;
}>;
type HookReceipt = Readonly<{
  events: readonly string[];
  hookOperationActive: readonly boolean[];
  closeError: string;
}>;
type IngressHookReceipt = Readonly<{
  directBytes: number;
  callbackEntries: readonly string[];
  nestedCallbacks: readonly string[];
  checkerExit: number;
  checkerStdout: string;
  checkerStderr: string;
}>;

const mediationChildPath = join(import.meta.dir, "authority-descriptor-mediation-child.ts");
const FIXTURE_TEXT = "descriptor-mediation";
const MEDIATION_ERRORS = Object.freeze({
  alreadyInstalled: "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_ALREADY_INSTALLED",
  asyncMediator: "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_ASYNC",
  expiredInvocation: "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_EXPIRED",
  invalidMediator: "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVALID",
  missingInvocation: "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_MISSING",
  reentry: "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_REENTRY",
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

  test("a synchronous mediator sees the exact raw operation sequence and every openSync argument", async () => {
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
      open_sync: 1,
      open_sync_args: [["/", DIRECTORY_OPEN_FLAGS]],
      openat: receipt.segments + 1,
      fstat_sync: receipt.segments + 2,
      read_sync: 1,
      close_sync: receipt.segments + 2
    });
    expect(receipt.loaderObservations).toEqual(["loader:false", "symbol:false"]);
    expect(receipt.bytes).toBe(Buffer.byteLength(FIXTURE_TEXT));
    expect(receipt.text).toBe(FIXTURE_TEXT);
  });

  test("installation validates before latching and exposes a frozen non-constructible function only", async () => {
    const receipt = await runScenario<InstallationReceipt>("install");
    expect(receipt).toEqual({
      frozen: true,
      constructible: false,
      ownProperties: [
        { key: "length", value: 1, writable: false, enumerable: false, configurable: false },
        {
          key: "name",
          value: "installDescriptorPrimitiveMediator",
          writable: false,
          enumerable: false,
          configurable: false
        }
      ],
      mutationRejections: {
        reset: true,
        getter: true,
        uninstall: true,
        replacement: true,
        raw_callable: true
      },
      invalidInstallation: MEDIATION_ERRORS.invalidMediator,
      firstInstallation: "NO_ERROR",
      secondInstallation: MEDIATION_ERRORS.alreadyInstalled,
      restrictedExports: []
    });
  });

  test("an omitted invocation fails closed before every openSync", async () => {
    const receipt = await runScenario<OmittedReceipt>("omitted");
    expect(receipt).toEqual({
      error: MEDIATION_ERRORS.missingInvocation,
      rawCalls: { open_sync: 0 }
    });
  });

  test("an uncaught repeated invocation throws at its call site but cannot replace the first raw result", async () => {
    const receipt = await runScenario<RepeatedReceipt>("repeated");
    expect(receipt).toEqual({
      returnedDirectory: true,
      repeatedError: MEDIATION_ERRORS.repeatedInvocation,
      rawCalls: 1
    });
  });

  test("a caught repeated invocation still preserves the first raw result and one raw call", async () => {
    const receipt = await runScenario<RepeatedReceipt>("caught_repeated");
    expect(receipt).toEqual({
      returnedDirectory: true,
      repeatedError: MEDIATION_ERRORS.repeatedInvocation,
      rawCalls: 1
    });
  });

  test("a retained invocation expires when its mediator callback returns", async () => {
    const receipt = await runScenario<LateReceipt>("late");
    expect(receipt).toEqual({
      missing: MEDIATION_ERRORS.missingInvocation,
      expired: MEDIATION_ERRORS.expiredInvocation,
      rawCalls: 0
    });
  });

  test("declared-async and ordinary thenable mediators fail closed before a primitive starts", async () => {
    expect(await runScenario<AsyncReceipt>("async")).toEqual({
      error: MEDIATION_ERRORS.asyncMediator,
      rawCalls: 0
    });
    expect(await runScenario<AsyncReceipt>("ordinary_thenable")).toEqual({
      error: MEDIATION_ERRORS.asyncMediator,
      rawCalls: 0
    });
  });

  test("deferred invocation expires after a stable missing failure without a raw call", async () => {
    const receipt = await runScenario<DeferredReceipt>("deferred");
    expect(receipt).toEqual({
      missing: MEDIATION_ERRORS.missingInvocation,
      deferredError: MEDIATION_ERRORS.expiredInvocation,
      rawCalls: 0
    });
  });

  test("mediated primitives preserve their raw return identity and thrown error", async () => {
    const receipt = await runScenario<PrimitiveReceipt>("primitive");
    expect(receipt).toEqual({
      returnedSame: true,
      error: "MEDIATED_RAW_FSTAT_ERROR",
      rawCalls: 2,
      operations: ["fstat_sync", "fstat_sync", "close_sync"]
    });
  });

  test("the first raw outcome owns post-invoke throw, thenable, and repeat precedence without leaking fds", async () => {
    const receipt = await runScenario<PostInvokeReceipt>("post_invoke");
    expect(receipt.bytes).toBe(Buffer.byteLength(FIXTURE_TEXT));
    expect(receipt.text).toBe(FIXTURE_TEXT);
    expect(receipt.outcomes).toEqual([
      "open_root:throw",
      "fstat_sync:uncaught_repeat",
      "openat:thenable",
      "read_sync:caught_repeat",
      "close_sync:throw"
    ]);
    expect(receipt.repeatedErrors).toEqual([
      MEDIATION_ERRORS.repeatedInvocation,
      MEDIATION_ERRORS.repeatedInvocation
    ]);
    expect(receipt.fdBaselineRestored).toBe(true);
    expect(receipt.segments).toBeGreaterThan(0);
    expect(receipt.rawCalls).toEqual({
      open_sync: 1,
      open_sync_args: [["/", DIRECTORY_OPEN_FLAGS]],
      openat: receipt.segments + 1,
      fstat_sync: receipt.segments + 2,
      read_sync: 1,
      close_sync: receipt.segments + 2
    });
  });

  test("a close that never reaches closeSync is retryable, while each retry settles one raw close", async () => {
    const receipt = await runScenario<CloseSettlementReceipt>("close_settlement");
    expect(receipt).toEqual({
      settlements: [
        {
          mode: "omitted",
          firstError: "CONTRACT_CAPABILITY_CLOSE_FAILED",
          firstRawCalls: 0,
          retry: "NO_ERROR",
          retryRawCalls: 1
        },
        {
          mode: "throw",
          firstError: "CONTRACT_CAPABILITY_CLOSE_FAILED",
          firstRawCalls: 0,
          retry: "NO_ERROR",
          retryRawCalls: 1
        },
        {
          mode: "thenable",
          firstError: "CONTRACT_CAPABILITY_CLOSE_FAILED",
          firstRawCalls: 0,
          retry: "NO_ERROR",
          retryRawCalls: 1
        }
      ],
      rawCloseCalls: 3
    });
  });

  test("every public capability entry rejects mediator reentry before validation, denial hooks, lifecycle, or raw work", async () => {
    const receipt = await runScenario<ReentryReceipt>("reentry");
    expect(receipt).toEqual({
      errors: {
        sealAdmission: MEDIATION_ERRORS.reentry,
        openRoot: MEDIATION_ERRORS.reentry,
        openRelative: MEDIATION_ERRORS.reentry,
        markRetained: MEDIATION_ERRORS.reentry,
        stat: MEDIATION_ERRORS.reentry,
        readRetained: MEDIATION_ERRORS.reentry,
        close: MEDIATION_ERRORS.reentry,
        rejectForbidden: MEDIATION_ERRORS.reentry
      },
      denials: [],
      returnedDirectory: true,
      rawCalls: 1
    });
  });

  test("mediators cannot capture raw open, openat, stat, read, or close results", async () => {
    const receipt = await runScenario<RawCaptureReceipt>("raw_capture");
    const expectedOperations = [
      "open_root",
      ...Array.from({ length: receipt.segments }, () => ["fstat_sync", "openat"]).flat(),
      "fstat_sync",
      "openat",
      "fstat_sync",
      "read_sync",
      ...Array.from({ length: receipt.segments + 2 }, () => "close_sync")
    ];
    expect(receipt.bytes).toBe(Buffer.byteLength(FIXTURE_TEXT));
    expect(receipt.text).toBe(FIXTURE_TEXT);
    expect(receipt.captures.map((capture) => capture.operation)).toEqual(expectedOperations);
    expect(receipt.captures.every((capture) => capture.type === "undefined" && capture.undefined)).toBe(true);
  });

  test("a callable Proxy mediator is applied without tag or constructor reflection", async () => {
    const receipt = await runScenario<ProxyReceipt>("proxy");
    expect(receipt).toEqual({
      operations: ["open_root", "close_sync"],
      tagReads: 0,
      descriptorIsOpaque: true
    });
  });

  test("installed mediation observes no invalid root, phase, parent, flags, handle, range, or owner attempt", async () => {
    const receipt = await runScenario<InvalidReceipt>("invalid");
    expect(receipt.rows).toEqual([
      ["root", "CONTRACT_CAPABILITY_DESCRIPTOR_DENIED"],
      ["phase", "CONTRACT_CAPABILITY_DESCRIPTOR_DENIED"],
      ["parent", "CONTRACT_CAPABILITY_DESCRIPTOR_DENIED"],
      ["flags", "CONTRACT_CAPABILITY_DESCRIPTOR_DENIED"],
      ["stat", "CONTRACT_CAPABILITY_DESCRIPTOR_DENIED"],
      ["read_phase", "CONTRACT_CAPABILITY_DESCRIPTOR_DENIED"],
      ["read_range", "CONTRACT_CAPABILITY_DESCRIPTOR_DENIED"],
      ["close", "CONTRACT_CAPABILITY_DESCRIPTOR_DENIED"]
    ]);
    expect(receipt.operations).toEqual([]);
    expect(receipt.rawCalls).toEqual({
      open_sync: 0,
      open_sync_args: [],
      openat: 0,
      fstat_sync: 0,
      read_sync: 0,
      close_sync: 0
    });
  });

  test("same-number close and reopen replacement leaves the old descriptor stale while the replacement remains usable", async () => {
    const receipt = await runScenario<SameFdReceipt>("same_fd");
    expect(receipt).toEqual({
      openCalls: 2,
      statCalls: 1,
      closeCalls: 2,
      replacementIsDirectory: true,
      stale: "CONTRACT_CAPABILITY_DESCRIPTOR_DENIED"
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

  test("real readBoundedFile and checker ingress callbacks enter inactive and start distinct inactive-prior mediation", async () => {
    const receipt = await runScenario<IngressHookReceipt>("ingress_hooks");
    expect(receipt.directBytes).toBeGreaterThan(0);
    expect(receipt.callbackEntries).toEqual([
      "direct:observe:false",
      "direct:afterAdmission:false",
      "direct:beforeCleanup:false",
      "checker:observe:false",
      "checker:afterAdmission:false"
    ]);
    expect(receipt.nestedCallbacks).toEqual([
      "direct:observe:open_root:false",
      "direct:observe:close_sync:false",
      "direct:afterAdmission:open_root:false",
      "direct:afterAdmission:close_sync:false",
      "direct:beforeCleanup:open_root:false",
      "direct:beforeCleanup:close_sync:false",
      "checker:observe:open_root:false",
      "checker:observe:close_sync:false",
      "checker:afterAdmission:open_root:false",
      "checker:afterAdmission:close_sync:false"
    ]);
    expect(receipt.checkerExit).toBe(0);
    expect(receipt.checkerStderr).toBe("");
    expect(receipt.checkerStdout).toContain('"status":"ok"');
  });
});
