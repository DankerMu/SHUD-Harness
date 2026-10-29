import { inspect } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EvidenceReport, PiGateDecision } from "@shud-harness/dsh-shud-core";
import { applyDecision, markReportReviewed } from "./index.ts";
import {
  freezeEvidenceReport,
  makeEvidenceReport,
  makeReportDecision,
} from "./report-render-test-harness.ts";
import {
  DECISION_OUTCOMES,
  OBSERVED_AT,
  PRIVATE_PAYLOAD,
  REPORT_SOURCES,
  expectRejectedWithoutClock,
} from "./report-state-test-harness.ts";

// These literal legal rows are independent of the production implementation.
const LEGAL_DECISIONS = [
  { before: "reviewed", outcome: "accepted", after: "accepted" },
  { before: "reviewed", outcome: "rejected", after: "rejected" },
  { before: "reviewed", outcome: "revision_requested", after: "revision_requested" },
] as const;

const NOW = new Date(OBSERVED_AT);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(REPORT_SOURCES)("report transitions from $status", (source) => {
  test.each(DECISION_OUTCOMES)("%s obeys the seven-by-three decision matrix", (outcome) => {
    const report = freezeEvidenceReport(
      makeEvidenceReport({
        status: source.status,
        decision_history:
          source.historyOutcome === null ? [] : [makeReportDecision(source.historyOutcome)],
      }),
    );
    const decision = Object.freeze(makeReportDecision(outcome));
    const before = structuredClone({ report, decision });
    const expected = LEGAL_DECISIONS.find(
      (row) => row.before === source.status && row.outcome === outcome,
    );

    if (expected === undefined) {
      expectRejectedWithoutClock(
        (now) => applyDecision(report, decision, now),
        "invalid_transition",
      );
    } else {
      const result = applyDecision(report, decision, NOW);
      expect(result).not.toBe(report);
      expect(result.decision_history).not.toBe(report.decision_history);
      expect(result).toStrictEqual({
        ...before.report,
        status: expected.after,
        decision_history: [before.decision],
        updated_at: OBSERVED_AT,
      });
      expect(["awaiting_pi", "archived"]).not.toContain(result.status);
    }

    expect({ report, decision }).toStrictEqual(before);
    expect(NOW.toISOString()).toBe(OBSERVED_AT);
  });

  test("successful validation obeys the seven-source matrix", () => {
    const report = freezeEvidenceReport(
      makeEvidenceReport({
        status: source.status,
        decision_history:
          source.historyOutcome === null ? [] : [makeReportDecision(source.historyOutcome)],
      }),
    );
    const before = structuredClone(report);

    if (source.validation === null) {
      expectRejectedWithoutClock((now) => markReportReviewed(report, now), "invalid_transition");
    } else {
      const result = markReportReviewed(report, NOW);
      expect(result).not.toBe(report);
      expect(result).toStrictEqual({ ...before, status: "reviewed", updated_at: OBSERVED_AT });
    }

    expect(report).toStrictEqual(before);
    expect(NOW.toISOString()).toBe(OBSERVED_AT);
  });
});

describe("terminal history cannot be overwritten or re-enter a preterminal state", () => {
  test.each(DECISION_OUTCOMES)("a produced %s report rejects every subsequent event", (outcome) => {
    const draft = freezeEvidenceReport(makeEvidenceReport());
    const draftBefore = structuredClone(draft);
    const reviewed = freezeEvidenceReport(markReportReviewed(draft, NOW));
    const reviewedBefore = structuredClone(reviewed);
    const decision = Object.freeze(makeReportDecision(outcome));
    const terminal = freezeEvidenceReport(applyDecision(reviewed, decision, NOW));
    const before = structuredClone(terminal);

    expect([draft.status, reviewed.status, terminal.status]).toStrictEqual([
      "draft",
      "reviewed",
      outcome,
    ]);
    expect(terminal.decision_history).toStrictEqual([decision]);
    for (const nextOutcome of DECISION_OUTCOMES) {
      // Replaying the same decision and submitting a different one must both fail.
      const next = Object.freeze(
        makeReportDecision(nextOutcome, { decision_id: "DEC-20261029T110000-b002" }),
      );
      expectRejectedWithoutClock((now) => applyDecision(terminal, next, now), "invalid_transition");
    }
    expectRejectedWithoutClock(
      (now) => applyDecision(terminal, decision, now),
      "invalid_transition",
    );
    expectRejectedWithoutClock((now) => markReportReviewed(terminal, now), "invalid_transition");
    expectRejectedWithoutClock((now) => markReportReviewed(reviewed, now), "invalid_transition");
    expect(terminal).toStrictEqual(before);
    expect(reviewed).toStrictEqual(reviewedBefore);
    expect(draft).toStrictEqual(draftBefore);
  });

  describe.each(DECISION_OUTCOMES)("preterminal history containing %s", (outcome) => {
    test.each(["matching", "foreign"] as const)(
      "rejects %s history without erasing it",
      (owner) => {
        const history = makeReportDecision(
          outcome,
          owner === "foreign" ? { report_id: "REPORT-20261029T110000-b002" } : {},
        );
        const draft = freezeEvidenceReport(makeEvidenceReport({ decision_history: [history] }));
        const reviewed = freezeEvidenceReport(
          makeEvidenceReport({ status: "reviewed", decision_history: [history] }),
        );
        const decision = Object.freeze(makeReportDecision("accepted"));
        const before = structuredClone({ draft, reviewed, decision });

        expectRejectedWithoutClock(
          (now) => markReportReviewed(draft, now),
          "inconsistent_decision_history",
        );
        expectRejectedWithoutClock(
          (now) => applyDecision(reviewed, decision, now),
          "inconsistent_decision_history",
        );
        expect({ draft, reviewed, decision }).toStrictEqual(before);
      },
    );
  });
});

describe("decision identity and unchanged core comment semantics", () => {
  test("rejects a valid decision for another report before reading a clock", () => {
    const report = freezeEvidenceReport(makeEvidenceReport({ status: "reviewed" }));
    const decision = Object.freeze(
      makeReportDecision("rejected", { report_id: "REPORT-20261029T110000-b002" }),
    );
    const before = structuredClone({ report, decision });

    expectRejectedWithoutClock((now) => applyDecision(report, decision, now), "report_id_mismatch");
    expect({ report, decision }).toStrictEqual(before);
  });

  test.each([
    { outcome: "accepted", comment: null },
    { outcome: "rejected", comment: "  preserve PI comment\nverbatim  " },
    { outcome: "revision_requested", comment: "  preserve PI comment\nverbatim  " },
    { outcome: "rejected", comment: " \t\n " },
    { outcome: "revision_requested", comment: " \t\n " },
  ] as const)("preserves $outcome comment $comment", ({ outcome, comment }) => {
    const report = freezeEvidenceReport(makeEvidenceReport({ status: "reviewed" }));
    const decision = Object.freeze(makeReportDecision(outcome, { comment }));
    const before = structuredClone({ report, decision });

    expect(applyDecision(report, decision, NOW)).toStrictEqual({
      ...before.report,
      status: outcome,
      decision_history: [before.decision],
      updated_at: OBSERVED_AT,
    });
    expect({ report, decision }).toStrictEqual(before);
  });
});

const INVALID_FIELDS: { name: string; fields: Record<string, unknown> }[] = [
  { name: "empty decision id", fields: { decision_id: "" } },
  { name: "malformed decision id", fields: { decision_id: PRIVATE_PAYLOAD } },
  { name: "wrong decision brand", fields: { decision_id: "REPORT-20261029T100000-a001" } },
  { name: "uppercase decision suffix", fields: { decision_id: "DEC-20261029T100000-A001" } },
  { name: "non-string decision id", fields: { decision_id: 442 } },
  { name: "empty report id", fields: { report_id: "" } },
  { name: "malformed report id", fields: { report_id: PRIVATE_PAYLOAD } },
  { name: "wrong report brand", fields: { report_id: "TASK-20261029T100000-a001" } },
  { name: "uppercase report suffix", fields: { report_id: "REPORT-20261029T100000-A001" } },
  { name: "non-string report id", fields: { report_id: 442 } },
  { name: "empty approval reference", fields: { approval_ref: "" } },
  { name: "null approval reference", fields: { approval_ref: null } },
  { name: "non-string approval reference", fields: { approval_ref: 442 } },
  { name: "empty decision time", fields: { decided_at: "" } },
  { name: "non-ISO decision time", fields: { decided_at: PRIVATE_PAYLOAD } },
  { name: "impossible calendar date", fields: { decided_at: "2026-02-30T10:00:00Z" } },
  { name: "missing timezone", fields: { decided_at: "2026-10-29T10:00:00" } },
  { name: "numeric decision time", fields: { decided_at: 442 } },
  { name: "unknown outcome", fields: { outcome: PRIVATE_PAYLOAD } },
  { name: "nonterminal outcome", fields: { outcome: "reviewed" } },
  { name: "prototype outcome", fields: { outcome: "__proto__" } },
  { name: "constructor outcome", fields: { outcome: "constructor" } },
  { name: "inherited method outcome", fields: { outcome: "toString" } },
  { name: "array outcome", fields: { outcome: Object.freeze(["accepted"]) } },
  {
    name: "coercible outcome",
    fields: { outcome: Object.freeze({ toString: () => "accepted" }) },
  },
  {
    name: "primitive-coercible outcome",
    fields: { outcome: Object.freeze({ [Symbol.toPrimitive]: () => "accepted" }) },
  },
  { name: "accepted prose comment", fields: { comment: PRIVATE_PAYLOAD } },
  { name: "accepted empty comment", fields: { comment: "" } },
  { name: "accepted whitespace comment", fields: { comment: " \t\n " } },
  { name: "numeric comment", fields: { comment: 442 } },
  { name: "rejected null comment", fields: { outcome: "rejected", comment: null } },
  { name: "rejected empty comment", fields: { outcome: "rejected", comment: "" } },
  { name: "revision null comment", fields: { outcome: "revision_requested", comment: null } },
  { name: "revision empty comment", fields: { outcome: "revision_requested", comment: "" } },
  { name: "unknown field", fields: { [PRIVATE_PAYLOAD]: PRIVATE_PAYLOAD } },
  { name: "removed approval field", fields: { rejected_approval_ref: PRIVATE_PAYLOAD } },
];

describe("applyDecision validates raw decisions through the closed core contract", () => {
  const base = makeReportDecision("accepted");
  const missingFields = [
    "decision_id",
    "report_id",
    "approval_ref",
    "outcome",
    "comment",
    "decided_at",
  ] as const;
  const cases: { name: string; decision: unknown }[] = [
    ...INVALID_FIELDS.map(({ name, fields }) => ({ name, decision: { ...base, ...fields } })),
    ...missingFields.map((field) => {
      const decision: Partial<PiGateDecision> = { ...base };
      delete decision[field];
      return { name: `missing ${field}`, decision };
    }),
    { name: "null decision", decision: null },
    { name: "undefined decision", decision: undefined },
    { name: "string decision", decision: PRIVATE_PAYLOAD },
    { name: "array decision", decision: [Object.freeze(base)] },
    { name: "empty decision", decision: {} },
  ];

  test.each(cases)(
    "rejects $name without raw diagnostics, mutation or clock reads",
    ({ decision }) => {
      const report = freezeEvidenceReport(makeEvidenceReport({ status: "reviewed" }));
      const before = structuredClone(report);
      if (decision !== null && typeof decision === "object") Object.freeze(decision);
      const decisionBefore = inspect(decision, { depth: null });

      expectRejectedWithoutClock(
        (now) => applyDecision(report, decision as PiGateDecision, now),
        "invalid_decision",
      );
      expect(report).toStrictEqual(before);
      expect(inspect(decision, { depth: null })).toBe(decisionBefore);
    },
  );
});

describe("report transition clocks and field ownership", () => {
  test.each(["explicit", "default"] as const)(
    "validation uses the %s observation clock",
    (clock) => {
      const report = freezeEvidenceReport(makeEvidenceReport());
      const before = structuredClone(report);
      vi.useFakeTimers();
      vi.setSystemTime(clock === "explicit" ? new Date("2026-11-02T00:00:00Z") : NOW);

      const result =
        clock === "explicit" ? markReportReviewed(report, NOW) : markReportReviewed(report);
      expect(result).toStrictEqual({ ...before, status: "reviewed", updated_at: OBSERVED_AT });
      expect(report).toStrictEqual(before);
      expect(NOW.toISOString()).toBe(OBSERVED_AT);
    },
  );

  describe.each(DECISION_OUTCOMES)("%s decision observation time", (outcome) => {
    test.each(["2026-10-28T10:00:00Z", "2026-10-29T09:10:11.123Z", "2026-10-30T10:00:00.123456Z"])(
      "preserves decided_at %s independently of either observation clock",
      (decided_at) => {
        const report = freezeEvidenceReport(makeEvidenceReport({ status: "reviewed" }));
        const decision = Object.freeze(makeReportDecision(outcome, { decided_at }));
        const before = structuredClone({ report, decision });
        vi.useFakeTimers();
        vi.setSystemTime(NOW);

        for (const result of [
          applyDecision(report, decision, NOW),
          applyDecision(report, decision),
        ]) {
          expect(result).toStrictEqual({
            ...before.report,
            status: outcome,
            decision_history: [before.decision],
            updated_at: OBSERVED_AT,
          });
          expect(result.decision_history[0]?.decided_at).toBe(decided_at);
        }
        expect({ report, decision }).toStrictEqual(before);
        expect(NOW.toISOString()).toBe(OBSERVED_AT);
      },
    );
  });

  test("an explicit decision clock overrides the wall clock without normalizing approval evidence", () => {
    const report = freezeEvidenceReport(makeEvidenceReport({ status: "reviewed" }));
    const decision = Object.freeze(makeReportDecision("accepted", { approval_ref: " \t\n " }));
    const before = structuredClone({ report, decision });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));

    expect(applyDecision(report, decision, NOW)).toStrictEqual({
      ...before.report,
      status: "accepted",
      decision_history: [before.decision],
      updated_at: OBSERVED_AT,
    });
    expect({ report, decision }).toStrictEqual(before);
    expect(NOW.toISOString()).toBe(OBSERVED_AT);
  });

  test("preserves authored fields and unsorted references without validating their contents", () => {
    const draft = freezeEvidenceReport(
      makeEvidenceReport({
        summary: "  authored summary\n{{status}}  ",
        observations: ["second observation", "first observation"],
        limitations: [],
        pi_questions: [],
        linked_runs: ["RUN-20261029T100000-ffff", "RUN-20261027T080005-a1b2"],
        stack_ids: ["STACK-20261029T100000-ffff", "STACK-20261027T080005-b2c3"],
        data_ids: ["DATA-20261029T100000-ffff", "DATA-20261027T080005-c3d4"],
        llm_response_models: ["z-model", "a-model"],
        created_at: "2026-10-31T00:00:00Z",
        updated_at: "2026-11-01T00:00:00Z",
      }),
    );
    const before = structuredClone(draft);
    const reviewed = freezeEvidenceReport(markReportReviewed(draft, NOW));
    const decision = Object.freeze(makeReportDecision("accepted"));

    expect(reviewed).toStrictEqual({ ...before, status: "reviewed", updated_at: OBSERVED_AT });
    expect(applyDecision(reviewed, decision, NOW)).toStrictEqual({
      ...before,
      status: "accepted",
      decision_history: [decision],
      updated_at: OBSERVED_AT,
    });
    expect(draft).toStrictEqual(before);
  });
});

describe("unsupported and coercible report sources fail closed", () => {
  test.each([
    { name: "unknown", status: PRIVATE_PAYLOAD },
    { name: "prototype key", status: "__proto__" },
    { name: "constructor key", status: "constructor" },
    { name: "null", status: null },
    { name: "undefined", status: undefined },
    { name: "array reviewed", status: Object.freeze(["reviewed"]) },
    { name: "array draft", status: Object.freeze(["draft"]) },
    { name: "coercible reviewed", status: Object.freeze({ toString: () => "reviewed" }) },
    { name: "coercible draft", status: Object.freeze({ [Symbol.toPrimitive]: () => "draft" }) },
  ])("rejects $name for both operations without reading a clock", ({ status }) => {
    const report = freezeEvidenceReport({
      ...makeEvidenceReport(),
      status: status as EvidenceReport["status"],
    });
    const before = inspect(report, { depth: null });
    const decision = Object.freeze(makeReportDecision("accepted"));

    expectRejectedWithoutClock((now) => markReportReviewed(report, now), "invalid_transition");
    expectRejectedWithoutClock((now) => applyDecision(report, decision, now), "invalid_transition");
    expect(inspect(report, { depth: null })).toBe(before);
  });
});
