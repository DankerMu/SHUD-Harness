import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { type TaskCard } from "@shud-harness/dsh-shud-core";
import { renderReport } from "@shud-harness/dsh-shud-records";
import { INVARIANTS } from "../../dsh-shud-records/src/report-validation-test-harness.ts";
import { observedStart } from "../../dsh-shud-jobs/src/detached-shud/test-harness.ts";
import {
  TASK,
  cardSnapshot,
  getCard,
  plannedCard,
  putCard,
  treeOrAbsent,
} from "./task-linked/test-harness.ts";
import {
  DRAFT,
  REPORT,
  expectReportError as expectToolError,
  fileSnapshot,
  generated,
  putReport,
  reportHarness,
  reportPath,
  resultValue,
  seedEvidence,
  terminalReport,
} from "./report-workflow/test-harness.ts";

for (const status of ["planned", "running", "reporting"] as const) {
  test(`generation from ${status} publishes canonical draft, card and Markdown without approvals`, async () => {
    const h = await reportHarness();
    const collect = vi.spyOn(h.registry, "collectShud");
    try {
      const { job, run, stack, data } = await seedEvidence(h);
      const card = putCard(h, { ...getCard(h), status });
      const evidenceBefore = await treeOrAbsent(join(h.cwd, "runs"));
      const report = generated(h, await h.invoke("report_generate", DRAFT));
      expect(collect).toHaveBeenCalledTimes(1);
      expect([job.job_id, job.run_id]).toContain(collect.mock.calls[0][0]);
      expect(collect.mock.calls[0][1]).toEqual({ readonly: true });
      expect(report).toMatchObject({
        task_id: TASK,
        status: "draft",
        summary: DRAFT.summary,
        observations: DRAFT.observations,
        pi_questions: DRAFT.pi_questions,
        limitations: [
          ...DRAFT.limitations,
          "本里程碑无指标 artifact，不能据此作指标或模型改进结论。",
        ],
        linked_runs: [run.run_id],
        stack_ids: [stack.stack_id],
        data_ids: [data.data_id],
        llm_response_models: [run.llm.response_model],
        decision_history: [],
      });
      expect(getCard(h)).toEqual({
        ...card,
        status: "reporting",
        runtime_phase: null,
        linked_reports: [report.report_id],
        updated_at: getCard(h).updated_at,
      });
      expect(getCard(h).linked_jobs).toEqual([job.job_id]);
      const markdown = fs.readFileSync(reportPath(h, report.report_id, "md"), "utf8");
      expect(markdown).toBe(renderReport(h.cwd, report.report_id));
      expect(markdown.split("\n")[1]).toBe("DRAFT — not accepted by PI");
      expect(markdown).toContain("https://first.invalid/?a=1&amp;b=2");
      for (const literal of [
        ...INVARIANTS,
        stack.llm.request_alias,
        stack.llm.response_model,
        run.llm.response_model,
        DRAFT.summary,
      ])
        expect(markdown).toContain(literal);
      expect(await treeOrAbsent(join(h.cwd, "runs"))).toEqual(evidenceBefore);
    } finally {
      collect.mockRestore();
      await h.dispose();
    }
  });
}

test.each([
  "created",
  "awaiting_pi",
  "done",
  "cancelled",
  "parked",
  "blocked",
] as TaskCard["status"][])(
  "generation rejects %s before stale card reconciliation",
  async (status) => {
    const h = await reportHarness();
    try {
      await seedEvidence(h);
      putCard(h, plannedCard({ status, linked_reports: [] }));
      const before = await treeOrAbsent(h.cwd);
      const collect = vi.spyOn(h.registry, "collectShud");
      expectToolError(await h.invoke("report_generate", DRAFT), new RegExp(status, "u"));
      expect(collect).not.toHaveBeenCalled();
      collect.mockRestore();
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each(
  [
    null,
    [],
    "text",
    1,
    {},
    { ...DRAFT, force: true },
    { ...DRAFT, task_id: "../reports/x" },
    { ...DRAFT, task_id: REPORT },
    { ...DRAFT, summary: "" },
    { ...DRAFT, observations: [1] },
    { ...DRAFT, limitations: [""] },
    { ...DRAFT, pi_questions: null },
  ].map((args) => ({ args })),
)("closed generation arguments reject $args without workspace IO", async ({ args }) => {
  const h = await reportHarness();
  try {
    const before = await treeOrAbsent(h.cwd);
    expectToolError(
      await h.invoke("report_generate", args),
      /parameter|argument|task_id|summary|observations|limitations|pi_questions|object|force/iu,
    );
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test.each(["report_generate", "report_validate"] as const)(
  "%s requires session cwd",
  async (name) => {
    const h = await reportHarness();
    try {
      const before = await treeOrAbsent(h.cwd);
      expectToolError(
        await h.invoke(name, name === "report_generate" ? DRAFT : { report_id: REPORT }, false),
        /session|cwd/iu,
      );
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each(["observations", "limitations", "pi_questions"] as const)(
  "empty authored %s cannot be satisfied by automatic text",
  async (field) => {
    const h = await reportHarness();
    try {
      await seedEvidence(h);
      const before = await treeOrAbsent(h.cwd);
      expectToolError(
        await h.invoke("report_generate", { ...DRAFT, [field]: [] }),
        new RegExp(field, "u"),
      );
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test("no job means closure failure and no creating read side effects", async () => {
  const h = await reportHarness();
  try {
    const absent = await treeOrAbsent(h.cwd);
    expectToolError(await h.invoke("report_generate", DRAFT), /task|missing/iu);
    expect(await treeOrAbsent(h.cwd)).toEqual(absent);
    putCard(h, plannedCard({ linked_reports: [] }));
    const before = await treeOrAbsent(h.cwd);
    expectToolError(await h.invoke("report_generate", DRAFT), /job|closure/iu);
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test.each(["created", "submitted", "running", "succeeded", "failed", "cancelled"] as const)(
  "uncollected %s is not implicitly collected and independent reconcile remains",
  async (status) => {
    const h = await reportHarness();
    try {
      const stamp = status === "running" ? observedStart(process.pid) : undefined;
      const { job } = await seedEvidence(h, "a001", {
        status,
        ...(stamp === undefined
          ? {}
          : {
              pid: process.pid,
              pid_started_at: stamp,
              submitted_at: stamp,
              started_at: stamp,
              finished_at: null,
              exit_code: null,
            }),
      });
      putCard(h, plannedCard({ linked_reports: [] }));
      const runBefore = await treeOrAbsent(job.run_dir);
      const collect = vi.spyOn(h.registry, "collectShud");
      const message = expectToolError(
        await h.invoke("report_generate", DRAFT),
        /collect|failed|cancelled/iu,
      );
      expect(message).toContain(job.job_id);
      expect(collect).not.toHaveBeenCalled();
      collect.mockRestore();
      expect(getCard(h)).toMatchObject({
        linked_jobs: [job.job_id],
        stack_id: job.stack_id,
        data_id: job.data_id,
        linked_reports: [],
      });
      expect(await treeOrAbsent(job.run_dir)).toEqual(runBefore);
      expect(fs.existsSync(join(h.cwd, "reports"))).toBe(false);
      const reconciled = await cardSnapshot(h);
      expectToolError(await h.invoke("report_generate", DRAFT), /collect|failed|cancelled/iu);
      expect(await cardSnapshot(h)).toEqual(reconciled);
    } finally {
      await h.dispose();
    }
  },
);

test.each(["cvode", "cancelled", "lost"] as const)(
  "collected failed %s blocks closure",
  async (exit_class) => {
    const h = await reportHarness();
    try {
      const { job } = await seedEvidence(
        h,
        "a001",
        {},
        {
          status: "failed",
          exit_code: exit_class === "cvode" ? 19 : null,
          exit_class,
        },
      );
      const before = await treeOrAbsent(h.cwd);
      expect(
        expectToolError(await h.invoke("report_generate", DRAFT), /failed|closure/iu),
      ).toContain(job.job_id);
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each(["stack_id", "data_id"] as const)(
  "null RunRecord %s cannot borrow card references",
  async (field) => {
    const h = await reportHarness();
    try {
      await seedEvidence(h, "a001", {}, { [field]: null });
      const before = await treeOrAbsent(h.cwd);
      expectToolError(await h.invoke("report_generate", DRAFT), /stack|data|reference/iu);
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each([0, 2, 3, 4, "corrupt"])(
  "cached success still reads retained attempt evidence %s",
  async (attempts) => {
    const h = await reportHarness();
    try {
      const { job } = await seedEvidence(h);
      const path = join(job.run_dir, "collect-error.json");
      await io.writeFile(
        path,
        attempts === "corrupt"
          ? "PRIVATE_BAD_LEDGER"
          : JSON.stringify({
              attempts,
              last_error: "PRIVATE_OLD_ERROR",
              at: "2026-10-22T03:16:00Z",
            }),
      );
      const before = await treeOrAbsent(job.run_dir);
      const result = await h.invoke("report_generate", DRAFT);
      if (typeof attempts === "number" && attempts < 3) generated(h, result);
      else {
        const message = expectToolError(result, /collect|ledger|attempt/iu);
        expect(message).not.toContain("PRIVATE_");
        expect(fs.existsSync(join(h.cwd, "reports"))).toBe(false);
      }
      expect(await treeOrAbsent(job.run_dir)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each(["failed-validation", "revision"])(
  "regeneration after %s preserves prior report bytes and times",
  async (kind) => {
    const h = await reportHarness();
    try {
      const { run } = await seedEvidence(h);
      if (kind === "revision") {
        terminalReport(h, run, "revision_requested");
        putCard(h, { ...getCard(h), status: "planned", linked_reports: [REPORT] });
      } else {
        putReport(h, run, { observations: ["普遍改进"] });
        putCard(h, { ...getCard(h), status: "reporting", linked_reports: [REPORT] });
        expect(resultValue(await h.invoke("report_validate", { report_id: REPORT })).ok).toBe(
          false,
        );
      }
      const before = await Promise.all(
        ["json", "md"].map((ext) => fileSnapshot(reportPath(h, REPORT, ext))),
      );
      const report = generated(h, await h.invoke("report_generate", DRAFT));
      expect(report.report_id).not.toBe(REPORT);
      expect(report.decision_history).toEqual([]);
      expect(getCard(h).linked_reports).toEqual([REPORT, report.report_id]);
      expect(
        await Promise.all(["json", "md"].map((ext) => fileSnapshot(reportPath(h, REPORT, ext)))),
      ).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test("multiple runs retain reconciled job order and first-occurrence fact deduplication", async () => {
  const h = await reportHarness();
  try {
    const a = await seedEvidence(h, "a001");
    const b = await seedEvidence(
      h,
      "b002",
      {},
      { llm: { response_model: "second-model", response_model_source: "response" } },
    );
    const c = await seedEvidence(h, "c003");
    putCard(h, { ...getCard(h), linked_jobs: [c.job.job_id, b.job.job_id, a.job.job_id] });
    const report = generated(h, await h.invoke("report_generate", DRAFT));
    expect(report.linked_runs).toEqual([a.run.run_id, b.run.run_id, c.run.run_id]);
    expect(report.stack_ids).toEqual([a.stack.stack_id]);
    expect(report.data_ids).toEqual([a.data.data_id]);
    expect(report.llm_response_models).toEqual(["fixture-model", "second-model"]);
  } finally {
    await h.dispose();
  }
});

test("report tools expose only their closed authored contracts", async () => {
  const h = await reportHarness();
  try {
    for (const [name, keys] of [
      ["report_generate", ["limitations", "observations", "pi_questions", "summary", "task_id"]],
      ["report_validate", ["report_id"]],
    ] as const) {
      const schema = h.runtime.schemas(h.agent).find((tool) => tool.name === name);
      expect(schema?.parameters).toMatchObject({ type: "object", additionalProperties: false });
      expect(Object.keys(schema?.parameters?.properties ?? {}).sort()).toEqual(keys);
    }
  } finally {
    await h.dispose();
  }
});
