import { execFileSync } from "node:child_process";
import * as io from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type { RunJob } from "@shud-harness/dsh-shud-core";
import { barrier } from "./state-indexes/test-harness.ts";
import {
  OTHER_TASK,
  PRIVATE_PAYLOAD,
  TARGET_TASK,
  UNKNOWN_TASK,
  enteredBeforeCompletion,
  expectQueryFailure,
  observe,
  queryFixture,
  seedQueryRun,
  snapshotQueryTree,
  writeQueryRecord,
} from "./list-run-jobs/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.readFile).mockReset().mockImplementation(nativeIo.readFile);
});

const corruptions = [
  "malformed-json",
  "terminal-schema",
  "nested-schema",
  "missing-field",
  "unknown-field",
  "running-without-pid",
  "invalid-status",
  "run-id",
  "job-id",
  "run-dir",
  "missing-metadata",
  "unreadable-metadata",
  "metadata-symlink",
  "metadata-directory",
  "metadata-fifo",
  "run-symlink",
  "run-not-directory",
  "parent-symlink",
] as const;
type Corruption = (typeof corruptions)[number];

async function damage(record: RunJob, kind: Corruption): Promise<() => Promise<void>> {
  const path = join(record.run_dir, "run-job.json");
  const changes: Partial<Record<Corruption, object>> = {
    "terminal-schema": { input_bytes: PRIVATE_PAYLOAD },
    "nested-schema": { llm: { response_model: PRIVATE_PAYLOAD, response_model_source: "invalid" } },
    "missing-field": { notify: undefined },
    "unknown-field": { [PRIVATE_PAYLOAD]: "not a canonical RunJob field" },
    "running-without-pid": { status: "running", pid: null },
    "invalid-status": { status: PRIVATE_PAYLOAD },
    "run-id": { run_id: "RUN-20261022T031500-ffff" },
    "job-id": { job_id: "JOB-20261022T031500-ffff" },
    "run-dir": { run_dir: `/foreign/${PRIVATE_PAYLOAD}` },
  };
  if (kind === "malformed-json" || changes[kind]) {
    await io.writeFile(
      path,
      kind === "malformed-json"
        ? `{"secret":"${PRIVATE_PAYLOAD}",`
        : JSON.stringify({ ...record, ...changes[kind] }),
    );
    return () => writeQueryRecord(record);
  }
  if (kind === "unreadable-metadata") {
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      if (args[0] === path) {
        throw Object.assign(new Error(PRIVATE_PAYLOAD, { cause: new Error(PRIVATE_PAYLOAD) }), {
          code: "EACCES",
        });
      }
      return nativeIo.readFile(...args);
    });
    return () => {
      vi.mocked(io.readFile).mockImplementation(nativeIo.readFile);
      return Promise.resolve();
    };
  }
  const target =
    kind === "parent-symlink"
      ? dirname(record.run_dir)
      : kind === "run-symlink" || kind === "run-not-directory"
        ? record.run_dir
        : path;
  const saved = `${target}.owned`;
  await io.rename(target, saved);
  switch (kind) {
    case "missing-metadata":
      break;
    case "metadata-symlink":
    case "run-symlink":
    case "parent-symlink":
      await io.symlink(saved, target);
      break;
    case "metadata-directory":
      await io.mkdir(target);
      break;
    case "metadata-fifo":
      execFileSync("mkfifo", [target]);
      // Trap an unsafe open so a regression fails its no-read assertion rather than hanging on FIFO.
      vi.mocked(io.readFile).mockImplementation(async (...args) => {
        if (args[0] === path) throw new Error(PRIVATE_PAYLOAD);
        return nativeIo.readFile(...args);
      });
      break;
    case "run-not-directory":
      await io.writeFile(target, PRIVATE_PAYLOAD);
      break;
    default:
      throw new Error(`Unhandled query fixture corruption: ${kind}`);
  }
  return async () => {
    await io.rm(target, { recursive: true, force: true });
    await io.rename(saved, target);
    vi.mocked(io.readFile).mockImplementation(nativeIo.readFile);
  };
}

test.each(corruptions)(
  "%s in an unrelated indexed run rejects matching and unknown tasks, preserves evidence, and can be repaired",
  async (kind) => {
    const h = await queryFixture();
    let repair: (() => Promise<void>) | undefined;
    try {
      const good = await seedQueryRun(h, "a001");
      const bad = await seedQueryRun(
        h,
        "b002",
        {
          task_id: kind === "nested-schema" ? null : OTHER_TASK,
          status: "collected",
          // Give the corrupt run an independent parent for parent-path replacement cases.
          run_dir: join(h.cwd, "other-runs", "RUN-20261022T031500-b002"),
        },
        corruptions.indexOf(kind) % 2 === 0 ? "completed" : "active",
      );
      repair = await damage(bad, kind);
      const before = await snapshotQueryTree(h.root);
      const indexes = h.registry.indexes.read();
      const logs = [...h.logs];
      for (const task of [TARGET_TASK, UNKNOWN_TASK]) {
        await expectQueryFailure(h.registry.listRunJobsByTask(task), bad.run_id);
        expect(await snapshotQueryTree(h.root)).toEqual(before);
        expect(h.registry.indexes.read()).toEqual(indexes);
        expect(h.logs).toEqual(logs);
      }
      if (["metadata-fifo", "metadata-symlink", "metadata-directory"].includes(kind)) {
        expect(
          vi
            .mocked(io.readFile)
            .mock.calls.filter(([path]) => path === join(bad.run_dir, "run-job.json")),
        ).toEqual([]);
      }
      await repair();
      repair = undefined;
      expect(await h.registry.listRunJobsByTask(TARGET_TASK)).toEqual([good]);
      expect(await h.registry.listRunJobsByTask(UNKNOWN_TASK)).toEqual([]);
    } finally {
      await repair?.();
      vi.mocked(io.readFile).mockImplementation(nativeIo.readFile);
      await h.close();
    }
  },
  15000,
);

test.each(["run", "parent"] as const)(
  "replacement of the owned %s directory during an accepted read fails closed",
  async (scope) => {
    const h = await queryFixture();
    const entered = barrier();
    const release = barrier();
    let pending: Promise<unknown> | undefined;
    let restore: (() => Promise<void>) | undefined;
    try {
      const record = await seedQueryRun(h, "a001");
      const path = join(record.run_dir, "run-job.json");
      vi.mocked(io.readFile).mockImplementation(async (...args) => {
        const bytes = await nativeIo.readFile(...args);
        if (args[0] === path) {
          entered.release();
          await release.waiting;
        }
        return bytes;
      });
      const query = h.registry.listRunJobsByTask(TARGET_TASK);
      pending = observe(query);
      await enteredBeforeCompletion(entered.waiting, pending);
      const target = scope === "run" ? record.run_dir : dirname(record.run_dir);
      const saved = `${target}.owned`;
      await io.rename(target, saved);
      await writeQueryRecord(record);
      restore = async () => {
        await io.rm(target, { recursive: true, force: true });
        await io.rename(saved, target);
      };
      const before = await snapshotQueryTree(h.root);
      const logs = [...h.logs];
      release.release();
      await expectQueryFailure(query, record.run_id);
      expect(await snapshotQueryTree(h.root)).toEqual(before);
      expect(h.logs).toEqual(logs);
      await restore();
      restore = undefined;
      expect(await h.registry.listRunJobsByTask(TARGET_TASK)).toEqual([record]);
    } finally {
      release.release();
      await pending;
      await restore?.();
      vi.mocked(io.readFile).mockImplementation(nativeIo.readFile);
      await h.close();
    }
  },
  15000,
);
