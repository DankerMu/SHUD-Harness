import { expect, test } from "vitest";
import { createPolicyHarness, REPORT_ID, reportFixture, writeReport } from "./test-harness.ts";

test("audit captures only controlled decision tool and code, never private presentation", async () => {
  const h = await createPolicyHarness();
  try {
    await writeReport(h.cwd, reportFixture({ summary: "private-audit-summary" }));
    await h.decide("shud_run", { apiKey: "sk-private-audit-secret", path: h.cwd });
    await h.decide("report_submit", { report_id: REPORT_ID });
    await h.decide("report_decide", {
      report_id: REPORT_ID,
      disposition: "revision_requested",
      comment: "private-audit-PI-comment",
    });
    expect(h.policyLogs()).toEqual([
      ["deny shud_run role-tool-surface"],
      ["ask report_submit report-approval"],
      ["ask report_decide report-approval"],
    ]);
    const captured = JSON.stringify(h.policyLogs());
    for (const privateText of [
      REPORT_ID,
      h.cwd,
      "private-audit-summary",
      "private-audit-PI-comment",
      "sk-private-audit-secret",
    ]) {
      expect(captured).not.toContain(privateText);
    }
    // Logger capture checks instrumentation only, not operator-visible or session-log audit.
    await h.policyFiber.dispose();
    await h.policyFiber.dispose();
    expect(h.policyLogs()).toEqual([
      ["deny shud_run role-tool-surface"],
      ["ask report_submit report-approval"],
      ["ask report_decide report-approval"],
      ["deny=1 ask=2"],
    ]);
    expect(await h.decide("report_submit", { report_id: REPORT_ID })).toEqual({ kind: "cancel" });
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.policyLogs()).toHaveLength(4);
  } finally {
    await h.dispose();
  }
});

test("decision counts belong to each plugin instance and delegation is not audited", async () => {
  const first = await createPolicyHarness({ preset: "worker" });
  const second = await createPolicyHarness({ preset: "coordinator" });
  try {
    await first.decide("task_create");
    await first.decide("shud_collect");
    await second.decide("report_submit", { report_id: REPORT_ID });
    await second.decide("task_create");
    expect(first.policyLogs()).toEqual([["deny task_create role-tool-surface"]]);
    expect(second.policyLogs()).toEqual([["ask report_submit report-approval"]]);
    await first.policyFiber.dispose();
    await second.policyFiber.dispose();
    expect(first.policyLogs()).toEqual([["deny task_create role-tool-surface"], ["deny=1 ask=0"]]);
    expect(second.policyLogs()).toEqual([["ask report_submit report-approval"], ["deny=0 ask=1"]]);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test("unused plugin disposal reports zero counts exactly once", async () => {
  const h = await createPolicyHarness();
  try {
    await h.policyFiber.dispose();
    await h.policyFiber.dispose();
    expect(h.policyLogs()).toEqual([["deny=0 ask=0"]]);
  } finally {
    await h.dispose();
  }
});
