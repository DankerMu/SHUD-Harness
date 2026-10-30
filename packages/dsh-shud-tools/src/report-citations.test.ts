import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { installUnsafe } from "../../dsh-shud-records/src/test-harness.ts";
import {
  TASK,
  OTHER_TASK,
  cardPath,
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
} from "./report-workflow/test-harness.ts";

for (const field of ["summary", "observations", "limitations", "pi_questions"] as const) {
  test.each(["TASK", "STACK", "DATA", "RUN", "JOB", "REPORT"])(
    `${field} rejects absent %s citation before reconciliation without mkdir`,
    async (prefix) => {
      const h = await reportHarness();
      try {
        await seedEvidence(h);
        putCard(h, plannedCard({ linked_reports: [] }));
        const token = `${prefix}-20991231T235959-ffff`;
        const before = await treeOrAbsent(h.cwd);
        const collect = vi.spyOn(h.registry, "collectShud");
        const query = vi.spyOn(h.registry, "listRunJobsByTask");
        const message = expectToolError(
          await h.invoke("report_generate", {
            ...DRAFT,
            [field]: field === "summary" ? `Evidence (${token}).` : [`Evidence (${token}).`],
          }),
          new RegExp(token, "u"),
        );
        expect(message).toContain(token);
        expect(collect).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        collect.mockRestore();
        query.mockRestore();
        expect(await treeOrAbsent(h.cwd)).toEqual(before);
      } finally {
        await h.dispose();
      }
    },
  );
}

test.each(["active", "completed"] as const)(
  "all six resolvable citations accept owned %s RUN/JOB entries",
  async (index) => {
    const h = await reportHarness();
    try {
      const { job, run, stack, data } = await seedEvidence(h, "a001", {}, {}, index);
      putReport(h, run);
      const summary = [TASK, stack.stack_id, data.data_id, job.run_id, job.job_id, REPORT].join(
        ", ",
      );
      const report = generated(
        h,
        await h.invoke("report_generate", {
          ...DRAFT,
          summary,
          observations: [`[${summary}]`, summary],
          limitations: [summary],
          pi_questions: [summary],
        }),
      );
      expect(report.summary).toBe(summary);
      expect(report.observations).toEqual([`[${summary}]`, summary]);
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  "DEC-20991231T235959-ffff",
  "xRUN-20991231T235959-ffff",
  "RUN-20991231T235959-ffffx",
  "TASK-0001",
  "RUN-20991231T235959-FFFF",
  "REPORT-20991231T235959-ff",
])("non-citation %s is preserved without inventing references", async (summary) => {
  const h = await reportHarness();
  try {
    await seedEvidence(h);
    expect(generated(h, await h.invoke("report_generate", { ...DRAFT, summary })).summary).toBe(
      summary,
    );
  } finally {
    await h.dispose();
  }
});

for (const kind of ["task", "stack", "data", "report"] as const) {
  test.each(["missing", "corrupt", "schema", "foreign", "symlink", "fifo", "directory"] as const)(
    `${kind} citation with %s file fails without writes`,
    async (fault) => {
      const h = await reportHarness();
      try {
        const { run, stack, data } = await seedEvidence(h);
        putCard(h, { ...getCard(h), task_id: OTHER_TASK });
        putReport(h, run);
        const id =
          kind === "task"
            ? OTHER_TASK
            : kind === "stack"
              ? stack.stack_id
              : kind === "data"
                ? data.data_id
                : REPORT;
        const path =
          kind === "task"
            ? cardPath(h, OTHER_TASK)
            : kind === "stack"
              ? join(h.cwd, "stacks", `${id}.json`)
              : kind === "data"
                ? join(h.cwd, "provenance", `${id}.json`)
                : reportPath(h);
        const value = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
        const outside = join(h.root, "outside.json");
        fs.writeFileSync(outside, JSON.stringify(value));
        fs.unlinkSync(path);
        if (fault === "corrupt") fs.writeFileSync(path, "PRIVATE_CORRUPT_CITATION");
        else if (fault === "schema") fs.writeFileSync(path, JSON.stringify({ [`${kind}_id`]: id }));
        else if (fault === "foreign")
          fs.writeFileSync(
            path,
            JSON.stringify({ ...value, [`${kind}_id`]: `${id.slice(0, -4)}ffff` }),
          );
        else if (fault !== "missing") installUnsafe(path, fault, outside);
        const before = await treeOrAbsent(h.cwd);
        const outsideBefore = fs.readFileSync(outside);
        expectToolError(
          await h.invoke("report_generate", { ...DRAFT, summary: `Cites ${id}.` }),
          new RegExp(id, "u"),
        );
        expect(await treeOrAbsent(h.cwd)).toEqual(before);
        expect(fs.readFileSync(outside)).toEqual(outsideBefore);
      } finally {
        await h.dispose();
      }
    },
  );
}

test.each([
  "corrupt",
  "foreign",
  "symlink",
  "fifo",
  "directory",
  "root-symlink",
  "nested-symlink",
] as const)("unsafe or mismatched generating task %s fails before evidence work", async (fault) => {
  const h = await reportHarness();
  try {
    putCard(h, plannedCard({ linked_reports: [] }));
    const path = cardPath(h);
    const outside = join(h.root, "outside");
    fs.mkdirSync(outside);
    if (fault === "root-symlink" || fault === "nested-symlink") {
      const target = fault === "root-symlink" ? join(h.cwd, "tasks") : dirname(path);
      fs.rmSync(target, { recursive: true });
      fs.symlinkSync(outside, target);
    } else if (fault === "corrupt") fs.writeFileSync(path, "PRIVATE_CARD_PAYLOAD");
    else if (fault === "foreign")
      fs.writeFileSync(path, JSON.stringify({ ...getCard(h), task_id: OTHER_TASK }));
    else {
      fs.unlinkSync(path);
      installUnsafe(path, fault, outside);
    }
    const before = await treeOrAbsent(h.cwd);
    expectToolError(
      await h.invoke("report_generate", DRAFT),
      /task|identity|directory|target|parse|schema/iu,
    );
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
    expect(fs.readdirSync(outside)).toEqual([]);
  } finally {
    await h.dispose();
  }
});
