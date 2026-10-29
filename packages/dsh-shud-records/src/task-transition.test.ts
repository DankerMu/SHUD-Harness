import { inspect } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TaskCard, TaskStatus } from "@shud-harness/dsh-shud-core";
import { transitionTask, TaskTransitionError, type TaskEvent } from "./index.ts";
import { freezeTaskCard, makeTaskCard } from "./task-lifecycle-test-harness.ts";

const NOW = new Date("2026-10-29T09:10:11.123Z");
const STAMP = "2026-10-29T09:10:11.123Z";
const STATES = [
  "created",
  "planned",
  "running",
  "parked",
  "reporting",
  "awaiting_pi",
  "done",
  "cancelled",
  "blocked",
] as const satisfies readonly TaskStatus[];
const EVENTS = [
  { name: "task_create", event: { type: "task_create" } },
  { name: "shud_run", event: { type: "shud_run" } },
  { name: "reconcile", event: { type: "reconcile" } },
  { name: "report_generate", event: { type: "report_generate" } },
  { name: "report_submit", event: { type: "report_submit" } },
  {
    name: "report_decide:revision_requested",
    event: { type: "report_decide", disposition: "revision_requested" },
  },
  {
    name: "report_decide:rejected",
    event: { type: "report_decide", disposition: "rejected" },
  },
] as const satisfies readonly { name: string; event: TaskEvent }[];

// Literal D4/task-cards expectations, independently supplied before implementation.
// Never import the workplan oracle or a production transition table here.
const LEGAL = [
  { before: "created", event: "task_create", after: "planned", runtime_phase: null },
  { before: "planned", event: "shud_run", after: "running", runtime_phase: "submitted_job" },
  { before: "running", event: "shud_run", after: "running", runtime_phase: "submitted_job" },
  { before: "planned", event: "reconcile", after: "running", runtime_phase: "submitted_job" },
  { before: "planned", event: "report_generate", after: "reporting", runtime_phase: null },
  { before: "running", event: "report_generate", after: "reporting", runtime_phase: null },
  { before: "reporting", event: "report_generate", after: "reporting", runtime_phase: null },
  { before: "reporting", event: "report_submit", after: "done", runtime_phase: null },
  {
    before: "reporting",
    event: "report_decide:revision_requested",
    after: "planned",
    runtime_phase: null,
  },
  {
    before: "reporting",
    event: "report_decide:rejected",
    after: "cancelled",
    runtime_phase: null,
  },
] as const;

function expectFailure(call: () => unknown, reason: "invalid_event" | "invalid_transition"): void {
  let caught: unknown;
  try {
    call();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TaskTransitionError);
  expect(caught).toMatchObject({ reason });
  expect(inspect(caught, { depth: null })).not.toContain("private-task-text-439");
  expect(inspect(caught, { depth: null })).not.toContain("private-event-payload-439");
}

afterEach(() => vi.useRealTimers());

describe.each(STATES)("transitionTask from %s", (status) => {
  test.each(EVENTS)("$name obeys the independent transition matrix", ({ name, event }) => {
    const card = freezeTaskCard(makeTaskCard({ status }));
    const before = structuredClone(card);
    const expected = LEGAL.find((row) => row.before === status && row.event === name);
    Object.freeze(event);
    const eventBefore = structuredClone(event);

    if (expected === undefined) {
      expectFailure(() => transitionTask(card, event, NOW), "invalid_transition");
    } else {
      const result = transitionTask(card, event, NOW);
      expect(result).toStrictEqual({
        ...before,
        status: expected.after,
        runtime_phase: expected.runtime_phase,
        updated_at: STAMP,
      });
      expect(["created", "awaiting_pi", "parked", "blocked"]).not.toContain(result.status);
    }

    expect(card).toStrictEqual(before);
    expect(event).toStrictEqual(eventBefore);
    expect(NOW.toISOString()).toBe(STAMP);
  });
});

describe("transitionTask time and field ownership", () => {
  test.each([
    "running_local",
    "submitted_job",
    "waiting_for_job",
    "collecting",
    null,
    undefined,
  ] as const)(
    "overwrites prior runtime phase %s without filling absent optional metadata",
    (runtime_phase) => {
      const card = makeTaskCard({
        status: "running",
        stack_id: null,
        data_id: null,
        runtime_phase,
      });
      delete card.theory_bundle_ids;
      if (runtime_phase === undefined) delete card.runtime_phase;
      freezeTaskCard(card);
      const before = structuredClone(card);

      expect(transitionTask(card, { type: "report_generate" }, NOW)).toStrictEqual({
        ...before,
        status: "reporting",
        runtime_phase: null,
        updated_at: STAMP,
      });
      expect(card).toStrictEqual(before);
    },
  );

  test.each([
    {
      status: "running",
      runtime_phase: "submitted_job",
      event: { type: "shud_run" },
    },
    {
      status: "reporting",
      runtime_phase: null,
      event: { type: "report_generate" },
    },
  ] as const)("repeated $event.type refreshes time even with unchanged state and phase", (row) => {
    const card = freezeTaskCard(
      makeTaskCard({ status: row.status, runtime_phase: row.runtime_phase }),
    );
    const before = structuredClone(card);

    expect(transitionTask(card, row.event, NOW)).toStrictEqual({
      ...before,
      updated_at: STAMP,
    });
    expect(card).toStrictEqual(before);
  });

  test("uses the wall clock when the optional Date is omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const card = freezeTaskCard(makeTaskCard());
    const before = structuredClone(card);

    expect(transitionTask(card, { type: "shud_run" })).toStrictEqual({
      ...before,
      status: "running",
      runtime_phase: "submitted_job",
      updated_at: STAMP,
    });
    expect(card).toStrictEqual(before);
  });

  test("uses the explicit Date verbatim rather than repairing a backwards clock", () => {
    const card = freezeTaskCard(makeTaskCard({ updated_at: "2026-10-30T00:00:00.000Z" }));
    const before = structuredClone(card);

    expect(transitionTask(card, { type: "shud_run" }, NOW)).toStrictEqual({
      ...before,
      status: "running",
      runtime_phase: "submitted_job",
      updated_at: STAMP,
    });
    expect(card).toStrictEqual(before);
  });
});

const INVALID_EVENTS: { name: string; event: unknown }[] = [
  { name: "unknown type", event: { type: "private-event-payload-439" } },
  { name: "missing type", event: {} },
  { name: "null", event: null },
  { name: "string event", event: "shud_run" },
  { name: "array event", event: ["shud_run"] },
  { name: "prototype key", event: { type: "__proto__" } },
  { name: "constructor key", event: { type: "constructor" } },
  { name: "inherited method key", event: { type: "toString" } },
  { name: "array type", event: { type: ["shud_run"] } },
  { name: "coercible type", event: { type: { toString: () => "shud_run" } } },
  {
    name: "primitive-coercible type",
    event: { type: { [Symbol.toPrimitive]: () => "report_submit" } },
  },
  { name: "missing disposition", event: { type: "report_decide" } },
  { name: "unsupported disposition", event: { type: "report_decide", disposition: "accepted" } },
  { name: "array disposition", event: { type: "report_decide", disposition: ["rejected"] } },
  {
    name: "coercible disposition",
    event: { type: "report_decide", disposition: { toString: () => "revision_requested" } },
  },
];

describe.each(["planned", "reporting"] as const)("closed events from %s", (status) => {
  test.each(INVALID_EVENTS)("rejects $name without exposing or changing input", ({ event }) => {
    const card = freezeTaskCard(makeTaskCard({ status }));
    const before = structuredClone(card);
    const eventBefore = inspect(event, { depth: null });
    if (event !== null && typeof event === "object") Object.freeze(event);

    expectFailure(() => transitionTask(card, event as TaskEvent, NOW), "invalid_event");

    expect(card).toStrictEqual(before);
    expect(inspect(event, { depth: null })).toBe(eventBefore);
  });
});

test.each(["report_submit", "rejected"] as const)(
  "reachable lifecycle ending in %s never introduces a forbidden state",
  (ending) => {
    let card: TaskCard = freezeTaskCard(makeTaskCard({ status: "created", runtime_phase: null }));
    const journey: { event: TaskEvent; status: TaskStatus }[] = [
      { event: { type: "task_create" }, status: "planned" },
      { event: { type: "reconcile" }, status: "running" },
      { event: { type: "shud_run" }, status: "running" },
      { event: { type: "report_generate" }, status: "reporting" },
      { event: { type: "report_generate" }, status: "reporting" },
      {
        event: { type: "report_decide", disposition: "revision_requested" },
        status: "planned",
      },
      { event: { type: "shud_run" }, status: "running" },
      { event: { type: "report_generate" }, status: "reporting" },
      {
        event:
          ending === "report_submit"
            ? { type: "report_submit" }
            : { type: "report_decide", disposition: "rejected" },
        status: ending === "report_submit" ? "done" : "cancelled",
      },
    ];

    for (const step of journey) {
      const before = structuredClone(card);
      const result = transitionTask(card, Object.freeze(step.event), NOW);
      expect(result.status).toBe(step.status);
      expect(["created", "awaiting_pi", "parked", "blocked"]).not.toContain(result.status);
      expect(card).toStrictEqual(before);
      card = freezeTaskCard(result);
    }
  },
);
