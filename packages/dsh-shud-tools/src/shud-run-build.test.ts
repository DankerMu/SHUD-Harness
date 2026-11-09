import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { RunJobSchema } from "@shud-harness/dsh-shud-core";
import {
  binaryBytes,
  binarySha256,
  fileSnapshot,
} from "../../dsh-shud-jobs/src/submit-shud-build/test-harness.ts";
import { submittedCopy, writeInputTree } from "../../dsh-shud-jobs/src/submit-shud/test-harness.ts";
import { expectNativeReceipt, seedBuild } from "./shud-run-build/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";
import { returnedRun } from "./task-linked/test-harness.ts";

test("shud_run executes the selected workspace build with requested threads", async () => {
  const h = await createToolHarness();
  try {
    vi.stubEnv("OMP_NUM_THREADS", "7");
    vi.stubEnv("SHUD_RHS_THREADS", "9");
    vi.stubEnv("SHUD_BUILD_TEST_MARKER", "preserved");
    const { build, buildDir, source, recordPath } = await seedBuild(h.cwd);
    // Keep the installed configured executable untouched: it produces invocation.json,
    // unlike the selected build's invoked-path/thread-receipt/argv-receipt files.
    const paths = [
      source,
      recordPath,
      h.shudBin,
      ...Object.keys(h.originals).map((name) => join(h.inputDir, name)),
    ];
    const snapshots = await Promise.all(paths.map(fileSnapshot));
    const result = await h.call({
      input_dir: h.inputDir,
      build_id: build.build_id,
      threads: 3,
    });
    // Assert immediately so the pre-feature strict tool fails on UNKNOWN_PARAMETER,
    // rather than waiting for receipts from a process that was never submitted.
    expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
    if (result.isError) throw new Error(result.error.message);
    const entries = h.registry.indexes.read().active;
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error("Successful shud_run omitted its active index entry");
    const job = RunJobSchema.parse(
      JSON.parse(await readFile(join(entry.run_dir, "run-job.json"), "utf8")),
    );
    expect(result.value).toEqual({
      status: "running",
      job_id: job.job_id,
      run_id: job.run_id,
      dsh_job_id: job.dsh_job_id,
      run_dir: job.run_dir,
    });
    const binary = join(job.run_dir, "bin", "shud");
    expect(job).toMatchObject({
      status: "running",
      build_id: build.build_id,
      binary_sha256: binarySha256,
      threads: 3,
      task_id: null,
      command: [binary, "-o", "output/tiny.out", "tiny"],
    });
    expect(job.dsh_job_id).toMatch(/^shud-[0-9a-f]{16}$/);
    await expectNativeReceipt(job.run_dir, "argv-receipt", "-o\noutput/tiny.out\ntiny\n");
    expect(await readFile(join(job.run_dir, "invoked-path"), "utf8")).toBe(`${binary}\n`);
    expect(await readFile(join(job.run_dir, "thread-receipt"), "utf8")).toBe("3\n3\npreserved\n");
    expect(await readFile(binary)).toEqual(binaryBytes);
    await expect(readFile(join(job.run_dir, "invocation.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(job.run_dir, "exit_code"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(process.env.OMP_NUM_THREADS).toBe("7");
    expect(process.env.SHUD_RHS_THREADS).toBe("9");
    await writeFile(join(job.run_dir, "allow-exit"), "");
    await expectNativeReceipt(job.run_dir, "exit_code", "0\n");
    expect(await Promise.all(paths.map(fileSnapshot))).toEqual(snapshots);
    expect((await readdir(buildDir)).sort()).toEqual(["build-record.json", "shud"]);
  } finally {
    try {
      await h.dispose();
    } finally {
      vi.unstubAllEnvs();
    }
  }
}, 15_000);

test("shud_run preserves the synthetic keliya cfg except DT_YE_IC when end_days is omitted", async () => {
  const h = await createToolHarness();
  try {
    const cfg =
      "# synthetic keliya window; not basin data\r\nSTART\t12053\r\nEND\t12143\r\nNUM_OPENMP\t8\r\nOTHER\t17\r\n";
    const inputDir = join(h.root, "input", "keliya");
    const originals = await writeInputTree(inputDir, cfg, undefined, "keliya");
    const { build, buildDir, source, recordPath } = await seedBuild(h.cwd);
    const paths = [
      source,
      recordPath,
      h.shudBin,
      ...Object.keys(originals).map((name) => join(inputDir, name)),
      ...Object.keys(h.originals).map((name) => join(h.inputDir, name)),
    ];
    const snapshots = await Promise.all(paths.map(fileSnapshot));
    const job = await returnedRun(
      h,
      await h.call({ input_dir: inputDir, build_id: build.build_id, threads: 1 }),
    );
    expect(job).toMatchObject({
      status: "running",
      project: "keliya",
      end_days: null,
      build_id: build.build_id,
      binary_sha256: binarySha256,
      threads: 1,
      command: [join(job.run_dir, "bin", "shud"), "-o", "output/keliya.out", "keliya"],
    });
    await expectNativeReceipt(job.run_dir, "argv-receipt", "-o\noutput/keliya.out\nkeliya\n");
    expect(await readFile(join(job.run_dir, "invoked-path"), "utf8")).toBe(
      `${join(job.run_dir, "bin", "shud")}\n`,
    );
    expect(
      (await readFile(join(job.run_dir, "thread-receipt"), "utf8")).split("\n").slice(0, 2),
    ).toEqual(["1", "1"]);
    expect(await readFile(join(job.run_dir, "input", "keliya", "keliya.cfg.para"))).toEqual(
      Buffer.from(`${cfg}DT_YE_IC\t1440\r\n`),
    );
    for (const [name, bytes] of Object.entries(originals))
      expect(await readFile(join(job.run_dir, "input", "keliya", name))).toEqual(
        submittedCopy(name, bytes, "keliya"),
      );
    await writeFile(join(job.run_dir, "allow-exit"), "");
    await expectNativeReceipt(job.run_dir, "exit_code", "0\n");
    expect(await Promise.all(paths.map(fileSnapshot))).toEqual(snapshots);
    expect((await readdir(buildDir)).sort()).toEqual(["build-record.json", "shud"]);
  } finally {
    await h.dispose();
  }
}, 15_000);
