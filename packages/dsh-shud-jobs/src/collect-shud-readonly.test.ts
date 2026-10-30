import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { beforeEach, expect, test, vi } from "vitest";
import { RunIdSchema } from "@shud-harness/dsh-shud-core";
import { existingResult, outputRoot, publishExit } from "./collect-shud/test-harness.ts";
import {
  observe,
  queryFixture,
  seedQueryRun,
  snapshotQueryTree,
} from "./list-run-jobs/test-harness.ts";
import { installUnsafe } from "../../dsh-shud-records/src/test-harness.ts";
import { observedStart } from "./detached-shud/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir) };
});
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.readFile).mockReset().mockImplementation(nativeIo.readFile);
  vi.mocked(io.readdir).mockReset().mockImplementation(nativeIo.readdir);
});
const PRIVATE = "PRIVATE_READONLY_COLLECT_446";

for (const index of ["active", "completed"] as const) {
  for (const identifier of ["run_id", "job_id"] as const) {
    test(`readonly collected ${identifier} from ${index} returns canonical evidence without writes or output scanning`, async () => {
      const h = await queryFixture();
      try {
        const job = await seedQueryRun(h, "a001", { status: "collected" }, index);
        const record = existingResult(job);
        await io.writeFile(join(job.run_dir, "run-record.json"), JSON.stringify(record));
        // The new mode reads only immutable evidence, not retained ledger contents.
        await io.writeFile(join(job.run_dir, "collect-error.json"), PRIVATE);
        const before = await snapshotQueryTree(h.root);
        vi.mocked(io.readdir).mockClear();
        vi.mocked(io.readFile).mockClear();
        expect(await h.registry.collectShud(job[identifier], { readonly: true })).toEqual(record);
        expect(io.readdir).not.toHaveBeenCalled();
        expect(vi.mocked(io.readFile).mock.calls.map(([path]) => path)).not.toContain(
          join(job.run_dir, "collect-error.json"),
        );
        expect(await snapshotQueryTree(h.root)).toEqual(before);
      } finally {
        await h.close();
      }
    });
  }
}

test.each([
  "missing",
  "corrupt",
  "schema",
  "identity",
  "symlink",
  "dangling-link",
  "fifo",
  "directory",
  "unreadable",
] as const)(
  "readonly %s immutable RunRecord rejects without generation, projection or ledger publication",
  async (fault) => {
    const h = await queryFixture();
    try {
      const job = await seedQueryRun(h, "a001", {
        status: "collected",
        exit_code: 0,
        started_at: "2026-10-22T03:15:00Z",
        finished_at: "2026-10-22T03:16:00Z",
      });
      await publishExit(job, "0\n");
      await io.mkdir(outputRoot(job), { recursive: true });
      await io.writeFile(join(outputRoot(job), "evidence.dat"), "real output bytes");
      const path = join(job.run_dir, "run-record.json");
      const outside = join(h.root, "foreign-record.json");
      fs.writeFileSync(outside, JSON.stringify(existingResult(job)));
      if (fault === "corrupt") fs.writeFileSync(path, PRIVATE);
      else if (fault === "schema") fs.writeFileSync(path, JSON.stringify({ run_id: job.run_id }));
      else if (fault === "identity")
        fs.writeFileSync(
          path,
          JSON.stringify({ ...existingResult(job), job_id: "JOB-20261022T031500-ffff" }),
        );
      else if (fault === "unreadable") {
        fs.writeFileSync(path, JSON.stringify(existingResult(job)));
        vi.mocked(io.readFile).mockImplementation(async (...args) => {
          if (args[0] === path) throw Object.assign(new Error(PRIVATE), { code: "EACCES" });
          return nativeIo.readFile(...args);
        });
      } else if (fault !== "missing") installUnsafe(path, fault, outside);
      const before = await snapshotQueryTree(h.root);
      const result = await observe(h.registry.collectShud(job.run_id, { readonly: true }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Readonly retrieval generated or accepted invalid evidence");
      expect(inspect(result.error, { depth: 12 })).not.toContain(PRIVATE);
      expect(await snapshotQueryTree(h.root)).toEqual(before);
      expect(fs.existsSync(join(job.run_dir, "collect-error.json"))).toBe(false);
    } finally {
      vi.mocked(io.readFile).mockImplementation(nativeIo.readFile);
      await h.close();
    }
  },
);

test.each(["created", "submitted", "running", "succeeded", "failed", "cancelled"] as const)(
  "readonly %s job rejects even with a valid cached record and never repairs collected projection",
  async (status) => {
    const h = await queryFixture();
    try {
      const stamp = status === "running" ? observedStart(process.pid) : undefined;
      const job = await seedQueryRun(h, "a001", {
        status,
        ...(stamp === undefined
          ? {}
          : {
              pid: process.pid,
              pid_started_at: stamp,
              submitted_at: stamp,
              started_at: stamp,
            }),
      });
      await io.writeFile(join(job.run_dir, "run-record.json"), JSON.stringify(existingResult(job)));
      const before = await snapshotQueryTree(h.root);
      await expect(h.registry.collectShud(job.job_id, { readonly: true })).rejects.toThrow(
        /collect|status|request/iu,
      );
      expect(await snapshotQueryTree(h.root)).toEqual(before);
    } finally {
      await h.close();
    }
  },
);

test.each(["omitted", "false"])(
  "default collection with readonly %s still generates and projects terminal evidence",
  async (mode) => {
    const h = await queryFixture();
    try {
      const job = await seedQueryRun(h, "a001", {
        status: "succeeded",
        exit_code: 0,
        started_at: "2026-10-22T03:15:00Z",
        finished_at: "2026-10-22T03:16:00Z",
      });
      await publishExit(job, "0\n");
      await io.mkdir(outputRoot(job), { recursive: true });
      await io.writeFile(join(outputRoot(job), "flow.dat"), "abc");
      const record =
        mode === "omitted"
          ? await h.registry.collectShud(job.run_id)
          : await h.registry.collectShud(job.run_id, { readonly: false });
      expect(record).toMatchObject({
        run_id: job.run_id,
        job_id: job.job_id,
        status: "succeeded",
        exit_code: 0,
        exit_class: "ok",
      });
      expect(record.artifacts.files).toEqual([{ path: "flow.dat", size_bytes: 3 }]);
      expect(
        JSON.parse(await io.readFile(join(job.run_dir, "run-job.json"), "utf8")),
      ).toMatchObject({ status: "collected" });
      expect(JSON.parse(await io.readFile(join(job.run_dir, "run-record.json"), "utf8"))).toEqual(
        record,
      );
    } finally {
      await h.close();
    }
  },
);

test("readonly rejects unknown and malformed persistent identities without discovery", async () => {
  const h = await queryFixture();
  try {
    const job = await seedQueryRun(h, "a001", { status: "collected" }, "unindexed");
    await io.writeFile(join(job.run_dir, "run-record.json"), JSON.stringify(existingResult(job)));
    const before = await snapshotQueryTree(h.root);
    await expect(h.registry.collectShud(job.run_id, { readonly: true })).rejects.toThrow(
      /UNKNOWN_ID/u,
    );
    await expect(
      h.registry.collectShud(RunIdSchema.parse("RUN-20261022T031500-ffff"), { readonly: true }),
    ).rejects.toThrow(/UNKNOWN_ID/u);
    vi.mocked(io.readFile).mockClear();
    await expect(
      Reflect.apply(h.registry.collectShud, h.registry, ["../untrusted", { readonly: true }]),
    ).rejects.toThrow();
    expect(io.readFile).not.toHaveBeenCalled();
    expect(await snapshotQueryTree(h.root)).toEqual(before);
  } finally {
    await h.close();
  }
});
