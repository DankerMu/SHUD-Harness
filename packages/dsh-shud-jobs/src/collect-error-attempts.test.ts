import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { beforeEach, expect, test, vi } from "vitest";
import { RunIdSchema } from "@shud-harness/dsh-shud-core";
import { makeRunRecord } from "../../dsh-shud-records/src/task-lifecycle-test-harness.ts";
import { installUnsafe } from "../../dsh-shud-records/src/test-harness.ts";
import {
  observe,
  queryFixture,
  seedQueryRun,
  snapshotQueryTree,
} from "./list-run-jobs/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, readFile: vi.fn(actual.readFile), lstat: vi.fn(actual.lstat) };
});
const native = await vi.importActual<typeof io>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.readFile).mockReset().mockImplementation(native.readFile);
  vi.mocked(io.lstat).mockReset().mockImplementation(native.lstat);
});
const ledger = { attempts: 3, last_error: "PRIVATE_LEDGER_ERROR_446", at: "2026-10-22T03:16:00Z" };

for (const index of ["active", "completed"] as const) {
  test.each([undefined, 0, 2, 3, 4])(
    `owned ${index} persistent ids expose retained attempts=%s despite cached success`,
    async (attempts) => {
      const h = await queryFixture();
      try {
        const job = await seedQueryRun(h, "a001", { status: "collected" }, index);
        await io.writeFile(
          join(job.run_dir, "run-record.json"),
          JSON.stringify(makeRunRecord(job)),
        );
        if (attempts !== undefined)
          await io.writeFile(
            join(job.run_dir, "collect-error.json"),
            JSON.stringify({ ...ledger, attempts }),
          );
        const before = await snapshotQueryTree(h.root);
        const collect = vi.spyOn(h.registry, "collectShud");
        expect(await h.registry.readCollectErrorAttempts(job.run_id)).toBe(attempts ?? 0);
        expect(await h.registry.readCollectErrorAttempts(job.job_id)).toBe(attempts ?? 0);
        expect(collect).not.toHaveBeenCalled();
        collect.mockRestore();
        expect(await snapshotQueryTree(h.root)).toEqual(before);
        expect(h.logs.join("\n")).not.toContain(ledger.last_error);
      } finally {
        await h.close();
      }
    },
  );
}

const invalid = [
  "broken-json",
  null,
  [],
  {},
  { ...ledger, extra: true },
  ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "3", null].map((attempts) => ({ ...ledger, attempts })),
  { ...ledger, last_error: " " },
  { ...ledger, at: "yesterday" },
  { ...ledger, at: null },
];
test.each(invalid.map((value) => ({ value })))(
  "invalid canonical ledger $value rejects without disclosure or resetting history",
  async ({ value }) => {
    const h = await queryFixture();
    try {
      const job = await seedQueryRun(h, "a001", { status: "collected" });
      await io.writeFile(join(job.run_dir, "run-record.json"), JSON.stringify(makeRunRecord(job)));
      await io.writeFile(
        join(job.run_dir, "collect-error.json"),
        value === "broken-json" ? "PRIVATE_LEDGER_ERROR_446" : JSON.stringify(value),
      );
      const before = await snapshotQueryTree(h.root);
      const result = await observe(h.registry.readCollectErrorAttempts(job.run_id));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Invalid retained ledger was silently accepted");
      expect(result.error).toBeInstanceOf(Error);
      expect(inspect(result.error, { depth: 12 })).not.toContain(ledger.last_error);
      expect(await snapshotQueryTree(h.root)).toEqual(before);
    } finally {
      await h.close();
    }
  },
);

test.each(["symlink", "dangling-link", "fifo", "directory", "unreadable"] as const)(
  "%s ledger is not a missing ledger",
  async (kind) => {
    const h = await queryFixture();
    try {
      const job = await seedQueryRun(h, "a001");
      const path = join(job.run_dir, "collect-error.json");
      const outside = join(h.root, "outside.json");
      fs.writeFileSync(outside, JSON.stringify(ledger));
      if (kind === "unreadable") {
        fs.writeFileSync(path, JSON.stringify(ledger));
        vi.mocked(io.readFile).mockImplementation(async (...args) => {
          if (args[0] === path)
            throw Object.assign(new Error(ledger.last_error), { code: "EACCES" });
          return native.readFile(...args);
        });
      } else installUnsafe(path, kind, outside);
      const before = await snapshotQueryTree(h.root);
      const result = await observe(h.registry.readCollectErrorAttempts(job.run_id));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Unsafe ledger was silently ignored");
      expect(inspect(result.error, { depth: 12 })).not.toContain(ledger.last_error);
      expect(await snapshotQueryTree(h.root)).toEqual(before);
    } finally {
      vi.mocked(io.readFile).mockImplementation(native.readFile);
      await h.close();
    }
  },
);

test.each([
  "unknown",
  "unindexed",
  "foreign-id",
  "foreign-path",
  "corrupt-job",
  "invalid-job",
  "unsafe-job",
  "unsafe-run",
])("%s routing cannot read attempt evidence", async (kind) => {
  const h = await queryFixture();
  try {
    const job = await seedQueryRun(h, "a001", {}, kind === "unindexed" ? "unindexed" : "active");
    const path = join(job.run_dir, "run-job.json");
    if (kind === "foreign-id")
      fs.writeFileSync(path, JSON.stringify({ ...job, job_id: "JOB-20261022T031500-ffff" }));
    if (kind === "foreign-path")
      fs.writeFileSync(path, JSON.stringify({ ...job, run_dir: h.root }));
    if (kind === "corrupt-job") fs.writeFileSync(path, "PRIVATE_JOB_PAYLOAD_446");
    if (kind === "unsafe-run") {
      const external = join(h.root, "external-run");
      fs.renameSync(job.run_dir, external);
      fs.symlinkSync(external, job.run_dir);
    }
    if (kind === "invalid-job")
      fs.writeFileSync(path, JSON.stringify({ ...job, llm: { response_model: null } }));
    if (kind === "unsafe-job") {
      const external = join(h.root, "external-job.json");
      fs.renameSync(path, external);
      fs.symlinkSync(external, path);
    }
    const before = await snapshotQueryTree(h.root);
    const id = kind === "unknown" ? RunIdSchema.parse("RUN-20261022T031500-eeee") : job.run_id;
    await expect(h.registry.readCollectErrorAttempts(id)).rejects.toThrow();
    expect(await snapshotQueryTree(h.root)).toEqual(before);
  } finally {
    await h.close();
  }
});

test.each(["../escape", "RUN-0001", "TASK-20261022T031500-a001", null, 1])(
  "invalid %j id rejects before filesystem IO",
  async (id) => {
    const h = await queryFixture();
    try {
      vi.mocked(io.readFile).mockClear();
      vi.mocked(io.lstat).mockClear();
      // Runtime negative: deliberately bypass the static branded consumer contract.
      await expect(
        Reflect.apply(h.registry.readCollectErrorAttempts, h.registry, [id]),
      ).rejects.toThrow();
      expect(io.readFile).not.toHaveBeenCalled();
      expect(io.lstat).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  },
);
