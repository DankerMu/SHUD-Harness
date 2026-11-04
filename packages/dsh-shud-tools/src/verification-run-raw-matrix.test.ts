import * as fs from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import * as policyGate from "../../dsh-shud-policy-gate/src/index.ts";
import { expect, test } from "vitest";
import { resultValue } from "./report-workflow/test-harness.ts";
import { fixturePaths, rejectedUnchanged } from "./verification-run/matrix/test-harness.ts";
import { verificationHarness } from "./verification-run/test-harness.ts";

for (const exists of [false, true]) {
  test.each(["verifications", "tasks", "task-directory", "task-file", "ancestor"] as const)(
    `mounted raw ${exists ? "existing" : "prospective"} %s blocks verification before execution`,
    async (kind) => {
      const h = await verificationHarness();
      try {
        if (exists) fs.mkdirSync(join(h.cwd, "verifications"));
        const raw =
          kind === "ancestor"
            ? h.cwd
            : kind === "task-directory"
              ? join(h.cwd, "tasks", h.card.task_id)
              : kind === "task-file"
                ? fixturePaths(h, "base").task
                : kind;
        await h.apply(rawGuard, { rawDirs: [raw] });
        let executions = 0;
        await h.ctx.plugin((ctx: Context) => {
          ctx.on("tools/execute", (_event, next) => {
            executions++;
            return next();
          });
        });
        await rejectedUnchanged(h, undefined, /Raw data is immutable/u);
        expect(executions).toBe(0);
      } finally {
        await h.dispose();
      }
    },
  );
}

test.each(["session", "verification-root", "task-file", "raw-alias"] as const)(
  "mounted raw protection survives the %s alias",
  async (kind) => {
    const h = await verificationHarness();
    try {
      let raw = fixturePaths(h, "base").task;
      if (kind === "session") {
        const alias = join(h.root, "session-alias");
        fs.symlinkSync(h.cwd, alias);
        Object.assign(h.agent.session.header, { cwd: alias });
      } else if (kind === "verification-root") {
        raw = join(h.root, "physical-verifications");
        fs.mkdirSync(raw);
        fs.symlinkSync(raw, join(h.cwd, "verifications"));
      } else if (kind === "task-file") {
        raw = join(h.root, "physical-task.json");
        fs.renameSync(fixturePaths(h, "base").task, raw);
        fs.symlinkSync(raw, fixturePaths(h, "base").task);
      } else {
        raw = join(h.root, "raw-alias");
        fs.symlinkSync(fixturePaths(h, "base").task, raw);
      }
      await h.apply(rawGuard, { rawDirs: [raw] });
      await rejectedUnchanged(h, undefined, /Raw data is immutable/u);
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  "verifications-sibling",
  "tasks/TASK-20261102T090000-ffff/task.json",
  "builds",
  "changes",
  "patches",
  "data/raw",
])("unrelated raw %s continues exactly once to actual verification publication", async (raw) => {
  const h = await verificationHarness({ rawDirs: [raw] });
  try {
    let preExecutions = 0;
    let executions = 0;
    await h.ctx.plugin((ctx: Context) => {
      ctx.on("tools/pre-execute", (_event, next) => {
        preExecutions++;
        return next();
      });
      ctx.on("tools/execute", (_event, next) => {
        executions++;
        return next();
      });
    });
    expect(resultValue(await h.invoke()).status).toBe("passed");
    expect(preExecutions).toBe(1);
    expect(executions).toBe(1);
  } finally {
    await h.dispose();
  }
});

test("raw denial takes precedence over current off-role policy without invoking verification", async () => {
  const h = await verificationHarness();
  try {
    const logs: string[] = [];
    h.ctx.logger.exporter({
      export(message) {
        logs.push(message.args.map(String).join(" "));
      },
    });
    await h.apply(rawGuard, { rawDirs: ["verifications"] });
    await h.apply(policyGate, {});
    h.current.preset = "coder";
    let executions = 0;
    await h.ctx.plugin((ctx: Context) => {
      ctx.on("tools/execute", (_event, next) => {
        executions++;
        return next();
      });
    });
    await rejectedUnchanged(h, undefined, /Raw data is immutable/u);
    expect(executions).toBe(0);
    expect(logs.some((line) => line.includes("deny verification_run raw-immutable"))).toBe(true);
    expect(logs.some((line) => line.includes("role-tool-surface"))).toBe(false);
  } finally {
    await h.dispose();
  }
});
