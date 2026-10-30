import { expect, test } from "vitest";
import { REPORT_APPROVAL_REASON_PREFIX } from "./index.ts";
import {
  createPolicyHarness,
  REPORT_ID,
  snapshotFile,
  SUMMARY_FIRST_LINE,
  writeReport,
  writeReportingTask,
} from "./test-harness.ts";

for (const tool of ["report_submit", "report_decide"]) {
  test.each([
    { outcome: "absent", requests: 0, message: /approval|PI/iu },
    { outcome: "rejected", requests: 1, message: /rejected/iu },
    { outcome: "cancelled", requests: 1, message: /cancelled/iu },
    { outcome: "unavailable", requests: 1, message: /no approval channel/iu },
    { outcome: "throw", requests: 1, message: /approval channel failed/iu },
  ] as const)(
    `${tool} fails closed on $outcome through actual ToolRuntime`,
    async ({ outcome, requests, message }) => {
      const h = await createPolicyHarness({ approval: outcome });
      try {
        const report = await writeReport(h.cwd);
        const card = await writeReportingTask(h.cwd);
        const beforeReport = await snapshotFile(report);
        const beforeCard = await snapshotFile(card);
        expect(h.tools.schemas(h.agent).map((schema) => schema.name)).toContain(tool);
        const result = await h.call(tool, {
          report_id: REPORT_ID,
          disposition: "revision_requested",
          comment: "PI original words",
        });
        expect(result.isError).toBe(true);
        if (!result.isError) throw new Error("Unapproved report tool executed");
        expect(result.error.message).toMatch(message);
        expect(result.error.message).not.toContain("UNKNOWN_TOOL");
        expect(h.request).toHaveBeenCalledTimes(requests);
        expect(h.executions).toEqual([]);
        expect(h.policyLogs()).toEqual([[`ask ${tool} report-approval`]]);
        expect(await snapshotFile(report)).toEqual(beforeReport);
        expect(await snapshotFile(card)).toEqual(beforeCard);
      } finally {
        await h.dispose();
      }
    },
  );

  test(`${tool} without an agent cannot ask or execute even with approval service`, async () => {
    const h = await createPolicyHarness();
    try {
      const result = await h.call(tool, { report_id: REPORT_ID }, null);
      expect(result.isError).toBe(true);
      if (!result.isError) throw new Error("Agent-less report tool executed");
      expect(result.error.message).toContain("no agent");
      expect(h.request).not.toHaveBeenCalled();
      expect(h.executions).toEqual([]);
      expect(h.policyLogs()).toEqual([[`ask ${tool} report-approval`]]);
    } finally {
      await h.dispose();
    }
  });

  test(`${tool} allowed-once dispatches exactly once and forwards approval fields`, async () => {
    const h = await createPolicyHarness({ approval: "allowed-once" });
    try {
      const report = await writeReport(h.cwd);
      const card = await writeReportingTask(h.cwd);
      const beforeReport = await snapshotFile(report);
      const beforeCard = await snapshotFile(card);
      const signal = new AbortController().signal;
      const input = {
        report_id: REPORT_ID,
        disposition: "revision_requested",
        comment: "PI line one\nPI line two",
      };
      const result = await h.call(tool, input, h.agent, signal);
      expect(result).toMatchObject({ isError: false, value: "executed" });
      expect(h.executions).toEqual([{ name: tool, arguments: input }]);
      expect(h.request).toHaveBeenCalledTimes(1);
      const [request] = h.request.mock.calls[0];
      expect(request.agent).toBe(h.agent);
      expect(request.toolName).toBe(tool);
      expect(request.callId).toBe("policy-call-1");
      expect(request.signal).toBe(signal);
      expect(request.reason).toBe(`${REPORT_APPROVAL_REASON_PREFIX} ${REPORT_ID}`);
      expect(request.displayReason?.en).toContain(SUMMARY_FIRST_LINE);
      expect(request.displayReason?.zh).toContain(SUMMARY_FIRST_LINE);
      if (tool === "report_decide") {
        expect(request.displayReason?.en).toContain(input.comment);
        expect(request.displayReason?.zh).toContain(input.comment);
      }
      // Boundary tools count execution only: no report transition or session-log claim here.
      expect(await snapshotFile(report)).toEqual(beforeReport);
      expect(await snapshotFile(card)).toEqual(beforeCard);
    } finally {
      await h.dispose();
    }
  });
}

test("current worker identity denies a registered report before the host approval service", async () => {
  const h = await createPolicyHarness({ preset: "worker", approval: "allowed-once" });
  try {
    const result = await h.call("report_submit", { report_id: REPORT_ID });
    expect(result).toMatchObject({
      isError: true,
      error: { message: "Role worker cannot call tool report_submit." },
    });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.executions).toEqual([]);
    expect(h.policyLogs()).toEqual([["deny report_submit role-tool-surface"]]);
  } finally {
    await h.dispose();
  }
});

test("unknown current role still reaches host approval rather than inheriting worker denial", async () => {
  const h = await createPolicyHarness({ preset: "reviewer", approval: "allowed-once" });
  try {
    h.session.header.agentPreset = "worker";
    expect(await h.call("report_submit", { report_id: REPORT_ID })).toMatchObject({
      isError: false,
    });
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.executions).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});

test("raw guard first short-circuits policy while ordinary calls reach policy", async () => {
  const h = await createPolicyHarness({ rawDirs: ["protected"], approval: "rejected" });
  try {
    const denied = await h.call("write", {
      file_path: "protected/new.csv",
      content: "private-data",
    });
    expect(denied.isError).toBe(true);
    if (!denied.isError) throw new Error("Raw write unexpectedly executed");
    expect(denied.error.message).toContain("immutable");
    expect(h.policyLogs()).toEqual([]);
    expect(h.stateOf).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.logs).toEqual([{ name: "shud-raw-guard", args: ["deny write raw-immutable"] }]);

    const rawRead = await h.call("bash", { command: "cat protected/private.csv" });
    expect(rawRead.isError).toBe(true);
    if (!rawRead.isError) throw new Error("Rejected raw read unexpectedly executed");
    expect(rawRead.error.message).toContain("rejected");
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.policyLogs()).toEqual([]);
    expect(h.stateOf).not.toHaveBeenCalled();
    expect(h.logs[1]).toEqual({ name: "shud-raw-guard", args: ["ask bash raw-read-provenance"] });

    const report = await h.call("report_submit", { report_id: REPORT_ID });
    expect(report.isError).toBe(true);
    if (!report.isError) throw new Error("Rejected report unexpectedly executed");
    expect(report.error.message).toContain("rejected");
    expect(h.policyLogs()).toEqual([["ask report_submit report-approval"]]);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.stateOf).toHaveBeenCalledTimes(1);

    const nonrawOffRole = await h.call("shud_run", { input_dir: "ordinary-input" });
    expect(nonrawOffRole).toMatchObject({
      isError: true,
      error: { message: "Role coordinator cannot call tool shud_run." },
    });
    expect(h.policyLogs()).toEqual([
      ["ask report_submit report-approval"],
      ["deny shud_run role-tool-surface"],
    ]);
    expect(h.executions).toEqual([]);
  } finally {
    await h.dispose();
  }
});
