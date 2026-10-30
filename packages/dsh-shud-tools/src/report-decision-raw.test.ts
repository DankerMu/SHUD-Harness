import * as fs from "node:fs";
import { join } from "node:path";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import { expect, test, vi } from "vitest";
import { TASK, OTHER_TASK, cardPath, treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  REPORT,
  OTHER_REPORT,
  reportPath,
  resultValue,
  expectReportError,
} from "./report-workflow/test-harness.ts";
import {
  TERMINAL_TOOLS,
  decisionArgs,
  decisionHarness,
  seedReviewed,
} from "./report-decisions/test-harness.ts";

for (const tool of TERMINAL_TOOLS) {
  for (const target of [
    "json",
    "markdown",
    "reports",
    "task-file",
    "task-directory",
    "tasks",
    "workspace",
  ] as const) {
    for (const exists of [true, false]) {
      test(`${tool} raw ${target} exists=${exists} denies before policy approval or real execution`, async () => {
        const h = await decisionHarness();
        try {
          await seedReviewed(h);
          const raw =
            target === "json"
              ? reportPath(h)
              : target === "markdown"
                ? reportPath(h, REPORT, "md")
                : target === "reports"
                  ? join(h.cwd, "reports")
                  : target === "task-file"
                    ? cardPath(h)
                    : target === "task-directory"
                      ? join(h.cwd, "tasks", TASK)
                      : target === "tasks"
                        ? join(h.cwd, "tasks")
                        : h.cwd;
          if (!exists) fs.rmSync(raw, { recursive: true, force: true });
          await h.mount([raw]);
          const before = await treeOrAbsent(h.root);
          expectReportError(await h.call(tool, decisionArgs(tool)), /immutable/iu);
          expect(h.request).not.toHaveBeenCalled();
          expect(h.executions).toEqual([]);
          expect(h.logs.filter((entry) => entry.name === "shud-policy-gate")).toEqual([]);
          expect(await treeOrAbsent(h.root)).toEqual(before);
        } finally {
          await h.dispose();
        }
      });
    }
  }
  for (const alias of [
    "session",
    "reports",
    "json-file",
    "markdown-file",
    "tasks",
    "task-directory",
    "task-file",
    "raw-alias",
    "case",
  ] as const) {
    test(`${tool} protects physical ${alias} alias before policy`, async (context) => {
      const h = await decisionHarness();
      try {
        await seedReviewed(h);
        let raw = reportPath(h, REPORT, "md");
        if (alias === "session") {
          const path = join(h.root, "session-alias");
          fs.symlinkSync(h.cwd, path);
          Object.assign(h.agent.session.header, { cwd: path });
        } else if (alias === "raw-alias") {
          raw = join(h.root, "raw-alias");
          fs.symlinkSync(reportPath(h, REPORT, "md"), raw);
        } else if (alias === "case") {
          raw = join(h.cwd, "Reports", `${REPORT}.md`);
          if (!fs.existsSync(raw)) {
            context.skip("filesystem distinguishes reports root case");
            return;
          }
        } else {
          const source =
            alias === "reports"
              ? join(h.cwd, "reports")
              : alias === "json-file"
                ? reportPath(h)
                : alias === "markdown-file"
                  ? reportPath(h, REPORT, "md")
                  : alias === "tasks"
                    ? join(h.cwd, "tasks")
                    : alias === "task-directory"
                      ? join(h.cwd, "tasks", TASK)
                      : cardPath(h);
          const outside = join(h.root, "protected-physical");
          fs.renameSync(source, outside);
          fs.symlinkSync(outside, source);
          raw = outside;
        }
        await h.mount([raw]);
        const before = await treeOrAbsent(h.root);
        expectReportError(await h.call(tool, decisionArgs(tool)), /immutable/iu);
        expect(h.request).not.toHaveBeenCalled();
        expect(h.executions).toEqual([]);
        expect(h.logs.filter((entry) => entry.name === "shud-policy-gate")).toEqual([]);
        expect(await treeOrAbsent(h.root)).toEqual(before);
      } finally {
        await h.dispose();
      }
    });
  }
  for (const target of [
    "other-json",
    "other-markdown",
    "other-task",
    "report-prefix",
    "task-prefix",
  ] as const) {
    test(`${tool} disjoint protected ${target} still asks and publishes after allowed-once`, async () => {
      const h = await decisionHarness();
      try {
        await seedReviewed(h);
        const raw =
          target === "other-json"
            ? reportPath(h, OTHER_REPORT)
            : target === "other-markdown"
              ? reportPath(h, OTHER_REPORT, "md")
              : target === "other-task"
                ? cardPath(h, OTHER_TASK)
                : join(h.cwd, target === "report-prefix" ? "reports-sibling" : "tasks-sibling");
        await h.mount([raw]);
        const before = await treeOrAbsent(raw);
        resultValue(await h.call(tool, decisionArgs(tool)));
        expect(h.request).toHaveBeenCalledTimes(1);
        expect(h.executions).toHaveLength(1);
        expect(await treeOrAbsent(raw)).toEqual(before);
      } finally {
        await h.dispose();
      }
    });
  }
  for (const directory of ["stacks", "provenance"] as const) {
    test(`${tool} missing protected ${directory} reference never creates its directory`, async () => {
      const h = await decisionHarness();
      try {
        await seedReviewed(h);
        fs.rmSync(join(h.cwd, directory), { recursive: true });
        fs.unlinkSync(reportPath(h, REPORT, "md"));
        await h.mount([join(h.cwd, directory)]);
        const before = await treeOrAbsent(h.root);
        expectReportError(await h.call(tool, decisionArgs(tool)), /render/u);
        expect(h.request).toHaveBeenCalledTimes(1);
        expect(h.executions).toHaveLength(1);
        expect(await treeOrAbsent(h.root)).toEqual(before);
        expect(fs.existsSync(join(h.cwd, directory))).toBe(false);
      } finally {
        await h.dispose();
      }
    });
  }
}

// Public admission seam gives a semantic RED even before the two real tools are registered.
for (const tool of TERMINAL_TOOLS) {
  for (const target of ["json", "markdown", "task"] as const) {
    test(`raw admission routes ${tool} ${target} to existing exact report protection`, async () => {
      const h = await decisionHarness();
      try {
        await seedReviewed(h);
        const raw =
          target === "json"
            ? reportPath(h)
            : target === "markdown"
              ? reportPath(h, REPORT, "md")
              : cardPath(h);
        await h.mount([raw]);
        const next = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: "cancel" }));
        const before = await treeOrAbsent(h.root);
        const decision = await h.ctx.waterfall(
          "tools/pre-execute",
          {
            name: tool,
            arguments: decisionArgs(tool),
            callId: "raw-route-semantic" as ToolCallId,
            agent: h.agent,
            signal: new AbortController().signal,
          } as ToolExecution,
          next,
        );
        const immutableReason: unknown = expect.stringMatching(/immutable/iu);
        expect(decision).toMatchObject({
          kind: "deny",
          reason: immutableReason,
        });
        expect(h.logs).toContainEqual({
          name: "shud-raw-guard",
          args: [`deny ${tool} raw-immutable`],
        });
        expect(next).not.toHaveBeenCalled();
        expect(h.logs.filter((entry) => entry.name === "shud-policy-gate")).toEqual([]);
        expect(h.request).not.toHaveBeenCalled();
        expect(await treeOrAbsent(h.root)).toEqual(before);
      } finally {
        await h.dispose();
      }
    });
  }
}

for (const tool of TERMINAL_TOOLS) {
  test(`${tool} full raw-policy chain without an agent fails closed before any domain execution`, async () => {
    const h = await decisionHarness();
    try {
      await seedReviewed(h);
      await h.mount();
      const before = await treeOrAbsent(h.root);
      expectReportError(
        await h.call(tool, decisionArgs(tool), "missing-agent-chain", false),
        /targets|denied|no agent/iu,
      );
      expect(h.request).not.toHaveBeenCalled();
      expect(h.executions).toEqual([]);
      expect(await treeOrAbsent(h.root)).toEqual(before);
    } finally {
      await h.dispose();
    }
  });
}
