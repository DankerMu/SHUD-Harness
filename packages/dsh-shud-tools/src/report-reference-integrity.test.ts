import * as fs from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { EvidenceReportSchema } from "@shud-harness/dsh-shud-core";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { beforeEach, expect, test, vi } from "vitest";
import { CHECK_SHAPE } from "../../dsh-shud-records/src/report-validation-test-harness.ts";
import { getCard, putCard, treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  DRAFT,
  REPORT,
  expectReportError,
  putReport,
  readReport,
  reportHarness,
  reportPath,
  resultValue,
  seedEvidence,
} from "./report-workflow/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) };
});
const nativeFs = await vi.importActual<typeof fs>("node:fs");
beforeEach(() => {
  vi.mocked(fs.mkdirSync).mockReset().mockImplementation(nativeFs.mkdirSync);
});

async function observeAdmission(ctx: Context) {
  let executions = 0;
  const approvals: Array<Parameters<ApprovalService["request"]>[0]> = [];
  await ctx.plugin((services: Context) => {
    services.provide("approval", {
      request(request: Parameters<ApprovalService["request"]>[0]) {
        approvals.push(request);
        return Promise.resolve("allowed-once" as const);
      },
    });
    services.on("tools/execute", (_execution, next) => {
      executions++;
      return next();
    });
  });
  return {
    approvals,
    get executions() {
      return executions;
    },
  };
}

for (const root of ["stacks", "provenance"] as const) {
  test(`validation of missing protected ${root} returns thirteen checks without creating any directory`, async () => {
    const h = await reportHarness();
    try {
      const evidence = await seedEvidence(h);
      putReport(h, evidence.run);
      putCard(h, {
        ...getCard(h),
        status: "reporting",
        runtime_phase: null,
        linked_reports: [REPORT],
      });
      const protectedRoot = join(h.cwd, root);
      fs.rmSync(protectedRoot, { recursive: true });
      fs.writeFileSync(join(h.root, "foreign-sentinel"), "foreign immutable evidence");
      await h.apply(rawGuard, { rawDirs: [protectedRoot] });
      const admission = await observeAdmission(h.ctx);
      const before = await treeOrAbsent(h.root);
      vi.mocked(fs.mkdirSync).mockClear();

      const result = resultValue(await h.invoke("report_validate", { report_id: REPORT }));
      const unavailable = {
        code: "reference_unavailable",
        kind: root === "stacks" ? "stack" : "data",
        id: root === "stacks" ? evidence.stack.stack_id : evidence.data.data_id,
        stage: "missing",
      };
      const referenceCheck = root === "stacks" ? 1 : 2;
      expect(result).toEqual({
        report_id: REPORT,
        status: "draft",
        ok: false,
        checks: CHECK_SHAPE.map((check) => ({
          ...check,
          pass: check.id !== referenceCheck && ![8, 9, 12, 13].includes(check.id),
          details:
            check.id === referenceCheck
              ? [unavailable]
              : [8, 9, 12, 13].includes(check.id)
                ? [{ code: "render_unavailable", stage: "missing" }]
                : [],
        })),
      });
      expect(readReport(h).status).toBe("draft");
      expect(admission.executions).toBe(1);
      expect(admission.approvals).toEqual([]);
      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(fs.existsSync(protectedRoot)).toBe(false);
      expect(await treeOrAbsent(h.root)).toEqual(before);
    } finally {
      await h.dispose();
    }
  });

  test(`generation with missing protected ${root} retains only its prescribed draft/card commits`, async () => {
    const h = await reportHarness();
    try {
      const { run } = await seedEvidence(h);
      const originalCard = getCard(h);
      const protectedRoot = join(h.cwd, root);
      fs.rmSync(protectedRoot, { recursive: true });
      fs.writeFileSync(join(h.root, "foreign-sentinel"), "foreign immutable evidence");
      await h.apply(rawGuard, { rawDirs: [protectedRoot] });
      const admission = await observeAdmission(h.ctx);
      const preservedPaths = [
        join(h.cwd, "runs"),
        join(h.cwd, root === "stacks" ? "provenance" : "stacks"),
        h.stateDir,
        h.inputDir,
        join(h.root, "foreign-sentinel"),
      ];
      const preserved = await Promise.all(preservedPaths.map(treeOrAbsent));
      vi.mocked(fs.mkdirSync).mockClear();

      const message = expectReportError(await h.invoke("report_generate", DRAFT), /render/u);
      const reportNames = fs.readdirSync(join(h.cwd, "reports"));
      expect(reportNames).toHaveLength(1);
      expect(reportNames[0]).toMatch(/^REPORT-.*\.json$/u);
      const report = EvidenceReportSchema.parse(
        JSON.parse(fs.readFileSync(join(h.cwd, "reports", reportNames[0]), "utf8")),
      );
      expect(message).toContain(report.report_id);
      expect(report).toMatchObject({
        task_id: originalCard.task_id,
        status: "draft",
        linked_runs: [run.run_id],
        decision_history: [],
      });
      expect(getCard(h)).toEqual({
        ...originalCard,
        status: "reporting",
        runtime_phase: null,
        linked_reports: [report.report_id],
        updated_at: getCard(h).updated_at,
      });
      expect(fs.existsSync(reportPath(h, report.report_id, "md"))).toBe(false);
      expect(admission.executions).toBe(1);
      expect(admission.approvals).toEqual([]);
      expect(
        vi
          .mocked(fs.mkdirSync)
          .mock.calls.some(
            ([path]) =>
              String(path) === protectedRoot || String(path).startsWith(`${protectedRoot}/`),
          ),
      ).toBe(false);
      expect(fs.existsSync(protectedRoot)).toBe(false);
      expect(await Promise.all(preservedPaths.map(treeOrAbsent))).toEqual(preserved);
    } finally {
      await h.dispose();
    }
  });

  for (const markdown of ["missing", "stale"] as const) {
    test(`${markdown} Markdown entry repair cannot create protected missing ${root}`, async () => {
      const h = await reportHarness();
      try {
        const { run } = await seedEvidence(h);
        putReport(h, run, {}, false);
        putCard(h, {
          ...getCard(h),
          status: "reporting",
          runtime_phase: null,
          linked_reports: [REPORT],
        });
        if (markdown === "stale")
          fs.writeFileSync(
            reportPath(h, REPORT, "md"),
            "# stale report\nwrong watermark\noriginal body\n",
          );
        const protectedRoot = join(h.cwd, root);
        fs.rmSync(protectedRoot, { recursive: true });
        fs.writeFileSync(join(h.root, "foreign-sentinel"), "foreign immutable evidence");
        await h.apply(rawGuard, { rawDirs: [protectedRoot] });
        const admission = await observeAdmission(h.ctx);
        const before = await treeOrAbsent(h.root);
        vi.mocked(fs.mkdirSync).mockClear();

        const message = expectReportError(
          await h.invoke("report_validate", { report_id: REPORT }),
          /render/u,
        );
        expect(message).toContain(REPORT);
        expect(readReport(h).status).toBe("draft");
        expect(admission.executions).toBe(1);
        expect(admission.approvals).toEqual([]);
        expect(fs.mkdirSync).not.toHaveBeenCalled();
        expect(fs.existsSync(protectedRoot)).toBe(false);
        expect(await treeOrAbsent(h.root)).toEqual(before);
      } finally {
        await h.dispose();
      }
    });
  }
}
