import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskIdSchema } from "@shud-harness/dsh-shud-core";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { expect, test, vi } from "vitest";
import { admission, fileSnapshot, taskArgs, valueOf } from "./change-create/test-harness.ts";
import { allSourceFiles, invokeTool, seedBuildSource } from "./shud-build/test-harness.ts";
import { expectToolError, treeOrAbsent } from "./task-linked/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";

// Observe actual OS calls; the successful build tracers use no process doubles.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

test.each(["builds", "repos/SHUD"])(
  "raw %s denies shud_build before execution, approval, Git, make or workspace mutation",
  async (raw) => {
    const sundialsRoot = fs.mkdtempSync(join(tmpdir(), "shud-build-sundials-"));
    try {
      const h = await createToolHarness({ pumpPollMs: 60_000, sundialsRoot });
      try {
        const { source } = seedBuildSource(h.cwd);
        const created = valueOf(await invokeTool(h, "task_create", taskArgs));
        const taskId = TaskIdSchema.parse(created.task_id);
        const cardPath = join(h.cwd, "tasks", taskId, "task.json");
        const logs: string[] = [];
        h.ctx.logger.exporter({
          export(message) {
            logs.push(message.args.map(String).join(" "));
          },
        });
        await h.apply(rawGuard, { rawDirs: [raw] });
        const seen = await admission({
          ...h,
          source,
          invoke: (name, args) => invokeTool(h, name, args),
        });
        const beforeWorkspace = await treeOrAbsent(h.cwd);
        const beforeSource = allSourceFiles(source);
        const beforeCard = fileSnapshot(cardPath);
        expect(fs.existsSync(join(h.cwd, "builds"))).toBe(false);
        vi.mocked(childProcess.execFile).mockClear();
        vi.mocked(childProcess.execFileSync).mockClear();
        vi.mocked(childProcess.spawnSync).mockClear();
        try {
          const message = expectToolError(
            await invokeTool(h, "shud_build", { task_id: taskId }),
            /Raw data is immutable/u,
          );
          expect(seen.preExecutions).toBe(0);
          expect(seen.executions).toBe(0);
          expect(seen.approvals).toEqual([]);
          expect(childProcess.execFile).not.toHaveBeenCalled();
          expect(childProcess.execFileSync).not.toHaveBeenCalled();
          expect(childProcess.spawnSync).not.toHaveBeenCalled();
          expect(message).not.toContain(h.cwd);
          expect(message).not.toContain(taskId);
          expect(logs.some((line) => line.includes("deny shud_build raw-immutable"))).toBe(true);
          expect(fs.existsSync(join(h.cwd, "builds"))).toBe(false);
          expect(await treeOrAbsent(h.cwd)).toEqual(beforeWorkspace);
        } finally {
          expect(allSourceFiles(source)).toEqual(beforeSource);
          expect(fileSnapshot(cardPath)).toEqual(beforeCard);
        }
      } finally {
        await h.dispose();
      }
    } finally {
      fs.rmSync(sundialsRoot, { recursive: true, force: true });
    }
  },
);
