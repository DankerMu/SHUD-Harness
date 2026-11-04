import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { RunJobSchema, RunRecordSchema, TaskCardSchema } from "@shud-harness/dsh-shud-core";
import {
  binaryBytes,
  binarySha256,
  fileSnapshot,
} from "../../dsh-shud-jobs/src/submit-shud-build/test-harness.ts";
import { waitForRecovery } from "../../dsh-shud-jobs/src/reconcile-shud/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";
import { expectNativeReceipt, seedBuild } from "./shud-run-build/test-harness.ts";
import {
  cardPath,
  plannedCard,
  putCard,
  returnedRun,
  treeOrAbsent,
} from "./task-linked/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    lstat: vi.fn(actual.lstat),
    open: vi.fn(actual.open),
    readdir: vi.fn(actual.readdir),
  };
});

const options = [
  { name: "build-only", useBuild: true, threads: undefined, linked: false },
  { name: "threads-only", useBuild: false, threads: 2, linked: false },
  { name: "omitted", useBuild: false, threads: undefined, linked: false },
  {
    name: "safe integer threads",
    useBuild: false,
    threads: Number.MAX_SAFE_INTEGER,
    linked: false,
  },
  { name: "linked build and threads", useBuild: true, threads: 1, linked: true },
];

test.each(options.flatMap((row) => [false, true].map((inherited) => ({ ...row, inherited }))))(
  "$name executes and collects the chosen binary; inherited=$inherited",
  async ({ useBuild, threads, linked, inherited }) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    try {
      vi.stubEnv("OMP_NUM_THREADS", inherited ? "7" : undefined);
      vi.stubEnv("SHUD_RHS_THREADS", inherited ? "9" : undefined);
      vi.stubEnv("SHUD_BUILD_TEST_MARKER", "kept");
      // This link belongs to the isolated harness; never write through its shared target.
      await io.unlink(h.shudBin);
      const fallback = Buffer.concat([binaryBytes, Buffer.from("# configured fallback only\n")]);
      await io.writeFile(h.shudBin, fallback, { mode: 0o755 });
      const build = useBuild ? await seedBuild(h.cwd) : undefined;
      const foreign = join(h.root, "unsafe-build-target");
      if (!build) {
        await io.mkdir(foreign);
        await io.writeFile(join(foreign, "build-record.json"), "not a valid BuildRecord\n");
        await io.symlink(foreign, join(h.cwd, "builds"));
      }
      if (linked && build) putCard(h, plannedCard({ task_id: build.build.task_id }));
      const paths = [
        h.shudBin,
        ...Object.keys(h.originals).map((name) => join(h.inputDir, name)),
        ...(build ? [build.source, build.recordPath] : [join(foreign, "build-record.json")]),
      ];
      const snapshots = await Promise.all(paths.map(fileSnapshot));
      const foreignBefore = await treeOrAbsent(foreign);
      vi.clearAllMocks();
      const job = await returnedRun(
        h,
        await h.call({
          input_dir: h.inputDir,
          ...(build ? { build_id: build.build.build_id } : {}),
          ...(threads === undefined ? {} : { threads }),
          ...(linked && build ? { task_id: build.build.task_id } : {}),
        }),
      );
      if (!build) {
        for (const operation of [
          fs.readFileSync,
          fs.lstatSync,
          fs.openSync,
          io.readFile,
          io.lstat,
          io.open,
          io.readdir,
        ]) {
          expect(
            vi.mocked(operation).mock.calls.filter(([path]) => {
              const pathname =
                typeof path === "string"
                  ? path
                  : Buffer.isBuffer(path)
                    ? path.toString("utf8")
                    : path instanceof URL
                      ? fileURLToPath(path)
                      : undefined;
              return (
                pathname !== undefined && /\/(?:builds|unsafe-build-target)(?:\/|$)/u.test(pathname)
              );
            }),
          ).toEqual([]);
        }
        expect(await io.readlink(join(h.cwd, "builds"))).toBe(foreign);
        expect(await treeOrAbsent(foreign)).toEqual(foreignBefore);
        await expect(io.readdir(join(job.run_dir, "bin"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      const executable = build ? join(job.run_dir, "bin", "shud") : h.shudBin;
      expect(job).toMatchObject({
        build_id: build?.build.build_id ?? null,
        binary_sha256: build ? binarySha256 : null,
        threads: threads ?? null,
        task_id: linked ? build?.build.task_id : null,
        command: [executable, "-o", "output/tiny.out", "tiny"],
      });
      await expectNativeReceipt(job.run_dir, "argv-receipt", "-o\noutput/tiny.out\ntiny\n");
      expect(await io.readFile(join(job.run_dir, "invoked-path"), "utf8")).toBe(`${executable}\n`);
      const expectedThreads =
        threads === undefined
          ? inherited
            ? "7\n9\nkept\n"
            : "unset\nunset\nkept\n"
          : `${threads}\n${threads}\nkept\n`;
      expect(await io.readFile(join(job.run_dir, "thread-receipt"), "utf8")).toBe(expectedThreads);
      expect(await io.readFile(executable)).toEqual(build ? binaryBytes : fallback);
      expect(process.env.OMP_NUM_THREADS).toBe(inherited ? "7" : undefined);
      expect(process.env.SHUD_RHS_THREADS).toBe(inherited ? "9" : undefined);
      expect(job.run_dir).toBe(join(await io.realpath(h.cwd), "runs", job.run_id));
      expect(await io.readFile(join(job.run_dir, "input", "tiny", "tiny.cfg.para"))).toEqual(
        h.originals["tiny.cfg.para"],
      );
      const taskPath = linked && build ? cardPath(h, build.build.task_id) : undefined;
      const cardBefore = taskPath ? await fileSnapshot(taskPath) : undefined;
      if (taskPath) {
        expect(TaskCardSchema.parse(JSON.parse(await io.readFile(taskPath, "utf8")))).toMatchObject(
          {
            status: "running",
            runtime_phase: "submitted_job",
            linked_jobs: [job.job_id],
            stack_id: job.stack_id,
            data_id: job.data_id,
          },
        );
      } else {
        await expect(io.readdir(join(h.cwd, "tasks"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      await io.mkdir(join(job.run_dir, "output", "tiny.out"), { recursive: true });
      await io.writeFile(join(job.run_dir, "output", "tiny.out", "result.dat"), "fixture result\n");
      await io.writeFile(join(job.run_dir, "allow-exit"), "");
      await expectNativeReceipt(job.run_dir, "exit_code", "0\n");
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        const current = RunJobSchema.parse(
          JSON.parse(await io.readFile(join(job.run_dir, "run-job.json"), "utf8")),
        );
        return current.status === "succeeded" || current.status === "collected";
      }, "native build run settlement");
      const collected = await h.collect({ run_id: job.run_id });
      expect(collected, JSON.stringify(collected)).toMatchObject({ isError: false });
      if (collected.isError) throw new Error(collected.error.message);
      const record = RunRecordSchema.parse(collected.value);
      expect(record).toMatchObject({
        status: "succeeded",
        exit_code: 0,
        build_id: job.build_id,
        binary_sha256: job.binary_sha256,
        threads: job.threads,
        task_id: job.task_id,
        stack_id: job.stack_id,
        data_id: job.data_id,
        command: job.command,
      });
      const durable = RunJobSchema.parse(
        JSON.parse(await io.readFile(join(job.run_dir, "run-job.json"), "utf8")),
      );
      expect(durable).toMatchObject({
        status: "collected",
        build_id: job.build_id,
        binary_sha256: job.binary_sha256,
        threads: job.threads,
        task_id: job.task_id,
        stack_id: job.stack_id,
        data_id: job.data_id,
      });
      expect(await h.collect({ job_id: job.job_id })).toMatchObject({
        isError: false,
        value: record,
      });
      if (taskPath) expect(await fileSnapshot(taskPath)).toEqual(cardBefore);
      expect(await Promise.all(paths.map(fileSnapshot))).toEqual(snapshots);
    } finally {
      try {
        await h.dispose();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  },
  15_000,
);
