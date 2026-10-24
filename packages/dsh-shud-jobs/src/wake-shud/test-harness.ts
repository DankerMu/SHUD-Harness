import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { RunId, RunJob, RunRecord } from "@shud-harness/dsh-shud-core";
import type { ShudJobRegistry } from "../index.ts";
import { readResult, type CollectFixture } from "../collect-shud/test-harness.ts";
import { readInvocation, type Invocation } from "../detached-shud/test-harness.ts";
import { readRecord, releaseRun, waitForEvidence } from "../poll-shud/test-harness.ts";
import { waitForRecovery } from "../reconcile-shud/test-harness.ts";

export interface WakeEvidence {
  running: RunJob;
  invocation: Invocation | null;
  result: RunRecord;
  resultPath: string;
  resultBytes: Buffer;
  resultMtime: bigint;
}

/** Callers freeze only Date/intervals; native execution and bounded observation remain real. */
export async function collectedWake(h: CollectFixture) {
  const { producer, pending } = h.start();
  const running = await pending;
  waitForEvidence(running.run_dir, "invocation.json");
  const invocation = await readInvocation(running.run_dir);
  expect(invocation).toMatchObject({ ppid: running.pid, cwd: running.run_dir });
  const origin = vi.getRealSystemTime();
  vi.setSystemTime(origin);
  await releaseRun(running);
  await waitForRecovery(async () => {
    await h.registry.pollOnce();
    return (await readRecord(running.run_dir)).status === "collected";
  }, "genuine native completion and collection before wake delivery");
  const result = await readResult(running.run_dir);
  expect(result).toMatchObject({ run_id: running.run_id, exit_code: 0, exit_class: "ok" });
  const resultPath = join(running.run_dir, "run-record.json");
  return {
    running,
    invocation,
    producer,
    origin,
    result,
    resultPath,
    resultBytes: await io.readFile(resultPath),
    resultMtime: (await io.stat(resultPath, { bigint: true })).mtimeNs,
    entry: { run_id: running.run_id, job_id: running.job_id, run_dir: running.run_dir },
  };
}

export async function expectWakeEvidence(evidence: WakeEvidence): Promise<void> {
  expect(await readResult(evidence.running.run_dir)).toEqual(evidence.result);
  expect(await io.readFile(evidence.resultPath)).toEqual(evidence.resultBytes);
  expect((await io.stat(evidence.resultPath, { bigint: true })).mtimeNs).toBe(evidence.resultMtime);
  expect(await readInvocation(evidence.running.run_dir)).toEqual(evidence.invocation);
}

export async function deliveredWake(registry: ShudJobRegistry, runDir: string): Promise<void> {
  await waitForRecovery(async () => {
    await registry.pollOnce();
    return (await readRecord(runDir)).notify.status === "delivered";
  }, "durably delivered notification");
  await waitForRecovery(async () => {
    await registry.pollOnce();
    return !registry.indexes.read().active.some((entry) => entry.run_dir === runDir);
  }, "completed-index migration after delivery");
}

export function expectSingleWake(
  h: CollectFixture,
  runId: RunId,
  exitClass: RunRecord["exit_class"],
  artifacts: number,
): void {
  expect(h.followups).toHaveLength(1);
  const [{ sessionId, message }] = h.followups;
  expect(sessionId).toBe(h.ownerId);
  expect(message).toMatchObject({ role: "user", source: { kind: "shud-jobs" } });
  expect(message.id).toEqual(expect.any(String));
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  expect(text).toContain(runId);
  expect(text).toMatch(new RegExp(`\\b${exitClass}\\b`, "u"));
  expect(text).toMatch(new RegExp(`\\b${artifacts}\\b`, "u"));
  expect(h.flushes).toEqual([h.ownerId]);
  expect(h.sessionEvents.filter((event) => event.type === "job/settled")).toEqual([]);
}
