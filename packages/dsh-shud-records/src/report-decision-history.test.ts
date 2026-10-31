import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EvidenceReportSchema, type EvidenceReport } from "@shud-harness/dsh-shud-core";
import { renderReport, validateReport } from "./index.ts";
import { makeReportDecision } from "./report-render-test-harness.ts";
import { makeRenderingFixture, renderingInputs } from "./report-workspace-test-harness.ts";

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(join(tmpdir(), "report-decision-history-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function persistReport(overrides: Partial<EvidenceReport>) {
  const fixture = makeRenderingFixture();
  fixture.report = EvidenceReportSchema.parse({ ...fixture.report, ...overrides });
  const inputs = renderingInputs(fixture);
  for (const input of inputs) {
    const path = join(cwd, input.path);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, `${JSON.stringify(input.value, null, 2)}\n`);
  }
  const snapshot = () =>
    inputs.map(({ path }) => ({
      path,
      bytes: fs.readFileSync(join(cwd, path)),
      mtime: fs.statSync(join(cwd, path)).mtimeMs,
    }));
  return { reportId: fixture.report.report_id, snapshot };
}

// Independent cells from the six-field presentation contract, not renderer output.
const DECISIONS = [
  {
    outcome: "accepted",
    approvalRef: "call-report-decide-accepted-487",
    comment: null,
    cells: [
      "DEC-20261029T100000-a001",
      "REPORT-20261027T080005-3f9c",
      "accepted",
      "2026-10-29T10:00:00Z",
      "call-report-decide-accepted-487",
      "null",
    ],
  },
  {
    outcome: "rejected",
    approvalRef: "call-report-decide-rejected-487",
    comment: "PI rejects this evidence because the comparison is incomplete.",
    cells: [
      "DEC-20261029T100000-a001",
      "REPORT-20261027T080005-3f9c",
      "rejected",
      "2026-10-29T10:00:00Z",
      "call-report-decide-rejected-487",
      '"PI rejects this evidence because the comparison is incomplete."',
    ],
  },
  {
    outcome: "revision_requested",
    approvalRef: "call-report-decide-revision-487",
    comment: "PI requests a revised comparison before another review.",
    cells: [
      "DEC-20261029T100000-a001",
      "REPORT-20261027T080005-3f9c",
      "revision_requested",
      "2026-10-29T10:00:00Z",
      "call-report-decide-revision-487",
      '"PI requests a revised comparison before another review."',
    ],
  },
] as const;

test.each(DECISIONS)(
  "renderReport projects all six persisted $outcome decision fields only in the appendix",
  ({ outcome, approvalRef, comment, cells }) => {
    const { reportId, snapshot } = persistReport({
      status: outcome,
      decision_history: [makeReportDecision(outcome, { approval_ref: approvalRef, comment })],
    });
    const before = snapshot();

    const markdown = renderReport(cwd, reportId);

    expect(snapshot()).toStrictEqual(before);
    const sections = markdown.split(/^## /m);
    expect(sections).toHaveLength(11);
    const appendix = sections[10] ?? "";
    expect(appendix).toMatch(/^10\. 附录：命令、日志、artifact manifest\n/);
    const observations = sections[6] ?? "";
    expect(observations).toMatch(/^6\. 观测与解释限制\n/);
    expect(observations).toContain("First observation\n{{summary}} stays authored.");
    expect(observations).toContain("Second observation.");
    if (comment !== null) {
      expect(observations).not.toContain(comment);
      expect(sections.slice(0, 10).join("## ")).not.toContain(comment);
    }

    expect(appendix).toContain(approvalRef);
    expect(appendix).toContain(
      [
        "### PI decision history",
        "",
        "| decision_id | report_id | outcome | decided_at | approval_ref | comment |",
        "| --- | --- | --- | --- | --- | --- |",
        `| ${cells.join(" | ")} |`,
      ].join("\n"),
    );
    expect(appendix.indexOf("### PI decision history")).toBeLessThan(
      appendix.indexOf("### Run RUN-20261029T080000-b002"),
    );
  },
);

test("renderReport shows empty history without inventing a decision", () => {
  const { reportId, snapshot } = persistReport({ decision_history: [] });
  const before = snapshot();
  const markdown = renderReport(cwd, reportId);
  expect(markdown).toContain(
    "### PI decision history\n\nNo PI decision recorded.\n\n### Run RUN-20261029T080000-b002",
  );
  expect(markdown).not.toContain("| decision_id |");
  expect(markdown).not.toContain("| null |");
  expect(snapshot()).toStrictEqual(before);
});

test.each([
  {
    outcome: "accepted",
    header: "Accepted by PI · 2026-10-29T10:00:00Z · DEC-20261029T100000-a001 · ARCHIVED",
    footer: "ARCHIVED",
    commentCell: "null",
  },
  {
    outcome: "rejected",
    header: "REJECTED — not accepted by PI · ARCHIVED",
    footer: "REJECTED — not accepted by PI · ARCHIVED",
    commentCell: '"private-decision-comment-440"',
  },
  {
    outcome: "revision_requested",
    header: "REVISION REQUESTED — not accepted by PI · ARCHIVED",
    footer: "REVISION REQUESTED — not accepted by PI · ARCHIVED",
    commentCell: '"private-decision-comment-440"',
  },
] as const)(
  "renderReport retains archived $outcome history and inherited watermarks",
  ({ outcome, header, footer, commentCell }) => {
    const { reportId, snapshot } = persistReport({
      status: "archived",
      decision_history: [makeReportDecision(outcome)],
    });
    const before = snapshot();
    const markdown = renderReport(cwd, reportId);
    const lines = markdown.trimEnd().split("\n");
    expect(lines[1]).toBe(header);
    expect(lines.at(-1)).toBe(footer);
    const appendix = markdown.split("## 10. 附录：命令、日志、artifact manifest\n")[1];
    expect(appendix).toContain(
      `| DEC-20261029T100000-a001 | REPORT-20261027T080005-3f9c | ${outcome} | 2026-10-29T10:00:00Z | private-approval-reference-440 | ${commentCell} |`,
    );
    expect(snapshot()).toStrictEqual(before);
  },
);

test("renderReport distinguishes the comment string null from a null comment", () => {
  const { reportId, snapshot } = persistReport({
    status: "rejected",
    decision_history: [makeReportDecision("rejected", { comment: "null" })],
  });
  const before = snapshot();
  const markdown = renderReport(cwd, reportId);
  expect(markdown).toContain(
    '| DEC-20261029T100000-a001 | REPORT-20261027T080005-3f9c | rejected | 2026-10-29T10:00:00Z | private-approval-reference-440 | "null" |',
  );
  expect(snapshot()).toStrictEqual(before);
});

test("renderReport preserves nonterminal history array order and duplicate entries", () => {
  const later = makeReportDecision("rejected", {
    approval_ref: "call-later-487",
    comment: "Later decision.",
    decided_at: "2026-10-30T10:00:00Z",
  });
  const earlier = makeReportDecision("revision_requested", {
    approval_ref: "call-earlier-487",
    comment: "Earlier decision.",
  });
  // Existing nonterminal render semantics permit multiple entries; terminal guards stay intact.
  const { reportId, snapshot } = persistReport({
    status: "reviewed",
    decision_history: [later, earlier, later],
  });
  const before = snapshot();
  const markdown = renderReport(cwd, reportId);
  const history = markdown.split("### PI decision history\n\n")[1]?.split("\n\n### Run ")[0];
  expect(history?.split("\n").slice(2)).toEqual([
    '| DEC-20261029T100000-a001 | REPORT-20261027T080005-3f9c | rejected | 2026-10-30T10:00:00Z | call-later-487 | "Later decision." |',
    '| DEC-20261029T100000-a001 | REPORT-20261027T080005-3f9c | revision_requested | 2026-10-29T10:00:00Z | call-earlier-487 | "Earlier decision." |',
    '| DEC-20261029T100000-a001 | REPORT-20261027T080005-3f9c | rejected | 2026-10-30T10:00:00Z | call-later-487 | "Later decision." |',
  ]);
  expect(snapshot()).toStrictEqual(before);
});

test.each(["rejected", "revision_requested"] as const)(
  "renderReport escapes %s history once without changing structure or source evidence",
  (outcome) => {
    const { reportId, snapshot } = persistReport({
      status: outcome,
      decision_history: [
        makeReportDecision(outcome, {
          approval_ref: "call&<>|`\\\r\n## injected {{summary}}",
          comment: '  PI&<>|`\\\r\n## injected "{{header}}" {{decision_history}}  ',
        }),
      ],
    });
    const before = snapshot();
    const markdown = renderReport(cwd, reportId);
    expect(renderReport(cwd, reportId)).toBe(markdown);
    expect(snapshot()).toStrictEqual(before);
    const sections = markdown.split(/^## /m);
    expect(sections).toHaveLength(11);
    const history = sections[10]?.split("### PI decision history\n\n")[1]?.split("\n\n### Run ")[0];
    const lines = history?.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines?.[2]?.slice(2, -2).split(" | ")).toEqual([
      "DEC-20261029T100000-a001",
      "REPORT-20261027T080005-3f9c",
      outcome,
      "2026-10-29T10:00:00Z",
      "call&amp;&lt;&gt;&#124;&#96;&#92;&#13;&#10;## injected {{summary}}",
      '"  PI&amp;&lt;&gt;&#124;&#96;&#92;&#92;&#92;r&#92;n## injected &#92;"{{header}}&#92;" {{decision_history}}  "',
    ]);
    expect(history).not.toContain("&amp;#");
    expect(history).not.toContain("<>");
    expect(history).not.toContain("\r");
    expect(sections[6]).not.toContain("PI&amp;");
  },
);

test("validateReport keeps decision comments outside C7 authored-field checks", () => {
  const { reportId, snapshot } = persistReport({
    status: "rejected",
    decision_history: [
      makeReportDecision("rejected", { comment: "PI disputes this phrase: 模型机制已验证" }),
    ],
  });
  const before = snapshot();
  const markdown = renderReport(cwd, reportId);
  expect(markdown.split("### PI decision history\n\n")[1]).toContain(
    '"PI disputes this phrase: 模型机制已验证"',
  );
  expect(markdown.split(/^## /m)[6]).not.toContain("PI disputes this phrase:");
  const result = validateReport(cwd, reportId);
  expect(result.checks.find(({ id }) => id === 7)).toEqual({
    id: 7,
    pass: true,
    vacuous: false,
    details: [],
  });
  expect(result.ok).toBe(true);
  expect(snapshot()).toStrictEqual(before);
});

test("validateReport attributes a secret-shaped decision comment to section 10 without echo", () => {
  const secret = ["sk", "synthetic487comment"].join("-");
  const comment = `PI comment contains a synthetic candidate: ${secret}`;
  const { reportId, snapshot } = persistReport({
    status: "revision_requested",
    decision_history: [makeReportDecision("revision_requested", { comment })],
  });
  const before = snapshot();
  const result = validateReport(cwd, reportId);
  expect(result.checks.filter(({ pass }) => !pass).map(({ id }) => id)).toEqual([13]);
  expect(result.checks.find(({ id }) => id === 13)).toEqual({
    id: 13,
    pass: false,
    vacuous: false,
    details: [{ code: "secret_detected", section: 10 }],
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(comment);
  expect(snapshot()).toStrictEqual(before);
});
