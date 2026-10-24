import * as io from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readResult } from "./collect-shud/test-harness.ts";
import { activeGroup } from "./detached-shud/test-harness.ts";
import { readyRun } from "./kill-shud/test-harness.ts";
import { pollFixture, readRecord, releaseRun } from "./poll-shud/test-harness.ts";
import { deliveredWake, expectSingleWake } from "./wake-shud/test-harness.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

test.each([
  { route: "nonzero exit 13", code: 13, exitClass: "input", parentStatus: "failed" },
  { route: "public cancellation", code: 0, exitClass: "cancelled", parentStatus: "killed" },
] as const)(
  "$route wakes once with its factual outcome",
  async (scenario) => {
    const { route, code, exitClass, parentStatus } = scenario;
    const h = await pollFixture(code, "held", "available");
    try {
      const { record, id, pid, producer } = await readyRun(h);
      const invocationPath = join(record.run_dir, "invocation.json");
      const invocationBytes = await io.readFile(invocationPath);
      const invocationMtime = (await io.stat(invocationPath, { bigint: true })).mtimeNs;
      if (route === "public cancellation")
        expect(h.registry.kill(id, h.ownerId, "wake route cancellation")).toBe("requested");
      else await releaseRun(record);
      await deliveredWake(h.registry, record.run_dir);
      const result = await readResult(record.run_dir);
      expect(result).toMatchObject({
        run_id: record.run_id,
        exit_code: route === "public cancellation" ? null : 13,
        exit_class: exitClass,
        artifacts: { files: [] },
      });
      expectSingleWake(h, record.run_id, exitClass, 0);
      expect(h.registry.get(id).status).toBe(parentStatus);
      expect(await readRecord(record.run_dir)).toMatchObject({
        status: "collected",
        pid,
        pid_started_at: record.pid_started_at,
        notify: { status: "delivered", attempts: 0 },
      });
      expect(h.registry.indexes.read()).toEqual({
        active: [],
        completed: [{ run_id: record.run_id, job_id: record.job_id, run_dir: record.run_dir }],
      });
      const resultPath = join(record.run_dir, "run-record.json");
      const bytes = await io.readFile(resultPath);
      const mtime = (await io.stat(resultPath, { bigint: true })).mtimeNs;
      await h.registry.pollOnce();
      await h.registry.pollOnce();
      expectSingleWake(h, record.run_id, exitClass, 0);
      expect(await h.registry.collectShud(record.run_id)).toEqual(result);
      expect(await io.readFile(resultPath)).toEqual(bytes);
      expect((await io.stat(resultPath, { bigint: true })).mtimeNs).toBe(mtime);
      expect(await io.readFile(invocationPath)).toEqual(invocationBytes);
      expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(invocationMtime);
      expect(producer.executions).toHaveLength(1);
      expect(producer.attempts).toHaveLength(1);
      expect(activeGroup(pid)).toEqual([]);
    } finally {
      await h.close();
    }
  },
  15000,
);
