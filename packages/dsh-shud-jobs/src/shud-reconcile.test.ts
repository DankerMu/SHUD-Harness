import { expect, test } from "vitest";
import {
  reconcileEntry,
  type ReconcileDecision,
  type ReconcileSnapshot,
} from "./shud-reconcile.ts";
import type { ExitEvidence } from "./shud-exit.ts";
import type { ProcessBirthObservation } from "./process-birth.ts";

const wrapper: ProcessBirthObservation = {
  pid: 4242,
  pid_started_at: "2026-10-22T03:15:00.000Z",
  state: "S",
  birthLatestMs: Date.parse("2026-10-22T03:15:00.000Z"),
};

test("R1 created selects never-started lost settlement", () => {
  expect(reconcileEntry({ status: "created", notify: "pending" })).toEqual({
    row: "R1",
    action: "settle-lost",
  });
});

test.each([0, 19])("R2 submitted exit %s outranks an otherwise adoptable wrapper", (code) => {
  const evidence: ExitEvidence = { code };
  expect(
    reconcileEntry({
      status: "submitted",
      notify: "pending",
      submitted_at: "2026-10-22T03:15:00.999Z",
      exit: evidence,
      wrapper,
    }),
  ).toEqual({ row: "R2", action: "settle-exit", evidence });
});

test("R2 newly observed exit replaces R4 lost after the shell's non-live recheck", () => {
  const evidence: ExitEvidence = { code: 19 };
  expect(
    reconcileEntry({
      status: "submitted",
      notify: "pending",
      submitted_at: "2026-10-22T03:15:00.999Z",
      exit: evidence,
      wrapper: null,
    }),
  ).toEqual({ row: "R2", action: "settle-exit", evidence });
});

test.each(["invalid", "unreadable"] as const)(
  "R2 retains %s exit evidence for canonical failed-settlement accounting",
  (kind) => {
    const evidence: ExitEvidence = { kind, error: new Error("exit evidence rejected") };
    expect(
      reconcileEntry({
        status: "submitted",
        notify: "pending",
        submitted_at: "2026-10-22T03:15:00.999Z",
        exit: evidence,
        wrapper: null,
      }),
    ).toEqual({ row: "R2", action: "settle-exit", evidence });
  },
);

test.each(["2026-10-22T03:14:59.000Z", "2026-10-22T03:15:00.000Z", "2026-10-22T03:15:00.999Z"])(
  "R3 accepts a live wrapper no earlier than the submission second %s",
  (submittedAt) => {
    expect(
      reconcileEntry({
        status: "submitted",
        notify: "pending",
        submitted_at: submittedAt,
        exit: undefined,
        wrapper,
      }),
    ).toEqual({
      row: "R3",
      action: "promote",
      identity: { pid: 4242, pid_started_at: "2026-10-22T03:15:00.000Z" },
    });
  },
);

test.each([
  { name: "absent wrapper", observed: null, submittedAt: "2026-10-22T03:15:00.000Z" },
  {
    name: "zombie wrapper",
    observed: { ...wrapper, state: "Zs" },
    submittedAt: "2026-10-22T03:15:00.000Z",
  },
  { name: "earlier-second wrapper", observed: wrapper, submittedAt: "2026-10-22T03:15:01.000Z" },
])("R4 selects lost rather than R3 promotion for $name", ({ observed, submittedAt }) => {
  expect(
    reconcileEntry({
      status: "submitted",
      notify: "pending",
      submitted_at: submittedAt,
      exit: undefined,
      wrapper: observed,
    }),
  ).toEqual({ row: "R4", action: "settle-lost" });
});

test("submitted identity classification rejects a missing timestamp instead of selecting R4", () => {
  expect(() =>
    reconcileEntry({
      status: "submitted",
      notify: "pending",
      submitted_at: null,
      exit: undefined,
      wrapper,
    }),
  ).toThrow(/submitted_at/u);
});

test("R2 numeric exit does not require an unused submission timestamp", () => {
  const evidence: ExitEvidence = { code: 0 };
  expect(
    reconcileEntry({
      status: "submitted",
      notify: "pending",
      submitted_at: null,
      exit: evidence,
      wrapper: null,
    }),
  ).toEqual({ row: "R2", action: "settle-exit", evidence });
});

test.each([
  { cancellation: null, row: "R5", action: "monitor" },
  { cancellation: "2026-10-22T03:15:01.000Z", row: "R8", action: "cancel-group" },
] as const)(
  "$row selects $action for a matching live running process",
  ({ cancellation, row, action }) => {
    expect(
      reconcileEntry({
        status: "running",
        notify: "pending",
        identity: { pid: 4242, pid_started_at: "2026-10-22T03:15:00.000Z" },
        cancel_requested_at: cancellation,
        exit: undefined,
        process: wrapper,
      }),
    ).toEqual({ row, action });
  },
);

test.each([0, 19])("R6 exit %s outranks live cancelled R8 recovery", (code) => {
  const evidence: ExitEvidence = { code };
  expect(
    reconcileEntry({
      status: "running",
      notify: "pending",
      identity: { pid: 4242, pid_started_at: "2026-10-22T03:15:00.000Z" },
      cancel_requested_at: "2026-10-22T03:15:01.000Z",
      exit: evidence,
      process: wrapper,
    }),
  ).toEqual({ row: "R6", action: "settle-exit", evidence });
});

test("R6 numeric exit discovered after a non-live probe outranks R7 cancellation", () => {
  const evidence: ExitEvidence = { code: 19 };
  expect(
    reconcileEntry({
      status: "running",
      notify: "pending",
      identity: { pid: 4242, pid_started_at: "2026-10-22T03:15:00.000Z" },
      cancel_requested_at: "2026-10-22T03:15:01.000Z",
      exit: evidence,
      process: null,
    }),
  ).toEqual({ row: "R6", action: "settle-exit", evidence });
});

test.each([
  { name: "absent process", observed: null },
  { name: "zombie process", observed: { ...wrapper, state: "Zs" } },
  {
    name: "reused pid",
    observed: { ...wrapper, pid_started_at: "2026-10-22T03:15:02.000Z" },
  },
  { name: "different pid", observed: { ...wrapper, pid: 4243 } },
])("R7 settles a $name without adopting its group", ({ observed }) => {
  for (const expected of [
    { cancellation: null, action: "settle-lost" },
    { cancellation: "2026-10-22T03:15:01.000Z", action: "settle-cancelled" },
  ] as const) {
    expect(
      reconcileEntry({
        status: "running",
        notify: "pending",
        identity: { pid: 4242, pid_started_at: "2026-10-22T03:15:00.000Z" },
        cancel_requested_at: expected.cancellation,
        exit: undefined,
        process: observed,
      }),
    ).toEqual({ row: "R7", action: expected.action });
  }
});

const decisionRows: Array<{
  name: string;
  snapshot: ReconcileSnapshot;
  expected: ReconcileDecision;
}> = [
  {
    name: "R1",
    snapshot: { status: "created", notify: "pending" },
    expected: { row: "R1", action: "settle-lost" },
  },
  {
    name: "R2",
    snapshot: {
      status: "submitted",
      notify: "pending",
      submitted_at: "2026-10-22T03:15:00.999Z",
      exit: { code: 0 },
      wrapper: null,
    },
    expected: { row: "R2", action: "settle-exit", evidence: { code: 0 } },
  },
  {
    name: "R3",
    snapshot: {
      status: "submitted",
      notify: "pending",
      submitted_at: "2026-10-22T03:15:00.999Z",
      exit: undefined,
      wrapper,
    },
    expected: {
      row: "R3",
      action: "promote",
      identity: { pid: 4242, pid_started_at: "2026-10-22T03:15:00.000Z" },
    },
  },
  {
    name: "R4",
    snapshot: {
      status: "submitted",
      notify: "pending",
      submitted_at: "2026-10-22T03:15:00.999Z",
      exit: undefined,
      wrapper: null,
    },
    expected: { row: "R4", action: "settle-lost" },
  },
  {
    name: "R5",
    snapshot: {
      status: "running",
      notify: "pending",
      identity: { pid: 4242, pid_started_at: "2026-10-22T03:15:00.000Z" },
      cancel_requested_at: null,
      exit: undefined,
      process: wrapper,
    },
    expected: { row: "R5", action: "monitor" },
  },
  {
    name: "R6",
    snapshot: {
      status: "running",
      notify: "pending",
      identity: { pid: 4242, pid_started_at: "2026-10-22T03:15:00.000Z" },
      cancel_requested_at: null,
      exit: { code: 19 },
      process: wrapper,
    },
    expected: { row: "R6", action: "settle-exit", evidence: { code: 19 } },
  },
  {
    name: "R7",
    snapshot: {
      status: "running",
      notify: "pending",
      identity: { pid: 4242, pid_started_at: "2026-10-22T03:15:00.000Z" },
      cancel_requested_at: null,
      exit: undefined,
      process: null,
    },
    expected: { row: "R7", action: "settle-lost" },
  },
  {
    name: "R8",
    snapshot: {
      status: "running",
      notify: "pending",
      identity: { pid: 4242, pid_started_at: "2026-10-22T03:15:00.000Z" },
      cancel_requested_at: "2026-10-22T03:15:01.000Z",
      exit: undefined,
      process: wrapper,
    },
    expected: { row: "R8", action: "cancel-group" },
  },
  {
    name: "R9",
    snapshot: {
      status: "cancelled",
      notify: "pending",
      collection: { committed: false, attempts: 2 },
    },
    expected: { row: "R9", action: "collect" },
  },
  {
    name: "R10",
    snapshot: {
      status: "failed",
      notify: "pending",
      collection: { committed: false, attempts: 3 },
    },
    expected: { row: "R10", action: "retain-terminal" },
  },
  {
    name: "R11",
    snapshot: { status: "collected", notify: "pending" },
    expected: { row: "R11", action: "retain-collected" },
  },
  {
    name: "R12",
    snapshot: { status: "collected", notify: "delivered" },
    expected: { row: "R12", action: "complete-index" },
  },
];

test.each(decisionRows)(
  "D11 $name selects its specified row and action",
  ({ snapshot, expected }) => {
    expect(reconcileEntry(snapshot)).toEqual(expected);
  },
);

test.each(["delivered", "unreachable"] as const)(
  "R12 %s notification takes priority over every status and competing row",
  (notify) => {
    for (const { snapshot } of decisionRows) {
      expect(reconcileEntry({ ...snapshot, notify })).toEqual({
        row: "R12",
        action: "complete-index",
      });
    }
    expect(reconcileEntry({ status: "succeeded", notify })).toEqual({
      row: "R12",
      action: "complete-index",
    });
  },
);

test.each(["succeeded", "failed", "cancelled"] as const)(
  "R9 committed %s result overrides the exhausted generation budget",
  (status) => {
    expect(
      reconcileEntry({
        status,
        notify: "pending",
        collection: { committed: true, attempts: 3 },
      }),
    ).toEqual({ row: "R9", action: "collect" });
  },
);

test.each([
  { attempts: 0, row: "R9", action: "collect" },
  { attempts: 1, row: "R9", action: "collect" },
  { attempts: 2, row: "R9", action: "collect" },
  { attempts: 3, row: "R10", action: "retain-terminal" },
  { attempts: 4, row: "R10", action: "retain-terminal" },
] as const)(
  "generation attempts=$attempts selects $row independently of the collector's backoff clock",
  ({ attempts, row, action }) => {
    expect(
      reconcileEntry({
        status: "failed",
        notify: "pending",
        collection: { committed: false, attempts },
      }),
    ).toEqual({ row, action });
  },
);
