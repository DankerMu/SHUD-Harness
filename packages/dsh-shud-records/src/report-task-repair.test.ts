import { inspect } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EvidenceReport, TaskStatus } from "@shud-harness/dsh-shud-core";
import { reportTaskStatus, needsReportTaskRepair } from "./index.ts";
import {
  freezeEvidenceReport,
  makeEvidenceReport,
  makeReportDecision,
} from "./report-render-test-harness.ts";
import { freezeTaskCard, makeTaskCard } from "./task-lifecycle-test-harness.ts";
import {
  PRIVATE_PAYLOAD,
  expectNoReportClock,
  expectReportStateFailure,
} from "./report-state-test-harness.ts";

// Literal report-to-task expectations, independent of production code and the workplan file.
const SUPPORTED = [
  { status: "draft", taskStatus: "reporting", historyOutcome: null },
  { status: "reviewed", taskStatus: "reporting", historyOutcome: null },
  { status: "accepted", taskStatus: "done", historyOutcome: "accepted" },
  { status: "revision_requested", taskStatus: "planned", historyOutcome: "revision_requested" },
  { status: "rejected", taskStatus: "cancelled", historyOutcome: "rejected" },
] as const;
const TASK_STATUSES = [
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
const REPORT_ID = makeEvidenceReport().report_id;
const OTHER_ID = makeEvidenceReport({ report_id: "REPORT-20261029T110000-b002" }).report_id;
const POSITIONS = [
  { name: "unlinked", links: [OTHER_ID] },
  { name: "last", links: [OTHER_ID, REPORT_ID] },
  { name: "older", links: [REPORT_ID, OTHER_ID] },
] as const;

afterEach(() => vi.restoreAllMocks());

describe.each(SUPPORTED)("$status projects to $taskStatus", (row) => {
  test("maps the report status without reading a clock", () => {
    expectNoReportClock(() => expect(reportTaskStatus(row.status)).toBe(row.taskStatus));
  });

  describe.each(TASK_STATUSES)("card status %s", (status) => {
    test.each(POSITIONS)("$name position owns the repair decision", (position) => {
      const report = freezeEvidenceReport(
        makeEvidenceReport({
          status: row.status,
          decision_history:
            row.historyOutcome === null ? [] : [makeReportDecision(row.historyOutcome)],
        }),
      );
      const card = freezeTaskCard(
        makeTaskCard({ task_id: report.task_id, status, linked_reports: [...position.links] }),
      );
      const before = structuredClone({ card, report });
      const expected =
        position.name === "unlinked" || (position.name === "last" && status !== row.taskStatus);

      expectNoReportClock(() => expect(needsReportTaskRepair(card, report)).toBe(expected));
      expect({ card, report }).toStrictEqual(before);
    });
  });

  test("an empty link list still requires linking when the card status already matches", () => {
    const report = freezeEvidenceReport(makeEvidenceReport({ status: row.status }));
    const card = freezeTaskCard(
      makeTaskCard({ task_id: report.task_id, status: row.taskStatus, linked_reports: [] }),
    );
    const before = structuredClone({ card, report });

    expectNoReportClock(() => expect(needsReportTaskRepair(card, report)).toBe(true));
    expect({ card, report }).toStrictEqual(before);
  });

  test.each(POSITIONS)(
    "foreign-task $name report fails before link/status shortcuts",
    (position) => {
      const report = freezeEvidenceReport(makeEvidenceReport({ status: row.status }));
      const card = freezeTaskCard(
        makeTaskCard({
          task_id: "TASK-20261029T120000-ffff",
          status: row.taskStatus,
          linked_reports: [...position.links],
        }),
      );
      const before = structuredClone({ card, report });

      expectNoReportClock(() => {
        expectReportStateFailure(() => needsReportTaskRepair(card, report), "task_id_mismatch");
      });
      expect({ card, report }).toStrictEqual(before);
    },
  );

  test.each([
    { links: [REPORT_ID, OTHER_ID, REPORT_ID], matches: false, expected: true },
    { links: [REPORT_ID, OTHER_ID, REPORT_ID], matches: true, expected: false },
    { links: [REPORT_ID, REPORT_ID], matches: false, expected: true },
    { links: [REPORT_ID, REPORT_ID, OTHER_ID], matches: false, expected: false },
    { links: [OTHER_ID, OTHER_ID], matches: true, expected: true },
  ])("duplicate links $links with matching status $matches", ({ links, matches, expected }) => {
    const report = freezeEvidenceReport(makeEvidenceReport({ status: row.status }));
    const card = freezeTaskCard(
      makeTaskCard({
        task_id: report.task_id,
        status: matches ? row.taskStatus : "blocked",
        linked_reports: links,
      }),
    );
    const before = structuredClone({ card, report });

    expectNoReportClock(() => expect(needsReportTaskRepair(card, report)).toBe(expected));
    expect({ card, report }).toStrictEqual(before);
  });

  test.each([
    "running_local",
    "submitted_job",
    "waiting_for_job",
    "collecting",
    null,
    undefined,
  ] as const)("runtime phase %s and unrelated metadata never trigger repair", (runtime_phase) => {
    const report = freezeEvidenceReport(
      makeEvidenceReport({
        status: row.status,
        created_at: "2026-10-30T00:00:00Z",
        updated_at: "2026-10-28T00:00:00Z",
        // Projection is not approval or history authentication, including preterminal conflicts.
        decision_history: [makeReportDecision("rejected"), makeReportDecision("accepted")],
      }),
    );
    const card = makeTaskCard({
      task_id: report.task_id,
      status: row.taskStatus,
      linked_reports: [REPORT_ID, OTHER_ID, REPORT_ID],
      runtime_phase,
      stack_id: null,
      data_id: null,
      linked_jobs: [],
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-02T00:00:00Z",
    });
    delete card.theory_bundle_ids;
    if (runtime_phase === undefined) delete card.runtime_phase;
    freezeTaskCard(card);
    const before = structuredClone({ card, report });

    expectNoReportClock(() => {
      expect(reportTaskStatus(report.status)).toBe(row.taskStatus);
      expect(needsReportTaskRepair(card, report)).toBe(false);
    });
    expect({ card, report }).toStrictEqual(before);
  });
});

const UNSUPPORTED: { name: string; status: unknown }[] = [
  { name: "awaiting_pi", status: "awaiting_pi" },
  { name: "archived", status: "archived" },
  { name: "unknown", status: PRIVATE_PAYLOAD },
  { name: "prototype key", status: "__proto__" },
  { name: "constructor key", status: "constructor" },
  { name: "inherited method key", status: "toString" },
  { name: "null", status: null },
  { name: "undefined", status: undefined },
  { name: "number", status: 442 },
  { name: "array accepted", status: Object.freeze(["accepted"]) },
  { name: "array draft", status: Object.freeze(["draft"]) },
  { name: "coercible accepted", status: Object.freeze({ toString: () => "accepted" }) },
  { name: "coercible rejected", status: Object.freeze({ [Symbol.toPrimitive]: () => "rejected" }) },
];

describe.each(UNSUPPORTED)("unsupported report status $name", ({ status }) => {
  test("has no task-status projection", () => {
    const before = inspect(status, { depth: null });
    expectNoReportClock(() => {
      expectReportStateFailure(
        () => reportTaskStatus(status as EvidenceReport["status"]),
        "unsupported_report_status",
      );
    });
    expect(inspect(status, { depth: null })).toBe(before);
  });

  test.each(POSITIONS)("$name position cannot bypass support validation", (position) => {
    const report = freezeEvidenceReport({
      ...makeEvidenceReport(),
      status: status as EvidenceReport["status"],
    });
    const card = freezeTaskCard(
      makeTaskCard({
        task_id: report.task_id,
        status: "reporting",
        linked_reports: [...position.links],
      }),
    );
    const before = inspect({ card, report }, { depth: null });

    expectNoReportClock(() => {
      expectReportStateFailure(
        () => needsReportTaskRepair(card, report),
        "unsupported_report_status",
      );
    });
    expect(inspect({ card, report }, { depth: null })).toBe(before);
  });
});

test("link array order wins over report ids, timestamps and histories", () => {
  const earlierLink = freezeEvidenceReport(
    makeEvidenceReport({
      report_id: "REPORT-20261030T235959-ffff",
      status: "rejected",
      created_at: "2026-11-02T00:00:00Z",
      updated_at: "2026-11-03T00:00:00Z",
      decision_history: [
        makeReportDecision("rejected", {
          report_id: "REPORT-20261030T235959-ffff",
          decided_at: "2026-11-03T00:00:00Z",
        }),
      ],
    }),
  );
  const lastLink = freezeEvidenceReport(
    makeEvidenceReport({
      report_id: "REPORT-20261027T000000-0001",
      status: "accepted",
      created_at: "2026-10-27T00:00:00Z",
      updated_at: "2026-10-28T00:00:00Z",
      decision_history: [
        makeReportDecision("accepted", {
          report_id: "REPORT-20261027T000000-0001",
          decided_at: "2026-10-28T00:00:00Z",
        }),
      ],
    }),
  );
  const card = freezeTaskCard(
    makeTaskCard({
      task_id: earlierLink.task_id,
      status: "reporting",
      linked_reports: [earlierLink.report_id, lastLink.report_id],
    }),
  );
  const reversed = freezeTaskCard(
    makeTaskCard({
      ...card,
      linked_reports: [lastLink.report_id, earlierLink.report_id],
    }),
  );
  const before = structuredClone({ earlierLink, lastLink, card, reversed });

  expectNoReportClock(() => {
    expect(needsReportTaskRepair(card, earlierLink)).toBe(false);
    expect(needsReportTaskRepair(card, lastLink)).toBe(true);
    expect(needsReportTaskRepair(reversed, earlierLink)).toBe(true);
    expect(needsReportTaskRepair(reversed, lastLink)).toBe(false);
  });
  expect({ earlierLink, lastLink, card, reversed }).toStrictEqual(before);
});
