import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ShudJobRegistry, type ShudProducer, type SubmitShudRequest } from "./index.ts";
import {
  actualRegistry,
  submissionFixture,
  submissionProducer,
  writeInputTree,
} from "./submit-shud/test-harness.ts";

test.each(["equal", "nested"])(
  "stateDir %s to/inside input is rejected without changing input or state bytes",
  async (placement) => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    const stateDir = placement === "equal" ? h.inputDir : join(h.inputDir, "registry-state");
    try {
      await h.apply(ShudJobRegistry, { ...h.config, stateDir });
      const registry = actualRegistry(h.ctx);
      const names = [".lock-guard", "lock", "active.json", "completed.json"];
      const before = await Promise.all(names.map((name) => readFile(join(stateDir, name))));
      await expect(registry.submitShud(h.request, execution.start)).rejects.toThrow("stateDir");
      expect(await Promise.all(names.map((name) => readFile(join(stateDir, name))))).toEqual(
        before,
      );
      for (const [name, bytes] of Object.entries(h.originals)) {
        expect(await readFile(join(h.inputDir, name))).toEqual(bytes);
      }
      expect(await readdir(h.cwd)).not.toContain("runs");
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(execution.handles).toEqual([]);
    } finally {
      execution.finish();
      await h.dispose();
    }
  },
);

test("case aliases cannot hide a run root inside input on a case-insensitive filesystem", async ({
  skip,
}) => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  const workspace = join(h.root, "CaseWorkspace");
  const alias = join(h.root, "caseworkspace");
  try {
    await writeInputTree(workspace);
    try {
      await realpath(alias);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        skip("filesystem is case-sensitive");
        return;
      }
      throw error;
    }
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    await expect(
      registry.submitShud({ ...h.request, cwd: workspace, input_dir: alias }, execution.start),
    ).rejects.toThrow(/input/u);
    expect(await readdir(workspace)).not.toContain("runs");
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
  } finally {
    execution.finish();
    await h.dispose();
  }
});

test.each([
  { label: "bad\nlabel" },
  { end_days: 0 },
  { end_days: 1.5 },
  { owner_session: "" },
  { llm: { response_model: "", response_model_source: "configured" } },
  { llm: { response_model: "explicit", response_model_source: "environment" } },
])("invalid request fields fail before creating runs: %j", async (invalid) => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    await expect(
      registry.submitShud({ ...h.request, ...invalid } as SubmitShudRequest, execution.start),
    ).rejects.toThrow();
    expect(await readdir(h.cwd)).not.toContain("runs");
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
  } finally {
    execution.finish();
    await h.dispose();
  }
});

test("there is no default non-executing producer", async () => {
  const h = await submissionFixture();
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    await expect(
      registry.submitShud(h.request, undefined as unknown as ShudProducer),
    ).rejects.toThrow("requires an execution producer");
    expect(await readdir(h.cwd)).not.toContain("runs");
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
  } finally {
    await h.dispose();
  }
});

test("copied input is independent, submitted ids remain in-flight, and replacement starts with no local in-flight ids", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  try {
    const fiber = await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    const record = await registry.submitShud(h.request, execution.start);
    expect(registry.isSubmissionInFlight(record.run_id)).toBe(true);
    await writeFile(join(record.run_dir, "input", "tiny", "binary.dat"), "solver writeback");
    expect(await readFile(join(h.inputDir, "binary.dat"))).toEqual(h.originals["binary.dat"]);
    await fiber.dispose();
    await h.apply(ShudJobRegistry, h.config);
    const replacement = actualRegistry(h.ctx);
    expect(replacement.isSubmissionInFlight(record.run_id)).toBe(false);
    expect(replacement.indexes.lookup(record.run_id)?.run_dir).toBe(record.run_dir);
    expect(execution.cancellations).toContain("jobs service disposed");
  } finally {
    execution.finish();
    await h.dispose();
  }
});
