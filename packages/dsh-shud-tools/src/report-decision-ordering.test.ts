import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { ReportIdSchema } from "@shud-harness/dsh-shud-core";
import { barrier } from "../../dsh-shud-jobs/src/state-indexes/test-harness.ts";
import {
  enteredBeforeCompletion,
  settlesWhileHeld,
} from "../../dsh-shud-jobs/src/list-run-jobs/test-harness.ts";
import { makeReportDecision } from "../../dsh-shud-records/src/report-render-test-harness.ts";
import { OTHER_TASK, getCard, putCard } from "./task-linked/test-harness.ts";
import {
  DRAFT,
  REPORT,
  OTHER_REPORT,
  fileSnapshot,
  putReport,
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
  ioFault,
  seedReviewed,
} from "./report-decisions/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.rename).mockReset().mockImplementation(nativeIo.rename);
});

for (const markdown of ["missing", "stale", "current"] as const) {
  for (const alias of [false, true]) {
    test(`competing approved decisions serialize ${markdown} Markdown; physical cwd alias=${alias}`, async () => {
      const h = await decisionHarness();
      const entered = barrier();
      const release = barrier();
      const pending: Promise<unknown>[] = [];
      try {
        const { run } = await seedReviewed(h);
        // Independent task/report: it must finish while the first publication is held.
        putReport(h, run, { report_id: OTHER_REPORT, task_id: OTHER_TASK, status: "reviewed" });
        putCard(h, { ...getCard(h), task_id: OTHER_TASK, linked_reports: [OTHER_REPORT] });
        if (markdown === "missing") fs.unlinkSync(reportPath(h, REPORT, "md"));
        if (markdown === "stale")
          fs.writeFileSync(
            reportPath(h, REPORT, "md"),
            "# EvidenceReport\nREJECTED — not accepted by PI\n",
          );
        await h.mount();
        const physicalMarkdown = join(fs.realpathSync(join(h.cwd, "reports")), `${REPORT}.md`);
        let held = false;
        vi.mocked(io.rename).mockImplementation(async (source, target) => {
          // Canonicalize only the parent: the target can legitimately be absent.
          const physical = join(
            fs.realpathSync(join(String(target), "..")),
            String(target).split("/").at(-1)!,
          );
          if (physical === physicalMarkdown && !held) {
            held = true;
            entered.release();
            await release.waiting;
          }
          await nativeIo.rename(source, target);
        });
        const first = h.call("report_submit", { report_id: REPORT }, "winning-submit");
        pending.push(first);
        await enteredBeforeCompletion(entered.waiting, first);
        if (alias) {
          const aliasPath = join(h.root, "physical-cwd-alias");
          fs.symlinkSync(h.cwd, aliasPath);
          Object.assign(h.agent.session.header, { cwd: aliasPath });
        }
        const second = h.call(
          "report_decide",
          { report_id: REPORT, disposition: "rejected", comment: COMMENT },
          "losing-decide",
        );
        pending.push(second);
        const independent = h.call(
          "report_submit",
          { report_id: OTHER_REPORT },
          "independent-submit",
        );
        pending.push(independent);
        resultValue(await settlesWhileHeld(independent));
        expectSingleDecision(h, "accepted", "independent-submit", null, OTHER_REPORT);
        expect(readReport(h).decision_history).toHaveLength(markdown === "current" ? 1 : 0);
        release.release();
        resultValue(await first);
        expectReportError(await second, /reviewed/iu);
        const winner = expectSingleDecision(h, "accepted", "winning-submit", null);
        expect(winner.decision_id).not.toBe(
          readReport(h, OTHER_REPORT).decision_history[0].decision_id,
        );
        expectCanonicalMarkdown(h);
        expectCanonicalMarkdown(h, OTHER_REPORT);
        expect(h.request).toHaveBeenCalledTimes(3);
      } finally {
        release.release();
        await Promise.allSettled(pending);
        vi.mocked(io.rename).mockImplementation(nativeIo.rename);
        await h.dispose();
      }
    });
  }
}

for (const firstTool of ["report_validate", "report_generate"] as const) {
  test(`${firstTool} pending publication orders existing validation before an approved decision`, async () => {
    const h = await decisionHarness();
    const entered = barrier();
    const release = barrier();
    const pending: Promise<unknown>[] = [];
    try {
      const { run } = await seedReviewed(h);
      if (firstTool === "report_validate") putReport(h, run, { status: "draft" });
      await h.mount();
      let id = REPORT;
      let held = false;
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (String(target).endsWith(".md") && !held) {
          held = true;
          id = ReportIdSchema.parse(String(target).split("/").at(-1)!.slice(0, -3));
          entered.release();
          await release.waiting;
        }
        await nativeIo.rename(source, target);
      });
      const first = h.call(
        firstTool,
        firstTool === "report_generate" ? DRAFT : { report_id: REPORT },
      );
      pending.push(first);
      await enteredBeforeCompletion(entered.waiting, first);
      const aliasPath = join(h.root, "publication-alias");
      fs.symlinkSync(h.cwd, aliasPath);
      Object.assign(h.agent.session.header, { cwd: aliasPath });
      // Generation's new draft is validated in the very same lane, before terminal execution.
      const validation =
        firstTool === "report_generate" ? h.call("report_validate", { report_id: id }) : undefined;
      if (validation) pending.push(validation);
      const terminal = h.call("report_submit", { report_id: id }, "after-sibling-publication");
      pending.push(terminal);
      // Let approval finish; queued operations must not start while the original publication is held.
      await expect.poll(() => h.request.mock.calls.length).toBe(1);
      expect(readReport(h, id).decision_history).toEqual([]);
      release.release();
      resultValue(await first);
      if (validation) resultValue(await validation);
      resultValue(await terminal);
      expectSingleDecision(h, "accepted", "after-sibling-publication", null, id);
      expectCanonicalMarkdown(h, id);
    } finally {
      release.release();
      await Promise.allSettled(pending);
      vi.mocked(io.rename).mockImplementation(nativeIo.rename);
      await h.dispose();
    }
  });
}

for (const publication of ["stale-entry", "reviewed-final"] as const) {
  test(`existing validation callers serialize ${publication} publication, not just terminal tools`, async () => {
    const h = await decisionHarness();
    const entered = barrier();
    const release = barrier();
    const pending: Promise<unknown>[] = [];
    try {
      const { run } = await seedReviewed(h);
      putReport(h, run, { status: "draft" });
      if (publication === "stale-entry") fs.unlinkSync(reportPath(h, REPORT, "md"));
      putReport(h, run, { report_id: OTHER_REPORT, task_id: OTHER_TASK, status: "draft" });
      putCard(h, { ...getCard(h), task_id: OTHER_TASK, linked_reports: [OTHER_REPORT] });
      await h.mount();
      let held = false;
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (target === reportPath(h, REPORT, "md") && !held) {
          held = true;
          entered.release();
          await release.waiting;
        }
        await nativeIo.rename(source, target);
      });
      const first = h.call("report_validate", { report_id: REPORT });
      pending.push(first);
      await enteredBeforeCompletion(entered.waiting, first);
      const second = h.call("report_validate", { report_id: REPORT });
      pending.push(second);
      let secondSettled = false;
      void second.then(() => {
        secondSettled = true;
      });
      const independent = h.call("report_validate", { report_id: OTHER_REPORT });
      pending.push(independent);
      resultValue(await settlesWhileHeld(independent));
      expect(readReport(h).status).toBe(publication === "stale-entry" ? "draft" : "reviewed");
      expect(secondSettled).toBe(false);
      release.release();
      expect(resultValue(await first)).toMatchObject({ status: "reviewed", ok: true });
      expectReportError(await second, /draft/iu);
      expectCanonicalMarkdown(h);
    } finally {
      release.release();
      await Promise.allSettled(pending);
      vi.mocked(io.rename).mockImplementation(nativeIo.rename);
      await h.dispose();
    }
  });
}

test("an approval card pending at the host does not occupy a report operation lane", async () => {
  const h = await decisionHarness();
  const asked = barrier();
  const release = barrier();
  let pending: Promise<unknown> | undefined;
  try {
    await seedReviewed(h);
    await h.mount();
    h.request.mockImplementationOnce(async () => {
      asked.release();
      await release.waiting;
      return "allowed-once";
    });
    const first = h.call("report_submit", { report_id: REPORT }, "pending-card");
    pending = first;
    await enteredBeforeCompletion(asked.waiting, first);
    expect(readReport(h).status).toBe("reviewed");
    expect(readReport(h).decision_history).toEqual([]);
    expect(h.executions).toEqual([]);
    resultValue(
      await settlesWhileHeld(
        h.call(
          "report_decide",
          { report_id: REPORT, disposition: "rejected", comment: COMMENT },
          "ready-card",
        ),
      ),
    );
    release.release();
    expectReportError(await first, /reviewed/iu);
    expectSingleDecision(h, "rejected", "ready-card", COMMENT);
    expectCanonicalMarkdown(h);
  } finally {
    release.release();
    await pending;
    await h.dispose();
  }
});

test("failed lane reports its error and releases the next same-report repair", async () => {
  const h = await decisionHarness();
  const entered = barrier();
  const release = barrier();
  const pending: Promise<unknown>[] = [];
  try {
    await seedReviewed(h);
    await h.mount();
    let held = false;
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (target === reportPath(h, REPORT, "md") && !held) {
        held = true;
        entered.release();
        await release.waiting;
        throw ioFault();
      }
      await nativeIo.rename(source, target);
    });
    const first = h.call("report_submit", { report_id: REPORT }, "durable-before-render-failure");
    pending.push(first);
    await enteredBeforeCompletion(entered.waiting, first);
    const repair = h.call("report_validate", { report_id: REPORT });
    pending.push(repair);
    release.release();
    expectReportError(await first, /render/u);
    expectReportError(await repair, /draft/iu);
    expectSingleDecision(h, "accepted", "durable-before-render-failure", null);
    expectCanonicalMarkdown(h);
    // A further operation exercises a completed tail, not just a queued successor.
    expectReportError(await h.call("report_submit", { report_id: REPORT }), /reviewed/iu);
  } finally {
    release.release();
    await Promise.allSettled(pending);
    vi.mocked(io.rename).mockImplementation(nativeIo.rename);
    await h.dispose();
  }
});

test("generation publication and existing validation share a lane before terminal tools exist", async () => {
  const h = await decisionHarness();
  const entered = barrier();
  const release = barrier();
  const pending: Promise<unknown>[] = [];
  try {
    const { run } = await seedReviewed(h);
    putReport(h, run, { report_id: OTHER_REPORT, task_id: OTHER_TASK, status: "draft" });
    fs.unlinkSync(reportPath(h, OTHER_REPORT, "md"));
    putCard(h, { ...getCard(h), task_id: OTHER_TASK, linked_reports: [OTHER_REPORT] });
    await h.mount();
    let id = REPORT;
    let held = false;
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (String(target).endsWith(".md") && !held) {
        held = true;
        id = ReportIdSchema.parse(String(target).split("/").at(-1)!.slice(0, -3));
        entered.release();
        await release.waiting;
      }
      await nativeIo.rename(source, target);
    });
    const generation = h.call("report_generate", DRAFT);
    pending.push(generation);
    await enteredBeforeCompletion(entered.waiting, generation);
    const validation = h.call("report_validate", { report_id: id });
    pending.push(validation);
    const independent = h.call("report_validate", { report_id: OTHER_REPORT });
    pending.push(independent);
    resultValue(await settlesWhileHeld(independent));
    expect(readReport(h, id).status).toBe("draft");
    release.release();
    resultValue(await generation);
    expect(resultValue(await validation)).toMatchObject({ status: "reviewed", ok: true });
    expectCanonicalMarkdown(h, id);
  } finally {
    release.release();
    await Promise.allSettled(pending);
    vi.mocked(io.rename).mockImplementation(nativeIo.rename);
    await h.dispose();
  }
});

for (const tool of TERMINAL_TOOLS) {
  test(`${tool} rereads authoritative history after asynchronous entry repair`, async () => {
    const h = await decisionHarness();
    const entered = barrier();
    const release = barrier();
    let pending: Promise<unknown> | undefined;
    try {
      const { run } = await seedReviewed(h);
      fs.unlinkSync(reportPath(h, REPORT, "md"));
      await h.mount();
      let held = false;
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (target === reportPath(h, REPORT, "md") && !held) {
          held = true;
          entered.release();
          await release.waiting;
        }
        await nativeIo.rename(source, target);
      });
      const operation = h.call(tool, decisionArgs(tool));
      pending = operation;
      await enteredBeforeCompletion(entered.waiting, operation);
      const prior = makeReportDecision("accepted", {
        report_id: REPORT,
        approval_ref: "external-prior-history",
      });
      putReport(h, run, { status: "reviewed", decision_history: [prior] }, false);
      const authoritative = await fileSnapshot(reportPath(h));
      release.release();
      expectReportError(await operation, /history|decision|state/iu);
      expect(await fileSnapshot(reportPath(h))).toEqual(authoritative);
      expect(readReport(h).decision_history).toEqual([prior]);
    } finally {
      release.release();
      await pending;
      vi.mocked(io.rename).mockImplementation(nativeIo.rename);
      await h.dispose();
    }
  });
}
