import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { CollectFixture } from "../collect-shud/test-harness.ts";
import { installFakeShud, observedStart, terminateGroup } from "../detached-shud/test-harness.ts";
import { readyRun } from "../kill-shud/test-harness.ts";
import { replaceRecord, waitForOwnershipRelease } from "../poll-shud/test-harness.ts";

/** Retire the registration owner without terminating its genuinely running wrapper. */
export async function stopWhileRunning(h: CollectFixture, beforeStop?: () => Promise<void>) {
  const running = await readyRun(h);
  const stamp = observedStart(running.pid);
  await beforeStop?.();
  await h.fiber.dispose();
  await waitForOwnershipRelease(h.stateDir);
  return { ...running, stamp };
}

/** Retain the real wrapper while recreating the submitted-before-running crash checkpoint. */
export async function stopAtSubmitted(h: CollectFixture, submittedOffsetMs?: number) {
  const running = await stopWhileRunning(h);
  const stamp = running.stamp;
  const submittedAt = running.record.submitted_at;
  if (submittedAt === null) throw new Error("Real submission has no timestamp");
  const submitted = await replaceRecord(running.record, {
    status: "submitted",
    pid: null,
    pid_started_at: null,
    started_at: null,
    submitted_at:
      submittedOffsetMs === undefined
        ? submittedAt
        : new Date(
            Math.floor(Date.parse(submittedAt) / 1000) * 1000 + submittedOffsetMs,
          ).toISOString(),
  });
  return { ...running, submitted, stamp };
}

export async function stopWithCancellation(h: CollectFixture, beforeStop?: () => Promise<void>) {
  await installFakeShud(h.shudBin, 0, "resistant");
  const running = await stopWhileRunning(h, beforeStop);
  const requestedAt = Date.now();
  const record = await replaceRecord(running.record, {
    cancel_requested_at: new Date(requestedAt).toISOString(),
  });
  return { ...running, record, requestedAt };
}

/** Callers first restore native fault seams and release any held I/O barriers. */
export async function closeRecovery(
  h: CollectFixture,
  pid: number | undefined,
  applying?: Promise<unknown>,
): Promise<void> {
  try {
    if (pid !== undefined) await terminateGroup(pid);
    await applying?.catch(() => undefined);
  } finally {
    await h.close();
  }
}

/**
 * Native-process barriers need real time while the recovery deadline stays pinned.
 * Vitest expect.poll advances fake timers, which would cross the +9999ms boundary.
 */
export async function waitForRecovery(
  predicate: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

export async function waitForTerm(runDir: string): Promise<void> {
  await waitForRecovery(async () => {
    try {
      return (await readFile(join(runDir, "sigterm-seen"), "utf8")) === "SIGTERM\n";
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }, "the native SIGTERM receipt");
}

export async function completedWithinWindow(operation: Promise<unknown>): Promise<void> {
  let settled = false;
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await waitForRecovery(() => settled, "recovery operation settlement");
  await operation;
}
