import { inspect } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TaskCard } from "@shud-harness/dsh-shud-core";
import {
  codeChangeClosure,
  reconcileTaskCard,
  transitionTask,
  TaskTransitionError,
  type TaskEvent,
} from "./index.ts";
import {
  closureEvidence,
  evidenceLoaders,
  freezeEvidence,
} from "./code-change-closure-test-harness.ts";

const NOW = new Date("2026-11-02T10:11:12.123Z");
const STAMP = "2026-11-02T10:11:12.123Z";
const CHANGE = Object.freeze({ type: "change_create" } as const satisfies TaskEvent);

afterEach(() => vi.unstubAllGlobals());

function frozenCard(overrides: Partial<TaskCard> = {}): TaskCard {
  const card = { ...closureEvidence().card, ...overrides };
  freezeEvidence(card);
  return card;
}

function rejected(card: TaskCard, event: TaskEvent, reason: string): void {
  const before = structuredClone(card);
  const clock = vi.fn(() => {
    throw new Error("Rejected events must not read the clock");
  });
  vi.stubGlobal("Date", clock);
  let error: unknown;
  try {
    transitionTask(card, event);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TaskTransitionError);
  expect(error).toMatchObject({ reason });
  expect(inspect(error, { depth: null })).not.toContain("private-task-text-439");
  expect(clock).not.toHaveBeenCalled();
  expect(card).toStrictEqual(before);
}

describe("code_change state entry", () => {
  test("change_create first enters running_local without updating tool-owned links", () => {
    const card = frozenCard({ status: "planned", runtime_phase: null });
    expect(transitionTask(card, CHANGE, NOW)).toStrictEqual({
      ...card,
      status: "running",
      runtime_phase: "running_local",
      updated_at: STAMP,
    });
    expect(card.status).toBe("planned");
  });

  test("shud_run first enters submitted_job and a later change_create preserves it", () => {
    const card = frozenCard({ status: "planned", runtime_phase: null });
    const submitted = transitionTask(card, { type: "shud_run" }, NOW);
    freezeEvidence(submitted);
    expect(submitted).toStrictEqual({
      ...card,
      status: "running",
      runtime_phase: "submitted_job",
      updated_at: STAMP,
    });
    const later = new Date("2026-11-02T10:12:00.000Z");
    expect(transitionTask(submitted, CHANGE, later)).toStrictEqual({
      ...submitted,
      updated_at: "2026-11-02T10:12:00.000Z",
    });
  });

  test("shud_run after change_create still sets submitted_job", () => {
    const card = frozenCard({ status: "planned", runtime_phase: null });
    const local = transitionTask(card, CHANGE, NOW);
    freezeEvidence(local);
    expect(transitionTask(local, { type: "shud_run" }, NOW)).toStrictEqual({
      ...local,
      runtime_phase: "submitted_job",
    });
  });

  test.each([
    "running_local",
    "submitted_job",
    "waiting_for_job",
    "collecting",
    null,
    undefined,
  ] as const)(
    "running phase %s is preserved while accepted transition owns updated_at",
    (runtime_phase) => {
      const card = frozenCard({
        status: "running",
        runtime_phase,
        updated_at: "2026-11-03T00:00:00.000Z",
      });
      expect(transitionTask(card, CHANGE, NOW)).toStrictEqual({ ...card, updated_at: STAMP });
    },
  );

  test("an absent optional phase remains absent", () => {
    const card = closureEvidence().card;
    delete card.runtime_phase;
    freezeEvidence(card);
    expect(transitionTask(card, CHANGE, NOW)).toStrictEqual({ ...card, updated_at: STAMP });
  });

  test("an accepted change_create uses the default wall clock", () => {
    const card = frozenCard({ status: "planned", runtime_phase: null });
    const clock = vi.fn(function () {
      return NOW;
    });
    vi.stubGlobal("Date", clock);
    expect(transitionTask(card, CHANGE)).toStrictEqual({
      ...card,
      status: "running",
      runtime_phase: "running_local",
      updated_at: STAMP,
    });
    expect(clock).toHaveBeenCalledTimes(1);
  });

  test.each(["science_assist", "engineering", "ops"] as const)(
    "%s cannot enter via change_create",
    (type) => {
      rejected(
        frozenCard({ type, status: "planned", runtime_phase: null }),
        CHANGE,
        "invalid_task_type",
      );
    },
  );

  test.each([
    "created",
    "parked",
    "reporting",
    "awaiting_pi",
    "done",
    "cancelled",
    "blocked",
  ] as const)("change_create rejects %s without reading the clock", (status) => {
    rejected(frozenCard({ status }), CHANGE, "invalid_transition");
  });

  test.each(["shud_build", "change_submit", "verification_run"] as const)(
    "%s is not a transition event in any state",
    (type) => {
      for (const status of [
        "created",
        "planned",
        "running",
        "parked",
        "reporting",
        "awaiting_pi",
        "done",
        "cancelled",
        "blocked",
      ] as const) {
        rejected(frozenCard({ status }), { type } as unknown as TaskEvent, "invalid_event");
        vi.unstubAllGlobals();
      }
    },
  );

  test("reconcile enters running and closure permits the unchanged reporting exit", () => {
    const input = closureEvidence();
    input.card.status = "planned";
    input.card.runtime_phase = null;
    freezeEvidence(input);
    const reconciled = reconcileTaskCard(
      input.card,
      input.runJobs.map(({ job }) => ({ ...job, status: "running" as const })),
      NOW,
    );
    expect(reconciled).toStrictEqual({
      ...input.card,
      status: "running",
      runtime_phase: "submitted_job",
      updated_at: STAMP,
    });
    freezeEvidence(reconciled);
    expect(codeChangeClosure(reconciled, evidenceLoaders(input).loaders)).toMatchObject({
      ok: true,
      failures: [],
    });
    expect(transitionTask(reconciled, { type: "report_generate" }, NOW)).toStrictEqual({
      ...reconciled,
      status: "reporting",
      runtime_phase: null,
    });
  });
});
