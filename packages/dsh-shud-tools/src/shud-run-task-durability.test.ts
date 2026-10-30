import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { RunJobSchema, type RunJob, type TaskCard } from "@shud-harness/dsh-shud-core";
import { createToolHarness } from "./test-harness.ts";
import {
  TASK,
  OTHER_TASK,
  PRIVATE_FAULT,
  cardPath,
  cardSnapshot,
  expectLiveDurable,
  expectToolError,
  getCard,
  plannedCard,
  putCard,
  returnedRun,
  seedLiveRun,
  submissionSnapshot,
  treeOrAbsent,
} from "./task-linked/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const nativeFs = await vi.importActual<typeof fs>("node:fs");
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");
beforeEach(() => {
  vi.mocked(fs.renameSync).mockReset().mockImplementation(nativeFs.renameSync);
  vi.mocked(io.rename).mockReset().mockImplementation(nativeIo.rename);
});

async function runNames(cwd: string) {
  return io.readdir(join(cwd, "runs")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
}

test("no-op initial reconciliation leaves bytes and mtime unchanged when new input validation fails", async () => {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  try {
    putCard(h);
    const before = await cardSnapshot(h);
    const writes = vi.mocked(fs.renameSync);
    writes.mockClear();
    await io.unlink(join(h.inputDir, "tiny.cfg.para"));
    expectToolError(await h.call({ input_dir: h.inputDir, task_id: TASK }), /tiny\.cfg\.para/u);
    expect(await cardSnapshot(h)).toEqual(before);
    expect(writes.mock.calls.filter(([, target]) => target === cardPath(h))).toEqual([]);
    expect(await runNames(h.cwd)).toEqual([]);
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
  } finally {
    await h.dispose();
  }
});

test.each([false, true])(
  "live-job repair is committed before new producer; submission fails=%s",
  async (fails) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    try {
      const old = await seedLiveRun(h);
      const original = putCard(h);
      const submissions = vi.spyOn(h.registry, "submitShud");
      let repairAtPublication: TaskCard | undefined;
      let cardAtFirstRunWrite: unknown;
      vi.mocked(fs.renameSync).mockImplementation((source, target) => {
        nativeFs.renameSync(source, target);
        if (target === cardPath(h) && submissions.mock.calls.length === 0)
          repairAtPublication = getCard(h);
      });
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (String(target).endsWith("/run-job.json")) cardAtFirstRunWrite ??= getCard(h);
        await nativeIo.rename(source, target);
      });
      if (fails) await io.unlink(join(h.inputDir, "tiny.cfg.para"));
      try {
        const result = await h.call({ input_dir: h.inputDir, task_id: TASK });
        if (!repairAtPublication) throw new Error("Initial task repair was not published");
        expect(repairAtPublication.updated_at).toBeTypeOf("string");
        const repaired = {
          ...original,
          status: "running",
          runtime_phase: "submitted_job",
          linked_jobs: [old.job_id],
          stack_id: old.stack_id,
          data_id: old.data_id,
          updated_at: repairAtPublication.updated_at,
        };
        expect(repairAtPublication).toEqual(repaired);
        expect(submissions).toHaveBeenCalledTimes(1);
        if (fails) {
          expectToolError(result, /tiny\.cfg\.para/u);
          expect(getCard(h)).toEqual(repairAtPublication);
          expect(await runNames(h.cwd)).toEqual([old.run_id]);
          expect(h.registry.indexes.read().active).toHaveLength(1);
        } else {
          const current = await returnedRun(h, result);
          expect(cardAtFirstRunWrite).toEqual(repaired);
          expect(getCard(h).linked_jobs).toEqual([old.job_id, current.job_id].sort());
        }
      } finally {
        submissions.mockRestore();
      }
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
      vi.mocked(io.rename).mockImplementation(nativeIo.rename);
      await h.dispose();
    }
  },
  20_000,
);

test("failed initial repair publication leaves original bytes and mtime and prevents new submit and producer", async () => {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  try {
    await seedLiveRun(h);
    putCard(h);
    const before = await cardSnapshot(h);
    const submissionBefore = await submissionSnapshot(h);
    const submit = vi.spyOn(h.registry, "submitShud");
    const producerStarts = vi.spyOn(h.registry, "start");
    let failures = 0;
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (target === cardPath(h)) {
        failures++;
        throw new Error(PRIVATE_FAULT);
      }
      nativeFs.renameSync(source, target);
    });
    try {
      const message = expectToolError(
        await h.call({ input_dir: h.inputDir, task_id: TASK }),
        /write|task|workspace/iu,
      );
      expect(message).not.toContain(PRIVATE_FAULT);
      expect(failures).toBe(1);
      expect(submit).not.toHaveBeenCalled();
      expect(producerStarts).not.toHaveBeenCalled();
      expect(await cardSnapshot(h)).toEqual(before);
      expect(await io.readdir(join(h.cwd, "tasks", TASK))).toEqual(["task.json"]);
      expect(await submissionSnapshot(h)).toEqual(submissionBefore);
    } finally {
      submit.mockRestore();
      producerStarts.mockRestore();
    }
  } finally {
    vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
    await h.dispose();
  }
}, 15_000);

test.each(["repository", "provenance"])(
  "actual tool to records %s capture failure preserves the card and old run",
  async (kind) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    try {
      const old = await seedLiveRun(h);
      putCard(
        h,
        plannedCard({
          status: "running",
          runtime_phase: "submitted_job",
          linked_jobs: [old.job_id],
          stack_id: old.stack_id,
          data_id: old.data_id,
        }),
      );
      const cardBefore = await cardSnapshot(h);
      const before = await submissionSnapshot(h);
      const submit = vi.spyOn(h.registry, "submitShud");
      const producerStarts = vi.spyOn(h.registry, "start");
      let publicationFailures = 0;
      if (kind === "repository") {
        await io.rename(join(h.config.stackRepos.AutoSHUD, ".git"), join(h.root, "disabled-git"));
      } else {
        vi.mocked(fs.renameSync).mockImplementation((source, target) => {
          if (String(target).includes("/provenance/")) {
            publicationFailures++;
            throw new Error(PRIVATE_FAULT);
          }
          nativeFs.renameSync(source, target);
        });
      }
      try {
        expectToolError(
          await h.call({ input_dir: h.inputDir, task_id: TASK }),
          kind === "repository" ? /AutoSHUD|git|repository/iu : /write|provenance/iu,
        );
        expect(submit).toHaveBeenCalledTimes(1);
        expect(producerStarts).not.toHaveBeenCalled();
        if (kind === "provenance") expect(publicationFailures).toBe(1);
        expect(await cardSnapshot(h)).toEqual(cardBefore);
        expect(h.registry.indexes.read()).toEqual(before.indexes);
        expect(await runNames(h.cwd)).toEqual([old.run_id]);
        expect(await io.readdir(join(h.cwd, "provenance"))).toEqual([`${old.data_id}.json`]);
        await expectLiveDurable(h, old);
      } finally {
        submit.mockRestore();
        producerStarts.mockRestore();
      }
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
      await h.dispose();
    }
  },
  20_000,
);

test.each(["write", "reporting", "done", "missing", "corrupt", "foreign"])(
  "post-durable %s card failure keeps actual process, run, index and evidence and can later reconcile",
  async (kind) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    let durable: RunJob | undefined;
    let changedCard: { bytes: Buffer; mtime: bigint } | undefined;
    let failedWrites = 0;
    try {
      const original = putCard(h);
      const foreign = putCard(
        h,
        plannedCard({ task_id: OTHER_TASK, title: "foreign-card-do-not-rewrite" }),
      );
      const foreignPath = cardPath(h, OTHER_TASK);
      const foreignBefore = await treeOrAbsent(foreignPath);
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        const candidate = String(target).endsWith("/run-job.json")
          ? RunJobSchema.parse(JSON.parse(await nativeIo.readFile(source, "utf8")))
          : undefined;
        await nativeIo.rename(source, target);
        if (candidate?.status !== "running" || durable) return;
        durable = candidate;
        if (kind === "missing") await nativeIo.unlink(cardPath(h));
        else if (kind === "corrupt") await nativeIo.writeFile(cardPath(h), PRIVATE_FAULT);
        else if (kind === "foreign") await nativeIo.writeFile(cardPath(h), JSON.stringify(foreign));
        else if (kind === "reporting" || kind === "done") putCard(h, { ...original, status: kind });
        if (kind !== "missing") changedCard = await cardSnapshot(h);
      });
      vi.mocked(fs.renameSync).mockImplementation((source, target) => {
        if (durable && kind === "write" && target === cardPath(h)) {
          failedWrites++;
          throw new Error(PRIVATE_FAULT);
        }
        nativeFs.renameSync(source, target);
      });
      const result = await h.call({ input_dir: h.inputDir, task_id: TASK });
      const message = expectToolError(result, /运行已 durable、任务卡回写失败/u);
      if (!durable) throw new Error("Actual durable running publication was not reached");
      expect(message).toContain(durable.run_id);
      expect(message).not.toContain(PRIVATE_FAULT);
      expect(durable.task_id).toBe(TASK);
      expect(failedWrites).toBe(kind === "write" ? 1 : 0);
      await expectLiveDurable(h, durable);
      expect(h.registry.indexes.read().active).toHaveLength(1);
      if (kind === "missing") expect(nativeFs.existsSync(cardPath(h))).toBe(false);
      else expect(await cardSnapshot(h)).toEqual(changedCard);
      expect(await treeOrAbsent(foreignPath)).toEqual(foreignBefore);
      vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
      vi.mocked(io.rename).mockImplementation(nativeIo.rename);
      putCard(h, original);
      await io.unlink(join(h.inputDir, "tiny.cfg.para"));
      expectToolError(await h.call({ input_dir: h.inputDir, task_id: TASK }), /tiny\.cfg\.para/u);
      const card = getCard(h);
      expect(card.updated_at).toBeTypeOf("string");
      expect(card).toEqual({
        ...original,
        status: "running",
        runtime_phase: "submitted_job",
        linked_jobs: [durable.job_id],
        stack_id: durable.stack_id,
        data_id: durable.data_id,
        updated_at: card.updated_at,
      });
      expect(h.registry.indexes.read().active).toHaveLength(1);
      await expectLiveDurable(h, durable);
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
      vi.mocked(io.rename).mockImplementation(nativeIo.rename);
      await h.dispose();
    }
  },
  20_000,
);
