import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ShudJobRegistry } from "./index.ts";
import { expectAbsent, readResult } from "./collect-shud/test-harness.ts";
import { installFakeShud } from "./detached-shud/test-harness.ts";
import {
  pollFixture,
  readRecord,
  seedRun,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";

test("created never started is collected as lost during replacement registry apply", async () => {
  const h = await pollFixture();
  try {
    await installFakeShud(h.shudBin, 0);
    const record = await seedRun(
      h,
      {
        status: "created",
        pid: null,
        pid_started_at: null,
        submitted_at: null,
        started_at: null,
      },
      async (created) => {
        await io.mkdir(join(created.run_dir, "output"));
        await io.writeFile(join(created.run_dir, "stdout.log"), "");
        await io.writeFile(join(created.run_dir, "stderr.log"), "");
      },
    );
    await h.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);
    expect(await readRecord(record.run_dir)).toEqual(record);
    await expectAbsent(join(record.run_dir, "run-record.json"));
    const events = structuredClone(h.sessionEvents);
    const flushes = [...h.flushes];

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const replacement = actualRegistry(h.ctx);
    expect(replacement).not.toBe(h.registry);
    // Awaiting apply, not a later poll or manual collect, is the startup readiness boundary.
    expect(await readResult(record.run_dir)).toMatchObject({
      run_id: record.run_id,
      job_id: record.job_id,
      status: "failed",
      exit_code: null,
      exit_class: "lost",
      command: record.command,
    });
    const collected = await readRecord(record.run_dir);
    expect(collected.status).toBe("collected");
    expect(collected.notify).toEqual(record.notify);
    expect(collected.pid).toBeNull();
    expect(collected.pid_started_at).toBeNull();
    expect(collected.dsh_job_id).toBeNull();
    expect(collected.dsh_job_ids).toEqual([]);
    expect(replacement.list()).toEqual([]);
    await expectAbsent(join(record.run_dir, "wrapper.pid"));
    await expectAbsent(join(record.run_dir, "invocation.json"));
    await expectAbsent(join(record.run_dir, "exit_code"));
    expect(h.sessionEvents).toEqual(events);
    expect(h.flushes).toEqual(flushes);
  } finally {
    await h.close();
  }
}, 15000);
