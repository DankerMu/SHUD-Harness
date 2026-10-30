import * as io from "node:fs/promises";
import { beforeEach, expect, test, vi } from "vitest";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { barrier } from "./state-indexes/test-harness.ts";
import { pollFixture, settlingProducer, waitForEvidence } from "./poll-shud/test-harness.ts";
import {
  TARGET_TASK,
  enteredBeforeCompletion,
  settlesWhileHeld,
  snapshotQueryTree,
} from "./list-run-jobs/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.rename).mockReset().mockImplementation(nativeIo.rename);
});

test.each(["submitted", "running"] as const)(
  "a real D7 %s checkpoint is queryable without waiting for submission completion",
  async (status) => {
    // Unlike the config-only query fixtures, a real submission requires real Git capture inputs.
    const h = await pollFixture();
    const entered = barrier();
    const release = barrier();
    let current: RunJob | undefined;
    try {
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (typeof target === "string" && target.endsWith("/run-job.json")) {
          const candidate = RunJobSchema.parse(JSON.parse(await nativeIo.readFile(source, "utf8")));
          if (candidate.status === status) {
            await nativeIo.rename(source, target);
            current = candidate;
            entered.release();
            await release.waiting;
            return;
          }
        }
        await nativeIo.rename(source, target);
      });
      const producer = settlingProducer();
      h.producers.push(producer);
      const pending = h.registry.submitShud({ ...h.request, task_id: TARGET_TASK }, producer.start);
      h.submissions.push(pending);
      void pending.catch(() => undefined);
      await enteredBeforeCompletion(entered.waiting, pending);
      if (!current) throw new Error("Submission did not reach the selected durable checkpoint");
      const checkpoint = current;
      expect(h.registry.isSubmissionInFlight(checkpoint.run_id)).toBe(true);
      expect(checkpoint.stack_id).not.toBeNull();
      expect(checkpoint.data_id).not.toBeNull();
      if (status === "running") waitForEvidence(checkpoint.run_dir, "invocation.json");
      const before = await snapshotQueryTree(h.root);
      const errors = [...h.errors];
      expect(await settlesWhileHeld(h.registry.listRunJobsByTask(TARGET_TASK))).toEqual([
        checkpoint,
      ]);
      expect(h.registry.isSubmissionInFlight(checkpoint.run_id)).toBe(true);
      expect(await snapshotQueryTree(h.root)).toEqual(before);
      expect(h.errors).toEqual(errors);
      release.release();
      await pending;
    } finally {
      release.release();
      vi.mocked(io.rename).mockImplementation(nativeIo.rename);
      await h.close();
    }
  },
  15000,
);
