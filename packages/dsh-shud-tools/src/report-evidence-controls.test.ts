import * as fs from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { JobRecordIdSchema } from "@shud-harness/dsh-shud-core";
import { makeRenderingFixture } from "../../dsh-shud-records/src/report-workspace-test-harness.ts";
import { installUnsafe } from "../../dsh-shud-records/src/test-harness.ts";
import {
  OTHER_TASK,
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
  generated,
  putReport,
  reportHarness,
  reportPath,
  seedEvidence,
  terminalReport,
} from "./report-workflow/test-harness.ts";

test.each(["engineering", "ops"] as const)(
  "unsupported %s task cannot produce a science report",
  async (type) => {
    const h = await reportHarness();
    try {
      await seedEvidence(h);
      putCard(h, { ...getCard(h), type });
      const before = await treeOrAbsent(h.cwd);
      expectToolError(await h.invoke("report_generate", DRAFT), /type|science|unsupported/iu);
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each(["missing-job", "foreign-job", "foreign-record", "mismatched-record", "corrupt-record"])(
  "%s cannot be dropped from closure or replaced by another run",
  async (kind) => {
    const h = await reportHarness();
    try {
      const { job, run } = await seedEvidence(h);
      if (kind === "missing-job")
        putCard(h, {
          ...getCard(h),
          linked_jobs: [job.job_id, JobRecordIdSchema.parse("JOB-20261022T031500-ffff")],
        });
      else if (kind === "foreign-job")
        fs.writeFileSync(
          join(job.run_dir, "run-job.json"),
          JSON.stringify({ ...job, task_id: OTHER_TASK }),
        );
      else
        fs.writeFileSync(
          join(job.run_dir, "run-record.json"),
          kind === "corrupt-record"
            ? "PRIVATE_RUN_RECORD"
            : JSON.stringify({
                ...run,
                ...(kind === "foreign-record"
                  ? { task_id: OTHER_TASK }
                  : { job_id: "JOB-20261022T031500-ffff" }),
              }),
        );
      const before = await treeOrAbsent(h.cwd);
      expectToolError(
        await h.invoke("report_generate", DRAFT),
        /job|record|identity|closure|schema|JSON/iu,
      );
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test("unrelated failed task evidence does not block successful closure", async () => {
  const h = await reportHarness();
  try {
    await seedEvidence(
      h,
      "b002",
      { task_id: OTHER_TASK },
      { status: "failed", exit_class: "cvode", exit_code: 19 },
    );
    const { run } = await seedEvidence(h, "a001");
    expect(generated(h, await h.invoke("report_generate", DRAFT)).linked_runs).toEqual([
      run.run_id,
    ]);
  } finally {
    await h.dispose();
  }
});

test("different locks and provenance are retained in first linked-run occurrence order", async () => {
  const h = await reportHarness();
  try {
    const first = await seedEvidence(h, "a001");
    const fixture = makeRenderingFixture();
    const stack = fixture.stacks[1];
    const data = fixture.data[1];
    const second = await seedEvidence(h, "b002", {
      stack_id: stack.stack_id,
      data_id: data.data_id,
    });
    fs.writeFileSync(join(h.cwd, "stacks", `${stack.stack_id}.json`), JSON.stringify(stack));
    fs.writeFileSync(join(h.cwd, "provenance", `${data.data_id}.json`), JSON.stringify(data));
    const report = generated(h, await h.invoke("report_generate", DRAFT));
    expect(report.linked_runs).toEqual([first.run.run_id, second.run.run_id]);
    expect(report.stack_ids).toEqual([first.stack.stack_id, stack.stack_id]);
    expect(report.data_ids).toEqual([first.data.data_id, data.data_id]);
    expect(report.llm_response_models).toEqual(["fixture-model"]);
  } finally {
    await h.dispose();
  }
});

test.each(["symlink", "file", "fifo"] as const)(
  "unsafe %s reports root fails after retaining independent reconciliation",
  async (kind) => {
    const h = await reportHarness();
    try {
      const { job } = await seedEvidence(h);
      putCard(h, plannedCard({ linked_reports: [] }));
      const outside = join(h.root, "outside-reports");
      fs.mkdirSync(outside);
      fs.writeFileSync(join(outside, "sentinel"), "protected bytes");
      installUnsafe(join(h.cwd, "reports"), kind, outside);
      const outsideBefore = await treeOrAbsent(outside);
      expectToolError(await h.invoke("report_generate", DRAFT), /directory|reports|report/iu);
      expect(getCard(h)).toMatchObject({
        linked_jobs: [job.job_id],
        stack_id: job.stack_id,
        data_id: job.data_id,
        linked_reports: [],
      });
      expect(await treeOrAbsent(outside)).toEqual(outsideBefore);
      const reconciled = await cardSnapshot(h);
      expectToolError(await h.invoke("report_generate", DRAFT), /directory|reports|report/iu);
      expect(await cardSnapshot(h)).toEqual(reconciled);
    } finally {
      await h.dispose();
    }
  },
);

test("missing report validation does not create reports or task directories", async () => {
  const h = await reportHarness();
  try {
    const before = await treeOrAbsent(h.cwd);
    expectToolError(await h.invoke("report_validate", { report_id: REPORT }), /report|missing/iu);
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test.each(["accepted", "rejected"] as const)(
  "unlinked persisted %s report cannot reopen an already terminal card",
  async (status) => {
    const h = await reportHarness();
    try {
      const { run } = await seedEvidence(h);
      terminalReport(h, run, status);
      fs.unlinkSync(reportPath(h, REPORT, "md"));
      putCard(h, {
        ...getCard(h),
        status: status === "accepted" ? "done" : "cancelled",
        linked_reports: [],
      });
      const before = await treeOrAbsent(h.cwd);
      expectToolError(await h.invoke("report_validate", { report_id: REPORT }), /task_card/u);
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test("duplicate last report link remains the owning entry rather than an older occurrence", async () => {
  const h = await reportHarness();
  try {
    const { run } = await seedEvidence(h);
    putReport(h, run, { status: "reviewed" });
    putCard(h, { ...getCard(h), linked_reports: [REPORT, REPORT], status: "planned" });
    expectToolError(
      await h.invoke("report_validate", { report_id: REPORT }),
      /draft|status|precondition/iu,
    );
    expect(getCard(h)).toMatchObject({ status: "reporting", linked_reports: [REPORT, REPORT] });
  } finally {
    await h.dispose();
  }
});
