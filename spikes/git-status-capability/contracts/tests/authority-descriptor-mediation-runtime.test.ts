import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { ContractCapabilities } from "../lib/capabilities";
import * as capabilities from "../lib/capabilities";
import * as ingress from "../lib/ingress";
import { failure, success } from "./helpers";
import {
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
  battery: readonly ReentryRow[];
}>;
type ReentryReceipt = Readonly<{ entry: Entry; origins: readonly ReentryOriginReceipt[] }>;
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
  "denial"
];
const DENIED = "CONTRACT_CAPABILITY_DESCRIPTOR_DENIED";

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

function reentryRow(origin: ReentryOriginReceipt, method: string): ReentryRow {
  const row = origin.battery.find((candidate) => candidate.method === method);
  if (!row) throw new Error(`reentry row is absent: ${origin.origin}/${method}`);
  return row;
}

function assertReentryOrigin(origin: ReentryOriginReceipt, entry: Entry): void {
  expect(origin.fired).toBe(true);
  expect(origin.battery.map((row) => row.method).sort()).toEqual([...REENTRY_METHODS].sort());
  for (const method of REENTRY_METHODS) {
    const row = reentryRow(origin, method);
    expect(row.outcome).toBe(method === "ingress_read_bounded_file" ? "CONTRACT_SCHEMA_INVALID" : DENIED);
    expect(row.rawDelta).toBe(0);
    expect(row.denialCalls).toBe(0);
  }
  if (origin.origin === "authority_violation") {
    expect(origin.outcome).toEqual(expectedFailure(entry));
    expect(origin.denialCalls).toBe(0);
    return;
  }
  if (origin.origin === "denial") {
    expect(origin.outcome).toEqual({ code: DENIED, exit: null, stdout: "", stderr: "" });
    expect(origin.denialCalls).toBe(1);
    return;
  }
  expect(origin.outcome).toEqual(expectedSuccess(entry));
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
      expect(reentry.origins.map((origin) => origin.origin)).toEqual([...REENTRY_ORIGINS]);
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
