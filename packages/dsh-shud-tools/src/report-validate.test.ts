import * as fs from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  renderReport,
  validateReport,
  type ReportValidationCheck,
} from "@shud-harness/dsh-shud-records";
import { CHECK_SHAPE, SECRET } from "../../dsh-shud-records/src/report-validation-test-harness.ts";
import { installUnsafe } from "../../dsh-shud-records/src/test-harness.ts";
import {
  OTHER_TASK,
  cardPath,
  cardSnapshot,
  getCard,
  putCard,
  treeOrAbsent,
} from "./task-linked/test-harness.ts";
import {
  REPORT,
  OTHER_REPORT,
  expectReportError as expectToolError,
  fileSnapshot,
  putReport,
  readReport,
  reportHarness,
  reportPath,
  resultValue,
  seedEvidence,
  terminalReport,
} from "./report-workflow/test-harness.ts";

test("validation returns the exact thirteen canonical checks and publishes reviewed JSON then canonical Markdown", async () => {
  const h = await reportHarness();
  try {
    const { run } = await seedEvidence(h);
    putReport(h, run);
    putCard(h, {
      ...getCard(h),
      status: "reporting",
      runtime_phase: null,
      linked_reports: [REPORT],
    });
    const card = await cardSnapshot(h);
    const canonical = validateReport(h.cwd, REPORT);
    const result = resultValue(await h.invoke("report_validate", { report_id: REPORT }));
    expect(result).toEqual({
      report_id: REPORT,
      status: "reviewed",
      ok: true,
      checks: canonical.checks,
    });
    expect(
      (result.checks as ReportValidationCheck[]).map(({ id, vacuous, pass }) => ({
        id,
        vacuous,
        pass,
      })),
    ).toEqual(CHECK_SHAPE.map((check) => ({ ...check, pass: true })));
    expect(readReport(h).status).toBe("reviewed");
    expect(readReport(h).decision_history).toEqual([]);
    expect(fs.readFileSync(reportPath(h, REPORT, "md"), "utf8")).toBe(renderReport(h.cwd, REPORT));
    expect(await cardSnapshot(h)).toEqual(card);
  } finally {
    await h.dispose();
  }
});

test.each(["phrase", "secret", "limitations", "pi_questions", "stack", "data", "run"])(
  "%s validation failure returns all checks, leaves JSON and correct-header body untouched",
  async (failure) => {
    const h = await reportHarness();
    try {
      const { run, stack, data } = await seedEvidence(h);
      const changes =
        failure === "phrase"
          ? { limitations: ["校准证明结构正确"] }
          : failure === "secret"
            ? { observations: [`private ${SECRET}`] }
            : failure === "limitations"
              ? { limitations: [] }
              : failure === "pi_questions"
                ? { pi_questions: [] }
                : {};
      putReport(h, run, changes);
      putCard(h, { ...getCard(h), status: "reporting", linked_reports: [REPORT] });
      fs.writeFileSync(
        reportPath(h, REPORT, "md"),
        "# EvidenceReport\nDRAFT — not accepted by PI\nmanual body must survive\n",
      );
      if (failure === "stack") fs.unlinkSync(join(h.cwd, "stacks", `${stack.stack_id}.json`));
      if (failure === "data") fs.unlinkSync(join(h.cwd, "provenance", `${data.data_id}.json`));
      if (failure === "run") fs.unlinkSync(join(h.cwd, "runs", run.run_id, "run-record.json"));
      const before = await treeOrAbsent(h.cwd);
      const canonical = validateReport(h.cwd, REPORT);
      const result = resultValue(await h.invoke("report_validate", { report_id: REPORT }));
      expect(result).toEqual({
        report_id: REPORT,
        status: "draft",
        ok: false,
        checks: canonical.checks,
      });
      const failedId = {
        phrase: 7,
        secret: 13,
        limitations: 5,
        pi_questions: 6,
        stack: 1,
        data: 2,
        run: 3,
      }[failure];
      expect(result.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: failedId, pass: false })]),
      );
      expect(
        (result.checks as ReportValidationCheck[]).map(({ id, vacuous }) => ({ id, vacuous })),
      ).toEqual(CHECK_SHAPE);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

for (const stale of ["missing", "wrong-header"] as const) {
  test.each(["reviewed", "failed-check"])(
    `${stale} Markdown repair survives later %s rejection`,
    async (kind) => {
      const h = await reportHarness();
      try {
        const { run } = await seedEvidence(h);
        putReport(
          h,
          run,
          kind === "reviewed" ? { status: "reviewed" } : { summary: "普遍改进" },
          false,
        );
        if (stale === "wrong-header")
          fs.writeFileSync(reportPath(h, REPORT, "md"), "# old\nACCEPTED\nold body\n");
        const json = await fileSnapshot(reportPath(h));
        const result = await h.invoke("report_validate", { report_id: REPORT });
        if (kind === "reviewed") expectToolError(result, /draft|reviewed/iu);
        else expect(resultValue(result).ok).toBe(false);
        expect(await fileSnapshot(reportPath(h))).toEqual(json);
        expect(getCard(h)).toMatchObject({
          status: "reporting",
          runtime_phase: null,
          linked_reports: [REPORT],
        });
        expect(fs.readFileSync(reportPath(h, REPORT, "md"), "utf8")).toBe(
          renderReport(h.cwd, REPORT),
        );
      } finally {
        await h.dispose();
      }
    },
  );
}

for (const position of ["unlinked", "last", "older"] as const) {
  test.each([
    ["draft", "reporting"],
    ["reviewed", "reporting"],
    ["accepted", "done"],
    ["revision_requested", "planned"],
    ["rejected", "cancelled"],
  ] as const)(`${position} %s repairs only the owning report to %s`, async (status, projected) => {
    const h = await reportHarness();
    try {
      const { run } = await seedEvidence(h);
      if (status === "accepted" || status === "rejected" || status === "revision_requested")
        terminalReport(h, run, status);
      else putReport(h, run, { status, summary: "普遍改进" });
      const links =
        position === "unlinked"
          ? [OTHER_REPORT]
          : position === "last"
            ? [OTHER_REPORT, REPORT]
            : [REPORT, OTHER_REPORT];
      putCard(h, {
        ...getCard(h),
        status: position === "unlinked" ? "planned" : "reporting",
        linked_reports: links,
      });
      const original = await cardSnapshot(h);
      const reportBefore = await fileSnapshot(reportPath(h));
      const result = await h.invoke("report_validate", { report_id: REPORT });
      if (status === "draft") expect(resultValue(result).ok).toBe(false);
      else expectToolError(result, /draft|status|precondition/iu);
      expect(await fileSnapshot(reportPath(h))).toEqual(reportBefore);
      if (position === "older") expect(await cardSnapshot(h)).toEqual(original);
      else
        expect(getCard(h)).toMatchObject({
          status: projected,
          linked_reports: position === "unlinked" ? [...links, REPORT] : links,
        });
    } finally {
      await h.dispose();
    }
  });
}

test.each(["done", "cancelled"] as const)(
  "unlinked draft cannot reopen %s or repair Markdown",
  async (status) => {
    const h = await reportHarness();
    try {
      const { run } = await seedEvidence(h);
      putReport(h, run, {}, false);
      putCard(h, { ...getCard(h), status, linked_reports: [] });
      const before = await treeOrAbsent(h.cwd);
      const message = expectToolError(
        await h.invoke("report_validate", { report_id: REPORT }),
        /task_card/u,
      );
      expect(message).toContain(REPORT);
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each(["awaiting_pi", "archived"] as const)(
  "unsupported %s projection rejects before all writes",
  async (status) => {
    const h = await reportHarness();
    try {
      const { run } = await seedEvidence(h);
      putReport(h, run, { status }, false);
      const before = await treeOrAbsent(h.cwd);
      expectToolError(
        await h.invoke("report_validate", { report_id: REPORT }),
        /status|task_card|unsupported/iu,
      );
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each(["corrupt", "foreign", "cross-task", "symlink", "fifo", "directory"] as const)(
  "%s report identity fails closed",
  async (kind) => {
    const h = await reportHarness();
    try {
      const { run } = await seedEvidence(h);
      putReport(h, run);
      const path = kind === "cross-task" ? cardPath(h) : reportPath(h);
      if (kind === "corrupt") fs.writeFileSync(path, "PRIVATE_REPORT_PAYLOAD");
      else if (kind === "foreign")
        fs.writeFileSync(path, JSON.stringify({ ...readReport(h), report_id: OTHER_REPORT }));
      else if (kind === "cross-task")
        fs.writeFileSync(path, JSON.stringify({ ...getCard(h), task_id: OTHER_TASK }));
      else {
        fs.unlinkSync(path);
        installUnsafe(path, kind, reportPath(h, REPORT, "md"));
      }
      const before = await treeOrAbsent(h.cwd);
      expectToolError(
        await h.invoke("report_validate", { report_id: REPORT }),
        /report|identity|task_card|target/iu,
      );
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each(["symlink", "dangling-link", "fifo", "directory"] as const)(
  "unsafe %s Markdown is not treated as absent",
  async (kind) => {
    const h = await reportHarness();
    try {
      const { run } = await seedEvidence(h);
      putReport(h, run, {}, false);
      putCard(h, { ...getCard(h), status: "reporting", linked_reports: [REPORT] });
      installUnsafe(reportPath(h, REPORT, "md"), kind, reportPath(h));
      const before = await treeOrAbsent(h.cwd);
      const message = expectToolError(
        await h.invoke("report_validate", { report_id: REPORT }),
        /render/u,
      );
      expect(message).toContain(REPORT);
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each(
  [null, [], 3, {}, { report_id: "../escape" }, { report_id: REPORT, force: true }].map((args) => ({
    args,
  })),
)("closed validation rejects $args without reads or repair", async ({ args }) => {
  const h = await reportHarness();
  try {
    const before = await treeOrAbsent(h.cwd);
    expectToolError(
      await h.invoke("report_validate", args),
      /argument|parameter|object|report_id|force/iu,
    );
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  } finally {
    await h.dispose();
  }
});
