import * as fs from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { makeReportDecision } from "../../dsh-shud-records/src/report-render-test-harness.ts";
import {
  OTHER_TASK,
  cardPath,
  getCard,
  putCard,
  treeOrAbsent,
} from "./task-linked/test-harness.ts";
import {
  REPORT,
  OTHER_REPORT,
  putReport,
  readReport,
  reportPath,
  resultValue,
  fileSnapshot,
  expectReportError,
} from "./report-workflow/test-harness.ts";
import {
  TERMINAL_TOOLS,
  decisionArgs,
  decisionHarness,
  expectCanonicalMarkdown,
  seedReviewed,
} from "./report-decisions/test-harness.ts";

for (const tool of TERMINAL_TOOLS) {
  const valid = decisionArgs(tool);
  const invalid: Array<{ label: string; args: unknown }> = [
    ...[null, [], "invalid", 7, true].map((args) => ({
      label: `root ${JSON.stringify(args)}`,
      args,
    })),
    {
      label: "missing report id",
      args: tool === "report_submit" ? {} : { disposition: "rejected", comment: "PI" },
    },
    ...["REPORT-0001", "../outside", "", 1, null].map((report_id) => ({
      label: `report id ${JSON.stringify(report_id)}`,
      args: { ...valid, report_id },
    })),
    ...[
      "approval_ref",
      "decision_id",
      "decided_at",
      "rejected_approval_ref",
      "force",
      "workdir",
    ].map((key) => ({
      label: `forbidden ${key}`,
      args: { ...valid, [key]: "PRIVATE_CALLER_PAYLOAD" },
    })),
    ...(tool === "report_submit"
      ? ["comment", "disposition"].map((key) => ({
          label: `forbidden ${key}`,
          args: { ...valid, [key]: "rejected" },
        }))
      : [
          ...["accepted", "cancelled", "REJECTED", "", null, 1, true].map((disposition) => ({
            label: `disposition ${JSON.stringify(disposition)}`,
            args: { ...valid, disposition },
          })),
          ...["", null, 1, [], true].map((comment) => ({
            label: `comment ${JSON.stringify(comment)}`,
            args: { ...valid, comment },
          })),
          { label: "missing disposition", args: { report_id: REPORT, comment: "PI" } },
          { label: "missing comment", args: { report_id: REPORT, disposition: "rejected" } },
        ]),
  ];
  for (const { label, args } of invalid) {
    test(`${tool} rejects ${label} without domain writes`, async () => {
      const h = await decisionHarness();
      try {
        await seedReviewed(h);
        await h.mount();
        const before = await treeOrAbsent(h.root);
        expectReportError(
          await h.call(tool, args),
          /argument|parameter|report|comment|disposition|object|field|invalid|expected|unknown/iu,
        );
        expect(await treeOrAbsent(h.root)).toEqual(before);
      } finally {
        await h.dispose();
      }
    });
  }
  for (const status of [
    "draft",
    "awaiting_pi",
    "accepted",
    "rejected",
    "revision_requested",
    "archived",
  ] as const) {
    test(`${tool} rejects source ${status} without changing canonical history or terminal files`, async () => {
      const h = await decisionHarness();
      try {
        const { run } = await seedReviewed(h);
        const terminal =
          status === "accepted" || status === "rejected" || status === "revision_requested";
        putReport(h, run, {
          status,
          decision_history:
            terminal || status === "archived"
              ? [
                  makeReportDecision(
                    status === "archived" ? "rejected" : terminal ? status : "accepted",
                    { report_id: REPORT },
                  ),
                ]
              : [],
        });
        // Existing canonical projection means a negative does not accidentally rely on repair failures.
        putCard(h, {
          ...getCard(h),
          status:
            status === "accepted"
              ? "done"
              : status === "rejected"
                ? "cancelled"
                : status === "revision_requested"
                  ? "planned"
                  : "reporting",
        });
        await h.mount();
        const before = await treeOrAbsent(h.cwd);
        expectReportError(
          await h.call(tool, valid),
          /reviewed|state|status|task_card|transition/iu,
        );
        expect(await treeOrAbsent(h.cwd)).toEqual(before);
      } finally {
        await h.dispose();
      }
    });
  }
  for (const history of [
    "accepted",
    "rejected",
    "revision_requested",
    "foreign-report",
    "duplicate",
  ] as const) {
    test(`${tool} rejects reviewed inconsistent ${history} history`, async () => {
      const h = await decisionHarness();
      try {
        const { run } = await seedReviewed(h);
        const decision = makeReportDecision(
          history === "rejected" || history === "revision_requested" ? history : "accepted",
          { report_id: history === "foreign-report" ? OTHER_REPORT : REPORT },
        );
        putReport(h, run, {
          status: "reviewed",
          decision_history: history === "duplicate" ? [decision, decision] : [decision],
        });
        await h.mount();
        const before = await treeOrAbsent(h.cwd);
        expectReportError(await h.call(tool, valid), /history|decision|state/iu);
        expect(await treeOrAbsent(h.cwd)).toEqual(before);
      } finally {
        await h.dispose();
      }
    });
  }
  for (const callId of [undefined, null, "", 9, {}]) {
    test(`${tool} rejects invalid execution callId ${JSON.stringify(callId)} before entry repairs`, async () => {
      const h = await decisionHarness();
      try {
        await seedReviewed(h);
        fs.unlinkSync(reportPath(h, REPORT, "md"));
        putCard(h, { ...getCard(h), linked_reports: [] });
        await h.mount();
        const before = await treeOrAbsent(h.cwd);
        // Deliberately bypass the convenience method's default argument, not the real ToolRuntime.
        const result = await h.runtime.execute({
          name: tool,
          arguments: valid,
          agent: h.agent,
          signal: new AbortController().signal,
          callId: callId as never,
        });
        expectReportError(result, /call.?id|approval|execution/iu);
        expect(await treeOrAbsent(h.cwd)).toEqual(before);
      } finally {
        await h.dispose();
      }
    });
  }
  for (const damage of [
    "report-json",
    "report-identity",
    "unknown-status",
    "task-identity",
    "task-missing",
    "cwd-missing",
    "cwd-file",
  ] as const) {
    test(`${tool} rejects ${damage} without unsafe creation or mutation`, async () => {
      const h = await decisionHarness();
      try {
        const { report } = await seedReviewed(h);
        if (damage === "report-json") fs.writeFileSync(reportPath(h), "{ corrupt PRIVATE_PAYLOAD");
        if (damage === "report-identity")
          fs.writeFileSync(reportPath(h), JSON.stringify({ ...report, report_id: OTHER_REPORT }));
        if (damage === "unknown-status")
          fs.writeFileSync(reportPath(h), JSON.stringify({ ...report, status: "pi_reviewed" }));
        if (damage === "task-identity")
          fs.writeFileSync(cardPath(h), JSON.stringify({ ...getCard(h), task_id: OTHER_TASK }));
        if (damage === "task-missing") fs.rmSync(join(h.cwd, "tasks"), { recursive: true });
        if (damage === "cwd-missing") Object.assign(h.agent.session.header, { cwd: undefined });
        if (damage === "cwd-file") Object.assign(h.agent.session.header, { cwd: reportPath(h) });
        await h.mount();
        const before = await treeOrAbsent(h.root);
        const message = expectReportError(
          await h.call(tool, valid),
          /report|task|cwd|workspace|identity|unsafe|path/iu,
        );
        expect(message).not.toContain("PRIVATE_PAYLOAD");
        expect(await treeOrAbsent(h.root)).toEqual(before);
      } finally {
        await h.dispose();
      }
    });
  }
}

test("approved older reviewed report is not restricted to the latest link and does not rerun validation or closure", async () => {
  const h = await decisionHarness();
  try {
    const { run } = await seedReviewed(h);
    putReport(h, run, {
      status: "reviewed",
      observations: ["模型机制已验证"],
      limitations: [],
      pi_questions: [],
    });
    putReport(h, run, { report_id: OTHER_REPORT });
    putCard(h, { ...getCard(h), linked_reports: [REPORT, OTHER_REPORT] });
    // Empty authored arrays would fail closure, and the forbidden prose would fail validation.
    await h.mount();
    const otherBefore = await fileSnapshot(reportPath(h, OTHER_REPORT));
    resultValue(await h.call("report_submit", { report_id: REPORT }));
    expect(readReport(h).status).toBe("accepted");
    expect(getCard(h).status).toBe("done");
    expect(getCard(h).linked_reports).toEqual([REPORT, OTHER_REPORT]);
    expect(await fileSnapshot(reportPath(h, OTHER_REPORT))).toEqual(otherBefore);
    expectCanonicalMarkdown(h);
  } finally {
    await h.dispose();
  }
});

for (const tool of TERMINAL_TOOLS) {
  test(`${tool} independent entry repairs survive a draft precondition rejection`, async () => {
    const h = await decisionHarness();
    try {
      const { run } = await seedReviewed(h);
      putReport(h, run, { status: "draft" }, false);
      fs.unlinkSync(reportPath(h, REPORT, "md"));
      putCard(h, { ...getCard(h), status: "running", linked_reports: [] });
      const before = await fileSnapshot(reportPath(h));
      await h.mount();
      expectReportError(await h.call(tool, decisionArgs(tool)), /reviewed/iu);
      expect(await fileSnapshot(reportPath(h))).toEqual(before);
      expect(getCard(h)).toMatchObject({ status: "reporting", linked_reports: [REPORT] });
      expectCanonicalMarkdown(h);
    } finally {
      await h.dispose();
    }
  });
}
