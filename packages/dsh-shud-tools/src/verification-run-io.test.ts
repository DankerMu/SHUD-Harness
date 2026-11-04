import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobRecordIdSchema, RunIdSchema, RunRecordSchema } from "@shud-harness/dsh-shud-core";
import { writeWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { afterEach, expect, test, vi } from "vitest";
import { resultValue } from "./report-workflow/test-harness.ts";
import { expectToolError } from "./task-linked/test-harness.ts";
import {
  seedQueryRun,
  snapshotQueryTree,
} from "../../dsh-shud-jobs/src/list-run-jobs/test-harness.ts";
import {
  fixturePaths,
  PRIVATE,
  putFixture,
  SIDES,
  verificationArgs,
} from "./verification-run/matrix/test-harness.ts";
import {
  COMPARED_PATH,
  OUTPUT_BYTES,
  verificationHarness,
} from "./verification-run/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    readFileSync: vi.fn(actual.readFileSync),
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
    realpathSync: Object.assign(vi.fn(actual.realpathSync), {
      native: vi.fn(actual.realpathSync.native),
    }),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const native = await vi.importActual<typeof fs>("node:fs");
const nativeIO = await vi.importActual<typeof io>("node:fs/promises");
function restoreIO() {
  vi.mocked(fs.lstatSync).mockImplementation(native.lstatSync);
  vi.mocked(fs.readFileSync).mockImplementation(native.readFileSync);
  vi.mocked(fs.openSync).mockImplementation(native.openSync);
  vi.mocked(fs.readSync).mockImplementation(native.readSync);
  vi.mocked(fs.closeSync).mockImplementation(native.closeSync);
  vi.mocked(io.readFile).mockImplementation(nativeIO.readFile);
  vi.mocked(fs.realpathSync.native).mockImplementation(native.realpathSync.native);
}
afterEach(restoreIO);

for (const side of SIDES) {
  test.each(["job", "run", "build", "data", "ancestor", "open", "read", "close"] as const)(
    `${side} ${side === "base" ? "first" : "second"} evidence %s IO failure hides payload and publishes nothing`,
    async (fault) => {
      const h = await verificationHarness();
      try {
        const paths = fixturePaths(h, side);
        const before = await snapshotQueryTree(h.root);
        const fail = () => Object.assign(new Error(PRIVATE), { code: "EIO" });
        let injectedReads = 0;
        if (fault === "job" || fault === "run") {
          vi.mocked(io.readFile).mockImplementation(async (...args) => {
            if (args[0] === paths[fault]) throw fail();
            return nativeIO.readFile(...args);
          });
        } else if (fault === "build" || fault === "data") {
          vi.mocked(fs.readFileSync).mockImplementation((...args) => {
            if (String(args[0]) === paths[fault]) {
              injectedReads++;
              throw fail();
            }
            return native.readFileSync(...args);
          });
        } else if (fault === "ancestor") {
          vi.mocked(fs.lstatSync).mockImplementation((...args) => {
            if (
              String(args[0]).includes(h[side].job.run_id) &&
              String(args[0]).endsWith("/output/tiny.out")
            )
              throw fail();
            return native.lstatSync(...args);
          });
        } else {
          let descriptor: number | undefined;
          vi.mocked(fs.openSync).mockImplementation((...args) => {
            const target = String(args[0]);
            const output = target.includes(h[side].job.run_id) && target.endsWith(COMPARED_PATH);
            if (output && fault === "open") throw fail();
            const fd = native.openSync(...args);
            if (output) descriptor = fd;
            return fd;
          });
          vi.mocked(fs.readSync).mockImplementation((...args) => {
            if (args[0] === descriptor && fault === "read") throw fail();
            return native.readSync(...args);
          });
          vi.mocked(fs.closeSync).mockImplementation((fd) => {
            native.closeSync(fd);
            // Simulate a failed close acknowledgement without leaking a real test descriptor.
            if (fd === descriptor && fault === "close") throw fail();
          });
        }
        const result = await h.invoke();
        expectToolError(result, /read|directory|query|collect|open|close/iu);
        if (fault === "build" || fault === "data") expect(injectedReads).toBe(1);
        expect(JSON.stringify(result)).not.toContain(PRIVATE);
        expect(await snapshotQueryTree(h.root)).toEqual(before);
      } finally {
        restoreIO();
        await h.dispose();
      }
    },
  );
}

test("verification never reads solver logs or unrelated output artifacts", async () => {
  const h = await verificationHarness();
  try {
    const unrelated: string[] = [];
    for (const side of SIDES) {
      for (const name of [
        "stdout.log",
        "stderr.log",
        "output/tiny.out/cvode_stats.txt",
        "output/tiny.out/other.dat",
      ]) {
        const path = join(h[side].job.run_dir, name);
        native.writeFileSync(path, PRIVATE);
        unrelated.push(native.realpathSync(path));
      }
    }
    vi.clearAllMocks();
    expect(resultValue(await h.invoke()).status).toBe("passed");
    const opened = [
      ...vi.mocked(fs.openSync).mock.calls,
      ...vi.mocked(fs.readFileSync).mock.calls,
      ...vi.mocked(io.readFile).mock.calls,
    ].flatMap(([path]) => {
      if (typeof path === "string") return [path];
      if (Buffer.isBuffer(path)) return [path.toString("utf8")];
      if (path instanceof URL) return [fileURLToPath(path)];
      return [];
    });
    for (const path of unrelated) expect(opened).not.toContain(path);
  } finally {
    restoreIO();
    await h.dispose();
  }
});

test("unbound private run_dir resolution failure hides record paths and OS causes without writes", async () => {
  const h = await verificationHarness();
  try {
    const runId = RunIdSchema.parse("RUN-20261022T031500-f003");
    const privateDirectory = join(h.root, "PRIVATE_RECORD_PATH", runId);
    const job = await seedQueryRun(
      h,
      "f003",
      {
        ...h.candidate.job,
        run_id: runId,
        job_id: JobRecordIdSchema.parse("JOB-20261022T031500-f003"),
        run_dir: privateDirectory,
      },
      "completed",
    );
    const record = RunRecordSchema.parse({
      ...h.candidate.run,
      run_id: job.run_id,
      job_id: job.job_id,
    });
    putFixture(join(privateDirectory, "run-record.json"), record);
    native.mkdirSync(join(privateDirectory, "output", "tiny.out"), { recursive: true });
    native.writeFileSync(join(privateDirectory, COMPARED_PATH), OUTPUT_BYTES);
    native.mkdirSync(join(h.cwd, "runs", runId));
    writeWorkspaceRecord(h.cwd, "task", {
      ...h.card,
      linked_jobs: [h.base.job.job_id, job.job_id],
    });
    // Qualify actual indexed/collected evidence before injecting the unbound-root failure.
    expect(await h.registry.listRunJobsByTask(h.card.task_id)).toContainEqual(job);
    expect(await h.registry.collectShud(h.base.job.run_id, { readonly: true })).toEqual(h.base.run);
    expect(await h.registry.collectShud(job.run_id, { readonly: true })).toEqual(record);
    const before = await snapshotQueryTree(h.root);
    let injected = 0;
    vi.mocked(fs.realpathSync.native).mockImplementation((...args) => {
      if (args[0] === privateDirectory) {
        injected++;
        throw Object.assign(new Error("PRIVATE_OS_CAUSE"), { code: "EIO" });
      }
      return native.realpathSync.native(...args);
    });
    const result = await h.invoke({ ...verificationArgs(h), candidate_run_id: runId });
    restoreIO();
    const message = expectToolError(result, /run_dir|directory/iu);
    expect(injected).toBe(1);
    expect(await snapshotQueryTree(h.root)).toEqual(before);
    expect(message).toContain(runId);
    expect(message).not.toContain(privateDirectory);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    if (result.isError) expect(result.error).not.toHaveProperty("cause");
  } finally {
    restoreIO();
    await h.dispose();
  }
});
