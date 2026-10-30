import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import {
  JobRecordIdSchema,
  ReportIdSchema,
  RunJobSchema,
  type RunJob,
} from "@shud-harness/dsh-shud-core";
import { barrier } from "../../dsh-shud-jobs/src/state-indexes/test-harness.ts";
import { enteredBeforeCompletion } from "../../dsh-shud-jobs/src/list-run-jobs/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";
import {
  TASK,
  cardSnapshot,
  expectLiveDurable,
  expectToolError,
  getCard,
  plannedCard,
  putCard,
  returnedRun,
  seedLiveRun,
  type CallResult,
} from "./task-linked/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) };
});
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.readFile).mockReset().mockImplementation(nativeIo.readFile);
  vi.mocked(io.rename).mockReset().mockImplementation(nativeIo.rename);
});

test.each(["planned", "reporting"] as const)(
  "card changed to %s while the real registry query awaits is read fresh before repair",
  async (status) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    const entered = barrier();
    const release = barrier();
    let pending: Promise<CallResult> | undefined;
    try {
      const old = await seedLiveRun(h);
      putCard(h);
      let held = false;
      vi.mocked(io.readFile).mockImplementation(async (...args) => {
        if (!held && args[0] === join(old.run_dir, "run-job.json")) {
          held = true;
          entered.release();
          await release.waiting;
        }
        return nativeIo.readFile(...args);
      });
      pending = h.call({ input_dir: h.inputDir, task_id: TASK });
      await enteredBeforeCompletion(entered.waiting, pending);
      const fresh = putCard(
        h,
        plannedCard({
          status,
          title: "fresh while registry awaits",
          current_owner: "fresh-owner",
          linked_reports: [ReportIdSchema.parse("REPORT-20261027T080007-cafe")],
        }),
      );
      const before = await cardSnapshot(h);
      release.release();
      const result = await pending;
      if (status === "reporting") {
        expectToolError(result, /reporting/u);
        expect(await cardSnapshot(h)).toEqual(before);
        expect(h.registry.indexes.read().active).toHaveLength(1);
      } else {
        const current = await returnedRun(h, result);
        const card = getCard(h);
        expect(card.updated_at).toBeTypeOf("string");
        expect(card).toEqual({
          ...fresh,
          status: "running",
          runtime_phase: "submitted_job",
          linked_jobs: [old.job_id, current.job_id].sort(),
          stack_id: current.stack_id,
          data_id: current.data_id,
          updated_at: card.updated_at,
        });
      }
    } finally {
      release.release();
      await pending;
      vi.mocked(io.readFile).mockImplementation(nativeIo.readFile);
      await h.dispose();
    }
  },
  20_000,
);

test.each(["first", "second"] as const)(
  "overlapping actual submissions released %s last preserve fresh fields and last-writer capture ids",
  async (last) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    const firstEntered = barrier();
    const secondEntered = barrier();
    const releaseFirst = barrier();
    const releaseSecond = barrier();
    const pending: Array<Promise<CallResult>> = [];
    const records = new Map<string, RunJob>();
    try {
      const original = putCard(h);
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        const record = String(target).endsWith("/run-job.json")
          ? RunJobSchema.parse(JSON.parse(await nativeIo.readFile(source, "utf8")))
          : undefined;
        await nativeIo.rename(source, target);
        if (record?.status !== "running") return;
        if (record.label !== "first" && record.label !== "second")
          throw new Error("Missing controlled submission label");
        records.set(record.label, record);
        const entered = record.label === "first" ? firstEntered : secondEntered;
        const release = record.label === "first" ? releaseFirst : releaseSecond;
        entered.release();
        await release.waiting;
      });
      const first = h.call({ input_dir: h.inputDir, task_id: TASK, label: "first" });
      pending.push(first);
      await enteredBeforeCompletion(firstEntered.waiting, first);
      // These private repositories start with empty commits. An untracked file changes
      // captured dirty state; response_model deliberately does not affect identity (K4).
      await io.writeFile(
        join(h.config.stackRepos.SHUD, "task-linked-capture.txt"),
        "second submission capture\n",
      );
      const second = h.call({ input_dir: h.inputDir, task_id: TASK, label: "second" });
      pending.push(second);
      await enteredBeforeCompletion(secondEntered.waiting, second);
      const firstRecord = records.get("first");
      const secondRecord = records.get("second");
      if (!firstRecord || !secondRecord)
        throw new Error("Both actual running checkpoints are required");
      expect(firstRecord.stack_id).not.toBe(secondRecord.stack_id);
      expect(firstRecord.data_id).not.toBe(secondRecord.data_id);
      const firstFinished = last === "first" ? second : first;
      const lastFinished = last === "first" ? first : second;
      const firstRelease = last === "first" ? releaseSecond : releaseFirst;
      const lastRelease = last === "first" ? releaseFirst : releaseSecond;
      firstRelease.release();
      await returnedRun(h, await firstFinished);
      const foreignJob = JobRecordIdSchema.parse("JOB-20261027T080007-cafe");
      const fresh = putCard(h, {
        ...getCard(h),
        type: "engineering",
        title: "fresh title",
        question_or_goal: "fresh goal",
        created_by: "fresh creator",
        current_owner: "fresh owner",
        reviewer: "fresh reviewer",
        created_at: "2026-10-27T07:00:00Z",
        inference_budget: {
          mode: "deep",
          advisory_usd: 19,
          advisory_model_calls: 11,
          reviewer_enabled: false,
        },
        theory_bundle_ids: ["fresh theory", "another theory"],
        linked_reports: [
          ...original.linked_reports,
          ReportIdSchema.parse("REPORT-20261027T080007-cafe"),
        ],
        linked_jobs: [...getCard(h).linked_jobs, foreignJob],
      });
      lastRelease.release();
      await returnedRun(h, await lastFinished);
      const winner = last === "first" ? firstRecord : secondRecord;
      const card = getCard(h);
      expect(card.updated_at).toBeTypeOf("string");
      expect(card).toEqual({
        ...fresh,
        status: "running",
        runtime_phase: "submitted_job",
        linked_jobs: [firstRecord.job_id, secondRecord.job_id, foreignJob].sort(),
        stack_id: winner.stack_id,
        data_id: winner.data_id,
        updated_at: card.updated_at,
      });
      expect(h.registry.indexes.read().active).toHaveLength(2);
      await expectLiveDurable(h, firstRecord);
      await expectLiveDurable(h, secondRecord);
    } finally {
      releaseFirst.release();
      releaseSecond.release();
      await Promise.allSettled(pending);
      vi.mocked(io.rename).mockImplementation(nativeIo.rename);
      await h.dispose();
    }
  },
  25_000,
);
