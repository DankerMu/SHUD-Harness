import * as io from "node:fs/promises";
import { join } from "node:path";
import type * as NodeIo from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  DataProvenanceSchema,
  RunJobSchema,
  RunRecordSchema,
  StackLockSchema,
  type RunJob,
} from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { actualRegistry, submissionFixture } from "./submit-shud/test-harness.ts";
import { settlingProducer } from "./poll-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";
import {
  binaryBytes,
  binarySha256,
  buildFixture,
  fileSnapshot,
} from "./submit-shud-build/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function collectAfterRelease(
  registry: ShudJobRegistry,
  job: RunJob,
  execution: { completed: readonly unknown[] },
) {
  await io.writeFile(join(job.run_dir, "allow-exit"), "release\n");
  await waitForRecovery(async () => {
    await registry.pollOnce();
    return execution.completed.length === 1;
  }, "build execution settlement");
  const result = await registry.collectShud(job.run_id);
  expect(RunRecordSchema.parse(result)).toEqual(result);
  expect(await registry.collectShud(job.job_id)).toEqual(result);
  return result;
}

test.each([
  { mutation: "edit", threads: 1, receipt: "1\n1\npreserved\n" },
  { mutation: "delete", threads: 2, receipt: "2\n2\npreserved\n" },
] as const)(
  "first created binds executable and lineage before producer; source $mutation, threads $threads",
  async ({ mutation, threads, receipt }) => {
    const h = await buildFixture("tiny; touch PROJECT_INJECTION");
    const execution = settlingProducer();
    const publications: RunJob[] = [];
    try {
      vi.stubEnv("OMP_NUM_THREADS", "9");
      vi.stubEnv("SHUD_RHS_THREADS", "10");
      vi.stubEnv("SHUD_BUILD_TEST_MARKER", "preserved");
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (String(target).endsWith("/run-job.json")) {
          const record = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
          expect(record).toMatchObject({
            task_id: h.build.task_id,
            build_id: h.build.build_id,
            binary_sha256: binarySha256,
            threads,
            command: [
              join(record.run_dir, "bin", "shud"),
              "-o",
              `output/${h.request.project}.out`,
              h.request.project,
            ],
          });
          if (record.status === "created") {
            expect(execution.executions).toEqual([]);
            expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
            const binary = join(record.run_dir, "bin", "shud");
            expect(await io.readFile(binary)).toEqual(binaryBytes);
            expect((await io.lstat(binary)).isFile()).toBe(true);
            expect((await io.stat(binary)).mode & 0o777).toBe(0o755);
            expect(await io.readdir(join(record.run_dir, "bin"))).toEqual(["shud"]);
            const stack = StackLockSchema.parse(
              JSON.parse(
                await io.readFile(join(h.cwd, "stacks", `${record.stack_id}.json`), "utf8"),
              ),
            );
            expect(stack.build_id).toBe(h.build.build_id);
            expect(stack.repos.SHUD).toEqual({
              commit: h.build.source_commit,
              branch: h.build.source_branch,
              dirty: true,
              dirty_paths: ["docs/build.md", "scripts/build.sh"],
              dirty_paths_truncated: false,
            });
            const data = DataProvenanceSchema.parse(
              JSON.parse(
                await io.readFile(join(h.cwd, "provenance", `${record.data_id}.json`), "utf8"),
              ),
            );
            expect(data.sources.external_files).toEqual([]);
            expect(data.sources.input_root).toBe(await io.realpath(h.inputDir));
            expect(data.sources.files.map((file) => file.path)).toEqual(
              Object.keys(h.originals).sort(),
            );
            expect(
              await io.readFile(
                join(record.run_dir, "input", h.request.project, `${h.request.project}.cfg.para`),
                "utf8",
              ),
            ).toContain("END\t30\r\n");
          }
          publications.push(record);
        }
        await actualIo.rename(source, target);
      });
      const job = await registry.submitShud(
        { ...h.buildRequest, threads, end_days: 30 },
        (record, handle, cadence) => {
          expect(publications.map((value) => value.status)).toEqual(["created", "submitted"]);
          return execution.start(record, handle, cadence);
        },
      );
      expect(publications.map((record) => record.status)).toEqual([
        "created",
        "submitted",
        "submitted",
        "running",
      ]);
      await h.assertReadonly();
      await waitForRecovery(
        async () => (await io.readdir(job.run_dir)).includes("argv-receipt"),
        "real shell receipt",
      );
      expect(await io.readFile(join(job.run_dir, "invoked-path"), "utf8")).toBe(
        `${join(job.run_dir, "bin", "shud")}\n`,
      );
      expect(await io.readFile(join(job.run_dir, "thread-receipt"), "utf8")).toBe(receipt);
      expect(await io.readFile(join(job.run_dir, "argv-receipt"), "utf8")).toBe(
        `-o\noutput/${h.request.project}.out\n${h.request.project}\n`,
      );
      expect(await io.readdir(job.run_dir)).not.toContain("PROJECT_INJECTION");
      expect(process.env.OMP_NUM_THREADS).toBe("9");
      expect(process.env.SHUD_RHS_THREADS).toBe("10");
      expect(process.env.SHUD_BUILD_TEST_MARKER).toBe("preserved");
      if (mutation === "edit") await io.writeFile(h.source, "#!/bin/sh\nexit 71\n");
      else await io.unlink(h.source);
      expect(await io.readFile(join(job.run_dir, "bin", "shud"))).toEqual(binaryBytes);
      const result = await collectAfterRelease(registry, job, execution);
      expect(result).toMatchObject({
        status: "succeeded",
        exit_code: 0,
        build_id: h.build.build_id,
        binary_sha256: binarySha256,
        threads,
        task_id: h.build.task_id,
        stack_id: job.stack_id,
        data_id: job.data_id,
        command: job.command,
      });
      expect(await fileSnapshot(h.recordPath)).toEqual(h.before.record);
    } finally {
      await execution.cleanup();
      await h.dispose();
    }
  },
  15000,
);

test("an unlinked submission can execute a task build with omitted threads", async () => {
  const h = await buildFixture();
  const execution = settlingProducer();
  try {
    vi.stubEnv("OMP_NUM_THREADS", "4");
    vi.stubEnv("SHUD_RHS_THREADS", "5");
    vi.stubEnv("SHUD_BUILD_TEST_MARKER", "kept");
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    const request = { ...h.request, build_id: h.build.build_id };
    const job = await registry.submitShud(request, execution.start);
    expect(job).toMatchObject({
      task_id: null,
      build_id: h.build.build_id,
      binary_sha256: binarySha256,
      threads: null,
    });
    await waitForRecovery(
      async () => (await io.readdir(job.run_dir)).includes("argv-receipt"),
      "inherited build environment",
    );
    expect(await io.readFile(join(job.run_dir, "thread-receipt"), "utf8")).toBe("4\n5\nkept\n");
    expect(process.env.OMP_NUM_THREADS).toBe("4");
    expect(process.env.SHUD_RHS_THREADS).toBe("5");
    expect(await collectAfterRelease(registry, job, execution)).toMatchObject({
      task_id: null,
      build_id: h.build.build_id,
      binary_sha256: binarySha256,
      threads: null,
      exit_code: 0,
    });
    await h.assertReadonly();
  } finally {
    await execution.cleanup();
    await h.dispose();
  }
}, 15000);

test.each([
  { threads: undefined, host: undefined, receipt: "unset\nunset\nkept\n" },
  { threads: undefined, host: "4", receipt: "4\n5\nkept\n" },
  { threads: 2, host: "4", receipt: "2\n2\nkept\n" },
  { threads: 1, host: undefined, receipt: "1\n1\nkept\n" },
])(
  "configured execution supports independent threads: %j",
  async ({ threads, host, receipt }) => {
    const h = await submissionFixture();
    const execution = settlingProducer();
    try {
      vi.stubEnv("OMP_NUM_THREADS", host);
      vi.stubEnv("SHUD_RHS_THREADS", host === undefined ? undefined : "5");
      vi.stubEnv("SHUD_BUILD_TEST_MARKER", "kept");
      await io.unlink(h.shudBin);
      await io.writeFile(h.shudBin, binaryBytes, { mode: 0o755 });
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      const request = { ...h.request, ...(threads === undefined ? {} : { threads }) };
      const job = await registry.submitShud(request, execution.start);
      expect(job).toMatchObject({ build_id: null, binary_sha256: null, threads: threads ?? null });
      expect(job.command).toEqual([h.shudBin, "-o", "output/tiny.out", "tiny"]);
      expect(await io.readdir(job.run_dir)).not.toContain("bin");
      await waitForRecovery(
        async () => (await io.readdir(job.run_dir)).includes("argv-receipt"),
        "configured environment receipt",
      );
      expect(await io.readFile(join(job.run_dir, "thread-receipt"), "utf8")).toBe(receipt);
      expect(await io.readFile(join(job.run_dir, "invoked-path"), "utf8")).toBe(`${h.shudBin}\n`);
      expect(process.env.OMP_NUM_THREADS).toBe(host);
      expect(process.env.SHUD_RHS_THREADS).toBe(host === undefined ? undefined : "5");
      expect(process.env.SHUD_BUILD_TEST_MARKER).toBe("kept");
      expect(await collectAfterRelease(registry, job, execution)).toMatchObject({
        build_id: null,
        binary_sha256: null,
        threads: threads ?? null,
        exit_code: 0,
      });
    } finally {
      await execution.cleanup();
      await h.dispose();
    }
  },
  15000,
);
