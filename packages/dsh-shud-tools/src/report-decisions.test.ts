import * as fs from "node:fs";
import { expect, test } from "vitest";
import { EvidenceReportSchema, PiGateDecisionSchema } from "@shud-harness/dsh-shud-core";
import { REPORT_APPROVAL_REASON_PREFIX } from "../../dsh-shud-policy-gate/src/index.ts";
import { getCard, putCard, treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  DRAFT,
  REPORT,
  generated,
  readReport,
  reportPath,
  resultValue,
  expectReportError,
} from "./report-workflow/test-harness.ts";
import {
  COMMENT,
  TERMINAL_TOOLS,
  decisionArgs,
  decisionHarness,
  expectCanonicalMarkdown,
  expectSingleDecision,
  seedReviewed,
} from "./report-decisions/test-harness.ts";

const outcomes = [
  { tool: "report_submit", status: "accepted", task: "done", comment: null },
  { tool: "report_decide", status: "rejected", task: "cancelled", comment: COMMENT },
  { tool: "report_decide", status: "revision_requested", task: "planned", comment: COMMENT },
] as const;
for (const row of outcomes) {
  test(`allowed-once ${row.status} publishes one canonical decision, exact callId and task ${row.task}`, async () => {
    const h = await decisionHarness();
    try {
      const { report, card } = await seedReviewed(h);
      await h.mount();
      const callId = `original-call:${row.status}:447`;
      const args =
        row.tool === "report_submit"
          ? { report_id: REPORT }
          : { report_id: REPORT, disposition: row.status, comment: row.comment };
      const before = Date.now();
      const value = resultValue(await h.call(row.tool, args, callId));
      const after = Date.now();
      const decision = expectSingleDecision(h, row.status, callId, row.comment);
      expect(PiGateDecisionSchema.parse(decision)).toEqual(decision);
      expect(decision.decision_id).toMatch(/^DEC-\d{8}T\d{6}-[a-f0-9]{4}$/u);
      expect(Date.parse(decision.decided_at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(decision.decided_at)).toBeLessThanOrEqual(after);
      expect(value).toEqual({
        report_id: REPORT,
        status: row.status,
        decision_id: decision.decision_id,
      });
      const current = getCard(h);
      expect(current).toEqual({
        ...card,
        status: row.task,
        runtime_phase: null,
        updated_at: current.updated_at,
      });
      const published = readReport(h);
      expect(published).toEqual({
        ...report,
        status: row.status,
        decision_history: [decision],
        updated_at: published.updated_at,
      });
      expect(Date.parse(published.updated_at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(published.updated_at)).toBeLessThanOrEqual(after);
      expect(Date.parse(current.updated_at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(current.updated_at)).toBeLessThanOrEqual(after);
      expect(h.executions).toEqual([{ name: row.tool, callId }]);
      expect(h.request).toHaveBeenCalledTimes(1);
      const [request] = h.request.mock.calls[0];
      expect(request.callId).toBe(callId);
      expect(request.reason).toBe(`${REPORT_APPROVAL_REASON_PREFIX} ${REPORT}`);
      for (const language of ["en", "zh"] as const) {
        expect(request.displayReason?.[language]).toContain(REPORT);
        expect(request.displayReason?.[language]).toContain(`reports/${REPORT}.md`);
        if (row.comment !== null) {
          expect(request.displayReason?.[language]).toContain(row.comment);
          expect(request.displayReason?.[language]).toContain(row.status);
        }
      }
      expectCanonicalMarkdown(h);
      const markdown = fs.readFileSync(reportPath(h, REPORT, "md"), "utf8");
      expect(markdown).toContain(
        row.status === "accepted"
          ? `Accepted by PI · ${decision.decided_at} · ${decision.decision_id}`
          : row.status === "rejected"
            ? "REJECTED — not accepted by PI"
            : "REVISION REQUESTED — not accepted by PI",
      );
      expect(JSON.stringify(h.logs)).not.toContain(COMMENT);
      expect(
        JSON.stringify(h.logs.filter((entry) => entry.name === "shud-policy-gate")),
      ).not.toContain(REPORT);
    } finally {
      await h.dispose();
    }
  });
}

for (const tool of TERMINAL_TOOLS) {
  for (const approval of ["rejected", "cancelled", "unavailable", "absent", "throw"] as const) {
    test(`${tool} ${approval} never executes or repairs any domain file`, async () => {
      const h = await decisionHarness({ approval });
      try {
        await seedReviewed(h);
        // A denied operation must not opportunistically repair either target.
        putCard(h, { ...getCard(h), status: "running", linked_reports: [] });
        fs.unlinkSync(reportPath(h, REPORT, "md"));
        await h.mount();
        const before = await treeOrAbsent(h.root);
        expect(h.runtime.schemas(h.agent).map((schema) => schema.name)).toContain(tool);
        expectReportError(
          await h.call(tool, decisionArgs(tool)),
          /approval|rejected|cancelled|channel/iu,
        );
        expect(h.executions).toEqual([]);
        expect(h.request).toHaveBeenCalledTimes(approval === "absent" ? 0 : 1);
        expect(await treeOrAbsent(h.root)).toEqual(before);
      } finally {
        await h.dispose();
      }
    });
  }
  for (const denied of ["missing-agent", "worker"] as const) {
    test(`${tool} ${denied} is refused before approval and execution`, async () => {
      const h = await decisionHarness({ preset: denied === "worker" ? "worker" : "coordinator" });
      try {
        await seedReviewed(h);
        Object.assign(h.agent.session.header, { agentPreset: "coordinator" });
        // Isolate host no-agent fail-closed; raw cannot resolve a workspace without an agent.
        await h.mount(undefined, denied !== "missing-agent");
        const before = await treeOrAbsent(h.root);
        expectReportError(
          await h.call(tool, decisionArgs(tool), "denied-caller", denied !== "missing-agent"),
          /no agent|worker/iu,
        );
        expect(h.request).not.toHaveBeenCalled();
        expect(h.executions).toEqual([]);
        expect(await treeOrAbsent(h.root)).toEqual(before);
      } finally {
        await h.dispose();
      }
    });
  }
}

test("rejected submit then confirmed full comment records only the second call identity", async () => {
  const h = await decisionHarness();
  try {
    await seedReviewed(h);
    await h.mount();
    h.request.mockResolvedValueOnce("rejected");
    const before = await treeOrAbsent(h.cwd);
    expectReportError(
      await h.call("report_submit", { report_id: REPORT }, "denied-submit-call"),
      /rejected/iu,
    );
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
    resultValue(
      await h.call("report_decide", decisionArgs("report_decide"), "confirmed-decide-call"),
    );
    const decision = expectSingleDecision(
      h,
      "revision_requested",
      "confirmed-decide-call",
      COMMENT,
    );
    expect(Object.keys(decision).sort()).toEqual([
      "approval_ref",
      "comment",
      "decided_at",
      "decision_id",
      "outcome",
      "report_id",
    ]);
    expect(JSON.stringify(readReport(h))).not.toContain("denied-submit-call");
    expect(h.request.mock.calls.map(([request]) => request.callId)).toEqual([
      "denied-submit-call",
      "confirmed-decide-call",
    ]);
    expect(h.request.mock.calls[1][0].displayReason?.en).toContain(COMMENT);
    expect(h.request.mock.calls[1][0].displayReason?.zh).toContain(COMMENT);
    // These are approval service inputs, not fabricated persisted session-log events.
  } finally {
    await h.dispose();
  }
});

test("unconfirmed relayed comment stays reviewed and can be confirmed by a later distinct call", async () => {
  const h = await decisionHarness();
  try {
    await seedReviewed(h);
    await h.mount();
    h.request.mockResolvedValueOnce("rejected");
    const before = await treeOrAbsent(h.cwd);
    expectReportError(
      await h.call("report_decide", decisionArgs("report_decide"), "unconfirmed-comment"),
      /rejected/iu,
    );
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
    resultValue(
      await h.call(
        "report_decide",
        { ...decisionArgs("report_decide"), comment: " \n " },
        "confirmed-whitespace",
      ),
    );
    expectSingleDecision(h, "revision_requested", "confirmed-whitespace", " \n ");
  } finally {
    await h.dispose();
  }
});

test("registered generation validation and approved submission complete the real runtime lifecycle", async () => {
  const h = await decisionHarness();
  try {
    await seedReviewed(h);
    putCard(h, { ...getCard(h), linked_reports: [] });
    await h.mount();
    expect(h.runtime.schemas(h.agent).map((schema) => schema.name)).toEqual(
      expect.arrayContaining([
        "shud_run",
        "shud_collect",
        "task_create",
        "report_generate",
        "report_validate",
        "report_submit",
        "report_decide",
      ]),
    );
    const report = generated(h, await h.call("report_generate", DRAFT));
    expect(
      resultValue(await h.call("report_validate", { report_id: report.report_id })),
    ).toMatchObject({ status: "reviewed", ok: true });
    resultValue(
      await h.call("report_submit", { report_id: report.report_id }, "lifecycle-approved"),
    );
    expectSingleDecision(h, "accepted", "lifecycle-approved", null, report.report_id);
    expectCanonicalMarkdown(h, report.report_id);
    expect(EvidenceReportSchema.parse(readReport(h, report.report_id)).status).toBe("accepted");
  } finally {
    await h.dispose();
  }
});

for (const tool of TERMINAL_TOOLS) {
  test(`${tool} unknown current role asks instead of inheriting a worker creation header`, async () => {
    const h = await decisionHarness({ preset: "reviewer" });
    try {
      await seedReviewed(h);
      Object.assign(h.agent.session.header, { agentPreset: "worker" });
      await h.mount();
      resultValue(await h.call(tool, decisionArgs(tool)));
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.executions).toHaveLength(1);
    } finally {
      await h.dispose();
    }
  });
}
