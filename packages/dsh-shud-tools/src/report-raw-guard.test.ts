import * as fs from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { expect, test } from "vitest";
import {
  TASK,
  OTHER_TASK,
  cardPath,
  getCard,
  putCard,
  treeOrAbsent,
} from "./task-linked/test-harness.ts";
import {
  DRAFT,
  REPORT,
  OTHER_REPORT,
  expectReportError as expectToolError,
  generated,
  putReport,
  reportHarness,
  reportPath,
  resultValue,
  seedEvidence,
} from "./report-workflow/test-harness.ts";

async function admission(ctx: Context) {
  const approvals: Array<Parameters<ApprovalService["request"]>[0]> = [];
  let executions = 0;
  await ctx.plugin((services: Context) => {
    services.provide("approval", {
      request(request: Parameters<ApprovalService["request"]>[0]) {
        approvals.push(request);
        return Promise.resolve("allowed-once" as const);
      },
    });
    services.on("tools/execute", (_event, next) => {
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

for (const exists of [false, true]) {
  test.each(["reports", "report-subtree", "tasks", "task-directory", "task-file", "ancestor"])(
    `registered generation denies protected %s; exists=${exists}`,
    async (kind) => {
      const h = await reportHarness();
      try {
        if (exists) {
          await seedEvidence(h);
          fs.mkdirSync(join(h.cwd, "reports"));
        }
        const raw =
          kind === "reports"
            ? join(h.cwd, "reports")
            : kind === "report-subtree"
              ? join(h.cwd, "reports", "raw-subtree")
              : kind === "tasks"
                ? join(h.cwd, "tasks")
                : kind === "task-directory"
                  ? join(h.cwd, "tasks", TASK)
                  : kind === "task-file"
                    ? cardPath(h)
                    : h.cwd;
        await h.apply(rawGuard, { rawDirs: [raw] });
        const seen = await admission(h.ctx);
        const before = await treeOrAbsent(h.root);
        expectToolError(await h.invoke("report_generate", DRAFT), /immutable/iu);
        expect(seen.executions).toBe(0);
        expect(seen.approvals).toEqual([]);
        expect(await treeOrAbsent(h.root)).toEqual(before);
      } finally {
        await h.dispose();
      }
    },
  );
}

test.each(["reports", "json", "markdown", "tasks", "task-file", "ancestor"])(
  "registered validation denies %s before entry repair",
  async (kind) => {
    const h = await reportHarness();
    try {
      const { run } = await seedEvidence(h);
      putReport(h, run, {}, false);
      const raw =
        kind === "reports"
          ? join(h.cwd, "reports")
          : kind === "json"
            ? reportPath(h)
            : kind === "markdown"
              ? reportPath(h, REPORT, "md")
              : kind === "tasks"
                ? join(h.cwd, "tasks")
                : kind === "task-file"
                  ? cardPath(h)
                  : h.cwd;
      await h.apply(rawGuard, { rawDirs: [raw] });
      const seen = await admission(h.ctx);
      const before = await treeOrAbsent(h.root);
      expectToolError(await h.invoke("report_validate", { report_id: REPORT }), /immutable/iu);
      expect(seen.executions).toBe(0);
      expect(seen.approvals).toEqual([]);
      expect(await treeOrAbsent(h.root)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

for (const tool of ["report_generate", "report_validate"] as const) {
  const aliases = [
    "session",
    "reports",
    "task-file",
    "raw-alias",
    "case",
    ...(tool === "report_validate" ? ["markdown-file"] : []),
  ];
  for (const kind of aliases) {
    test(`${tool} protects physical ${kind} aliases`, async (context) => {
      const h = await reportHarness();
      try {
        const { run } = await seedEvidence(h);
        putReport(h, run);
        let raw = reportPath(h, REPORT, "md");
        if (kind === "session") {
          const alias = join(h.root, "session-alias");
          fs.symlinkSync(h.cwd, alias);
          Object.assign(h.agent.session.header, { cwd: alias });
        } else if (kind === "raw-alias") {
          raw = join(h.root, "raw-alias");
          fs.symlinkSync(reportPath(h, REPORT, "md"), raw);
        } else if (kind === "case") {
          raw = join(h.cwd, "Reports", `${REPORT}.md`);
          if (!fs.existsSync(raw)) {
            context.skip("filesystem distinguishes reports root case");
            return;
          }
        } else {
          const source =
            kind === "reports"
              ? join(h.cwd, "reports")
              : kind === "task-file"
                ? cardPath(h)
                : reportPath(h, REPORT, "md");
          const outside = join(h.root, "protected-physical");
          fs.renameSync(source, outside);
          fs.symlinkSync(outside, source);
          raw = kind === "reports" ? join(outside, `${REPORT}.md`) : outside;
        }
        await h.apply(rawGuard, { rawDirs: [raw] });
        const seen = await admission(h.ctx);
        const before = await treeOrAbsent(h.root);
        expectToolError(
          await h.invoke(tool, tool === "report_generate" ? DRAFT : { report_id: REPORT }),
          /immutable/iu,
        );
        expect(seen.executions).toBe(0);
        expect(seen.approvals).toEqual([]);
        expect(await treeOrAbsent(h.root)).toEqual(before);
      } finally {
        await h.dispose();
      }
    });
  }
}

test.each(["other-task", "other-report", "sibling"])(
  "validation disjoint %s control reaches real reviewed publication without approval",
  async (kind) => {
    const h = await reportHarness();
    try {
      const { run } = await seedEvidence(h);
      putReport(h, run);
      const raw =
        kind === "other-task"
          ? cardPath(h, OTHER_TASK)
          : kind === "other-report"
            ? reportPath(h, OTHER_REPORT)
            : join(h.cwd, "reports-sibling");
      const rawBefore = await treeOrAbsent(raw);
      await h.apply(rawGuard, { rawDirs: [raw] });
      const seen = await admission(h.ctx);
      expect(resultValue(await h.invoke("report_validate", { report_id: REPORT }))).toMatchObject({
        ok: true,
        status: "reviewed",
      });
      expect(seen.executions).toBe(1);
      expect(seen.approvals).toEqual([]);
      expect(await treeOrAbsent(raw)).toEqual(rawBefore);
    } finally {
      await h.dispose();
    }
  },
);

test("generation disjoint task and report-prefix controls publish normally without terminal tool mounting", async () => {
  const h = await reportHarness();
  try {
    await seedEvidence(h);
    putCard(h, { ...getCard(h), linked_reports: [] });
    await h.apply(rawGuard, { rawDirs: [cardPath(h, OTHER_TASK), join(h.cwd, "reports-sibling")] });
    const seen = await admission(h.ctx);
    generated(h, await h.invoke("report_generate", DRAFT));
    expect(seen.executions).toBe(1);
    expect(seen.approvals).toEqual([]);
    for (const name of ["report_submit", "report_decide"]) {
      const result = await h.runtime.execute({
        callId: "terminal-absence" as ToolCallId,
        name,
        arguments: { report_id: REPORT },
        agent: h.agent,
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(true);
      if (result.isError) {
        const info: unknown = result.error.info;
        const code =
          typeof info === "object" && info !== null && "code" in info ? info.code : undefined;
        expect(code).toBe("UNKNOWN_TOOL");
      }
    }
  } finally {
    await h.dispose();
  }
});
