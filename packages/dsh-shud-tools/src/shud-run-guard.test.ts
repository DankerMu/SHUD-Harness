import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { expect, test } from "vitest";
import { createToolHarness } from "./test-harness.ts";

test.each([
  "output denied",
  "both denied",
  "input rejected",
  "input unavailable",
  "input allowed",
  "ordinary input",
])("registered shud_run respects actual raw guard: %s", async (kind) => {
  const h = await createToolHarness();
  try {
    const asks: Array<Parameters<ApprovalService["request"]>[0]> = [];
    let executions = 0;
    const roots =
      kind === "output denied"
        ? [h.cwd]
        : kind === "both denied"
          ? [h.inputDir, h.cwd]
          : kind === "ordinary input"
            ? [join(h.root, "unrelated-raw")]
            : [h.inputDir];
    await h.apply(rawGuard, { rawDirs: roots });
    await h.ctx.plugin((services: Context) => {
      services.provide("approval", {
        request(request: Parameters<ApprovalService["request"]>[0]) {
          asks.push(request);
          return Promise.resolve(
            kind === "input allowed"
              ? "allowed-once"
              : kind === "input unavailable"
                ? "unavailable"
                : "rejected",
          );
        },
      });
      services.on("tools/execute", (_execution, next) => {
        executions++;
        return next();
      });
    });
    const result = await h.call({ input_dir: h.inputDir });
    const allowed = kind === "input allowed" || kind === "ordinary input";
    expect(result.isError).toBe(!allowed);
    expect(executions).toBe(allowed ? 1 : 0);
    expect(asks).toHaveLength(kind.startsWith("input ") ? 1 : 0);
    if (asks.length > 0) {
      expect(asks[0]).toMatchObject({ toolName: "shud_run", agent: h.agent });
    }
    if (!allowed) {
      if (!result.isError) throw new Error("Raw policy unexpectedly allowed the call");
      expect(result.error.message).toMatch(
        kind === "input rejected"
          ? /user rejected/iu
          : kind === "input unavailable"
            ? /no approval channel/iu
            : /immutable/iu,
      );
      expect(h.registry.list()).toEqual([]);
      expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
      await expect(readdir(join(h.cwd, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const [path, original] of Object.entries(h.originals)) {
      expect(await readFile(join(h.inputDir, path))).toEqual(original);
    }
  } finally {
    await h.dispose();
  }
});
