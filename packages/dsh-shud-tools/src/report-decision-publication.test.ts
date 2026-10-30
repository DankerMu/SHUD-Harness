import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import {
  OTHER_TASK,
  cardPath,
  cardSnapshot,
  getCard,
  putCard,
} from "./task-linked/test-harness.ts";
import {
  REPORT,
  OTHER_REPORT,
  fileSnapshot,
  readReport,
  reportPath,
  resultValue,
  expectReportError,
} from "./report-workflow/test-harness.ts";
import {
  PRIVATE,
  TERMINAL_TOOLS,
  decisionArgs,
  decisionHarness,
  durableSnapshot,
  expectCanonicalMarkdown,
  ioFault,
  seedReviewed,
} from "./report-decisions/test-harness.ts";

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
  return { ...actual, rename: vi.fn(actual.rename) };
});
const nativeFs = await vi.importActual<typeof fs>("node:fs");
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");
function restoreIO() {
  vi.mocked(fs.renameSync).mockReset().mockImplementation(nativeFs.renameSync);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(nativeFs.readFileSync);
  vi.mocked(io.rename).mockReset().mockImplementation(nativeIo.rename);
}
beforeEach(restoreIO);

for (const tool of TERMINAL_TOOLS) {
  for (const stage of [
    "entry-card",
    "entry-markdown",
    "report-json",
    "report-json-after-repair",
    "task-card",
    "render",
    "markdown-rename",
  ] as const) {
    test(`${tool} ${stage} failure keeps independent commits and next-call repair never duplicates a decision`, async () => {
      const h = await decisionHarness();
      try {
        const { stack } = await seedReviewed(h);
        if (
          stage === "entry-card" ||
          stage === "entry-markdown" ||
          stage === "report-json-after-repair"
        ) {
          putCard(h, { ...getCard(h), status: "running", linked_reports: [] });
          fs.unlinkSync(reportPath(h, REPORT, "md"));
        }
        await h.mount();
        const before = await durableSnapshot(h.cwd);
        const originalJson = await fileSnapshot(reportPath(h));
        const originalCard = await cardSnapshot(h);
        const stackPath = join(h.cwd, "stacks", `${stack.stack_id}.json`);
        const stackBytes = fs.readFileSync(stackPath);
        let failures = 0;
        let committed = false;
        restoreIO(); // Fixture construction is not an observed production write.
        vi.mocked(fs.renameSync).mockImplementation((source, target) => {
          if (
            ((stage === "report-json" || stage === "report-json-after-repair") &&
              target === reportPath(h)) ||
            ((stage === "entry-card" || stage === "task-card") && target === cardPath(h))
          ) {
            failures++;
            throw ioFault();
          }
          nativeFs.renameSync(source, target);
          if (target === reportPath(h)) committed = true;
        });
        vi.mocked(fs.readFileSync).mockImplementation((...args) => {
          if (stage === "render" && committed && args[0] === stackPath) {
            failures++;
            throw ioFault();
          }
          return nativeFs.readFileSync(...args);
        });
        vi.mocked(io.rename).mockImplementation(async (source, target) => {
          if (
            (stage === "entry-markdown" || stage === "markdown-rename") &&
            target === reportPath(h, REPORT, "md")
          ) {
            failures++;
            throw ioFault();
          }
          await nativeIo.rename(source, target);
        });
        const message = expectReportError(
          await h.call(tool, decisionArgs(tool), `fault-${stage}`),
          stage === "entry-card" || stage === "task-card"
            ? /task_card/u
            : stage.startsWith("report-json")
              ? /report|write/iu
              : /render/u,
        );
        expect(message).toContain(REPORT);
        expect(message).not.toContain(PRIVATE);
        expect(failures).toBe(1);
        restoreIO();
        expect(fs.readFileSync(stackPath)).toEqual(stackBytes);
        if (stage === "entry-card" || stage === "report-json")
          expect(await durableSnapshot(h.cwd)).toEqual(before);
        if (stage === "entry-markdown") {
          expect(await fileSnapshot(reportPath(h))).toEqual(originalJson);
          expect(getCard(h)).toMatchObject({ status: "reporting", linked_reports: [REPORT] });
          expect(fs.existsSync(reportPath(h, REPORT, "md"))).toBe(false);
        }
        if (stage === "report-json-after-repair") {
          expect(await fileSnapshot(reportPath(h))).toEqual(originalJson);
          expect(getCard(h)).toMatchObject({ status: "reporting", linked_reports: [REPORT] });
          expectCanonicalMarkdown(h);
        }
        const postcommit =
          stage === "task-card" || stage === "render" || stage === "markdown-rename";
        expect(readReport(h).decision_history).toHaveLength(postcommit ? 1 : 0);
        if (postcommit) {
          const durable = await fileSnapshot(reportPath(h));
          if (stage === "task-card") expect(await cardSnapshot(h)).toEqual(originalCard);
          else expect(getCard(h).status).toBe(tool === "report_submit" ? "done" : "planned");
          // The already mounted, nonterminal public tool repairs durable terminal state before rejecting.
          expectReportError(await h.call("report_validate", { report_id: REPORT }), /draft/iu);
          expect(await fileSnapshot(reportPath(h))).toEqual(durable);
          expect(getCard(h).status).toBe(tool === "report_submit" ? "done" : "planned");
          expectCanonicalMarkdown(h);
          const repaired = await durableSnapshot(h.cwd);
          expectReportError(await h.call(tool, decisionArgs(tool)), /reviewed/iu);
          expect(await durableSnapshot(h.cwd)).toEqual(repaired);
          expect(readReport(h).decision_history).toHaveLength(1);
        } else {
          resultValue(await h.call(tool, decisionArgs(tool)));
          expect(readReport(h).decision_history).toHaveLength(1);
          expectCanonicalMarkdown(h);
        }
      } finally {
        restoreIO();
        await h.dispose();
      }
    });
  }
  for (const change of ["missing", "corrupt", "foreign", "illegal-state", "fields"] as const) {
    test(`${tool} post-JSON fresh card observes ${change} without rollback or stale overwrite`, async () => {
      const h = await decisionHarness();
      try {
        await seedReviewed(h);
        await h.mount();
        const original = getCard(h);
        let changedSnapshot: unknown;
        vi.mocked(fs.renameSync).mockImplementation((source, target) => {
          nativeFs.renameSync(source, target);
          if (target !== reportPath(h)) return;
          const card = {
            ...original,
            title: "fresh PI title",
            current_owner: "pi" as const,
            linked_reports: [REPORT, OTHER_REPORT],
          };
          if (change === "missing") nativeFs.unlinkSync(cardPath(h));
          else if (change === "corrupt")
            nativeFs.writeFileSync(cardPath(h), "{ PRIVATE_CARD_CORRUPTION");
          else
            nativeFs.writeFileSync(
              cardPath(h),
              JSON.stringify(
                change === "foreign"
                  ? { ...card, task_id: OTHER_TASK }
                  : change === "illegal-state"
                    ? { ...card, status: "done" }
                    : card,
              ),
            );
          changedSnapshot = nativeFs.existsSync(cardPath(h))
            ? nativeFs.readFileSync(cardPath(h))
            : null;
        });
        const result = await h.call(tool, decisionArgs(tool), `fresh-${change}`);
        restoreIO();
        expect(readReport(h).decision_history).toHaveLength(1);
        if (change === "fields") {
          resultValue(result);
          expect(getCard(h)).toMatchObject({
            title: "fresh PI title",
            current_owner: "pi",
            linked_reports: [REPORT, OTHER_REPORT],
            status: tool === "report_submit" ? "done" : "planned",
          });
          expectCanonicalMarkdown(h);
        } else {
          const message = expectReportError(result, /task_card/u);
          expect(message).toContain(REPORT);
          expect(message).not.toContain("PRIVATE_CARD_CORRUPTION");
          expect(fs.existsSync(cardPath(h)) ? fs.readFileSync(cardPath(h)) : null).toEqual(
            changedSnapshot,
          );
          const durable = await fileSnapshot(reportPath(h));
          putCard(h, original);
          expectReportError(await h.call(tool, decisionArgs(tool)), /reviewed/iu);
          expect(await fileSnapshot(reportPath(h))).toEqual(durable);
          expectCanonicalMarkdown(h);
        }
      } finally {
        restoreIO();
        await h.dispose();
      }
    });
  }
  for (const status of ["done", "cancelled"] as const) {
    test(`${tool} illegal unlinked entry repair never reopens ${status} or repairs Markdown`, async () => {
      const h = await decisionHarness();
      try {
        await seedReviewed(h);
        putCard(h, { ...getCard(h), status, linked_reports: [] });
        fs.unlinkSync(reportPath(h, REPORT, "md"));
        await h.mount();
        const before = await durableSnapshot(h.cwd);
        expectReportError(await h.call(tool, decisionArgs(tool)), /task_card/u);
        expect(await durableSnapshot(h.cwd)).toEqual(before);
        expect(readReport(h).decision_history).toEqual([]);
      } finally {
        await h.dispose();
      }
    });
  }
}

test("repairing an older terminal report never moves the newer reporting card", async () => {
  const h = await decisionHarness();
  try {
    await seedReviewed(h);
    await h.mount();
    resultValue(await h.call("report_decide", decisionArgs("report_decide")));
    putCard(h, { ...getCard(h), status: "reporting", linked_reports: [REPORT, OTHER_REPORT] });
    fs.unlinkSync(reportPath(h, REPORT, "md"));
    const before = await cardSnapshot(h);
    expectReportError(await h.call("report_submit", { report_id: REPORT }), /reviewed/iu);
    expect(await cardSnapshot(h)).toEqual(before);
    expectCanonicalMarkdown(h);
    expect(readReport(h).decision_history).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});
