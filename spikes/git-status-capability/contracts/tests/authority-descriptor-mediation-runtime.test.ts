import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { ContractCapabilities } from "../lib/capabilities";
import * as capabilities from "../lib/capabilities";
import * as ingress from "../lib/ingress";
import { failure, success } from "./helpers";
import {
  librarySources,
  mediatedAwaitDenials,
  mediationSources,
  rejectionSinkDenials,
  withCloseRuntimeTree,
  type CloseRuntimeMutation
} from "./authority-descriptor-close-runtime";

type Entry = "ingress" | "checker";
type EntryOutcome = Readonly<{ code: string | null; exit: number | null; stdout: string; stderr: string }>;
type ChildResult = Readonly<{ exit: number; stderr: string; stdout: string }>;
type Counters = Readonly<{ openRoot: number; openat: number; fstat: number; read: number; close: number }>;
type IdentityReceipt = Readonly<{
  allFrozen: boolean;
  closeFaultCalls: number;
  entry: string;
  onCloseCalls: number;
  outcome: EntryOutcome;
  rawCloseCalls: number;
  sameAttempt: boolean;
}>;
type RetryReceipt = Readonly<{
  allFrozen: boolean;
  closeFaultCalls: number;
  entry: Entry;
  firstAndSecondDistinct: boolean;
  firstAndSecondFrozen: boolean;
  firstTwoAttempts: boolean;
  onCloseCalls: number;
  outcome: EntryOutcome;
  rawCloseCalls: number;
  sameAttempt: boolean;
}>;
type TerminalReceipt = Readonly<{
  allFrozen: boolean;
  closeFaultCalls: number;
  entry: Entry;
  onCloseCalls: number;
  outcome: EntryOutcome;
  sameAttempt: boolean;
  targetCloseCalls: number;
  targetRawStarts: number;
}>;
type HostileSite =
  | "after_admission_1"
  | "observe_open_root"
  | "observe_open_relative_1"
  | "observe_open_relative_2"
  | "observe_read_1"
  | "observe_read_2"
  | "close_attempt_1"
  | "close_fault_1";
type HostileRow = Readonly<{
  entry: Entry;
  site: HostileSite;
  valueMode: "thrown" | "returned";
  injected: boolean;
  rawAtInjection: Counters | null;
  rawFinal: Counters;
  outcome: EntryOutcome;
  traps: number;
  trapNames: readonly string[];
  primitiveProbes: number;
  fdBefore: number;
  fdAfter: number;
}>;
type HostileReceipt = Readonly<{
  entry: Entry;
  baseline: Readonly<{ outcome: EntryOutcome; raw: Counters; fdBefore: number; fdAfter: number }>;
  rows: readonly HostileRow[];
}>;
type FalsyRow = HostileRow & Readonly<{ falsyValue: string }>;
type FalsyReceipt = Readonly<{ entry: Entry; rows: readonly FalsyRow[] }>;
type InheritedReceipt = Readonly<{
  entry: Entry;
  outcome: EntryOutcome;
  afterAdmissionCalls: number;
  afterAdmissionReceiverMatches: boolean;
  closeAttemptCalls: number;
  closeAttemptReceiverMatches: boolean;
  closeFaultCalls: number;
  faultReceiverMatches: boolean;
  getterReads: number;
  getterReadsAtAdmission: number;
  getterReceiverMatches: boolean;
  ownHookProperties: readonly string[];
  prototypeHookProperties: readonly string[];
}>;
type SinkReceipt = Readonly<{
  entry: Entry;
  outcome: EntryOutcome;
  listenerCalls: number;
  listenersBefore: Readonly<Record<string, number>>;
  listenersAfter: Readonly<Record<string, number>>;
  peekCalls: number;
  promiseIdentityStable: boolean;
  promiseThenStable: boolean;
}>;
type ReentryRow = Readonly<{ method: string; outcome: string; rawDelta: number; denialCalls: number }>;
type ReentryOriginReceipt = Readonly<{
  origin: string;
  fired: boolean;
  outcome: EntryOutcome;
  denialCalls: number;
  authorityFaultReads: number | null;
  authorityFaultCoercions: number | null;
  faultsReportedToHook: readonly string[];
  followOnIngress: EntryOutcome;
  followOnChecker: EntryOutcome;
  battery: readonly ReentryRow[];
}>;
type ReentryReceipt = Readonly<{ entry: Entry; origins: readonly ReentryOriginReceipt[] }>;
type AdmissionReturnKind =
  | "undefined"
  | "primitive"
  | "all_trap_proxy"
  | "plain_native_promise"
  | "chained_outside_latch";
/**
 * The boundary-attributable half of an admission-return row. It carries exactly
 * what the boundary did with the value the hook returned, and nothing about the
 * value's own behavior, so it must be identical across every kind.
 */
type AdmissionReturnObservation = Readonly<{
  settled: boolean;
  outcome: EntryOutcome | null;
  rawFinal: Counters;
  traps: number;
  trapNames: readonly string[];
  primitiveProbes: number;
  fdDelta: number;
  batteryFired: boolean;
  denialCalls: number;
}>;
type AdmissionReturnRow = Readonly<{
  kind: AdmissionReturnKind;
  receipt: AdmissionReturnObservation;
  thenReads: number;
  continuationRan: boolean;
  continuationSawSettledOperation: boolean | null;
  battery: readonly ReentryRow[];
  fdBefore: number;
  fdAfter: number;
}>;
type AdmissionReturnReceipt = Readonly<{ entry: Entry; rows: readonly AdmissionReturnRow[] }>;
type ScheduledDescendantReceipt = Readonly<{
  entry: Entry;
  outcome: EntryOutcome;
  hookCalls: number;
  microtaskFired: boolean;
  timerFired: boolean;
  microtaskBattery: readonly ReentryRow[];
  timerBattery: readonly ReentryRow[];
  denialCalls: number;
  rawFinal: Counters;
  fdBefore: number;
  fdAfter: number;
}>;
type AuthorityFaultRow = Readonly<{
  label: string;
  outcome: EntryOutcome;
  violations: readonly string[];
  coercions: number;
  rawFinal: Counters;
  fdBefore: number;
  fdAfter: number;
}>;
type DirectFaultRow = Readonly<{
  label: string;
  outcome: string;
  violations: readonly string[];
  coercions: number;
}>;
type AuthorityFaultReceipt = Readonly<{
  entry: Entry;
  rows: readonly AuthorityFaultRow[];
  direct: readonly DirectFaultRow[];
}>;
type ReadReceipt = Readonly<{
  entry: Entry;
  outcome: EntryOutcome;
  mediatedReturns: readonly number[];
  readCalls: number;
  rawReadCalls: number;
  assembledBytes: number;
  assembledDigest: string;
}>;

const childPath = join(import.meta.dir, "authority-descriptor-mediation-runtime-child.ts");
const fixturePath = join(
  import.meta.dir,
  "..",
  "fixtures",
  "valid",
  "source-input-record-paired-surrogate.json"
);

const HOSTILE_SITES: readonly HostileSite[] = [
  "after_admission_1",
  "observe_open_root",
  "observe_open_relative_1",
  "observe_open_relative_2",
  "observe_read_1",
  "observe_read_2",
  "close_attempt_1",
  "close_fault_1"
];
const FALSY_VALUES: readonly string[] = ["undefined", "null", "zero", "empty_string", "false"];
const FALSY_SITES: readonly HostileSite[] = [
  "observe_open_relative_1",
  "after_admission_1",
  "close_attempt_1"
];
const OBSERVE_SITES: readonly HostileSite[] = [
  "observe_open_root",
  "observe_open_relative_1",
  "observe_open_relative_2",
  "observe_read_1",
  "observe_read_2"
];
const REENTRY_METHODS: readonly string[] = [
  "sealAdmission",
  "openRoot",
  "openRelative",
  "markRetained",
  "stat",
  "readRetained",
  "close",
  "rejectForbidden",
  "prototype_close",
  "captured_token_stat",
  "ingress_read_bounded_file"
];
const REENTRY_ORIGINS: readonly string[] = [
  "observe",
  "close_attempt",
  "close_fault",
  "authority_violation",
  "after_admission",
  "accessor_observe",
  "accessor_authority_fault",
  "authority_fault_coercion",
  "before_cleanup",
  "denial"
];
/** The frozen `ContractAuthorityFault` vocabulary, restated independently. */
const AUTHORITY_FAULT_LITERALS: readonly string[] = [
  "ambient_absolute_open",
  "replacement_object_read",
  "file_write",
  "child_spawn"
];
const INVALID_AUTHORITY_FAULT_LABELS: readonly string[] = [
  "bogus_string",
  "empty_string",
  "plain_object",
  "coercing_object"
];
/** `beforeCleanup` is an ingress-entry parameter the checker never exposes. */
const CHECKER_REENTRY_ORIGINS: readonly string[] = REENTRY_ORIGINS.filter(
  (origin) => origin !== "before_cleanup"
);
const FAILING_REENTRY_ORIGINS: ReadonlySet<string> = new Set([
  "authority_violation",
  "accessor_authority_fault"
]);
/**
 * Every way a mediator can hand a value back to a synchronous admission hook's
 * caller, ending with the round-3 attack: a promise chained outside every latch,
 * indistinguishable from a well-behaved one by any inspection of the value.
 */
const ADMISSION_RETURN_KINDS: readonly AdmissionReturnKind[] = [
  "undefined",
  "primitive",
  "all_trap_proxy",
  "plain_native_promise",
  "chained_outside_latch"
];
const DENIED = "CONTRACT_CAPABILITY_DESCRIPTOR_DENIED";
/**
 * A mutation that reinstates awaiting the hook's return value strands the
 * chained-attack row for the child's full bounded-settlement window, and every
 * row waits on a real timer for the mediator's own continuation, so the tests
 * that drive those rows need more than the default per-test budget.
 */
const ADMISSION_RETURN_TIMEOUT_MS = 60_000;

/**
 * Independent recomputation of the mediated path depth: the ingress admits one
 * root plus one descriptor per absolute segment, so every raw expectation below
 * is derived from the fixture path, not from the module under test.
 */
function pathSegments(path: string): number {
  const absolute = process.platform === "darwin" &&
    ["/etc", "/tmp", "/var"].some((alias) => resolve(path) === alias || resolve(path).startsWith(`${alias}/`))
    ? `/private${resolve(path)}`
    : resolve(path);
  return absolute.slice(parse(absolute).root.length).split(sep).filter(Boolean).length;
}

const SEGMENTS = pathSegments(fixturePath);
const FIXTURE_BYTES = readFileSync(fixturePath);

function counters(openRoot: number, openat: number, fstat: number, read: number, close: number): Counters {
  return Object.freeze({ openRoot, openat, fstat, read, close });
}

/** Admission + two verification passes + two reads + cleanup, per path segment. */
const BASELINE_RAW = counters(1, 3 * SEGMENTS, 5 * SEGMENTS + 3, 2, 3 * SEGMENTS + 1);
const SITE_RAW: Readonly<Record<HostileSite, Readonly<{ atInjection: Counters; thrownFinal: Counters }>>> =
  Object.freeze({
    after_admission_1: {
      atInjection: counters(1, SEGMENTS, SEGMENTS + 1, 0, 0),
      thrownFinal: counters(1, SEGMENTS, SEGMENTS + 1, 0, SEGMENTS + 1)
    },
    observe_open_root: {
      atInjection: counters(0, 0, 0, 0, 0),
      thrownFinal: counters(0, 0, 0, 0, 0)
    },
    observe_open_relative_1: {
      atInjection: counters(1, 0, 1, 0, 0),
      thrownFinal: counters(1, 0, 1, 0, 1)
    },
    observe_open_relative_2: {
      atInjection: counters(1, 1, 2, 0, 0),
      thrownFinal: counters(1, 1, 2, 0, 2)
    },
    observe_read_1: {
      atInjection: counters(1, 2 * SEGMENTS, 3 * SEGMENTS + 2, 0, SEGMENTS),
      thrownFinal: counters(1, 2 * SEGMENTS, 3 * SEGMENTS + 2, 0, 2 * SEGMENTS + 1)
    },
    observe_read_2: {
      atInjection: counters(1, 2 * SEGMENTS, 3 * SEGMENTS + 2, 1, SEGMENTS),
      thrownFinal: counters(1, 2 * SEGMENTS, 3 * SEGMENTS + 2, 1, 2 * SEGMENTS + 1)
    },
    close_attempt_1: {
      atInjection: counters(1, SEGMENTS + 1, SEGMENTS + 4, 0, 0),
      thrownFinal: BASELINE_RAW
    },
    close_fault_1: {
      atInjection: counters(1, SEGMENTS + 1, SEGMENTS + 4, 0, 1),
      thrownFinal: BASELINE_RAW
    }
  });
/** Each raw primitive observed once before its own raw start and once after. */
const PRIMITIVE_SITES: Readonly<Record<string, Readonly<{
  counter: keyof Counters; pre: HostileSite; post: HostileSite;
}>>> = Object.freeze({
  open_root: { counter: "openRoot", pre: "observe_open_root", post: "observe_open_relative_1" },
  openat: { counter: "openat", pre: "observe_open_relative_1", post: "observe_open_relative_2" },
  fstat_sync: { counter: "fstat", pre: "observe_open_root", post: "observe_open_relative_1" },
  read_sync: { counter: "read", pre: "observe_read_1", post: "observe_read_2" },
  close_sync: { counter: "close", pre: "close_attempt_1", post: "close_fault_1" }
});

async function runChild(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {}
): Promise<ChildResult> {
  const child = Bun.spawn([process.execPath, childPath, ...args], {
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe"
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return Object.freeze({ exit, stderr, stdout });
}

async function receipt<Value>(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {}
): Promise<Value> {
  const result = await runChild(args, environment);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Value;
}

async function mutatedReceipt<Value>(
  mutation: CloseRuntimeMutation,
  args: readonly string[]
): Promise<Value> {
  let value: Value | undefined;
  let captured = false;
  await withCloseRuntimeTree(mutation, async (tree) => {
    value = await receipt<Value>(args, { SHUD_DESCRIPTOR_PRODUCTION_ROOT: tree.root });
    captured = true;
  });
  if (!captured) throw new Error(`mutated receipt is absent: ${String(mutation)}`);
  return value!;
}

function expectedSuccess(entry: Entry): EntryOutcome {
  return entry === "ingress"
    ? { code: null, exit: null, stdout: "", stderr: "" }
    : { code: null, exit: 0, stdout: success("source_input_record"), stderr: "" };
}

function expectedFailure(entry: Entry): EntryOutcome {
  return entry === "ingress"
    ? { code: "CONTRACT_SCHEMA_INVALID", exit: null, stdout: "", stderr: "" }
    : { code: "CONTRACT_SCHEMA_INVALID", exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") };
}

function hostileRow(receiptValue: HostileReceipt, site: HostileSite, valueMode: "thrown" | "returned"): HostileRow {
  const row = receiptValue.rows.find((candidate) => candidate.site === site && candidate.valueMode === valueMode);
  if (!row) throw new Error(`hostile row is absent: ${site}/${valueMode}`);
  return row;
}

function assertHostileRow(row: HostileRow, entry: Entry): void {
  expect(row.injected).toBe(true);
  expect(row.traps).toBe(0);
  expect(row.trapNames).toEqual([]);
  expect(row.primitiveProbes).toBe(0);
  expect(row.fdAfter).toBe(row.fdBefore);
  expect(row.rawAtInjection).toEqual(SITE_RAW[row.site].atInjection);
  if (row.valueMode === "thrown") {
    expect(row.outcome).toEqual(expectedFailure(entry));
    expect(row.rawFinal).toEqual(SITE_RAW[row.site].thrownFinal);
    return;
  }
  expect(row.rawFinal).toEqual(BASELINE_RAW);
  expect(row.outcome).toEqual(
    row.site === "close_fault_1" ? expectedFailure(entry) : expectedSuccess(entry)
  );
}

function authorityFaultRow(receiptValue: AuthorityFaultReceipt, label: string): AuthorityFaultRow {
  const row = receiptValue.rows.find((candidate) => candidate.label === label);
  if (!row) throw new Error(`authority fault row is absent: ${label}`);
  return row;
}

function directFaultRow(receiptValue: AuthorityFaultReceipt, label: string): DirectFaultRow {
  const row = receiptValue.direct.find((candidate) => candidate.label === label);
  if (!row) throw new Error(`direct authority fault row is absent: ${label}`);
  return row;
}

function originReceipt(receiptValue: ReentryReceipt, origin: string): ReentryOriginReceipt {
  const found = receiptValue.origins.find((candidate) => candidate.origin === origin);
  if (!found) throw new Error(`reentry origin is absent: ${origin}`);
  return found;
}

function admissionReturnRow(
  receiptValue: AdmissionReturnReceipt,
  kind: AdmissionReturnKind
): AdmissionReturnRow {
  const row = receiptValue.rows.find((candidate) => candidate.kind === kind);
  if (!row) throw new Error(`admission return row is absent: ${kind}`);
  return row;
}

function batteryRow(battery: readonly ReentryRow[], label: string, method: string): ReentryRow {
  const row = battery.find((candidate) => candidate.method === method);
  if (!row) throw new Error(`reentry row is absent: ${label}/${method}`);
  return row;
}

function reentryRow(origin: ReentryOriginReceipt, method: string): ReentryRow {
  return batteryRow(origin.battery, origin.origin, method);
}

/**
 * A reentry battery that a mediator seam managed to run must have been rejected
 * on every public capability entry and every captured authority, without one
 * raw descriptor operation and without reaching a denial hook.
 */
function assertBatteryDenied(battery: readonly ReentryRow[], label: string): void {
  for (const row of battery) {
    expect([label, row.method, row.outcome]).toEqual([
      label,
      row.method,
      row.method === "ingress_read_bounded_file" ? "CONTRACT_SCHEMA_INVALID" : DENIED
    ]);
    expect([label, row.method, row.rawDelta]).toEqual([label, row.method, 0]);
    expect([label, row.method, row.denialCalls]).toEqual([label, row.method, 0]);
  }
}

/**
 * The boundary-attributable receipt every admission-return row must produce,
 * recomputed here rather than copied from the `undefined` row, so the identity
 * assertion has an independent expectation to agree with.
 */
function expectedAdmissionReturnObservation(entry: Entry): AdmissionReturnObservation {
  return {
    settled: true,
    outcome: expectedSuccess(entry),
    rawFinal: BASELINE_RAW,
    traps: 0,
    trapNames: [],
    primitiveProbes: 0,
    fdDelta: 0,
    batteryFired: false,
    denialCalls: 0
  };
}

/**
 * The value-shaped mediator seam. `authorityFault` is a value, not a callback,
 * so its only route back into the boundary is an implicit coercion of itself.
 * The value is validated against the frozen fault vocabulary inside the latch
 * that reads it, so no conversion of it ever runs: the hostile
 * `Symbol.toPrimitive` is never called, and the reentry battery it would have
 * run therefore does not exist. Whatever the battery did observe would still
 * have to be a rejected reentry that did no descriptor work.
 */
function assertAuthorityFaultCoercionOrigin(origin: ReentryOriginReceipt, entry: Entry): void {
  expect([origin.origin, origin.authorityFaultCoercions]).toEqual([origin.origin, 0]);
  expect([origin.origin, origin.fired]).toEqual([origin.origin, false]);
  for (const row of origin.battery) {
    expect([row.method, row.outcome]).toEqual([
      row.method,
      row.method === "ingress_read_bounded_file" ? "CONTRACT_SCHEMA_INVALID" : DENIED
    ]);
    expect([row.method, row.rawDelta]).toEqual([row.method, 0]);
    expect([row.method, row.denialCalls]).toEqual([row.method, 0]);
  }
  // A value outside the vocabulary is a contract failure, not an authority
  // violation: the violation hook is never handed a value it would have to name.
  expect(origin.outcome).toEqual(expectedFailure(entry));
  expect(origin.faultsReportedToHook).toEqual([]);
  expect(origin.denialCalls).toBe(0);
  expect(origin.followOnIngress).toEqual(expectedSuccess("ingress"));
  expect(origin.followOnChecker).toEqual(expectedSuccess("checker"));
}

function assertReentryOrigin(origin: ReentryOriginReceipt, entry: Entry): void {
  if (origin.origin === "authority_fault_coercion") {
    assertAuthorityFaultCoercionOrigin(origin, entry);
    return;
  }
  expect(origin.fired).toBe(true);
  expect(origin.battery.map((row) => row.method).sort()).toEqual([...REENTRY_METHODS].sort());
  for (const method of REENTRY_METHODS) {
    const row = reentryRow(origin, method);
    expect([origin.origin, method, row.outcome]).toEqual([
      origin.origin,
      method,
      method === "ingress_read_bounded_file" ? "CONTRACT_SCHEMA_INVALID" : DENIED
    ]);
    expect([origin.origin, method, row.rawDelta]).toEqual([origin.origin, method, 0]);
    expect([origin.origin, method, row.denialCalls]).toEqual([origin.origin, method, 0]);
  }
  // A rejected reentry is not a mediation fault: the process-global ingress
  // poison must stay clear for every later independent operation.
  expect([origin.origin, origin.followOnIngress]).toEqual([origin.origin, expectedSuccess("ingress")]);
  expect([origin.origin, origin.followOnChecker]).toEqual([origin.origin, expectedSuccess("checker")]);
  if (origin.origin === "accessor_observe" || origin.origin === "accessor_authority_fault") {
    // One `authorityFault` lookup per `readBoundedFile`, and the exact value
    // read is the value handed to `rejectForbidden`.
    expect([origin.origin, origin.authorityFaultReads]).toEqual([origin.origin, 1]);
    expect(origin.faultsReportedToHook).toEqual(
      origin.origin === "accessor_authority_fault" ? ["file_write"] : []
    );
  }
  if (FAILING_REENTRY_ORIGINS.has(origin.origin)) {
    expect([origin.origin, origin.outcome]).toEqual([origin.origin, expectedFailure(entry)]);
    expect(origin.denialCalls).toBe(0);
    return;
  }
  if (origin.origin === "denial") {
    expect(origin.outcome).toEqual({ code: DENIED, exit: null, stdout: "", stderr: "" });
    expect(origin.denialCalls).toBe(1);
    return;
  }
  expect([origin.origin, origin.outcome]).toEqual([origin.origin, expectedSuccess(entry)]);
  expect(origin.denialCalls).toBe(0);
}

describe("descriptor close runtime mediation", () => {
  test("direct, ingress, and checker callbacks share frozen attempts; a no-raw retry is distinct; raw starts remain terminal", async () => {
    for (const entry of ["capability", "ingress", "checker"] as const) {
      const identity = await receipt<IdentityReceipt>(["identity", entry]);
      expect(identity.entry).toBe(entry);
      expect(identity.allFrozen).toBe(true);
      expect(identity.sameAttempt).toBe(true);
      expect(identity.onCloseCalls).toBeGreaterThan(0);
      expect(identity.closeFaultCalls).toBe(identity.onCloseCalls);
      expect(identity.rawCloseCalls).toBeGreaterThan(0);
      if (entry === "capability") {
        expect(identity.rawCloseCalls).toBe(1);
        expect(identity.outcome).toEqual({ code: null, exit: null, stdout: "", stderr: "" });
      } else {
        expect(identity.outcome).toEqual(expectedSuccess(entry));
      }
    }

    await withCloseRuntimeTree(undefined, async (tree) => {
      for (const entry of ["ingress", "checker"] as const) {
        const retry = await receipt<RetryReceipt>(["retry", entry], {
          SHUD_DESCRIPTOR_PRODUCTION_ROOT: tree.root,
          SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE: "omit_once"
        });
        expect(retry.entry).toBe(entry);
        expect(retry.outcome).toEqual(expectedSuccess(entry));
        expect(retry.firstTwoAttempts).toBe(true);
        expect(retry.firstAndSecondDistinct).toBe(true);
        expect(retry.firstAndSecondFrozen).toBe(true);
        expect(retry.allFrozen).toBe(true);
        expect(retry.sameAttempt).toBe(true);
        expect(retry.closeFaultCalls).toBe(retry.onCloseCalls - 1);
        expect(retry.rawCloseCalls).toBeGreaterThan(0);
      }
    });

    for (const [scenario, shouldFail] of [
      ["terminal_return", false],
      ["terminal_throw", true]
    ] as const) {
      for (const entry of ["ingress", "checker"] as const) {
        const terminal = await receipt<TerminalReceipt>([scenario, entry]);
        expect(terminal.entry).toBe(entry);
        expect(terminal.targetCloseCalls).toBe(1);
        expect(terminal.targetRawStarts).toBe(1);
        expect(terminal.allFrozen).toBe(true);
        expect(terminal.sameAttempt).toBe(true);
        expect(terminal.closeFaultCalls).toBe(terminal.onCloseCalls);
        expect(terminal.outcome).toEqual(shouldFail ? expectedFailure(entry) : expectedSuccess(entry));
      }
    }
  });

  test("the #175 capability and ingress public surfaces remain closed", () => {
    expect(Object.getOwnPropertyNames(ContractCapabilities.prototype).sort()).toEqual([
      "close", "constructor", "markRetained", "openRelative", "openRoot", "readRetained", "rejectForbidden",
      "sealAdmission", "stat"
    ]);
    expect(Object.keys(ingress).sort()).toEqual(["ContractError", "parseBoundedJson", "readBoundedFile"]);
    expect(Object.keys(capabilities).sort()).toEqual([
      "ContractCapabilities",
      "DESCRIPTOR_OPERATION_POLICY",
      "DIRECTORY_OPEN_FLAGS",
      "FILE_OPEN_FLAGS",
      "capabilityCallbackActive",
      "withCapabilityCallback"
    ]);
  });

  test("hostile all-trap mediator values stay unobserved across five primitives, pre- and post-raw", async () => {
    for (const entry of ["ingress", "checker"] as const) {
      const hostile = await receipt<HostileReceipt>(["hostile", entry]);
      expect(hostile.baseline.outcome).toEqual(expectedSuccess(entry));
      expect(hostile.baseline.raw).toEqual(BASELINE_RAW);
      expect(hostile.baseline.fdAfter).toBe(hostile.baseline.fdBefore);
      expect(hostile.rows.length).toBe(HOSTILE_SITES.length * 2);

      for (const valueMode of ["thrown", "returned"] as const) {
        for (const site of HOSTILE_SITES) assertHostileRow(hostileRow(hostile, site, valueMode), entry);
      }

      for (const [primitive, mapping] of Object.entries(PRIMITIVE_SITES)) {
        for (const valueMode of ["thrown", "returned"] as const) {
          const before = hostileRow(hostile, mapping.pre, valueMode);
          const after = hostileRow(hostile, mapping.post, valueMode);
          expect([primitive, before.rawAtInjection![mapping.counter]]).toEqual([primitive, 0]);
          expect(after.rawAtInjection![mapping.counter]).toBeGreaterThan(0);
        }
      }
    }
  });

  test("prototype, has, and returned-value inspection mutations are red on the hostile matrix", async () => {
    const instanceofMutation = await mutatedReceipt<HostileReceipt>(
      "instanceof_recognition",
      ["hostile", "ingress"]
    );
    for (const site of OBSERVE_SITES) {
      const row = hostileRow(instanceofMutation, site, "thrown");
      expect(row.trapNames).toContain("getPrototypeOf");
      expect(row.traps).toBeGreaterThan(0);
      expect(() => assertHostileRow(row, "ingress")).toThrow();
    }

    const hasMutation = await mutatedReceipt<HostileReceipt>("has_probe_recognition", ["hostile", "ingress"]);
    for (const site of OBSERVE_SITES) {
      const row = hostileRow(hasMutation, site, "thrown");
      expect(row.trapNames).toContain("has");
      expect(row.traps).toBeGreaterThan(0);
      expect(() => assertHostileRow(row, "ingress")).toThrow();
    }

    const returnedMutation = await mutatedReceipt<HostileReceipt>(
      "returned_value_inspection",
      ["hostile", "ingress"]
    );
    for (const site of HOSTILE_SITES) {
      const row = hostileRow(returnedMutation, site, "returned");
      expect(row.trapNames).toContain("ownKeys");
      expect(row.traps).toBeGreaterThan(0);
      expect(() => assertHostileRow(row, "ingress")).toThrow();
    }
  });

  test("falsy hostile hook throws preserve exact legacy receipts without probing the primitive", async () => {
    for (const entry of ["ingress", "checker"] as const) {
      const falsy = await receipt<FalsyReceipt>(["falsy", entry]);
      expect(falsy.rows.length).toBe(FALSY_VALUES.length * FALSY_SITES.length);
      expect(falsy.rows.map((row) => row.falsyValue)).toEqual(
        FALSY_VALUES.flatMap((value) => FALSY_SITES.map(() => value))
      );
      for (const row of falsy.rows) {
        const label = `${row.falsyValue}/${row.site}`;
        expect([label, row.injected]).toEqual([label, true]);
        expect([label, row.primitiveProbes]).toEqual([label, 0]);
        expect([label, row.traps]).toEqual([label, 0]);
        expect([label, row.fdAfter]).toEqual([label, row.fdBefore]);
        if (row.site === "close_attempt_1") {
          // Legacy #193 semantics: a falsy close-hook throw is not a fault.
          expect([label, row.outcome]).toEqual([label, expectedSuccess(entry)]);
          expect([label, row.rawFinal]).toEqual([label, BASELINE_RAW]);
          continue;
        }
        expect([label, row.outcome]).toEqual([label, expectedFailure(entry)]);
        expect([label, row.rawFinal]).toEqual([label, SITE_RAW[row.site].thrownFinal]);
      }
    }

    const probeMutation = await mutatedReceipt<FalsyReceipt>(
      "property_probe_recognition",
      ["falsy", "ingress"]
    );
    for (const row of probeMutation.rows.filter((candidate) => candidate.site === "after_admission_1")) {
      if (row.falsyValue === "undefined" || row.falsyValue === "null") {
        expect(row.outcome.code).not.toBe("CONTRACT_SCHEMA_INVALID");
        continue;
      }
      expect([row.falsyValue, row.primitiveProbes]).toEqual([row.falsyValue, 1]);
    }
    const probedChecker = await mutatedReceipt<FalsyReceipt>(
      "property_probe_recognition",
      ["falsy", "checker"]
    );
    for (const row of probedChecker.rows.filter((candidate) =>
      candidate.site === "after_admission_1" && candidate.falsyValue !== "undefined" &&
      candidate.falsyValue !== "null"
    )) {
      expect([row.falsyValue, row.primitiveProbes]).toEqual([row.falsyValue, 1]);
    }

    const hasMutation = await mutatedReceipt<FalsyReceipt>("has_probe_recognition", ["falsy", "ingress"]);
    const inTested = hasMutation.rows.filter((row) => row.site === "after_admission_1");
    expect(inTested.length).toBe(FALSY_VALUES.length);
    for (const row of inTested) expect(row.outcome.code).not.toBe("CONTRACT_SCHEMA_INVALID");
  });

  test("an only-inherited closeFault is forwarded lazily on its original receiver", async () => {
    for (const entry of ["ingress", "checker"] as const) {
      const inherited = await receipt<InheritedReceipt>(["inherited", entry]);
      expect(inherited.outcome).toEqual(expectedSuccess(entry));
      expect(inherited.ownHookProperties).toEqual([]);
      expect(inherited.prototypeHookProperties).toEqual(["afterAdmission", "closeFault", "onCloseAttempt"]);
      expect(inherited.getterReadsAtAdmission).toBe(0);
      expect(inherited.getterReads).toBe(3 * SEGMENTS + 1);
      expect(inherited.closeFaultCalls).toBe(inherited.getterReads);
      expect(inherited.closeAttemptCalls).toBe(inherited.getterReads);
      expect(inherited.afterAdmissionCalls).toBe(1);
      expect(inherited.getterReceiverMatches).toBe(true);
      expect(inherited.faultReceiverMatches).toBe(true);
      expect(inherited.closeAttemptReceiverMatches).toBe(true);
      expect(inherited.afterAdmissionReceiverMatches).toBe(true);
    }

    const gated = await mutatedReceipt<InheritedReceipt>("own_property_hook_gate", ["inherited", "ingress"]);
    expect(gated.getterReads).toBe(0);
    expect(gated.closeFaultCalls).toBe(0);
    expect(gated.closeAttemptCalls).toBe(3 * SEGMENTS + 1);
  });

  test("mediation registers no rejection sink, calls no peek, and rewrites no Promise identity", async () => {
    for (const source of await mediationSources(undefined)) expect(rejectionSinkDenials(source)).toEqual([]);
    for (const [mutation, denial] of [
      ["aliased_rejection_listener", "rejection_listener_registration"],
      ["detached_bun_peek", "promise_sink_peek"],
      ["promise_identity_rewrite", "promise_identity_rewrite"]
    ] as const) {
      const denials = (await mediationSources(mutation)).flatMap((source) => rejectionSinkDenials(source));
      expect(denials).toEqual([denial]);
    }

    for (const entry of ["ingress", "checker"] as const) {
      const sink = await receipt<SinkReceipt>(["sink", entry]);
      expect(sink.outcome).toEqual(expectedSuccess(entry));
      expect(sink.listenerCalls).toBe(0);
      expect(sink.listenersAfter).toEqual(sink.listenersBefore);
      expect(sink.listenersAfter).toEqual({ rejectionHandled: 0, unhandledRejection: 0 });
      expect(sink.peekCalls).toBe(0);
      expect(sink.promiseIdentityStable).toBe(true);
      expect(sink.promiseThenStable).toBe(true);
    }

    const transient = await mutatedReceipt<SinkReceipt>("aliased_rejection_listener", ["sink", "ingress"]);
    expect(transient.listenerCalls).toBeGreaterThan(0);
    expect(transient.listenersAfter).toEqual(transient.listenersBefore);

    const peeked = await mutatedReceipt<SinkReceipt>("detached_bun_peek", ["sink", "ingress"]);
    expect(peeked.peekCalls).toBeGreaterThan(0);

    const rewritten = await mutatedReceipt<SinkReceipt>("promise_identity_rewrite", ["sink", "ingress"]);
    expect(rewritten.promiseIdentityStable).toBe(false);
  });

  test("every public capability entry and captured authority rejects callback reentry", async () => {
    for (const entry of ["ingress", "checker"] as const) {
      const reentry = await receipt<ReentryReceipt>(["reentry", entry]);
      expect(reentry.origins.map((origin) => origin.origin)).toEqual(
        entry === "ingress" ? [...REENTRY_ORIGINS] : [...CHECKER_REENTRY_ORIGINS]
      );
      for (const origin of reentry.origins) assertReentryOrigin(origin, entry);
    }

    const unguarded = await mutatedReceipt<ReentryReceipt>("remove_reentry_guard", ["reentry", "ingress"]);
    for (const origin of unguarded.origins) {
      expect(() => assertReentryOrigin(origin, "ingress")).toThrow();
    }
    const observed = unguarded.origins.find((origin) => origin.origin === "observe");
    expect(observed).toBeDefined();
    expect(observed!.fired).toBe(true);
    expect(reentryRow(observed!, "sealAdmission").outcome).toBe("NO_ERROR");
    expect(reentryRow(observed!, "stat").outcome).toBe("NO_ERROR");
    expect(reentryRow(observed!, "stat").rawDelta).toBeGreaterThan(0);
    expect(reentryRow(observed!, "close").rawDelta).toBeGreaterThan(0);
    expect(reentryRow(observed!, "captured_token_stat").denialCalls).toBeGreaterThan(0);
    expect(reentryRow(observed!, "ingress_read_bounded_file").rawDelta).toBeGreaterThan(0);
    expect(observed!.outcome).toEqual(expectedFailure("ingress"));
  });

  test("an admission hook's return value is discarded unexamined, whatever shape it has", async () => {
    for (const entry of ["ingress", "checker"] as const) {
      const returns = await receipt<AdmissionReturnReceipt>(["admission_return", entry]);
      expect(returns.rows.map((row) => row.kind)).toEqual([...ADMISSION_RETURN_KINDS]);
      const expected = expectedAdmissionReturnObservation(entry);
      const baseline = admissionReturnRow(returns, "undefined");

      for (const kind of ADMISSION_RETURN_KINDS) {
        const row = admissionReturnRow(returns, kind);
        // The boundary-attributable receipt is the same for every shape, and it
        // is the independently recomputed one, not merely self-consistent.
        expect([kind, row.receipt]).toEqual([kind, expected]);
        expect([kind, row.receipt]).toEqual([kind, baseline.receipt]);
        expect([kind, row.fdAfter]).toEqual([kind, row.fdBefore]);
        expect([kind, row.battery]).toEqual([kind, []]);
      }

      // Zero property reads and zero traps: the all-trap Proxy records no
      // observation at all, and the chained attack's thenable is never probed by
      // the boundary - the one read it does see belongs to the mediator's own
      // adoption job, which runs after the operation has already settled.
      const proxy = admissionReturnRow(returns, "all_trap_proxy");
      expect(proxy.receipt.traps).toBe(0);
      expect(proxy.receipt.trapNames).toEqual([]);
      expect(proxy.continuationRan).toBe(false);

      for (const kind of ["plain_native_promise", "chained_outside_latch"] as const) {
        const row = admissionReturnRow(returns, kind);
        expect([kind, row.continuationRan]).toEqual([kind, true]);
        // The operation had already settled when the returned value's own
        // continuation ran, so the boundary waited for nothing.
        expect([kind, row.continuationSawSettledOperation]).toEqual([kind, true]);
      }
      expect(admissionReturnRow(returns, "chained_outside_latch").thenReads).toBe(1);
      for (const kind of ["undefined", "primitive"] as const) {
        expect([kind, admissionReturnRow(returns, kind).continuationRan]).toEqual([kind, false]);
      }
    }

    // Reinstating the await is red exactly where the removed choke-point was
    // attackable: the boundary suspends on the mediator's value, so the plain
    // promise settles before the operation does, and the promise chained outside
    // every latch strands the operation with its descriptors still open while the
    // mediator's adoption job reaches its capability with full authority.
    const awaited = await mutatedReceipt<AdmissionReturnReceipt>(
      "awaited_admission_return",
      ["admission_return", "ingress"]
    );
    const expectedIngress = expectedAdmissionReturnObservation("ingress");

    // The plain-promise row shows why the class is context-shaped rather than
    // value-shaped: the awaited value is well behaved, so the mutation leaves the
    // whole receipt intact and only the ordering betrays the suspension.
    const awaitedNative = admissionReturnRow(awaited, "plain_native_promise");
    expect(awaitedNative.receipt).toEqual(expectedIngress);
    expect(awaitedNative.continuationSawSettledOperation).toBe(false);

    const stranded = admissionReturnRow(awaited, "chained_outside_latch");
    expect(stranded.receipt.settled).toBe(false);
    expect(stranded.receipt.outcome).toBeNull();
    expect(stranded.receipt).not.toEqual(expectedIngress);
    expect(stranded.fdAfter).toBeGreaterThan(stranded.fdBefore);
    expect(stranded.receipt.rawFinal.openRoot + stranded.receipt.rawFinal.openat)
      .toBeGreaterThan(stranded.receipt.rawFinal.close);
    expect(stranded.receipt.batteryFired).toBe(true);
    expect(batteryRow(stranded.battery, "chained_outside_latch", "stat").outcome).toBe("NO_ERROR");
    expect(batteryRow(stranded.battery, "chained_outside_latch", "readRetained").outcome).toBe("NO_ERROR");
    expect(batteryRow(stranded.battery, "chained_outside_latch", "readRetained").rawDelta)
      .toBeGreaterThan(0);
    expect(batteryRow(stranded.battery, "chained_outside_latch", "ingress_read_bounded_file").outcome)
      .toBe("NO_ERROR");

    // The mutation is targeted: a hook that returns nothing, a primitive, or a
    // Proxy keeps its exact receipt, because none of those is a promise.
    for (const kind of ["undefined", "primitive", "all_trap_proxy"] as const) {
      expect([kind, admissionReturnRow(awaited, kind).receipt]).toEqual([kind, expectedIngress]);
    }
  }, ADMISSION_RETURN_TIMEOUT_MS);

  test("the library awaits no mediator-supplied value anywhere", async () => {
    expect(mediatedAwaitDenials(await librarySources(undefined))).toEqual([]);

    // The oracle is not vacuous: it denies the exact await the round-3 gate
    // removed, and it denies it wherever in `lib/` it reappears.
    expect(mediatedAwaitDenials(await librarySources("awaited_admission_return")))
      .toEqual(["awaited_mediator_value"]);

    const clean = await librarySources(undefined);
    for (const reintroduced of [
      "    await hooks.afterAdmission?.(admission!.logicalAbsolutePath);",
      "    const admitted: unknown = hooks.afterAdmission;\n    await admitted;",
      "    for await (const value of hooks as AsyncIterable<unknown>) void value;"
    ]) {
      const mutated = clean.map((source) => source.name !== "ingress.ts" ? source : {
        name: source.name,
        source: source.source.replace(
          "    assertIngressWorkAvailable();",
          `${reintroduced}\n    assertIngressWorkAvailable();`
        )
      });
      expect(mediatedAwaitDenials(mutated)).toEqual(["awaited_mediator_value"]);
    }

    // Formatting and comments cannot change the verdict, and an unparsable
    // source fails closed.
    const commented = clean.map((source) => ({
      name: source.name,
      source: `${source.source}\n// await hooks.afterAdmission?.(path);\nconst awaitDecoy = "await admitted";\n`
    }));
    expect(mediatedAwaitDenials(commented)).toEqual([]);
    expect(mediatedAwaitDenials([{ name: "broken.ts", source: "function (" }]))
      .toEqual(["awaited_mediator_value"]);
  });

  test("work a synchronous admission hook schedules is reentry-rejected by the retained latch arm", async () => {
    for (const entry of ["ingress", "checker"] as const) {
      const scheduled = await receipt<ScheduledDescendantReceipt>(["scheduled_descendant", entry]);
      expect(scheduled.hookCalls).toBe(1);
      expect(scheduled.outcome).toEqual(expectedSuccess(entry));
      expect(scheduled.rawFinal).toEqual(BASELINE_RAW);
      expect(scheduled.fdAfter).toBe(scheduled.fdBefore);
      expect(scheduled.denialCalls).toBe(0);

      // Both queues descend from the hook's async context, so both are latched
      // even though the operation that ran the hook has already settled and
      // closed every descriptor it held.
      expect(scheduled.microtaskFired).toBe(true);
      expect(scheduled.timerFired).toBe(true);
      assertBatteryDenied(scheduled.microtaskBattery, `${entry}/queueMicrotask`);
      assertBatteryDenied(scheduled.timerBattery, `${entry}/setTimeout`);
      expect(scheduled.microtaskBattery.map((row) => row.method).sort())
        .toEqual([...REENTRY_METHODS].sort());
      expect(scheduled.timerBattery.map((row) => row.method).sort())
        .toEqual([...REENTRY_METHODS].sort());
    }

    // F1, restated for synchronous-only hooks: without the async-context arm the
    // descendants run unlatched, and a whole new ingress operation succeeds from
    // a mediator continuation that the boundary never authorized.
    const unlatched = await mutatedReceipt<ScheduledDescendantReceipt>(
      "async_unlatched_callback",
      ["scheduled_descendant", "ingress"]
    );
    expect(unlatched.microtaskFired).toBe(true);
    expect(unlatched.timerFired).toBe(true);
    for (const [label, battery] of [
      ["queueMicrotask", unlatched.microtaskBattery],
      ["setTimeout", unlatched.timerBattery]
    ] as const) {
      expect(() => assertBatteryDenied(battery, label)).toThrow();
      const nested = batteryRow(battery, label, "ingress_read_bounded_file");
      expect([label, nested.outcome]).toEqual([label, "NO_ERROR"]);
      expect(nested.rawDelta).toBeGreaterThan(0);
    }
  }, ADMISSION_RETURN_TIMEOUT_MS);


  test("every #189 latch-boundary mutation is red on the reentry battery", async () => {
    // F1's synchronous negative control: dropping the async-context arm leaves
    // the synchronous depth intact, so a hook that reenters from its own frame
    // is still rejected. The arm's own witness is the scheduled-descendant row.
    const stillLatchedSynchronous = await mutatedReceipt<ReentryReceipt>(
      "async_unlatched_callback",
      ["reentry", "ingress", "after_admission"]
    );
    expect(() => assertReentryOrigin(originReceipt(stillLatchedSynchronous, "after_admission"), "ingress"))
      .not.toThrow();

    // F2: the hook property is read in the caller's own frame, so an accessor
    // reenters unlatched and `authorityFault` is read twice.
    const unlatchedLookup = await mutatedReceipt<ReentryReceipt>(
      "unlatched_hook_lookup",
      ["reentry", "ingress", "accessor_observe"]
    );
    const accessorObserve = originReceipt(unlatchedLookup, "accessor_observe");
    expect(accessorObserve.fired).toBe(true);
    expect(() => assertReentryOrigin(accessorObserve, "ingress")).toThrow();
    expect(reentryRow(accessorObserve, "stat").rawDelta).toBeGreaterThan(0);
    const doubleRead = await mutatedReceipt<ReentryReceipt>(
      "unlatched_hook_lookup",
      ["reentry", "ingress", "accessor_authority_fault"]
    );
    const accessorFault = originReceipt(doubleRead, "accessor_authority_fault");
    expect(accessorFault.authorityFaultReads).toBe(2);
    // The second read is the one `rejectForbidden` acts on, so the fault the
    // boundary reports is not the fault the guard tested.
    expect(accessorFault.faultsReportedToHook.at(-1)).toBe("child_spawn");
    expect(() => assertReentryOrigin(accessorFault, "ingress")).toThrow();

    // F5: the mediator fault value leaves the latch unvalidated, so the coercion
    // the rejection message performs on it runs with the latch disarmed and
    // every descriptor of the sealed operation still open.
    const unvalidatedFault = await mutatedReceipt<ReentryReceipt>(
      "unvalidated_authority_fault",
      ["reentry", "ingress", "authority_fault_coercion"]
    );
    const coercedFault = originReceipt(unvalidatedFault, "authority_fault_coercion");
    expect(coercedFault.authorityFaultCoercions).toBe(1);
    expect(coercedFault.fired).toBe(true);
    expect(() => assertReentryOrigin(coercedFault, "ingress")).toThrow();
    expect(reentryRow(coercedFault, "readRetained").outcome).toBe("NO_ERROR");
    expect(reentryRow(coercedFault, "readRetained").rawDelta).toBeGreaterThan(0);
    expect(reentryRow(coercedFault, "stat").rawDelta).toBeGreaterThan(0);
    expect(reentryRow(coercedFault, "ingress_read_bounded_file").outcome).toBe("NO_ERROR");
    const untouchedAccessor = await mutatedReceipt<ReentryReceipt>(
      "unvalidated_authority_fault",
      ["reentry", "ingress", "accessor_authority_fault"]
    );
    expect(() =>
      assertReentryOrigin(originReceipt(untouchedAccessor, "accessor_authority_fault"), "ingress")
    ).not.toThrow();

    // F3: `beforeCleanup` runs unlatched while every admission descriptor is open.
    const unlatchedCleanup = await mutatedReceipt<ReentryReceipt>(
      "unlatched_before_cleanup",
      ["reentry", "ingress", "before_cleanup"]
    );
    const beforeCleanup = originReceipt(unlatchedCleanup, "before_cleanup");
    expect(beforeCleanup.fired).toBe(true);
    expect(() => assertReentryOrigin(beforeCleanup, "ingress")).toThrow();
    expect(reentryRow(beforeCleanup, "stat").rawDelta).toBeGreaterThan(0);
    const untouchedAdmission = await mutatedReceipt<ReentryReceipt>(
      "unlatched_before_cleanup",
      ["reentry", "ingress", "after_admission"]
    );
    expect(() => assertReentryOrigin(originReceipt(untouchedAdmission, "after_admission"), "ingress"))
      .not.toThrow();
  }, ADMISSION_RETURN_TIMEOUT_MS);

  test("only the frozen fault vocabulary is admitted, and no fault value is ever coerced", async () => {
    for (const entry of ["ingress", "checker"] as const) {
      const faults = await receipt<AuthorityFaultReceipt>(["authority_fault", entry]);

      // Every valid literal keeps its exact legacy receipt: the operation fails
      // with the canonical code and the violation is reported once, verbatim.
      for (const literal of AUTHORITY_FAULT_LITERALS) {
        const row = authorityFaultRow(faults, `literal_${literal}`);
        expect([literal, row.outcome]).toEqual([literal, expectedFailure(entry)]);
        expect([literal, row.violations]).toEqual([literal, [literal]]);
        expect([literal, row.coercions]).toEqual([literal, 0]);
        expect([literal, row.rawFinal]).toEqual([literal, SITE_RAW.after_admission_1.thrownFinal]);
        expect([literal, row.fdAfter]).toEqual([literal, row.fdBefore]);
      }

      // An absent fault is the only accepted non-fault.
      const absent = authorityFaultRow(faults, "absent");
      expect(absent.outcome).toEqual(expectedSuccess(entry));
      expect(absent.violations).toEqual([]);
      expect(absent.rawFinal).toEqual(BASELINE_RAW);

      // Every value outside the vocabulary is rejected with the same stable
      // receipt, is never reported as a violation, and is never converted.
      for (const label of INVALID_AUTHORITY_FAULT_LABELS) {
        const row = authorityFaultRow(faults, label);
        expect([label, row.outcome]).toEqual([label, expectedFailure(entry)]);
        expect([label, row.violations]).toEqual([label, []]);
        expect([label, row.coercions]).toEqual([label, 0]);
        expect([label, row.rawFinal]).toEqual([label, SITE_RAW.after_admission_1.thrownFinal]);
        expect([label, row.fdAfter]).toEqual([label, row.fdBefore]);
      }

      // The public capability method enforces the same vocabulary on its own.
      for (const literal of AUTHORITY_FAULT_LITERALS) {
        expect(directFaultRow(faults, `literal_${literal}`)).toEqual({
          label: `literal_${literal}`,
          outcome: `CONTRACT_CAPABILITY_FORBIDDEN_${literal}`,
          violations: [literal],
          coercions: 0
        });
      }
      for (const label of ["bogus_string", "coercing_object"]) {
        expect(directFaultRow(faults, label)).toEqual({
          label,
          outcome: "CONTRACT_CAPABILITY_FAULT_INVALID",
          violations: [],
          coercions: 0
        });
      }
      expect(directFaultRow(faults, "literal_admission_phase")).toEqual({
        label: "literal_admission_phase",
        outcome: "CONTRACT_CAPABILITY_FAULT_PHASE_INVALID",
        violations: [],
        coercions: 0
      });
    }

    // Reverting the guard makes the boundary coerce the foreign value and
    // silently admit a fault that is not in the vocabulary.
    const unvalidated = await mutatedReceipt<AuthorityFaultReceipt>(
      "unvalidated_authority_fault",
      ["authority_fault", "ingress"]
    );
    const coerced = authorityFaultRow(unvalidated, "coercing_object");
    expect(coerced.coercions).toBe(1);
    expect(coerced.violations).toEqual(["NON_STRING_FAULT"]);
    const directCoerced = directFaultRow(unvalidated, "coercing_object");
    expect(directCoerced.coercions).toBe(1);
    expect(directCoerced.outcome).toBe("CONTRACT_CAPABILITY_FORBIDDEN_file_write");
    expect(directFaultRow(unvalidated, "bogus_string").outcome).toBe("CONTRACT_CAPABILITY_FORBIDDEN_bogus");
    // The frozen message table and the interpolation it replaced agree on every
    // valid literal, so the fix changes no receipt a real fault can produce.
    const fixed = await receipt<AuthorityFaultReceipt>(["authority_fault", "ingress"]);
    for (const literal of AUTHORITY_FAULT_LITERALS) {
      expect(directFaultRow(unvalidated, `literal_${literal}`))
        .toEqual(directFaultRow(fixed, `literal_${literal}`));
      expect(authorityFaultRow(unvalidated, `literal_${literal}`).violations)
        .toEqual(authorityFaultRow(fixed, `literal_${literal}`).violations);
    }
  });

  test("mediated reads return the exact byte count and bytes of the retained file", async () => {
    const expectedDigest = new Bun.CryptoHasher("sha256").update(FIXTURE_BYTES).digest("hex");
    for (const entry of ["ingress", "checker"] as const) {
      const read = await receipt<ReadReceipt>(["read", entry]);
      expect(read.outcome).toEqual(expectedSuccess(entry));
      expect(read.mediatedReturns).toEqual([FIXTURE_BYTES.length, 0]);
      expect(read.readCalls).toBe(2);
      expect(read.rawReadCalls).toBe(2);
      expect(read.assembledBytes).toBe(FIXTURE_BYTES.length);
      expect(read.assembledDigest).toBe(expectedDigest);
    }

    const offByOne = await mutatedReceipt<ReadReceipt>("read_off_by_one", ["read", "ingress"]);
    expect(offByOne.mediatedReturns[0]).toBe(FIXTURE_BYTES.length + 1);
    expect(offByOne.assembledDigest).not.toBe(expectedDigest);
    expect(offByOne.outcome.code).toBe("CONTRACT_BYTES_LIMIT");
  });
});
