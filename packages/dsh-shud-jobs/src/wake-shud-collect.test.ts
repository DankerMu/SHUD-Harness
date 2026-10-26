import * as io from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { COLLECT_RETRY_INTERVAL_MS, MAX_COLLECT_ATTEMPTS } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import {
  expectAbsent,
  outputRoot,
  readLedger,
  readResult,
  type CollectFixture,
} from "./collect-shud/test-harness.ts";
import { readInvocation } from "./detached-shud/test-harness.ts";
import { readyRun } from "./kill-shud/test-harness.ts";
import {
  pollFixture,
  readRecord,
  releaseRun,
  replaceRecord,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";
import {
  collectedWake,
  deliveredWake,
  expectSingleWake,
  expectWakeEvidence,
} from "./wake-shud/test-harness.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function genuineCollectFailures(h: CollectFixture, failures = MAX_COLLECT_ATTEMPTS) {
  const running = await readyRun(h);
  const origin = vi.getRealSystemTime();
  vi.setSystemTime(origin);
  const root = outputRoot(running.record);
  await io.mkdir(root);
  const sentinel = join(h.root, "collection-sentinel.dat");
  await io.writeFile(sentinel, "PRIVATE_ARTIFACT_BYTES");
  const foreign = join(root, "foreign.dat");
  await io.symlink(sentinel, foreign);
  await releaseRun(running.record);
  const ledgerPath = join(running.record.run_dir, "collect-error.json");
  for (let attempt = 1; attempt <= failures; attempt++) {
    vi.setSystemTime(origin + (attempt - 1) * COLLECT_RETRY_INTERVAL_MS);
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      try {
        return (await readLedger(running.record.run_dir)).attempts === attempt;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    }, `genuine collection failure ${attempt}`);
    expect((await readLedger(running.record.run_dir)).at).toBe(
      new Date(origin + (attempt - 1) * COLLECT_RETRY_INTERVAL_MS).toISOString(),
    );
    expect(h.followups).toEqual([]);
    expect(h.flushes).toEqual([]);
  }
  await expectAbsent(join(running.record.run_dir, "run-record.json"));
  return {
    ...running,
    origin,
    foreign,
    sentinel,
    ledgerPath,
    entry: {
      run_id: running.record.run_id,
      job_id: running.record.job_id,
      run_dir: running.record.run_dir,
    },
  };
}

test("a genuinely capped collection failure remains pending headless and delivers a controlled R10 wake after late service activation", async () => {
  const h = await pollFixture(0, "held", "absent");
  try {
    const run = await genuineCollectFailures(h);
    const ledger = await readLedger(run.record.run_dir);
    expect(ledger.last_error).toBe("SHUD collect output scan: SYMLINK");
    const ledgerBytes = await io.readFile(run.ledgerPath);
    const ledgerMtime = (await io.stat(run.ledgerPath, { bigint: true })).mtimeNs;
    const terminal = await readRecord(run.record.run_dir);
    expect(terminal.status).not.toBe("collected");
    expect(terminal.notify).toMatchObject({ status: "pending", attempts: 0, at: null });
    expect(h.registry.indexes.read()).toEqual({ active: [run.entry], completed: [] });
    await h.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);
    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const replacement = actualRegistry(h.ctx);
    await replacement.pollOnce();
    expect((await readRecord(run.record.run_dir)).notify).toMatchObject({
      status: "pending",
      attempts: 0,
      at: null,
    });
    expect(h.followups).toEqual([]);
    expect(h.flushes).toEqual([]);
    await h.mountSessionController();
    await waitForRecovery(async () => {
      await replacement.pollOnce();
      return h.followups.length > 0;
    }, "one controlled wake for the capped collection failure");
    await deliveredWake(replacement, run.record.run_dir);
    expect(h.followups).toHaveLength(1);
    const [{ sessionId, message }] = h.followups;
    expect(sessionId).toBe(h.ownerId);
    expect(message).toMatchObject({ role: "user", source: { kind: "shud-jobs" } });
    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    expect(text).toContain(run.record.run_id);
    expect(text).toMatch(/collect.*fail|fail.*collect/iu);
    expect(text).toContain("output scan");
    expect(text).toContain("SYMLINK");
    expect(text).not.toContain("PRIVATE_ARTIFACT_BYTES");
    expect(text).not.toMatch(/exit_class\s*[:=]\s*ok/iu);
    expect(h.errors.join("\n")).not.toContain("PRIVATE_");
    expect(h.flushes).toEqual([h.ownerId]);
    expect(h.sessionEvents.filter((event) => event.type === "job/settled")).toEqual([]);
    expect(await readRecord(run.record.run_dir)).toMatchObject({
      status: terminal.status,
      notify: { status: "delivered", attempts: 0 },
    });
    expect(replacement.indexes.read()).toEqual({ active: [], completed: [run.entry] });
    await expectAbsent(join(run.record.run_dir, "run-record.json"));
    await replacement.pollOnce();
    await replacement.pollOnce();
    expect(h.followups).toHaveLength(1);
    expect(await io.readFile(run.ledgerPath)).toEqual(ledgerBytes);
    expect((await io.stat(run.ledgerPath, { bigint: true })).mtimeNs).toBe(ledgerMtime);
    expect(await io.readFile(run.sentinel, "utf8")).toBe("PRIVATE_ARTIFACT_BYTES");
    expect(await readInvocation(run.record.run_dir)).toEqual(run.invocation);
    expect(run.producer.executions).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 15000);

test("completed-index migration ends an uncommitted original observation before a later direct retry", async () => {
  const h = await pollFixture(0, "held", "absent");
  try {
    const run = await genuineCollectFailures(h);
    const terminal = await readRecord(run.record.run_dir);
    expect(terminal.status).toBe("succeeded");
    expect(terminal.started_at).toBe(run.record.started_at);
    expect(terminal.finished_at).toEqual(expect.any(String));
    expect(run.producer.completed).toHaveLength(1);
    expect((await readLedger(run.record.run_dir)).attempts).toBe(MAX_COLLECT_ATTEMPTS);
    const ledgerBytes = await io.readFile(run.ledgerPath);
    const ledgerMtime = (await io.stat(run.ledgerPath, { bigint: true })).mtimeNs;
    expect(h.registry.indexes.read()).toEqual({ active: [run.entry], completed: [] });

    // Keep the original registry: a reload would lose observations independently of migration.
    await h.mountSessionController();
    await deliveredWake(h.registry, run.record.run_dir);
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [run.entry] });
    const notified = await readRecord(run.record.run_dir);
    expect(notified).toMatchObject({
      status: "succeeded",
      finished_at: terminal.finished_at,
      notify: { status: "delivered", attempts: 0 },
    });
    const resultPath = join(run.record.run_dir, "run-record.json");
    await expectAbsent(resultPath);
    expect(h.followups).toHaveLength(1);
    expect(JSON.stringify(h.followups[0].message)).toContain("SYMLINK");
    expect(h.flushes).toEqual([h.ownerId]);

    await io.unlink(run.foreign);
    const result = await h.registry.collectShud(run.record.run_id);
    expect(result).toMatchObject({
      run_id: run.record.run_id,
      job_id: run.record.job_id,
      exit_code: 0,
      exit_class: "ok",
      resources: { wall_seconds: null },
    });
    expect(await readRecord(run.record.run_dir)).toEqual({ ...notified, status: "collected" });
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [run.entry] });
    expect(await io.readFile(run.ledgerPath)).toEqual(ledgerBytes);
    expect((await io.stat(run.ledgerPath, { bigint: true })).mtimeNs).toBe(ledgerMtime);
    const resultBytes = await io.readFile(resultPath);
    const resultMtime = (await io.stat(resultPath, { bigint: true })).mtimeNs;
    expect(await h.registry.collectShud(run.record.job_id)).toEqual(result);
    expect(await io.readFile(resultPath)).toEqual(resultBytes);
    expect((await io.stat(resultPath, { bigint: true })).mtimeNs).toBe(resultMtime);
    await h.registry.pollOnce();
    expect(h.followups).toHaveLength(1);
    expect(h.flushes).toEqual([h.ownerId]);
    expect(await readInvocation(run.record.run_dir)).toEqual(run.invocation);
    expect(run.producer.executions).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 15000);

test.each([
  {
    form: "filesystem errno",
    reason: "SHUD collect output scan: EIO",
    expected: ["output scan", "EIO"],
    excluded: [],
  },
  {
    form: "composite filesystem errnos",
    reason: "SHUD collect run-record publication: EIO+ENOSPC",
    expected: ["run-record publication", "EIO", "ENOSPC"],
    excluded: [],
  },
  {
    form: "validation without its field path",
    reason: "SHUD collect RunRecord: VALIDATION resources.wall_seconds",
    expected: ["RunRecord", "VALIDATION"],
    excluded: ["resources.wall_seconds"],
  },
])(
  "a capped historical $form reason produces one controlled failure wake",
  async ({ reason, expected, excluded }) => {
    const h = await pollFixture(0, "held", "absent");
    try {
      const run = await genuineCollectFailures(h);
      const ledger = await readLedger(run.record.run_dir);
      expect(ledger.attempts).toBe(MAX_COLLECT_ATTEMPTS);
      // Keep the genuine durable cap/time while representing another honest producer diagnostic.
      await io.writeFile(run.ledgerPath, JSON.stringify({ ...ledger, last_error: reason }));
      const bytes = await io.readFile(run.ledgerPath);
      const mtime = (await io.stat(run.ledgerPath, { bigint: true })).mtimeNs;
      const terminal = await readRecord(run.record.run_dir);
      expect(terminal.status).toBe("succeeded");
      expect(terminal.notify).toMatchObject({ status: "pending", attempts: 0, at: null });
      expect(h.registry.indexes.read()).toEqual({ active: [run.entry], completed: [] });

      await h.mountSessionController();
      await deliveredWake(h.registry, run.record.run_dir);
      expect(h.followups).toHaveLength(1);
      const [{ sessionId, message }] = h.followups;
      expect(sessionId).toBe(h.ownerId);
      expect(message).toMatchObject({ role: "user", source: { kind: "shud-jobs" } });
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      expect(text).toContain(run.record.run_id);
      expect(text).toMatch(/collect.*fail|fail.*collect/iu);
      for (const token of expected) expect(text).toContain(token);
      for (const fieldPath of excluded) {
        expect(JSON.stringify(message)).not.toContain(fieldPath);
        expect(h.errors.join("\n")).not.toContain(fieldPath);
      }
      expect(text).not.toMatch(/exit_class\s*[:=]\s*ok/iu);
      expect(text).not.toContain("PRIVATE_ARTIFACT_BYTES");
      expect(h.flushes).toEqual([h.ownerId]);
      expect(h.sessionEvents.filter((event) => event.type === "job/settled")).toEqual([]);
      expect(await readRecord(run.record.run_dir)).toMatchObject({
        status: terminal.status,
        notify: { status: "delivered", attempts: 0 },
      });
      expect(h.registry.indexes.read()).toEqual({ active: [], completed: [run.entry] });
      await expectAbsent(join(run.record.run_dir, "run-record.json"));
      await h.registry.pollOnce();
      await h.registry.pollOnce();
      expect(h.followups).toHaveLength(1);
      expect(h.flushes).toEqual([h.ownerId]);
      expect(await io.readFile(run.ledgerPath)).toEqual(bytes);
      expect((await io.stat(run.ledgerPath, { bigint: true })).mtimeNs).toBe(mtime);
      expect(await io.readFile(run.sentinel, "utf8")).toBe("PRIVATE_ARTIFACT_BYTES");
      expect(await readInvocation(run.record.run_dir)).toEqual(run.invocation);
      expect(run.producer.executions).toHaveLength(1);
    } finally {
      await h.close();
    }
  },
  15000,
);

test.each(["invalid timestamp", "untrusted stage", "untrusted code"] as const)(
  "a capped ledger with %s cannot authorize a failure wake or overwrite its evidence",
  async (kind) => {
    const h = await pollFixture(0, "held", "absent");
    try {
      const run = await genuineCollectFailures(h);
      const ledger = await readLedger(run.record.run_dir);
      await io.writeFile(
        run.ledgerPath,
        JSON.stringify({
          ...ledger,
          at: kind === "invalid timestamp" ? "invalid-time" : ledger.at,
          last_error:
            kind === "untrusted stage"
              ? "SHUD collect PRIVATE_STAGE: SYMLINK"
              : kind === "untrusted code"
                ? "SHUD collect output scan: PRIVATE_CODE"
                : ledger.last_error,
        }),
      );
      const bytes = await io.readFile(run.ledgerPath);
      const mtime = (await io.stat(run.ledgerPath, { bigint: true })).mtimeNs;
      await h.mountSessionController();
      // A healthy run on the same registry establishes live delivery, so absent services cannot
      // accidentally satisfy the corrupt-ledger/no-wake oracle.
      vi.setSystemTime(vi.getRealSystemTime());
      h.request.owner_session = h.otherId;
      const healthy = await collectedWake(h);
      await deliveredWake(h.registry, healthy.running.run_dir);
      await h.registry.pollOnce();
      expect(h.followups).toHaveLength(1);
      expect(h.followups[0].sessionId).toBe(h.otherId);
      expect(JSON.stringify(h.followups[0].message)).toContain(healthy.running.run_id);
      expect(JSON.stringify(h.followups[0].message)).not.toContain(run.record.run_id);
      expect(h.flushes).toEqual([h.otherId]);
      expect((await readRecord(run.record.run_dir)).notify).toMatchObject({
        status: "pending",
        attempts: 0,
        at: null,
      });
      expect(h.registry.indexes.read()).toEqual({
        active: [run.entry],
        completed: [healthy.entry],
      });
      expect(await io.readFile(run.ledgerPath)).toEqual(bytes);
      expect((await io.stat(run.ledgerPath, { bigint: true })).mtimeNs).toBe(mtime);
      if (kind === "invalid timestamp") expect(h.errors.join("\n")).toMatch(/INVALID_FIELDS/u);
      expect(h.errors.join("\n")).not.toContain("PRIVATE_");
      await expectAbsent(join(run.record.run_dir, "run-record.json"));
      await expectWakeEvidence(healthy);
    } finally {
      await h.close();
    }
  },
  15000,
);

test("a recent uncapped collection failure cannot wake early and later produces the factual success wake", async () => {
  const h = await pollFixture(0, "held", "absent");
  try {
    const run = await genuineCollectFailures(h, 1);
    const bytes = await io.readFile(run.ledgerPath);
    const mtime = (await io.stat(run.ledgerPath, { bigint: true })).mtimeNs;
    await io.rm(run.foreign);
    await h.mountSessionController();
    for (const offset of [1000, COLLECT_RETRY_INTERVAL_MS - 1]) {
      vi.setSystemTime(run.origin + offset);
      await h.registry.pollOnce();
      await h.registry.pollOnce();
      expect(h.followups).toEqual([]);
      expect(h.flushes).toEqual([]);
      expect((await readRecord(run.record.run_dir)).notify.status).toBe("pending");
      await expectAbsent(join(run.record.run_dir, "run-record.json"));
      expect(await io.readFile(run.ledgerPath)).toEqual(bytes);
    }
    vi.setSystemTime(run.origin + COLLECT_RETRY_INTERVAL_MS);
    await deliveredWake(h.registry, run.record.run_dir);
    expectSingleWake(h, run.record.run_id, "ok", 0);
    expect(await readResult(run.record.run_dir)).toMatchObject({
      exit_class: "ok",
      artifacts: { files: [] },
    });
    expect(await io.readFile(run.ledgerPath)).toEqual(bytes);
    expect((await io.stat(run.ledgerPath, { bigint: true })).mtimeNs).toBe(mtime);
  } finally {
    await h.close();
  }
}, 15000);

test.each(["capped", "recent", "corrupt"] as const)(
  "a committed RunRecord outranks a %s ledger for R9 repair and the eventual success wake",
  async (kind) => {
    const h = await pollFixture(0, "held", "absent");
    try {
      const run = await collectedWake(h);
      await h.fiber.dispose();
      await waitForOwnershipRelease(h.stateDir);
      const collected = await readRecord(run.running.run_dir);
      await replaceRecord(collected, { status: "succeeded" });
      const ledgerPath = join(run.running.run_dir, "collect-error.json");
      const ledger =
        kind === "corrupt"
          ? "not-json PRIVATE_HISTORICAL_LEDGER"
          : JSON.stringify({
              attempts: kind === "capped" ? MAX_COLLECT_ATTEMPTS : 1,
              at: new Date(run.origin).toISOString(),
              last_error: "PRIVATE_HISTORICAL_LEDGER",
            });
      await io.writeFile(ledgerPath, ledger);
      const mtime = (await io.stat(ledgerPath, { bigint: true })).mtimeNs;
      await h.mountSessionController();
      await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      const replacement = actualRegistry(h.ctx);
      expect((await readRecord(run.running.run_dir)).status).toBe("collected");
      await deliveredWake(replacement, run.running.run_dir);
      expectSingleWake(h, run.running.run_id, "ok", 0);
      expect(await io.readFile(ledgerPath, "utf8")).toBe(ledger);
      expect((await io.stat(ledgerPath, { bigint: true })).mtimeNs).toBe(mtime);
      expect(h.errors.join("\n")).not.toContain("PRIVATE_HISTORICAL_LEDGER");
      await expectWakeEvidence(run);
    } finally {
      await h.close();
    }
  },
  15000,
);
