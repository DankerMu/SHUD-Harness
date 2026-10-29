import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  generateRunIdentifiers,
  RunRecordSchema,
  type RunExitClass,
} from "@shud-harness/dsh-shud-core";
import { terminateGroup } from "./detached-shud/test-harness.ts";
import {
  pollFixture,
  readRecord,
  releaseRun,
  replaceRecord,
  seedRun,
} from "./poll-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";
import {
  existingResult,
  expectAbsent,
  outputRoot,
  publishExit,
  readLedger,
  seedTerminal,
} from "./collect-shud/test-harness.ts";

const numericClasses = {
  0: "ok",
  10: "nan",
  12: "file_io",
  13: "input",
  19: "cvode",
  20: "consistency",
  3: "other",
} satisfies Record<number, RunExitClass>;

test.each(Object.entries(numericClasses))(
  "real exit %s produces the canonical %s RunRecord with actual artifact metadata",
  async (codeText, exitClass) => {
    const code = Number(codeText);
    const h = await pollFixture(code);
    const { producer, pending } = h.start();
    try {
      const job = await pending;
      const root = outputRoot(job);
      await io.mkdir(join(root, "nested"), { recursive: true });
      await io.writeFile(join(root, "z.txt"), "last\n");
      await io.writeFile(join(root, "a.bin"), Buffer.from([0, 255, 1, 2]));
      await io.writeFile(join(root, "nested", "b with spaces.dat"), "abc");
      await releaseRun(job);
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return producer.completed.length === 1;
      }, "native producer completion before explicit result collection");
      const result = await h.registry.collectShud(job.run_id);
      expect(job.stack_id).toMatch(/^STACK-\d{8}T\d{6}-[0-9a-f]{4}$/u);
      expect(job.data_id).toMatch(/^DATA-\d{8}T\d{6}-[0-9a-f]{4}$/u);
      expect(RunRecordSchema.parse(result)).toEqual(result);
      expect(result).toMatchObject({
        run_id: job.run_id,
        job_id: job.job_id,
        task_id: null,
        stack_id: job.stack_id,
        data_id: job.data_id,
        status: code === 0 ? "succeeded" : "failed",
        exit_code: code,
        exit_class: exitClass,
        command: [h.shudBin, "-o", "output/tiny.out", "tiny"],
        llm: h.request.llm,
        artifacts: {
          stdout: join(job.run_dir, "stdout.log"),
          stderr: join(job.run_dir, "stderr.log"),
          shud_output: root,
          files: [
            { path: "a.bin", size_bytes: 4 },
            { path: "nested/b with spaces.dat", size_bytes: 3 },
            { path: "z.txt", size_bytes: 5 },
          ],
        },
        numerical_health: {
          water_balance_residual: null,
          cvode_failures: null,
          negative_state_count: null,
          max_solver_dt: null,
        },
        resources: { peak_memory_mb: null },
      });
      expect(result.resources.wall_seconds).toBeGreaterThanOrEqual(0);
      const observed = producer.durableAtSettle[0];
      expect(observed.started_at).toBe(job.started_at);
      if (observed.started_at === null || observed.finished_at === null)
        throw new Error("Original online observation is missing an endpoint");
      expect(result.resources.wall_seconds).toBe(
        (Date.parse(observed.finished_at) - Date.parse(observed.started_at)) / 1000,
      );
      expect(Number.isFinite(Date.parse(result.collected_at))).toBe(true);
      expect((await readRecord(job.run_dir)).status).toBe("collected");
      await producer.doneObserved;
      expect(producer.durableAtSettle[0].status).toBe(code === 0 ? "succeeded" : "failed");
      expect(producer.durableAtDone[0].status).toBe(code === 0 ? "succeeded" : "failed");
      expect(h.registry.indexes.read()).toEqual({
        active: [{ run_id: job.run_id, job_id: job.job_id, run_dir: job.run_dir }],
        completed: [],
      });
      expect(h.flushes).toEqual([]);
    } finally {
      await h.close();
    }
  },
  15000,
);

test.each([false, true])(
  "real no-exit termination collects cancelled=%s rather than inventing a numeric exit",
  async (cancelled) => {
    const h = await pollFixture();
    const { pending } = h.start();
    try {
      const job = await pending;
      if (job.pid === null) throw new Error("Actual wrapper identity is missing");
      if (cancelled) {
        await replaceRecord(job, { cancel_requested_at: "2026-10-22T03:15:01.000Z" });
        await h.registry.pollOnce();
      }
      await terminateGroup(job.pid);
      await h.registry.pollOnce();
      const result = await h.registry.collectShud(job.run_id);
      expect(RunRecordSchema.parse(result)).toEqual(result);
      expect(result).toMatchObject({
        status: "failed",
        exit_code: null,
        exit_class: cancelled ? "cancelled" : "lost",
      });
      expect(result.artifacts.files).toEqual([]);
      if (!cancelled) expect(result.resources.wall_seconds).toBeNull();
      await expectAbsent(join(job.run_dir, "exit_code"));
      expect((await readRecord(job.run_dir)).status).toBe("collected");
    } finally {
      await h.close();
    }
  },
  15000,
);

test("the online dispatcher automatically collects after terminal persistence and registration completion", async () => {
  const h = await pollFixture();
  const { producer, pending } = h.start();
  try {
    const job = await pending;
    await releaseRun(job);
    await producer.doneObserved;
    await expect
      .poll(async () => (await io.readdir(job.run_dir)).includes("run-record.json"))
      .toBe(true);
    const result = RunRecordSchema.parse(
      JSON.parse(await io.readFile(join(job.run_dir, "run-record.json"), "utf8")),
    );
    expect(result.exit_class).toBe("ok");
    const terminal = producer.durableAtSettle[0];
    expect(result.resources.wall_seconds).toBeGreaterThanOrEqual(0);
    if (terminal.started_at === null || terminal.finished_at === null)
      throw new Error("Automatic collection is missing an observed endpoint");
    expect(result.resources.wall_seconds).toBe(
      (Date.parse(terminal.finished_at) - Date.parse(terminal.started_at)) / 1000,
    );
    const bytes = await io.readFile(join(job.run_dir, "run-record.json"));
    const mtime = (await io.stat(join(job.run_dir, "run-record.json"), { bigint: true })).mtimeNs;
    expect(await h.registry.collectShud(job.run_id)).toEqual(result);
    expect(await io.readFile(join(job.run_dir, "run-record.json"))).toEqual(bytes);
    expect((await io.stat(join(job.run_dir, "run-record.json"), { bigint: true })).mtimeNs).toBe(
      mtime,
    );
    expect(producer.durableAtSettle[0].status).toBe("succeeded");
    expect(producer.durableAtDone[0].status).toBe("succeeded");
    expect(producer.completed).toHaveLength(1);
    await expect.poll(async () => (await readRecord(job.run_dir)).status).toBe("collected");
    expect(h.flushes).toEqual([]);
  } finally {
    await h.close();
  }
}, 15000);

test("collection copies prescribed references and provenance but disk-only timestamps are not duration observations", async () => {
  const h = await pollFixture();
  try {
    const job = await seedTerminal(h, {
      task_id: "task-308",
      stack_id: "stack-308",
      data_id: "data-308",
      llm: { response_model: "observed-model-308", response_model_source: "response" },
    });
    const result = await h.registry.collectShud(job.job_id);
    expect(result).toMatchObject({
      task_id: "task-308",
      stack_id: "stack-308",
      data_id: "data-308",
      llm: { response_model: "observed-model-308", response_model_source: "response" },
      resources: { wall_seconds: null, peak_memory_mb: null },
      numerical_health: {
        water_balance_residual: null,
        cvode_failures: null,
        negative_state_count: null,
        max_solver_dt: null,
      },
    });
    expect(h.registry.list()).toEqual([]);
  } finally {
    await h.close();
  }
});

test.each(["started_at", "finished_at"] as const)(
  "unknown %s yields null elapsed time, not a fabricated zero",
  async (field) => {
    const h = await pollFixture();
    try {
      const job = await seedTerminal(h, { [field]: null });
      const result = await h.registry.collectShud(job.run_id);
      expect(result.resources).toEqual({ wall_seconds: null, peak_memory_mb: null });
    } finally {
      await h.close();
    }
  },
);

test.each(["empty", "absent"] as const)(
  "an initially %s output directory accurately produces an empty artifact list",
  async (kind) => {
    const h = await pollFixture();
    try {
      const job = await seedTerminal(h, {}, async (record) => {
        if (kind === "absent") await io.rm(outputRoot(record), { recursive: true });
      });
      const result = await h.registry.collectShud(job.run_id);
      expect(result.artifacts.files).toEqual([]);
      expect(result.artifacts.shud_output).toBe(outputRoot(job));
      expect(result.exit_class).toBe("ok");
    } finally {
      await h.close();
    }
  },
);

test("repeated collection returns immutable bytes and mtime after output and exit evidence change", async () => {
  const h = await pollFixture();
  try {
    const job = await seedTerminal(h);
    const api = h.registry;
    const first = await api.collectShud(job.run_id);
    const path = join(job.run_dir, "run-record.json");
    const bytes = await io.readFile(path);
    const stat = await io.stat(path, { bigint: true });
    await io.writeFile(join(outputRoot(job), "later.dat"), "new artifact bytes");
    await publishExit(job, "13\n");
    expect(await api.collectShud(job.job_id)).toEqual(first);
    await h.registry.pollOnce();
    expect(await io.readFile(path)).toEqual(bytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(stat.mtimeNs);
    expect(first.artifacts.files).toEqual([]);
    await h.registry.indexes.completeActive(job.run_id);
    expect(await api.collectShud(job.run_id)).toEqual(first);
    expect(await io.readFile(path)).toEqual(bytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(stat.mtimeNs);
  } finally {
    await h.close();
  }
});

test("an existing valid committed record repairs only collected status without requiring old evidence or outputs", async () => {
  const h = await pollFixture();
  let immutable = "";
  let mtime = 0n;
  try {
    const job = await seedTerminal(h, {}, async (record) => {
      immutable = JSON.stringify(existingResult(record));
      const path = join(record.run_dir, "run-record.json");
      await io.writeFile(path, immutable);
      mtime = (await io.stat(path, { bigint: true })).mtimeNs;
      await io.rm(join(record.run_dir, "exit_code"));
      await io.rm(outputRoot(record), { recursive: true });
    });
    const result = await h.registry.collectShud(job.run_id);
    expect(result).toEqual(existingResult(job));
    expect(await io.readFile(join(job.run_dir, "run-record.json"), "utf8")).toBe(immutable);
    expect((await io.stat(join(job.run_dir, "run-record.json"), { bigint: true })).mtimeNs).toBe(
      mtime,
    );
    expect((await readRecord(job.run_dir)).status).toBe("collected");
    await expectAbsent(join(job.run_dir, "collect-error.json"));
  } finally {
    await h.close();
  }
});

test("unknown and still-running direct requests reject without creating collection artifacts", async () => {
  const h = await pollFixture();
  const { pending } = h.start();
  try {
    const job = await pending;
    const api = h.registry;
    const unknown = generateRunIdentifiers();
    await expect(api.collectShud(unknown.run_id)).rejects.toThrow();
    await expect(api.collectShud(job.run_id)).rejects.toThrow();
    expect((await readRecord(job.run_dir)).status).toBe("running");
    await expectAbsent(join(job.run_dir, "run-record.json"));
    await expectAbsent(join(job.run_dir, "collect-error.json"));
    expect(h.registry.indexes.lookup(job.run_id)?.run_dir).toBe(job.run_dir);
  } finally {
    await h.close();
  }
}, 15000);

test.each(["created", "submitted", "running"] as const)(
  "direct collection reports current %s status and nullable current registration without artifacts",
  async (status) => {
    const h = await pollFixture();
    try {
      for (const currentId of [null, "shud-0123456789abcdef"]) {
        const job = await seedRun(h, {
          status,
          dsh_job_id: currentId,
          dsh_job_ids: ["shud-fedcba9876543210", ...(currentId === null ? [] : [currentId])],
          ...(status === "running" ? {} : { pid: null, pid_started_at: null, started_at: null }),
        });
        const error: unknown = await h.registry.collectShud(job.run_id).then(
          () => null,
          (failure: unknown) => failure,
        );
        expect(error).toMatchObject({ code: "NOT_TERMINAL" });
        if (!(error instanceof Error)) throw new Error("Nonterminal collection did not reject");
        expect(error.message).toContain(status);
        expect(error.message).toContain("dsh_job_id");
        expect(error.message).toContain(currentId ?? "null");
        expect(error.message).not.toContain("shud-fedcba9876543210");
        expect(await readRecord(job.run_dir)).toEqual(job);
        await expectAbsent(join(job.run_dir, "run-record.json"));
        await expectAbsent(join(job.run_dir, "collect-error.json"));
      }
    } finally {
      await h.close();
    }
  },
);

const conflictingExitFiles: Record<string, string | null> = {
  missing: null,
  invalid: "abc\n",
  empty: "",
  whitespace: " \t\n",
  partial: "13junk",
  fractional: "13.5",
  unsafe: "9007199254740992",
  mismatch: "0\n",
};

test.each(Object.entries(conflictingExitFiles))(
  "numeric cached exit with %s file evidence fails collection and preserves both sources",
  async (_kind, fileBytes) => {
    const h = await pollFixture();
    try {
      const job = await seedTerminal(
        h,
        {
          status: "cancelled",
          exit_code: 13,
          cancel_requested_at: "2026-10-22T03:15:01.000Z",
        },
        async (record) => {
          if (fileBytes === null) await io.rm(join(record.run_dir, "exit_code"));
          else await publishExit(record, fileBytes);
        },
      );
      await h.registry.pollOnce();
      const ledger = await readLedger(job.run_dir);
      expect(ledger.attempts).toBe(1);
      expect(ledger.last_error).toMatch(/exit/iu);
      expect(await readRecord(job.run_dir)).toEqual({ ...job, status: "failed" });
      if (fileBytes === null) await expectAbsent(join(job.run_dir, "exit_code"));
      else expect(await io.readFile(join(job.run_dir, "exit_code"), "utf8")).toBe(fileBytes);
      await expectAbsent(join(job.run_dir, "run-record.json"));
      expect(h.registry.list()).toEqual([]);
      expect(h.errors.length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  },
);

test("null cached exit accepts repaired valid file evidence instead of preserving a stale lost classification", async () => {
  const h = await pollFixture();
  try {
    const job = await seedTerminal(h, { status: "failed", exit_code: null }, (record) =>
      publishExit(record, "0\n"),
    );
    const result = await h.registry.collectShud(job.run_id);
    expect(result).toMatchObject({ status: "succeeded", exit_code: 0, exit_class: "ok" });
    expect((await readRecord(job.run_dir)).status).toBe("collected");
  } finally {
    await h.close();
  }
});

test.each([0, 13])(
  "valid file exit %s wins over a cancellation mark during null-code collection",
  async (code) => {
    const h = await pollFixture();
    try {
      const job = await seedTerminal(
        h,
        {
          status: "cancelled",
          exit_code: null,
          cancel_requested_at: "2026-10-22T03:15:01.000Z",
        },
        (record) => publishExit(record, `${code}\n`),
      );
      const result = await h.registry.collectShud(job.run_id);
      expect(result).toMatchObject({
        exit_code: code,
        exit_class: code === 0 ? "ok" : "input",
        status: code === 0 ? "succeeded" : "failed",
      });
      expect(await readRecord(job.run_dir)).toEqual({ ...job, status: "collected" });
    } finally {
      await h.close();
    }
  },
);

test("a never-started lost run with no output ancestor collects an honest empty manifest and unknown duration", async () => {
  const h = await pollFixture();
  try {
    const job = await seedTerminal(
      h,
      {
        status: "failed",
        exit_code: null,
        pid: null,
        pid_started_at: null,
        started_at: null,
      },
      (record) => io.rm(join(record.run_dir, "output"), { recursive: true }),
    );
    const result = await h.registry.collectShud(job.run_id);
    expect(result).toMatchObject({
      status: "failed",
      exit_code: null,
      exit_class: "lost",
      artifacts: { files: [] },
      resources: { wall_seconds: null, peak_memory_mb: null },
    });
    expect(result.artifacts.shud_output).toBe(outputRoot(job));
    expect((await readRecord(job.run_dir)).status).toBe("collected");
  } finally {
    await h.close();
  }
});
