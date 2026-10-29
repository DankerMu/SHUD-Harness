import { inspect } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DataIdSchema,
  JobRecordIdSchema,
  StackIdSchema,
  type RunJob,
  type TaskCard,
  type TaskStatus,
} from "@shud-harness/dsh-shud-core";
import { reconcileTaskCard, TaskReconcileError } from "./index.ts";
import {
  freezeRunJob,
  freezeTaskCard,
  makeRunJob,
  makeTaskCard,
} from "./task-lifecycle-test-harness.ts";

const NOW = new Date("2026-10-29T09:10:11.123Z");
const STAMP = "2026-10-29T09:10:11.123Z";
const FIRST = JobRecordIdSchema.parse("JOB-20261027T080005-0001");
const SECOND = JobRecordIdSchema.parse("JOB-20261027T080005-0002");
const RETAINED = JobRecordIdSchema.parse("JOB-20261027T080005-ffff");
const STACK_FIRST = StackIdSchema.parse("STACK-20261027T080005-0001");
const STACK_SECOND = StackIdSchema.parse("STACK-20261027T080005-0002");
const DATA_FIRST = DataIdSchema.parse("DATA-20261027T080005-0001");
const DATA_SECOND = DataIdSchema.parse("DATA-20261027T080005-0002");

function reconcileUnchangedInputs(card: TaskCard, jobs: RunJob[], expected: TaskCard): TaskCard {
  freezeTaskCard(card);
  jobs.forEach(freezeRunJob);
  Object.freeze(jobs);
  const before = structuredClone({ card, jobs });
  const result = reconcileTaskCard(card, jobs, NOW);
  expect(result).toStrictEqual(expected);
  expect({ card, jobs }).toStrictEqual(before);
  expect(NOW.toISOString()).toBe(STAMP);
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("reconcileTaskCard job knowledge", () => {
  test.each([
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ])("unions and sorts links without losing prior IDs for permutation %j", (...order) => {
    const card = makeTaskCard({ linked_jobs: [RETAINED, SECOND, SECOND] });
    const jobs = [
      makeRunJob(FIRST),
      makeRunJob(SECOND),
      makeRunJob("JOB-20261027T080005-0003", {
        task_id: "TASK-20261027T080005-eeee",
        status: "running",
        submitted_at: "2026-10-29T10:00:00Z",
      }),
    ];
    const permuted = order.map((index) => jobs[index]);
    permuted.push(jobs[0]);

    reconcileUnchangedInputs(card, permuted, {
      ...card,
      linked_jobs: [FIRST, SECOND, RETAINED],
      updated_at: STAMP,
    });
  });

  test("canonicalizes duplicate prior links even without jobs", () => {
    const card = makeTaskCard({ linked_jobs: [SECOND, FIRST, SECOND] });
    reconcileUnchangedInputs(card, [], {
      ...card,
      linked_jobs: [FIRST, SECOND],
      updated_at: STAMP,
    });
  });

  test.each([null, "TASK-20261027T080005-eeee", "TASK-20261027T080005-3f9c-extra"])(
    "ignores a foreign task_id %s even when its job is already linked",
    (task_id) => {
      const card = makeTaskCard({ linked_jobs: [FIRST], stack_id: null, data_id: null });
      const job = makeRunJob(FIRST, {
        task_id,
        status: "running",
        stack_id: "private-invalid-reference-439",
        data_id: "private-invalid-reference-439",
      });
      expect(reconcileUnchangedInputs(card, [job], card)).toBe(card);
    },
  );

  test.each([
    { stack_id: null, data_id: null, stack: STACK_FIRST, data: DATA_FIRST },
    { stack_id: STACK_SECOND, data_id: null, stack: STACK_SECOND, data: DATA_FIRST },
    { stack_id: null, data_id: DATA_SECOND, stack: STACK_FIRST, data: DATA_SECOND },
    { stack_id: STACK_SECOND, data_id: DATA_SECOND, stack: STACK_SECOND, data: DATA_SECOND },
  ])("fills only null references for $stack_id / $data_id", (row) => {
    const card = makeTaskCard({ linked_jobs: [], stack_id: row.stack_id, data_id: row.data_id });
    reconcileUnchangedInputs(card, [makeRunJob(FIRST)], {
      ...card,
      linked_jobs: [FIRST],
      stack_id: row.stack,
      data_id: row.data,
      updated_at: STAMP,
    });
  });

  test("preserves absent optional metadata and the task type while adding a link", () => {
    const card = makeTaskCard({ type: "ops", linked_jobs: [] });
    delete card.theory_bundle_ids;
    delete card.runtime_phase;
    reconcileUnchangedInputs(card, [makeRunJob(FIRST)], {
      ...card,
      linked_jobs: [FIRST],
      updated_at: STAMP,
    });
  });
});

const LATEST_CASES = [
  {
    name: "later date beats the larger job id",
    first: "2026-10-28T00:00:00Z",
    second: "2026-10-27T23:59:59Z",
    stack: STACK_FIRST,
    data: DATA_FIRST,
  },
  {
    name: "fraction magnitudes are not raw ISO lexical order",
    first: "2026-10-27T08:00:05.1Z",
    second: "2026-10-27T08:00:05Z",
    stack: STACK_FIRST,
    data: DATA_FIRST,
  },
  {
    name: "distinct instants within one millisecond do not become a tie",
    first: "2026-10-27T08:00:05.0002Z",
    second: "2026-10-27T08:00:05.0001Z",
    stack: STACK_FIRST,
    data: DATA_FIRST,
  },
  {
    name: "arbitrary fractional precision is retained",
    first: "2026-10-27T08:00:05.00000000000000000002Z",
    second: "2026-10-27T08:00:05.00000000000000000001Z",
    stack: STACK_FIRST,
    data: DATA_FIRST,
  },
  {
    name: "equivalent .1 and .100 instants use largest job id",
    first: "2026-10-27T08:00:05.1Z",
    second: "2026-10-27T08:00:05.100Z",
    stack: STACK_SECOND,
    data: DATA_SECOND,
  },
  {
    name: "equivalent whole-second spellings use largest job id",
    first: "2026-10-27T08:00:05Z",
    second: "2026-10-27T08:00:05.000Z",
    stack: STACK_SECOND,
    data: DATA_SECOND,
  },
  {
    name: "identical timestamps use largest job id",
    first: "2026-10-27T08:00:05Z",
    second: "2026-10-27T08:00:05Z",
    stack: STACK_SECOND,
    data: DATA_SECOND,
  },
  {
    name: "known timestamp is newer than null regardless of job id",
    first: "2026-10-27T08:00:05Z",
    second: null,
    stack: STACK_FIRST,
    data: DATA_FIRST,
  },
  {
    name: "null is older than a known timestamp in either position",
    first: null,
    second: "2026-10-27T08:00:05Z",
    stack: STACK_SECOND,
    data: DATA_SECOND,
  },
  {
    name: "all-null timestamps use largest job id",
    first: null,
    second: null,
    stack: STACK_SECOND,
    data: DATA_SECOND,
  },
];

describe.each([false, true])("latest overall job with reversed order %s", (reverse) => {
  test.each(LATEST_CASES)("$name", (row) => {
    const card = makeTaskCard({ linked_jobs: [], stack_id: null, data_id: null });
    const jobs = [
      makeRunJob(FIRST, { submitted_at: row.first }),
      makeRunJob(SECOND, {
        submitted_at: row.second,
        stack_id: STACK_SECOND,
        data_id: DATA_SECOND,
      }),
    ];
    if (reverse) jobs.reverse();
    reconcileUnchangedInputs(card, jobs, {
      ...card,
      linked_jobs: [FIRST, SECOND],
      stack_id: row.stack,
      data_id: row.data,
      updated_at: STAMP,
    });
  });
});

test.each([
  { stack_id: null, data_id: DATA_SECOND },
  { stack_id: STACK_SECOND, data_id: null },
  { stack_id: null, data_id: null },
])("does not fall back when the latest reference is null: %j", (references) => {
  const card = makeTaskCard({ linked_jobs: [], stack_id: null, data_id: null });
  reconcileUnchangedInputs(
    card,
    [
      makeRunJob(FIRST),
      makeRunJob(SECOND, { submitted_at: "2026-10-27T09:00:00Z", ...references }),
    ],
    { ...card, ...references, linked_jobs: [FIRST, SECOND], updated_at: STAMP },
  );
});

describe("selected reference validation", () => {
  test.each(["stack_id", "data_id"] as const)("rejects an invalid selected %s", (field) => {
    const card = freezeTaskCard(makeTaskCard({ linked_jobs: [], [field]: null }));
    const job = freezeRunJob(makeRunJob(FIRST, { [field]: "private-invalid-reference-439" }));
    const jobs = Object.freeze([job]);
    const before = structuredClone({ card, jobs });
    let caught: unknown;
    try {
      reconcileTaskCard(card, jobs, NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TaskReconcileError);
    expect(caught).toMatchObject({ reason: "invalid_job_reference", job_id: FIRST, field });
    expect(inspect(caught, { depth: null })).not.toContain("private-invalid-reference-439");
    expect(inspect(caught, { depth: null })).not.toContain("private-task-text-439");
    expect({ card, jobs }).toStrictEqual(before);
  });

  test("does not validate an older job's unused references", () => {
    const card = makeTaskCard({ linked_jobs: [], stack_id: null, data_id: null });
    reconcileUnchangedInputs(
      card,
      [
        makeRunJob(FIRST, {
          stack_id: "private-invalid-reference-439",
          data_id: "private-invalid-reference-439",
        }),
        makeRunJob(SECOND, {
          submitted_at: "2026-10-27T09:00:00Z",
          stack_id: STACK_SECOND,
          data_id: DATA_SECOND,
        }),
      ],
      {
        ...card,
        linked_jobs: [FIRST, SECOND],
        stack_id: STACK_SECOND,
        data_id: DATA_SECOND,
        updated_at: STAMP,
      },
    );
  });

  test.each(["stack_id", "data_id"] as const)(
    "does not validate selected %s when the card already has that reference",
    (field) => {
      const card = makeTaskCard({ linked_jobs: [FIRST] });
      const job = makeRunJob(FIRST, { [field]: "private-invalid-reference-439" });
      expect(reconcileUnchangedInputs(card, [job], card)).toBe(card);
    },
  );
});

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
const JOB_STATES = [
  { status: "created", activates: true },
  { status: "submitted", activates: true },
  { status: "running", activates: true },
  { status: "succeeded", activates: false },
  { status: "failed", activates: false },
  { status: "cancelled", activates: false },
  { status: "collected", activates: false },
] as const;

describe.each(STATES)("reconciliation from %s", (status) => {
  test.each(JOB_STATES)("$status job only activates a planned card", (row) => {
    const card = makeTaskCard({ status, runtime_phase: "collecting", linked_jobs: [FIRST] });
    const job = makeRunJob(FIRST, { status: row.status });
    if (status === "planned" && row.activates) {
      reconcileUnchangedInputs(card, [job], {
        ...card,
        status: "running",
        runtime_phase: "submitted_job",
        updated_at: STAMP,
      });
    } else {
      expect(reconcileUnchangedInputs(card, [job], card)).toBe(card);
    }
  });
});

test("an older live job activates planned even when the latest job is terminal", () => {
  const card = makeTaskCard({ linked_jobs: [], stack_id: null, data_id: null });
  reconcileUnchangedInputs(
    card,
    [
      makeRunJob(FIRST, { status: "running" }),
      makeRunJob(SECOND, {
        status: "collected",
        submitted_at: "2026-10-27T09:00:00Z",
        stack_id: STACK_SECOND,
        data_id: DATA_SECOND,
      }),
    ],
    {
      ...card,
      linked_jobs: [FIRST, SECOND],
      stack_id: STACK_SECOND,
      data_id: DATA_SECOND,
      status: "running",
      runtime_phase: "submitted_job",
      updated_at: STAMP,
    },
  );
});

describe("reconciliation no-write signal and clock", () => {
  test("empty knowledge preserves the original card and missing references", () => {
    const card = makeTaskCard({ linked_jobs: [], stack_id: null, data_id: null });
    expect(reconcileUnchangedInputs(card, [], card)).toBe(card);
  });

  test("a no-op does not consume the explicit clock", () => {
    const card = freezeTaskCard(makeTaskCard({ linked_jobs: [FIRST] }));
    const jobs = Object.freeze([freezeRunJob(makeRunJob(FIRST))]);
    const before = structuredClone({ card, jobs });
    const now = new Date(STAMP);
    const clock = vi.spyOn(now, "toISOString");

    expect(reconcileTaskCard(card, jobs, now)).toBe(card);
    expect(clock).not.toHaveBeenCalled();
    expect({ card, jobs }).toStrictEqual(before);
  });

  test("a no-op does not read the default wall clock", () => {
    const card = freezeTaskCard(makeTaskCard({ linked_jobs: [] }));
    const before = structuredClone(card);
    const clock = vi.spyOn(globalThis, "Date");

    expect(reconcileTaskCard(card, [])).toBe(card);
    expect(clock).not.toHaveBeenCalled();
    expect(card).toStrictEqual(before);
  });

  test("a change without an explicit Date uses the wall clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const card = freezeTaskCard(makeTaskCard({ linked_jobs: [] }));
    const jobs = Object.freeze([freezeRunJob(makeRunJob(FIRST))]);
    const before = structuredClone({ card, jobs });

    expect(reconcileTaskCard(card, jobs)).toStrictEqual({
      ...card,
      linked_jobs: [FIRST],
      updated_at: STAMP,
    });
    expect({ card, jobs }).toStrictEqual(before);
  });

  test("a change stamps the explicit Date without synthetic monotonic repair", () => {
    const card = makeTaskCard({ linked_jobs: [], updated_at: "2026-10-30T00:00:00.000Z" });
    reconcileUnchangedInputs(card, [makeRunJob(FIRST)], {
      ...card,
      linked_jobs: [FIRST],
      updated_at: STAMP,
    });
  });
});
