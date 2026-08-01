import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DIRECTORY_OPEN_FLAGS, FILE_OPEN_FLAGS } from "../lib/capabilities";

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

type RoundTwoScenario =
  | "thenable_matrix"
  | "installer_surface"
  | "proxy_reflection"
  | "invocation_surface"
  | "invalid_denials"
  | "reentry_windows"
  | "openat_tuple";
type RoundRawCounts = Readonly<{
  open_sync: number;
  openat: number;
  fstat_sync: number;
  read_sync: number;
  close_sync: number;
}>;
type ThenableMatrixReceipt = Readonly<{
  rows: readonly Readonly<{
    operation: string;
    shape: string;
    outer: string;
    callbackExited: boolean;
    getterRan: boolean;
    getterSawCallbackExited: boolean;
    expired: string;
    reentry: string;
    denials: readonly string[];
    raw: RoundRawCounts;
    retry: string;
    retryRaw: RoundRawCounts;
  }>[];
}>;
type InvocationSurfaceReceipt = Readonly<{
  bytes: number;
  captures: readonly Readonly<{
    operation: string;
    returnedUndefined: boolean;
    before: unknown;
    after: unknown;
    mutations: Readonly<Record<string, boolean>>;
  }>[];
}>;
type InvalidDenialsReceipt = Readonly<{
  rows: readonly Readonly<{
    name: string;
    error: string;
    events: readonly Readonly<{ event: unknown; frozen: boolean }>[];
  }>[];
  operations: readonly string[];
  raw: RoundRawCounts;
}>;
type ReentryWindowsReceipt = Readonly<{
  rows: readonly Readonly<{
    operation: string;
    errors: Readonly<Record<string, string>>;
    during: Readonly<{
      denials: number;
      closeAttempts: number;
      authorityViolations: number;
      raw: RoundRawCounts;
    }>;
    pendingStable: boolean;
    admissionStable: boolean | null;
    outerRaw: RoundRawCounts;
  }>[];
}>;
type OpenAtTupleReceipt = Readonly<{
  operations: readonly string[];
  openAt: readonly Readonly<{ parent: number; path: readonly number[]; flags: number; result: number }>[];
  closeDescriptors: readonly number[];
  raw: RoundRawCounts;
}>;
type InstallerSurfaceReceipt = Readonly<{
  surface: unknown;
  forbiddenSurface: readonly unknown[];
  setPrototypeRejected: boolean;
  definePropertyRejected: boolean;
  invalidInstallation: string;
  firstInstallation: string;
  secondInstallation: string;
}>;
type ProxyReflectionReceipt = Readonly<{
  operations: readonly string[];
  raw: RoundRawCounts;
  beforeControls: Readonly<Record<string, number>>;
  controls: Readonly<Record<string, string>>;
  afterControls: Readonly<Record<string, number>>;
}>;

const ROUND_TWO_ZERO_RAW: RoundRawCounts = Object.freeze({
  open_sync: 0,
  openat: 0,
  fstat_sync: 0,
  read_sync: 0,
  close_sync: 0
});

const mediationChildPath = join(import.meta.dir, "authority-descriptor-mediation-child.ts");
const roundTwoMediationChildPath = join(import.meta.dir, "authority-descriptor-mediation-round-2-child.ts");
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

async function runScenario<Receipt>(
  scenario: Scenario | RoundTwoScenario,
  childPath = mediationChildPath
): Promise<Receipt> {
  const child = Bun.spawn([process.execPath, childPath, scenario], { stdout: "pipe", stderr: "pipe" });
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
  test("return-value getters and Proxy traps expire all five primitive closures before inspection", async () => {
    const receipt = await runScenario<ThenableMatrixReceipt>("thenable_matrix", roundTwoMediationChildPath);
    expect(receipt.rows).toHaveLength(10);
    for (const row of receipt.rows) {
      expect(row.outer).toBe(
        row.operation === "close_sync" ? "CONTRACT_CAPABILITY_CLOSE_FAILED" : MEDIATION_ERRORS.asyncMediator
      );
      expect(row.callbackExited).toBe(true);
      expect(row.getterRan).toBe(true);
      expect(row.getterSawCallbackExited).toBe(true);
      expect(row.expired).toBe(MEDIATION_ERRORS.expiredInvocation);
      expect(row.reentry).toBe(MEDIATION_ERRORS.reentry);
      expect(row.denials).toEqual([]);
      expect(row.raw).toEqual(ROUND_TWO_ZERO_RAW);
      if (row.operation === "close_sync") {
        expect(row.retry).toBe("NO_ERROR");
        expect(row.retryRaw).toEqual({
          open_sync: 0,
          openat: 0,
          fstat_sync: 0,
          read_sync: 0,
          close_sync: 1
        });
      } else {
        expect(row.retry).toBe("NOT_APPLICABLE");
      }
    }
    expect(receipt.rows.map((row) => `${row.operation}:${row.shape}`)).toEqual([
      "open_root:getter", "open_root:proxy",
      "openat:getter", "openat:proxy",
      "fstat_sync:getter", "fstat_sync:proxy",
      "read_sync:getter", "read_sync:proxy",
      "close_sync:getter", "close_sync:proxy"
    ]);
  });

  test("installer has only the standard frozen Function surface and no inherited controls", async () => {
    const receipt = await runScenario<InstallerSurfaceReceipt>("installer_surface", roundTwoMediationChildPath);
    expect(receipt.surface).toEqual({
      frozen: true,
      prototypeIsFunctionPrototype: true,
      keys: ["length", "name"],
      descriptors: [
        { key: "length", value: 1, writable: false, enumerable: false, configurable: false },
        {
          key: "name",
          value: "installDescriptorPrimitiveMediator",
          writable: false,
          enumerable: false,
          configurable: false
        }
      ]
    });
    expect(receipt.forbiddenSurface).toEqual([
      { name: "reset", reachable: false, type: "undefined", callable: false },
      { name: "getMediator", reachable: false, type: "undefined", callable: false },
      { name: "uninstall", reachable: false, type: "undefined", callable: false },
      { name: "replaceMediator", reachable: false, type: "undefined", callable: false },
      { name: "rawCallable", reachable: false, type: "undefined", callable: false },
      { name: "rawResult", reachable: false, type: "undefined", callable: false }
    ]);
    expect(receipt.setPrototypeRejected).toBe(true);
    expect(receipt.definePropertyRejected).toBe(true);
    expect(receipt.invalidInstallation).toBe(MEDIATION_ERRORS.invalidMediator);
    expect(receipt.firstInstallation).toBe("NO_ERROR");
    expect(receipt.secondInstallation).toBe(MEDIATION_ERRORS.alreadyInstalled);
  });

  test("callable Proxy mediation performs no constructor, tag, prototype, or branding reflection", async () => {
    const receipt = await runScenario<ProxyReflectionReceipt>("proxy_reflection", roundTwoMediationChildPath);
    expect(receipt.operations).toEqual(["open_root", "close_sync"]);
    expect(receipt.raw).toEqual({
      open_sync: 1,
      openat: 0,
      fstat_sync: 0,
      read_sync: 0,
      close_sync: 1
    });
    expect(receipt.beforeControls).toEqual({ constructor: 0, tag: 0, prototype: 0, branding: 0 });
    expect(receipt.controls).toEqual({
      constructorControl: "PROXY_CONSTRUCTOR_REFLECTION",
      tagControl: "PROXY_TAG_REFLECTION",
      prototypeControl: "PROXY_PROTOTYPE_REFLECTION",
      brandingControl: "PROXY_TAG_REFLECTION"
    });
    expect(receipt.afterControls).toEqual({ constructor: 1, tag: 1, prototype: 1, branding: 1 });
  });

  test("every invocation closure is frozen before all five raw-result kinds execute", async () => {
    const receipt = await runScenario<InvocationSurfaceReceipt>("invocation_surface", roundTwoMediationChildPath);
    const expectedSurface = {
      frozen: true,
      prototypeIsFunctionPrototype: true,
      keys: ["length", "name"],
      descriptors: [
        { key: "length", writable: false, enumerable: false, configurable: false },
        { key: "name", writable: false, enumerable: false, configurable: false }
      ],
      rawResultReachable: false,
      rawResultDescriptor: false,
      forbiddenSymbolReachable: false,
      forbiddenSymbolDescriptor: false,
      symbols: []
    };
    expect(receipt.bytes).toBe(1);
    expect([...new Set(receipt.captures.map((capture) => capture.operation))].sort()).toEqual([
      "close_sync", "fstat_sync", "open_root", "openat", "read_sync"
    ]);
    for (const capture of receipt.captures) {
      expect(capture.returnedUndefined).toBe(true);
      expect(capture.before).toEqual(expectedSurface);
      expect(capture.after).toEqual(expectedSurface);
      expect(capture.mutations).toEqual({
        rawResult: true,
        getter: true,
        symbol: true,
        tagSymbol: true,
        prototype: true
      });
    }
  });

  test("installed invalid rows emit one exact frozen denial event before mediation or raw work", async () => {
    const receipt = await runScenario<InvalidDenialsReceipt>("invalid_denials", roundTwoMediationChildPath);
    const expectedEvents = [
      ["root", { schema_version: "shud.contract.descriptor-denial.v1", operation: "open_root", reason: "root_invalid", descriptor: null, generation: null, phase: "admission" }],
      ["phase", { schema_version: "shud.contract.descriptor-denial.v1", operation: "open_root", reason: "phase_invalid", descriptor: null, generation: null, phase: null }],
      ["parent", { schema_version: "shud.contract.descriptor-denial.v1", operation: "openat", reason: "unproven_parent", descriptor: null, generation: null, phase: "post_admission" }],
      ["flags", { schema_version: "shud.contract.descriptor-denial.v1", operation: "openat", reason: "flags_invalid", descriptor: 40, generation: 1, phase: "admission" }],
      ["stat", { schema_version: "shud.contract.descriptor-denial.v1", operation: "fstat_sync", reason: "unproven_descriptor", descriptor: 0, generation: null, phase: null }],
      ["read_phase", { schema_version: "shud.contract.descriptor-denial.v1", operation: "read_sync", reason: "phase_invalid", descriptor: 41, generation: 2, phase: "admission" }],
      ["read_range", { schema_version: "shud.contract.descriptor-denial.v1", operation: "read_sync", reason: "range_invalid", descriptor: 41, generation: 2, phase: "admission" }],
      ["close", { schema_version: "shud.contract.descriptor-denial.v1", operation: "close_sync", reason: "owner_mismatch", descriptor: 41, generation: 2, phase: "admission" }]
    ] as const;
    expect(receipt.rows.map((row) => row.name)).toEqual(expectedEvents.map(([name]) => name));
    for (const [index, [, event]] of expectedEvents.entries()) {
      const row = receipt.rows[index]!;
      expect(row.error).toBe("CONTRACT_CAPABILITY_DESCRIPTOR_DENIED");
      expect(row.events).toEqual([{ event, frozen: true }]);
    }
    expect(receipt.operations).toEqual([]);
    expect(receipt.raw).toEqual(ROUND_TWO_ZERO_RAW);
  });

  test("every public entry fails before observable work in each outer primitive window", async () => {
    const receipt = await runScenario<ReentryWindowsReceipt>("reentry_windows", roundTwoMediationChildPath);
    const expectedErrors = {
      sealAdmission: MEDIATION_ERRORS.reentry,
      openRoot: MEDIATION_ERRORS.reentry,
      openRelative: MEDIATION_ERRORS.reentry,
      markRetained: MEDIATION_ERRORS.reentry,
      stat: MEDIATION_ERRORS.reentry,
      readRetained: MEDIATION_ERRORS.reentry,
      close: MEDIATION_ERRORS.reentry,
      rejectForbidden: MEDIATION_ERRORS.reentry
    };
    const outerCounts: Readonly<Record<string, RoundRawCounts>> = {
      open_root: { open_sync: 1, openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 },
      openat: { open_sync: 0, openat: 1, fstat_sync: 0, read_sync: 0, close_sync: 0 },
      fstat_sync: { open_sync: 0, openat: 0, fstat_sync: 1, read_sync: 0, close_sync: 0 },
      read_sync: { open_sync: 0, openat: 0, fstat_sync: 0, read_sync: 1, close_sync: 0 },
      close_sync: { open_sync: 0, openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 1 }
    };
    expect(receipt.rows.map((row) => row.operation)).toEqual([
      "open_root", "openat", "fstat_sync", "read_sync", "close_sync"
    ]);
    for (const row of receipt.rows) {
      expect(row.errors).toEqual(expectedErrors);
      expect(row.during).toEqual({
        denials: 0,
        closeAttempts: 0,
        authorityViolations: 0,
        raw: ROUND_TWO_ZERO_RAW
      });
      expect(row.pendingStable).toBe(true);
      expect(row.admissionStable).toBe(row.operation === "read_sync" ? null : true);
      expect(row.outerRaw).toEqual(outerCounts[row.operation]!);
    }
  });

  test("the sole openat callable receives the exact validated parent, NUL child bytes, flags, and result lifecycle", async () => {
    const receipt = await runScenario<OpenAtTupleReceipt>("openat_tuple", roundTwoMediationChildPath);
    expect(receipt.operations).toEqual([
      "open_root", "fstat_sync", "openat", "fstat_sync", "openat", "fstat_sync",
      "close_sync", "close_sync", "close_sync"
    ]);
    expect(receipt.openAt).toEqual([
      {
        parent: 40,
        path: [95, 95, 117, 110, 109, 101, 100, 105, 97, 116, 101, 100, 95, 95, 0],
        flags: DIRECTORY_OPEN_FLAGS,
        result: 41
      },
      {
        parent: 41,
        path: [112, 97, 121, 108, 111, 97, 100, 0],
        flags: FILE_OPEN_FLAGS,
        result: 42
      }
    ]);
    expect(receipt.closeDescriptors).toEqual([42, 41, 40]);
    expect(receipt.raw).toEqual({
      open_sync: 1,
      openat: 2,
      fstat_sync: 3,
      read_sync: 0,
      close_sync: 3
    });
  });
});
