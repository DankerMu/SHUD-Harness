import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { JobRecordIdSchema } from "@shud-harness/dsh-shud-core";
import { renderReport } from "@shud-harness/dsh-shud-records";
import { barrier } from "../../dsh-shud-jobs/src/state-indexes/test-harness.ts";
import { enteredBeforeCompletion } from "../../dsh-shud-jobs/src/list-run-jobs/test-harness.ts";
import { completeMetrics } from "../../dsh-shud-records/src/run-metrics-test-harness.ts";
import {
  OTHER_TASK,
  cardPath,
  cardSnapshot,
  getCard,
  plannedCard,
  putCard,
  treeOrAbsent,
} from "./task-linked/test-harness.ts";
import {
  DRAFT,
  REPORT,
  OTHER_REPORT,
  PRIVATE,
  expectReportError as expectToolError,
  fileSnapshot,
  generated,
  installMetrics,
  putReport,
  readReport,
  reportHarness,
  reportPath,
  resultValue,
  seedEvidence,
  terminalReport,
} from "./report-workflow/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, rename: vi.fn(actual.rename), readFile: vi.fn(actual.readFile) };
});
const nativeFs = await vi.importActual<typeof fs>("node:fs");
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");
beforeEach(() => {
  vi.mocked(fs.renameSync).mockReset().mockImplementation(nativeFs.renameSync);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(nativeFs.readFileSync);
  vi.mocked(io.rename).mockReset().mockImplementation(nativeIo.rename);
  vi.mocked(io.readFile).mockReset().mockImplementation(nativeIo.readFile);
});
function ioFault() {
  return Object.assign(new Error(PRIVATE), { code: "EIO" });
}

for (const stage of ["reconcile", "report", "task_card", "render"] as const) {
  test(`${stage} publication fault preserves exactly the earlier commits and supports next-call repair`, async () => {
    const h = await reportHarness();
    try {
      const { job } = await seedEvidence(h);
      if (stage === "reconcile") putCard(h, plannedCard({ linked_reports: [] }));
      const original = await cardSnapshot(h);
      let publishedReport: string | undefined;
      let failures = 0;
      vi.mocked(fs.renameSync).mockImplementation((source, target) => {
        const isReport = String(target).includes("/reports/") && String(target).endsWith(".json");
        if (
          (stage === "report" && isReport) ||
          ((stage === "task_card" || stage === "reconcile") && target === cardPath(h))
        ) {
          failures++;
          throw ioFault();
        }
        nativeFs.renameSync(source, target);
        if (isReport) publishedReport = String(target);
      });
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (stage === "render" && String(target).endsWith(".md")) {
          failures++;
          throw ioFault();
        }
        await nativeIo.rename(source, target);
      });
      const collect = vi.spyOn(h.registry, "collectShud");
      const result = await h.invoke("report_generate", DRAFT);
      const message = expectToolError(
        result,
        stage === "task_card" || stage === "render"
          ? new RegExp(stage, "u")
          : /write|report|task|reconcile/iu,
      );
      expect(message).not.toContain(PRIVATE);
      expect(failures).toBe(1);
      if (stage === "reconcile") expect(collect).not.toHaveBeenCalled();
      collect.mockRestore();
      vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
      vi.mocked(io.rename).mockImplementation(nativeIo.rename);
      if (stage === "report" || stage === "reconcile") {
        expect(publishedReport).toBeUndefined();
        expect(await cardSnapshot(h)).toEqual(original);
        expect(await treeOrAbsent(join(h.cwd, "reports"))).toSatisfy(
          (value: unknown) => value === null || Object.keys(value as object).length === 1,
        );
      } else {
        expect(publishedReport).toBeDefined();
        const report = JSON.parse(nativeFs.readFileSync(publishedReport!, "utf8")) as {
          report_id: string;
          status: string;
        };
        expect(report.status).toBe("draft");
        expect(message).toContain(report.report_id);
        if (stage === "task_card") expect(await cardSnapshot(h)).toEqual(original);
        else
          expect(getCard(h)).toMatchObject({
            status: "reporting",
            linked_reports: [report.report_id],
          });
        expect(
          resultValue(await h.invoke("report_validate", { report_id: report.report_id })),
        ).toMatchObject({ ok: true, status: "reviewed" });
        expect(getCard(h).linked_reports).toEqual([report.report_id]);
      }
      expect(h.registry.indexes.lookup(job.job_id)).toBeDefined();
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
      vi.mocked(io.rename).mockImplementation(nativeIo.rename);
      await h.dispose();
    }
  });
}

test.each(["json", "markdown"])(
  "validation %s publication failure retains correct authoritative status",
  async (stage) => {
    const h = await reportHarness();
    try {
      const { run } = await seedEvidence(h);
      putReport(h, run);
      putCard(h, { ...getCard(h), status: "reporting", linked_reports: [REPORT] });
      const jsonBefore = await fileSnapshot(reportPath(h));
      const markdownBefore = await fileSnapshot(reportPath(h, REPORT, "md"));
      let failures = 0;
      if (stage === "json")
        vi.mocked(fs.renameSync).mockImplementation((source, target) => {
          if (target === reportPath(h)) {
            failures++;
            throw ioFault();
          }
          nativeFs.renameSync(source, target);
        });
      else
        vi.mocked(io.rename).mockImplementation(async (source, target) => {
          if (target === reportPath(h, REPORT, "md")) {
            failures++;
            throw ioFault();
          }
          await nativeIo.rename(source, target);
        });
      const message = expectToolError(
        await h.invoke("report_validate", { report_id: REPORT }),
        stage === "markdown" ? /render/u : /write|report/iu,
      );
      expect(message).not.toContain(PRIVATE);
      expect(failures).toBe(1);
      expect(await fileSnapshot(reportPath(h, REPORT, "md"))).toEqual(markdownBefore);
      if (stage === "json") expect(await fileSnapshot(reportPath(h))).toEqual(jsonBefore);
      else {
        expect(message).toContain(REPORT);
        expect(readReport(h).status).toBe("reviewed");
      }
      expect(fs.readdirSync(join(h.cwd, "reports")).sort()).toEqual([
        `${REPORT}.json`,
        `${REPORT}.md`,
      ]);
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
      vi.mocked(io.rename).mockImplementation(nativeIo.rename);
      await h.dispose();
    }
  },
);

test("failed card repair never reaches Markdown; terminal repair publishes no intermediate reporting state", async () => {
  const h = await reportHarness();
  try {
    const { run } = await seedEvidence(h);
    terminalReport(h, run, "accepted");
    fs.unlinkSync(reportPath(h, REPORT, "md"));
    // Atomic temp creation/removal may change directory mtime even on a failed rename.
    // Keep entries, inode/mode, all file bytes and all file mtimes in this boundary oracle.
    const snapshot = async () =>
      Object.fromEntries(
        Object.entries((await treeOrAbsent(h.cwd)) ?? {}).map(([path, value]) => [
          path,
          typeof value === "object" &&
          value !== null &&
          "kind" in value &&
          value.kind === "directory"
            ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "mtimeNs"))
            : value,
        ]),
      );
    const before = await snapshot();
    let failures = 0;
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (target === cardPath(h)) {
        failures++;
        throw ioFault();
      }
      nativeFs.renameSync(source, target);
    });
    expectToolError(await h.invoke("report_validate", { report_id: REPORT }), /task_card/u);
    expect(failures).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect(fs.existsSync(reportPath(h, REPORT, "md"))).toBe(false);
    const states: string[] = [];
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      nativeFs.renameSync(source, target);
      if (target === cardPath(h)) states.push(getCard(h).status);
    });
    expectToolError(
      await h.invoke("report_validate", { report_id: REPORT }),
      /draft|status|precondition/iu,
    );
    expect(states).toEqual(["done"]);
    expect(getCard(h).linked_reports).toEqual([REPORT]);
    expect(fs.readFileSync(reportPath(h, REPORT, "md"), "utf8")).toBe(renderReport(h.cwd, REPORT));
  } finally {
    vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
    await h.dispose();
  }
});

test("metric digest failure retains the independently reconciled stale card without publishing a report", async () => {
  const h = await reportHarness();
  try {
    const { job, run } = await seedEvidence(h);
    const metricsPath = installMetrics(job.run_dir, run, completeMetrics());
    nativeFs.appendFileSync(metricsPath, " ");
    const stale = putCard(h, plannedCard({ linked_reports: [] }));
    const before = await cardSnapshot(h);
    const runsBefore = await treeOrAbsent(join(h.cwd, "runs"));
    const commits: { bytes: Buffer; mtime: bigint }[] = [];
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      nativeFs.renameSync(source, target);
      if (target === cardPath(h)) {
        commits.push({
          bytes: nativeFs.readFileSync(cardPath(h)),
          mtime: nativeFs.statSync(cardPath(h), { bigint: true }).mtimeNs,
        });
      }
    });
    const message = expectToolError(await h.invoke("report_generate", DRAFT), /metrics\.json/u);
    expect(message).toContain(`runs/${run.run_id}/metrics.json`);
    expect(commits).toHaveLength(1);
    expect(commits[0].bytes).not.toEqual(before.bytes);
    const updatedAt: unknown = expect.any(String);
    expect(getCard(h)).toEqual({
      ...stale,
      linked_jobs: [job.job_id],
      stack_id: job.stack_id,
      data_id: job.data_id,
      updated_at: updatedAt,
    });
    expect(await cardSnapshot(h)).toEqual(commits[0]);
    expect(await treeOrAbsent(join(h.cwd, "runs"))).toEqual(runsBefore);
    expect(await treeOrAbsent(join(h.cwd, "reports"))).toBeNull();
    commits.length = 0;
    const reconciled = await cardSnapshot(h);
    expectToolError(await h.invoke("report_generate", DRAFT), /metrics\.json/u);
    expect(commits).toEqual([]);
    expect(await cardSnapshot(h)).toEqual(reconciled);
    expect(await treeOrAbsent(join(h.cwd, "reports"))).toBeNull();
  } finally {
    vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
    await h.dispose();
  }
});

test("metric failure during stale Markdown repair preserves the prior report and the earlier card repair commit", async () => {
  const h = await reportHarness();
  try {
    const { job, run } = await seedEvidence(h);
    const metricsPath = installMetrics(job.run_dir, run, completeMetrics());
    const report = generated(h, await h.invoke("report_generate", DRAFT));
    const committedCard = getCard(h);
    const reportBefore = await fileSnapshot(reportPath(h, report.report_id));
    putCard(h, { ...committedCard, status: "running", linked_reports: [] });
    expect(getCard(h).linked_reports).toEqual([]);
    expect(getCard(h).status).toBe("running");
    const markdownPath = reportPath(h, report.report_id, "md");
    nativeFs.writeFileSync(markdownPath, "# stale report\nwrong watermark\noriginal body\n");
    const markdownBefore = await fileSnapshot(markdownPath);
    nativeFs.appendFileSync(metricsPath, " ");
    const runsBefore = await treeOrAbsent(join(h.cwd, "runs"));
    const commits: { bytes: Buffer; mtime: bigint }[] = [];
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      nativeFs.renameSync(source, target);
      if (target === cardPath(h)) {
        commits.push({
          bytes: nativeFs.readFileSync(cardPath(h)),
          mtime: nativeFs.statSync(cardPath(h), { bigint: true }).mtimeNs,
        });
      }
    });
    const message = expectToolError(
      await h.invoke("report_validate", { report_id: report.report_id }),
      /render/u,
    );
    expect(message).toContain(report.report_id);
    expect(commits).toHaveLength(1);
    const updatedAt: unknown = expect.any(String);
    expect(getCard(h)).toEqual({ ...committedCard, updated_at: updatedAt });
    expect(await cardSnapshot(h)).toEqual(commits[0]);
    expect(await fileSnapshot(reportPath(h, report.report_id))).toEqual(reportBefore);
    expect(await fileSnapshot(markdownPath)).toEqual(markdownBefore);
    expect(await treeOrAbsent(join(h.cwd, "runs"))).toEqual(runsBefore);
    commits.length = 0;
    const repaired = await cardSnapshot(h);
    expectToolError(await h.invoke("report_validate", { report_id: report.report_id }), /render/u);
    expect(commits).toEqual([]);
    expect(await cardSnapshot(h)).toEqual(repaired);
    expect(await fileSnapshot(reportPath(h, report.report_id))).toEqual(reportBefore);
    expect(await fileSnapshot(markdownPath)).toEqual(markdownBefore);
  } finally {
    vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
    await h.dispose();
  }
});

test("unreadable Markdown is not absence and exposes no raw cause", async () => {
  const h = await reportHarness();
  try {
    const { run } = await seedEvidence(h);
    putReport(h, run);
    putCard(h, { ...getCard(h), status: "reporting", linked_reports: [REPORT] });
    const before = await treeOrAbsent(h.cwd);
    let failures = 0;
    vi.mocked(fs.readFileSync).mockImplementation((...args) => {
      if (args[0] === reportPath(h, REPORT, "md")) {
        failures++;
        throw ioFault();
      }
      return nativeFs.readFileSync(...args);
    });
    const message = expectToolError(
      await h.invoke("report_validate", { report_id: REPORT }),
      /render/u,
    );
    expect(message).toContain(REPORT);
    expect(message).not.toContain(PRIVATE);
    expect(failures).toBe(1);
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  } finally {
    vi.mocked(fs.readFileSync).mockImplementation(nativeFs.readFileSync);
    await h.dispose();
  }
});

for (const boundary of ["query", "evidence"] as const) {
  test.each(["fields", "job", "state", "identity"])(
    `fresh ${boundary} card boundary observes concurrent %s`,
    async (change) => {
      const h = await reportHarness();
      const entered = barrier();
      const release = barrier();
      let pending: Promise<unknown> | undefined;
      try {
        const { job } = await seedEvidence(h);
        const target = join(job.run_dir, boundary === "query" ? "run-job.json" : "run-record.json");
        let held = false;
        vi.mocked(io.readFile).mockImplementation(async (...args) => {
          if (args[0] === target && !held) {
            held = true;
            entered.release();
            await release.waiting;
          }
          return nativeIo.readFile(...args);
        });
        const operation = h.invoke("report_generate", DRAFT);
        pending = operation;
        await enteredBeforeCompletion(entered.waiting, operation);
        const current = getCard(h);
        if (change === "fields")
          putCard(h, {
            ...current,
            title: "Concurrent PI title",
            current_owner: "pi",
            linked_reports: [OTHER_REPORT],
          });
        else if (change === "job")
          putCard(h, {
            ...current,
            linked_jobs: [
              ...current.linked_jobs,
              JobRecordIdSchema.parse("JOB-20261022T031500-ffff"),
            ],
          });
        else if (change === "state") putCard(h, { ...current, status: "done" });
        else fs.writeFileSync(cardPath(h), JSON.stringify({ ...current, task_id: OTHER_TASK }));
        const afterConcurrent = await cardSnapshot(h);
        release.release();
        const result = await operation;
        if (change === "fields") {
          const report = generated(h, result);
          expect(getCard(h)).toMatchObject({
            title: "Concurrent PI title",
            current_owner: "pi",
            linked_reports: [OTHER_REPORT, report.report_id],
          });
        } else {
          expectToolError(result, /job|task|state|identity|done|closure/iu);
          expect(await cardSnapshot(h)).toEqual(afterConcurrent);
          expect(fs.existsSync(join(h.cwd, "reports"))).toBe(false);
        }
      } finally {
        release.release();
        await pending;
        vi.mocked(io.readFile).mockImplementation(nativeIo.readFile);
        await h.dispose();
      }
    },
  );
}

test.each(["fields", "state", "missing", "corrupt", "identity"])(
  "post-JSON fresh card handles concurrent %s without rollback",
  async (change) => {
    const h = await reportHarness();
    try {
      await seedEvidence(h);
      let durablePath: string | undefined;
      vi.mocked(fs.renameSync).mockImplementation((source, target) => {
        nativeFs.renameSync(source, target);
        if (String(target).includes("/reports/") && String(target).endsWith(".json")) {
          durablePath = String(target);
          const card = getCard(h);
          if (change === "fields")
            putCard(h, {
              ...card,
              title: "Fresh postcommit title",
              linked_reports: [OTHER_REPORT],
            });
          else if (change === "state") putCard(h, { ...card, status: "done" });
          else if (change === "missing") nativeFs.unlinkSync(cardPath(h));
          else
            nativeFs.writeFileSync(
              cardPath(h),
              change === "corrupt"
                ? "PRIVATE_CARD_CORRUPTION"
                : JSON.stringify({ ...card, task_id: OTHER_TASK }),
            );
        }
      });
      const result = await h.invoke("report_generate", DRAFT);
      expect(durablePath).toBeDefined();
      if (change === "fields") {
        const report = generated(h, result);
        expect(getCard(h)).toMatchObject({
          title: "Fresh postcommit title",
          linked_reports: [OTHER_REPORT, report.report_id],
        });
      } else {
        const message = expectToolError(result, /task_card/u);
        const report = JSON.parse(nativeFs.readFileSync(durablePath!, "utf8")) as {
          report_id: string;
          status: string;
        };
        expect(message).toContain(report.report_id);
        expect(report.status).toBe("draft");
        expect(fs.readdirSync(join(h.cwd, "reports"))).toEqual([`${report.report_id}.json`]);
        if (change === "state") expect(getCard(h).status).toBe("done");
        if (change === "identity") expect(getCard(h).task_id).toBe(OTHER_TASK);
        if (change === "missing") expect(fs.existsSync(cardPath(h))).toBe(false);
        if (change === "corrupt")
          expect(fs.readFileSync(cardPath(h), "utf8")).toBe("PRIVATE_CARD_CORRUPTION");
      }
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
      await h.dispose();
    }
  },
);
