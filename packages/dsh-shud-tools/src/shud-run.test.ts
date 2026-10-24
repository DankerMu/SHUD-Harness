import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { RunJobSchema } from "@shud-harness/dsh-shud-core";
import {
  readInvocation,
  releaseInvocation,
} from "../../dsh-shud-jobs/src/detached-shud/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";

test("shud_run returns durable and current job ids while the native solver is still running", async () => {
  const h = await createToolHarness();
  try {
    const result = await h.call({ input_dir: h.inputDir, end_days: 30, label: "tiny 30d" });
    // In the unmounted baseline this reports ToolRuntime's normalized UNKNOWN_TOOL result.
    expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
    if (result.isError) throw new Error(result.error.message);
    const value = result.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Successful shud_run must return an object");
    }
    expect(value.status).toBe("running");
    expect(value.job_id).toMatch(/^JOB-\d{8}T\d{6}-[0-9a-f]{4}$/);
    expect(value.run_id).toMatch(/^RUN-\d{8}T\d{6}-[0-9a-f]{4}$/);
    expect(value.dsh_job_id).toMatch(/^shud-[0-9a-f]{16}$/);
    expect(value.run_dir).toBeTypeOf("string");
    const entries = h.registry.indexes.read().active;
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error("Successful shud_run omitted its active index entry");
    const record = RunJobSchema.parse(
      JSON.parse(await readFile(join(entry.run_dir, "run-job.json"), "utf8")),
    );
    expect(result.value).toEqual({
      status: "running",
      job_id: record.job_id,
      run_id: record.run_id,
      dsh_job_id: record.dsh_job_id,
      run_dir: record.run_dir,
    });
    expect(record).toMatchObject({
      status: "running",
      run_dir: join(await realpath(h.cwd), "runs", record.run_id),
      owner_session: h.ownerId,
      label: "tiny 30d",
      llm: { response_model: "configured-test-model", response_model_source: "configured" },
    });
    expect(h.registry.list()).toMatchObject([
      { id: record.dsh_job_id, label: `${record.run_id} tiny 30d`, status: "running" },
    ]);
    await expect.poll(() => readInvocation(record.run_dir)).not.toBeNull();
    const invocation = await readInvocation(record.run_dir);
    if (!invocation) throw new Error("Native solver omitted its invocation receipt");
    expect(invocation).toMatchObject({
      cwd: record.run_dir,
      argv: ["-o", "output/tiny.out", "tiny"],
    });
    expect(invocation.port).toBeTypeOf("number");
    expect(() => process.kill(invocation.pid, 0)).not.toThrow();
    await expect(readFile(join(record.run_dir, "exit_code"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const [path, original] of Object.entries(h.originals)) {
      expect(await readFile(join(h.inputDir, path))).toEqual(original);
    }
    expect(await readFile(join(record.run_dir, "input", "tiny", "tiny.cfg.para"), "utf8")).toBe(
      "# synthetic input\r\nSTART\t0\r\nEND\t30\r\nOTHER\t17\r\n",
    );
    const rendered = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(rendered).toContain("job_output");
    expect(rendered).toContain("job_kill");
    expect(rendered).toContain(record.dsh_job_id);
    expect(rendered).toContain("job_list");
    expect(rendered).toContain("shud_collect");
    await releaseInvocation(invocation);
    await expect.poll(() => readFile(join(record.run_dir, "exit_code"), "utf8")).toBe("0\n");
  } finally {
    await h.dispose();
  }
}, 15_000);
