import * as io from "node:fs/promises";
import { join } from "node:path";
import { generateRunIdentifiers, RunRecordSchema } from "@shud-harness/dsh-shud-core";
import type * as NodeIo from "node:fs/promises";
import { beforeEach, expect, test, vi } from "vitest";
import {
  expectAbsent,
  outputRoot,
  readLedger,
  readResult,
} from "../../dsh-shud-jobs/src/collect-shud/test-harness.ts";
import {
  readRecord,
  releaseRun,
  replaceRecord,
} from "../../dsh-shud-jobs/src/poll-shud/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
});

test("shud_collect returns the canonical RunRecord for an indexed terminal run through ToolRuntime", async () => {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  try {
    const submitted = await h.call({ input_dir: h.inputDir });
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ isError: false });
    const entry = h.registry.indexes.read().active[0];
    if (!entry) throw new Error("Submission omitted its active index entry");
    const job = await readRecord(entry.run_dir);
    await io.mkdir(outputRoot(job), { recursive: true });
    await io.writeFile(join(outputRoot(job), "result.dat"), "abc");
    await releaseRun(job);
    await h.registry.pollOnce();
    expect((await readRecord(job.run_dir)).status).toBe("succeeded");
    await expectAbsent(join(job.run_dir, "run-record.json"));

    const result = await h.collect({ run_id: job.run_id });
    // The unmounted baseline returns ToolRuntime's normalized UNKNOWN_TOOL error here.
    expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
    if (result.isError) throw new Error(result.error.message);
    const record = RunRecordSchema.parse(result.value);
    expect(result.value).toEqual(record);
    expect(record).toMatchObject({
      run_id: job.run_id,
      job_id: job.job_id,
      status: "succeeded",
      exit_code: 0,
      exit_class: "ok",
      command: [h.shudBin, "-o", "output/tiny.out", "tiny"],
      artifacts: { files: [{ path: "result.dat", size_bytes: 3 }] },
      llm: { response_model: "configured-test-model", response_model_source: "configured" },
    });
    expect(record).toEqual(await readResult(job.run_dir));
    expect((await readRecord(job.run_dir)).status).toBe("collected");
    await expectAbsent(join(job.run_dir, "collect-error.json"));

    const recordPath = join(job.run_dir, "run-record.json");
    const bytes = await io.readFile(recordPath);
    const mtime = (await io.stat(recordPath, { bigint: true })).mtimeNs;
    await io.writeFile(join(outputRoot(job), "later.dat"), "not in the committed result");
    const repeated = await h.collect({ job_id: job.job_id });
    expect(repeated).toMatchObject({ isError: false, value: record });

    await h.mountSessionController();
    await h.registry.pollOnce();
    expect(h.flushes).toEqual([h.ownerId]);
    expect(h.registry.indexes.read()).toEqual({
      active: [],
      completed: [{ run_id: job.run_id, job_id: job.job_id, run_dir: job.run_dir }],
    });
    const other = h.ctx.agents.get(h.otherId);
    if (!other) throw new Error("Different calling session is unavailable");
    const otherCwd = join(h.root, "other-workspace");
    await io.mkdir(otherCwd);
    Object.assign(other.session.header, { cwd: otherCwd });
    expect(other.session.id).not.toBe(h.agent.session.id);
    expect(other.session.header.cwd).not.toBe(h.agent.session.header.cwd);
    for (const args of [{ run_id: job.run_id }, { job_id: job.job_id }]) {
      expect(await h.collect(args, other)).toMatchObject({ isError: false, value: record });
    }
    expect(await io.readFile(recordPath)).toEqual(bytes);
    expect((await io.stat(recordPath, { bigint: true })).mtimeNs).toBe(mtime);

    const unindexedIds = generateRunIdentifiers();
    const unindexedDir = join(h.cwd, "runs", unindexedIds.run_id);
    await io.mkdir(unindexedDir);
    const unindexedPath = join(unindexedDir, "run-record.json");
    const unindexedRecord = { ...record, ...unindexedIds };
    expect(RunRecordSchema.parse(unindexedRecord)).toEqual(unindexedRecord);
    await io.writeFile(unindexedPath, JSON.stringify(unindexedRecord));
    for (const args of [{ run_id: unindexedIds.run_id }, { job_id: unindexedIds.job_id }]) {
      const unindexed = await h.collect(args);
      expect(unindexed.isError).toBe(true);
      if (!unindexed.isError) throw new Error("Unindexed on-disk result was discovered");
      expect(unindexed.error.message).toContain("UNKNOWN_ID");
    }
    expect(JSON.parse(await io.readFile(unindexedPath, "utf8"))).toEqual(unindexedRecord);
  } finally {
    await h.dispose();
  }
}, 15_000);

const validRunId = "RUN-20261024T120000-abcd";
const validJobId = "JOB-20261024T120000-abcd";
const invalidArguments: Array<{ name: string; args: unknown; error: RegExp }> = [
  { name: "neither id", args: {}, error: /exactly one/iu },
  {
    name: "both ids",
    args: { run_id: validRunId, job_id: validJobId },
    error: /exactly one/iu,
  },
  ...[null, [], "run", 7, false].map((args) => ({
    name: `invalid root ${JSON.stringify(args)}`,
    args,
    error: /object/iu,
  })),
  ...["run_id", "job_id"].flatMap((field) =>
    [null, [], {}, 7, false, "", "unknown", "shud-0123456789abcdef"].map((value) => ({
      name: `${field} invalid value ${JSON.stringify(value)}`,
      args: { [field]: value },
      error: new RegExp(field, "iu"),
    })),
  ),
  { name: "swapped run brand", args: { run_id: validJobId }, error: /run_id/iu },
  { name: "swapped job brand", args: { job_id: validRunId }, error: /job_id/iu },
  ...["workdir", "dsh_job_id", "toString"].map((key) => ({
    name: `unknown ${key}`,
    args: { run_id: validRunId, [key]: "unexpected" },
    error: /unknown parameter/iu,
  })),
];

test.each(invalidArguments)(
  "shud_collect rejects $name at ToolRuntime",
  async ({ args, error }) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    try {
      const schema = h.runtime.schemas(h.agent).find((tool) => tool.name === "shud_collect");
      expect(schema?.parameters).toMatchObject({ type: "object", additionalProperties: false });
      expect(Object.keys(schema?.parameters?.properties ?? {}).sort()).toEqual([
        "job_id",
        "run_id",
      ]);
      const result = await h.collect(args);
      expect(result.isError).toBe(true);
      if (!result.isError) throw new Error("Invalid collection arguments were accepted");
      expect(result.error.message).toMatch(error);
      expect(result.error.message).not.toContain("UNKNOWN_ID");
      expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
      await expectAbsent(join(h.cwd, "runs"));
    } finally {
      await h.dispose();
    }
  },
);

test.each(["created", "submitted", "running"] as const)(
  "shud_collect reports current %s status and nullable registration without collecting",
  async (status) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    try {
      expect(await h.call({ input_dir: h.inputDir })).toMatchObject({ isError: false });
      const entry = h.registry.indexes.read().active[0];
      if (!entry) throw new Error("Submission omitted its active index entry");
      const original = await readRecord(entry.run_dir);
      try {
        for (const currentId of [null, "shud-0123456789abcdef"]) {
          const job = await replaceRecord(original, {
            status,
            dsh_job_id: currentId,
            dsh_job_ids: ["shud-fedcba9876543210", ...(currentId === null ? [] : [currentId])],
          });
          const result = await h.collect({ run_id: job.run_id });
          expect(result.isError).toBe(true);
          if (!result.isError) throw new Error("Nonterminal request collected a result");
          expect(result.error.message).toContain("NOT_TERMINAL");
          expect(result.error.message).toContain(status);
          expect(result.error.message).toContain("dsh_job_id");
          expect(result.error.message).toContain(currentId ?? "null");
          expect(result.error.message).not.toContain("shud-fedcba9876543210");
          expect(await readRecord(job.run_dir)).toEqual(job);
          await expectAbsent(join(job.run_dir, "run-record.json"));
          await expectAbsent(join(job.run_dir, "collect-error.json"));
        }
      } finally {
        await replaceRecord(original, {});
      }
    } finally {
      await h.dispose();
    }
  },
  15_000,
);

test("shud_collect fails closed on unsafe current registration without echoing metadata", async () => {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  try {
    expect(await h.call({ input_dir: h.inputDir })).toMatchObject({ isError: false });
    const entry = h.registry.indexes.read().active[0];
    if (!entry) throw new Error("Submission omitted its active index entry");
    const job = await readRecord(entry.run_dir);
    const path = join(job.run_dir, "run-job.json");
    const secret = "PRIVATE_CURRENT_ID_315 Authorization: Bearer forbidden";
    const unsafe = JSON.stringify({ ...job, dsh_job_id: secret });
    try {
      await io.writeFile(path, unsafe);
      const result = await h.collect({ job_id: job.job_id });
      expect(result.isError).toBe(true);
      if (!result.isError) throw new Error("Malformed current registration was accepted");
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain("Authorization");
      expect(result.error.message).toContain("SHUD collect run metadata: VALIDATION dsh_job_id");
      expect(await io.readFile(path, "utf8")).toBe(unsafe);
      await expectAbsent(join(job.run_dir, "run-record.json"));
      await expectAbsent(join(job.run_dir, "collect-error.json"));
    } finally {
      await replaceRecord(job, {});
    }
  } finally {
    await h.dispose();
  }
}, 15_000);

test.each([false, true])(
  "shud_collect retains the canonical generation reason when ledger publication fails=%s",
  async (publicationFails) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    try {
      expect(await h.call({ input_dir: h.inputDir })).toMatchObject({ isError: false });
      const entry = h.registry.indexes.read().active[0];
      if (!entry) throw new Error("Submission omitted its active index entry");
      const job = await readRecord(entry.run_dir);
      await releaseRun(job);
      await h.registry.pollOnce();
      await io.writeFile(join(job.run_dir, "exit_code"), "abc");
      const ledgerPath = join(job.run_dir, "collect-error.json");
      if (publicationFails) {
        vi.mocked(io.rename).mockImplementation(async (source, target) => {
          if (target === ledgerPath) {
            throw Object.assign(new Error("PRIVATE_LEDGER_CAUSE_315"), { code: "EIO" });
          }
          await actualIo.rename(source, target);
        });
      }
      const result = await h.collect({ run_id: job.run_id });
      expect(result.isError).toBe(true);
      if (!result.isError) throw new Error("Invalid exit evidence collected a result");
      const reason = "SHUD collect exit evidence: INVALID_INTEGER";
      expect(result.error.message).toContain(reason);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_LEDGER_CAUSE_315");
      if (publicationFails) {
        expect(result.error.message).toContain("SHUD collect collect-error write: EIO");
        await expectAbsent(ledgerPath);
      } else {
        expect(await readLedger(job.run_dir)).toMatchObject({ attempts: 1, last_error: reason });
      }
      expect((await readRecord(job.run_dir)).status).toBe("failed");
      await expectAbsent(join(job.run_dir, "run-record.json"));
    } finally {
      vi.mocked(io.rename).mockImplementation(actualIo.rename);
      await h.dispose();
    }
  },
  15_000,
);

test("shud_collect journals invalid terminal full-schema metadata as a collection attempt", async () => {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  try {
    expect(await h.call({ input_dir: h.inputDir })).toMatchObject({ isError: false });
    const entry = h.registry.indexes.read().active[0];
    if (!entry) throw new Error("Submission omitted its active index entry");
    const running = await readRecord(entry.run_dir);
    await releaseRun(running);
    await h.registry.pollOnce();
    const job = await readRecord(entry.run_dir);
    expect(job.status).toBe("succeeded");
    const path = join(job.run_dir, "run-job.json");
    const invalid = JSON.stringify({ ...job, command: "PRIVATE_INVALID_COMMAND_315" });
    try {
      await io.writeFile(path, invalid);
      const result = await h.collect({ run_id: job.run_id });
      expect(result.isError).toBe(true);
      if (!result.isError) throw new Error("Invalid terminal metadata collected a result");
      const ledger = await readLedger(job.run_dir);
      expect(ledger.attempts).toBe(1);
      expect(ledger.last_error).toMatch(/command/iu);
      expect(result.error.message).toContain(ledger.last_error);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_INVALID_COMMAND_315");
      expect(await io.readFile(path, "utf8")).toBe(invalid);
      await expectAbsent(join(job.run_dir, "run-record.json"));
    } finally {
      await replaceRecord(job, {});
    }
  } finally {
    await h.dispose();
  }
}, 15_000);
