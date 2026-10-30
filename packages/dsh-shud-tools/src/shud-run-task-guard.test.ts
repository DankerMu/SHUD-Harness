import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { expect, test, vi } from "vitest";
import { createToolHarness } from "./test-harness.ts";
import {
  TASK,
  OTHER_TASK,
  cardPath,
  expectToolError,
  plannedCard,
  putCard,
  returnedRun,
  treeOrAbsent,
} from "./task-linked/test-harness.ts";

async function observeAdmission(ctx: Context) {
  const approvals: Array<Parameters<ApprovalService["request"]>[0]> = [];
  let executions = 0;
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

for (const exists of [false, true]) {
  test.each(["tasks", "task-directory", "task-file", "ancestor"])(
    `registered linked submission denies protected %s before execution; exists=${exists}`,
    async (kind) => {
      const h = await createToolHarness({ pumpPollMs: 60_000 });
      const submit = vi.spyOn(h.registry, "submitShud");
      const query = vi.spyOn(h.registry, "listRunJobsByTask");
      try {
        if (exists) putCard(h);
        const raw =
          kind === "tasks"
            ? join(h.cwd, "tasks")
            : kind === "task-directory"
              ? join(h.cwd, "tasks", TASK)
              : kind === "task-file"
                ? cardPath(h)
                : h.cwd;
        await h.apply(rawGuard, { rawDirs: [raw] });
        const observed = await observeAdmission(h.ctx);
        const roots = [h.cwd, h.stateDir, h.inputDir];
        const before = await Promise.all(roots.map(treeOrAbsent));
        expectToolError(await h.call({ input_dir: h.inputDir, task_id: TASK }), /immutable/iu);
        expect(observed.executions).toBe(0);
        expect(observed.approvals).toEqual([]);
        expect(submit).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        expect(h.registry.list()).toEqual([]);
        expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
        expect(await Promise.all(roots.map(treeOrAbsent))).toEqual(before);
      } finally {
        submit.mockRestore();
        query.mockRestore();
        await h.dispose();
      }
    },
  );
}

for (const kind of [
  "session",
  "session-absent",
  "tasks",
  "task-directory",
  "target-file",
  "raw",
  "case",
]) {
  test(`registered raw policy protects physical task target through ${kind} alias`, async ({
    skip,
  }) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    const submit = vi.spyOn(h.registry, "submitShud");
    try {
      if (kind !== "session-absent") putCard(h);
      let raw = cardPath(h);
      const external = join(h.root, "physical-task-target");
      if (kind === "session" || kind === "session-absent") {
        const alias = join(h.root, "session-alias");
        await io.symlink(h.cwd, alias);
        Object.assign(h.agent.session.header, { cwd: alias });
      } else if (kind === "raw") {
        raw = join(h.root, "raw-alias");
        await io.symlink(cardPath(h), raw);
      } else if (kind === "case") {
        raw = join(h.cwd, "Tasks", TASK, "task.json");
        if (!fs.existsSync(raw)) {
          skip("filesystem distinguishes task-root case spellings");
          return;
        }
      } else {
        const source =
          kind === "tasks"
            ? join(h.cwd, "tasks")
            : kind === "task-directory"
              ? join(h.cwd, "tasks", TASK)
              : cardPath(h);
        await io.rename(source, external);
        await io.symlink(external, source);
        raw =
          kind === "tasks"
            ? join(external, TASK, "task.json")
            : kind === "task-directory"
              ? join(external, "task.json")
              : external;
      }
      await h.apply(rawGuard, { rawDirs: [raw] });
      const observed = await observeAdmission(h.ctx);
      const roots = [h.cwd, h.stateDir, h.inputDir, external];
      const before = await Promise.all(roots.map(treeOrAbsent));
      expectToolError(await h.call({ input_dir: h.inputDir, task_id: TASK }), /immutable/iu);
      expect(observed.executions).toBe(0);
      expect(observed.approvals).toEqual([]);
      expect(submit).not.toHaveBeenCalled();
      expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await Promise.all(roots.map(treeOrAbsent))).toEqual(before);
    } finally {
      submit.mockRestore();
      await h.dispose();
    }
  });
}

test.each([false, true])(
  "registered task output denial wins before input approval; reversed=%s",
  async (reversed) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    try {
      putCard(h);
      const rawDirs = [h.inputDir, cardPath(h)];
      await h.apply(rawGuard, { rawDirs: reversed ? [...rawDirs].reverse() : rawDirs });
      const observed = await observeAdmission(h.ctx);
      const roots = [h.cwd, h.stateDir, h.inputDir];
      const before = await Promise.all(roots.map(treeOrAbsent));
      for (const input of [{ input_dir: h.inputDir }, {}, { input_dir: null }, { input_dir: 7 }]) {
        expectToolError(await h.call({ ...input, task_id: TASK }), /immutable/iu);
        expect(observed.executions).toBe(0);
        expect(observed.approvals).toEqual([]);
        expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
        expect(await Promise.all(roots.map(treeOrAbsent))).toEqual(before);
      }
    } finally {
      await h.dispose();
    }
  },
);

test.each(["other-task", "sibling", "no-task", "input-approval"])(
  "registered guarded %s control keeps exact-target scope",
  async (kind) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    const query = vi.spyOn(h.registry, "listRunJobsByTask");
    const submit = vi.spyOn(h.registry, "submitShud");
    try {
      if (kind !== "no-task") putCard(h);
      if (kind === "other-task") putCard(h, plannedCard({ task_id: OTHER_TASK }));
      const raw =
        kind === "other-task"
          ? cardPath(h, OTHER_TASK)
          : kind === "sibling"
            ? join(h.cwd, "tasks", `${TASK}-sibling`)
            : kind === "input-approval"
              ? h.inputDir
              : join(h.cwd, "tasks");
      const before = await treeOrAbsent(raw);
      await h.apply(rawGuard, { rawDirs: [raw] });
      const observed = await observeAdmission(h.ctx);
      const lookup = vi.spyOn(fs.realpathSync, "native");
      try {
        const args = { input_dir: h.inputDir, ...(kind === "no-task" ? {} : { task_id: TASK }) };
        const record = await returnedRun(h, await h.call(args));
        expect(record.task_id).toBe(kind === "no-task" ? null : TASK);
        expect(observed.executions).toBe(1);
        expect(observed.approvals).toHaveLength(kind === "input-approval" ? 1 : 0);
        expect(submit).toHaveBeenCalledTimes(1);
        if (kind === "no-task") {
          expect(query).not.toHaveBeenCalled();
          // One configured raw-root resolution is allowed; there is no task-derived lookup.
          expect(
            lookup.mock.calls
              .map(([path]) => String(path))
              .filter((path) => path.includes("/tasks")),
          ).toEqual([join(h.cwd, "tasks")]);
          expect(fs.existsSync(join(h.cwd, "tasks"))).toBe(false);
        } else expect(query).toHaveBeenCalledExactlyOnceWith(TASK);
        expect(await treeOrAbsent(raw)).toEqual(before);
      } finally {
        lookup.mockRestore();
      }
    } finally {
      query.mockRestore();
      submit.mockRestore();
      await h.dispose();
    }
  },
  15_000,
);

test.each(["../reports/x", "TASK-0001", null])(
  "invalid linked id %j is tool-rejected, not a new raw task target",
  async (task_id) => {
    const h = await createToolHarness();
    const query = vi.spyOn(h.registry, "listRunJobsByTask");
    try {
      await h.apply(rawGuard, { rawDirs: [join(h.cwd, "tasks")] });
      const observed = await observeAdmission(h.ctx);
      expectToolError(await h.call({ input_dir: h.inputDir, task_id }), /task_id/u);
      expect(observed.executions).toBe(1);
      expect(observed.approvals).toEqual([]);
      expect(query).not.toHaveBeenCalled();
      expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(fs.existsSync(join(h.cwd, "tasks"))).toBe(false);
    } finally {
      query.mockRestore();
      await h.dispose();
    }
  },
);
