import * as fs from "node:fs";
import type * as NodeFs from "node:fs";
import { inspect } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DecisionIdSchema,
  ReportIdSchema,
  type EvidenceReport,
  type PiGateDecision,
} from "@shud-harness/dsh-shud-core";
import { isReportMarkdownStale, ReportRenderError } from "./index.ts";
import {
  freezeEvidenceReport,
  makeEvidenceReport,
  makeReportDecision,
} from "./report-render-test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    statSync: vi.fn(actual.statSync),
    lstatSync: vi.fn(actual.lstatSync),
    readdirSync: vi.fn(actual.readdirSync),
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});

// Literal expectations copied from the independently frozen issue-440 watermark oracle.
// Do not import the workplan file or derive expected headers from production helpers.
const WATERMARKS = [
  { status: "draft", outcome: null, header: "DRAFT — not accepted by PI" },
  { status: "reviewed", outcome: null, header: "DRAFT — not accepted by PI" },
  { status: "awaiting_pi", outcome: null, header: "DRAFT — not accepted by PI" },
  {
    status: "revision_requested",
    outcome: "revision_requested",
    header: "REVISION REQUESTED — not accepted by PI",
  },
  { status: "rejected", outcome: "rejected", header: "REJECTED — not accepted by PI" },
  {
    status: "accepted",
    outcome: "accepted",
    header: "Accepted by PI · 2026-10-29T10:00:00Z · DEC-20261029T100000-a001",
  },
  {
    status: "archived",
    outcome: "accepted",
    header: "Accepted by PI · 2026-10-29T10:00:00Z · DEC-20261029T100000-a001 · ARCHIVED",
  },
  {
    status: "archived",
    outcome: "revision_requested",
    header: "REVISION REQUESTED — not accepted by PI · ARCHIVED",
  },
  {
    status: "archived",
    outcome: "rejected",
    header: "REJECTED — not accepted by PI · ARCHIVED",
  },
] as const satisfies readonly {
  status: EvidenceReport["status"];
  outcome: PiGateDecision["outcome"] | null;
  header: string;
}[];

const TITLE = "# EvidenceReport: REPORT-20261027T080005-3f9c";
const FOREIGN_REPORT_ID = ReportIdSchema.parse("REPORT-20261029T100001-f002");

function expectHistoryFailure(report: EvidenceReport, markdown: string | undefined): void {
  const before = structuredClone(report);
  freezeEvidenceReport(report);
  let caught: unknown;
  try {
    isReportMarkdownStale(report, markdown);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReportRenderError);
  expect(caught).toMatchObject({
    name: "ReportRenderError",
    stage: "decision_history",
  });
  expect(caught).not.toHaveProperty("cause");
  expect(caught).not.toHaveProperty("issues");
  expect(caught).not.toHaveProperty("path", expect.any(String));
  const diagnostic = inspect(caught, { depth: null });
  for (const sentinel of [
    "private-report-summary-440",
    "private-report-observation-440",
    "private-report-limitation-440",
    "private-report-question-440",
    "private-approval-reference-440",
    "private-decision-comment-440",
    FOREIGN_REPORT_ID,
  ]) {
    expect(diagnostic).not.toContain(sentinel);
  }
  expect(report).toStrictEqual(before);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(WATERMARKS)("isReportMarkdownStale $status / $outcome", (row) => {
  function report(): EvidenceReport {
    return freezeEvidenceReport(
      makeEvidenceReport({
        status: row.status,
        decision_history: row.outcome === null ? [] : [makeReportDecision(row.outcome)],
      }),
    );
  }

  test("uses only the exact physical second line, with or without an ending newline", () => {
    const input = report();
    const before = structuredClone(input);
    expect(isReportMarkdownStale(input, `${TITLE}\n${row.header}`)).toBe(false);
    expect(isReportMarkdownStale(input, `${TITLE}\n${row.header}\n`)).toBe(false);
    expect(input).toStrictEqual(before);
  });

  test.each([
    { name: "missing Markdown", markdown: undefined },
    { name: "empty Markdown", markdown: "" },
    { name: "title only", markdown: TITLE },
    { name: "missing header", markdown: `${TITLE}\n` },
  ])("marks $name stale", ({ markdown }) => {
    const input = report();
    const before = structuredClone(input);
    expect(isReportMarkdownStale(input, markdown)).toBe(true);
    expect(input).toStrictEqual(before);
  });

  test("does not search the title, body, footer, comments or blank lines for a marker", () => {
    const input = report();
    const before = structuredClone(input);
    for (const markdown of [
      `${row.header}\nnot the header`,
      `${TITLE}\n\n${row.header}`,
      `${TITLE}\nwrong header\nBody\n${row.header}\n`,
      `${TITLE}\n<!-- ${row.header} -->`,
      `${TITLE}\n> ${row.header}`,
      `${TITLE}\n ${row.header}`,
      `${TITLE}\n${row.header} `,
      `${TITLE}\n${row.header} extra`,
    ]) {
      expect(isReportMarkdownStale(input, markdown)).toBe(true);
    }
    expect(input).toStrictEqual(before);
  });

  test("ignores title, body, footer, authored fields and report timestamps", () => {
    const input = freezeEvidenceReport(
      makeEvidenceReport({
        ...report(),
        summary: "Changed summary with {{header}} token-like text",
        observations: ["Changed\nobservation"],
        limitations: ["Changed limitation"],
        pi_questions: ["Changed question?"],
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2099-12-31T23:59:59Z",
      }),
    );
    const before = structuredClone(input);
    for (const body of [
      "",
      "\nBody without footer",
      "\nCompletely changed body\nWRONG FOOTER\n",
      "\nAccepted by PI · fabricated body marker\nDRAFT — not accepted by PI\n",
    ]) {
      expect(isReportMarkdownStale(input, `Changed title\n${row.header}${body}`)).toBe(false);
    }
    expect(input).toStrictEqual(before);
  });

  test("rejects every different canonical header, but not statuses sharing the same header", () => {
    const input = report();
    for (const other of WATERMARKS) {
      expect(isReportMarkdownStale(input, `${TITLE}\n${other.header}\n`)).toBe(
        other.header !== row.header,
      );
    }
  });
});

describe("isReportMarkdownStale decision provenance", () => {
  test.each(["accepted", "archived"] as const)(
    "%s takes the acceptance id and time from decision history, not report timestamps or the clock",
    (status) => {
      vi.useFakeTimers();
      const report = freezeEvidenceReport(
        makeEvidenceReport({
          status,
          decision_history: [
            makeReportDecision("accepted", {
              decision_id: DecisionIdSchema.parse("DEC-20261028T090000-b002"),
              decided_at: "2026-10-28T09:00:00Z",
            }),
          ],
        }),
      );
      const before = structuredClone(report);
      const header =
        status === "accepted"
          ? "Accepted by PI · 2026-10-28T09:00:00Z · DEC-20261028T090000-b002"
          : "Accepted by PI · 2026-10-28T09:00:00Z · DEC-20261028T090000-b002 · ARCHIVED";
      for (const now of ["2000-01-01T00:00:00Z", "2099-12-31T23:59:59Z"]) {
        vi.setSystemTime(new Date(now));
        expect(isReportMarkdownStale(report, `${TITLE}\n${header}\n`)).toBe(false);
      }
      expect(
        isReportMarkdownStale(report, `${TITLE}\n${header.replace("09:00:00", "09:00:01")}\n`),
      ).toBe(true);
      expect(isReportMarkdownStale(report, `${TITLE}\n${header.replace("b002", "b003")}\n`)).toBe(
        true,
      );
      expect(report).toStrictEqual(before);
    },
  );

  describe.each(WATERMARKS.filter((row) => row.outcome !== null))(
    "$status / $outcome fails closed on invalid terminal evidence",
    (row) => {
      test.each(["missing", "foreign", "duplicate", "multiple", "conflicting", "mixed-foreign"])(
        "%s history is rejected even for missing or otherwise fresh Markdown",
        (kind) => {
          if (row.outcome === null) throw new Error("Expected a terminal watermark fixture");
          const matching = makeReportDecision(row.outcome);
          const foreign = makeReportDecision(row.outcome, { report_id: FOREIGN_REPORT_ID });
          const other = makeReportDecision(row.outcome === "accepted" ? "rejected" : "accepted", {
            decision_id: DecisionIdSchema.parse("DEC-20261029T110000-c003"),
            decided_at: "2026-10-29T11:00:00Z",
          });
          const histories: Record<string, PiGateDecision[]> = {
            missing: [],
            foreign: [foreign],
            duplicate: [matching, matching],
            multiple: [
              matching,
              makeReportDecision(row.outcome, {
                decision_id: DecisionIdSchema.parse("DEC-20261029T110000-c003"),
                decided_at: "2026-10-29T11:00:00Z",
              }),
            ],
            conflicting: [matching, other],
            "mixed-foreign": [matching, foreign],
          };
          const history = histories[kind];
          if (history === undefined) throw new Error("Expected a terminal history fixture");
          for (const decisions of [history, [...history].reverse()]) {
            for (const markdown of [undefined, `${TITLE}\n${row.header}\n`, `${TITLE}\nwrong`]) {
              expectHistoryFailure(
                makeEvidenceReport({ status: row.status, decision_history: decisions }),
                markdown,
              );
            }
          }
        },
      );
    },
  );

  test.each(["accepted", "rejected", "revision_requested"] as const)(
    "%s rejects a sole matching-report decision with the wrong outcome",
    (status) => {
      for (const outcome of ["accepted", "rejected", "revision_requested"] as const) {
        if (outcome === status) continue;
        expectHistoryFailure(
          makeEvidenceReport({ status, decision_history: [makeReportDecision(outcome)] }),
          undefined,
        );
      }
    },
  );
});

test("isReportMarkdownStale uses no filesystem operations on success, stale or history failure", () => {
  const report = freezeEvidenceReport(makeEvidenceReport());
  const invalid = makeEvidenceReport({ status: "accepted" });
  const operations = [
    fs.readFileSync,
    fs.statSync,
    fs.lstatSync,
    fs.readdirSync,
    fs.openSync,
    fs.writeFileSync,
    fs.mkdirSync,
  ];
  for (const operation of operations) vi.mocked(operation).mockClear();
  expect(isReportMarkdownStale(report, `${TITLE}\nDRAFT — not accepted by PI\n`)).toBe(false);
  expect(isReportMarkdownStale(report, undefined)).toBe(true);
  expectHistoryFailure(invalid, undefined);
  for (const operation of operations) expect(operation).not.toHaveBeenCalled();
});
