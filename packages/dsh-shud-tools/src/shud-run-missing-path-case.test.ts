import * as fs from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { expect, test, vi } from "vitest";
import { expectToolError, treeOrAbsent } from "./task-linked/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";

for (const namespace of ["empty", "native-insensitive"] as const) {
  for (const [raw, output] of [
    ["RUNS", "runs"],
    ["STACKS", "stacks"],
    ["PROVENANCE", "provenance"],
  ]) {
    test(`registered shud_run refuses absent ${raw}/${output} in ${namespace}`, async ({
      skip,
    }) => {
      const h = await createToolHarness({ pumpPollMs: 60_000 });
      const submissions = vi.spyOn(h.registry, "submitShud");
      try {
        expect(fs.readdirSync(h.cwd)).toEqual([]);
        if (namespace === "native-insensitive") {
          fs.writeFileSync(join(h.cwd, "marker"), "independent namespace evidence\n");
          const alternate = fs.lstatSync(join(h.cwd, "MARKER"), { throwIfNoEntry: false });
          if (!alternate) {
            skip("native namespace is sensitive; empty-namespace refusals still run on this host");
            return;
          }
          const marker = fs.lstatSync(join(h.cwd, "marker"));
          expect(alternate.dev).toBe(marker.dev);
          expect(alternate.ino).toBe(marker.ino);
        }
        expect(fs.existsSync(join(h.cwd, raw))).toBe(false);
        expect(fs.existsSync(join(h.cwd, output))).toBe(false);
        await h.apply(rawGuard, { rawDirs: [raw] });
        const approvals: Array<Parameters<ApprovalService["request"]>[0]> = [];
        let executions = 0;
        await h.ctx.plugin((services: Context) => {
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
        const paths = [h.cwd, h.stateDir, h.inputDir];
        const before = await Promise.all(paths.map(treeOrAbsent));
        const indexes = h.registry.indexes.read();
        expectToolError(
          await h.call({ input_dir: h.inputDir, project: "tiny" }),
          namespace === "empty" ? /unavailable/iu : /immutable/iu,
        );
        expect(executions).toBe(0);
        expect(approvals).toEqual([]);
        expect(submissions).not.toHaveBeenCalled();
        expect(h.registry.list()).toEqual([]);
        expect(h.registry.indexes.read()).toEqual(indexes);
        expect(await Promise.all(paths.map(treeOrAbsent))).toEqual(before);
        for (const spelling of ["RUNS", "runs", "STACKS", "stacks", "PROVENANCE", "provenance"]) {
          expect(fs.existsSync(join(h.cwd, spelling))).toBe(false);
        }
      } finally {
        submissions.mockRestore();
        await h.dispose();
      }
    });
  }
}
