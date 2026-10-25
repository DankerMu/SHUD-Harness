import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ShudJobRegistry } from "./index.ts";
import {
  actualRegistry,
  submissionFixture,
  submissionProducer,
} from "./submit-shud/test-harness.ts";

test("actual parent output controls preserve a character split between stdout writes", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  try {
    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const registry = actualRegistry(h.ctx);
    const record = await registry.submitShud(h.request, execution.start);
    const id = execution.handles[0].id;
    execution.append(Buffer.from([0x41, 0xf0, 0x90]));
    await vi.advanceTimersByTimeAsync(7);
    expect(
      registry
        .read(id)
        .chunks.map((chunk) => chunk.text)
        .join(""),
    ).toBe("A");
    await vi.advanceTimersByTimeAsync(7);
    expect(registry.read(id).chunks).toEqual([]);
    execution.append(Buffer.from([0x90, 0x80, 0x0a]));
    await vi.advanceTimersByTimeAsync(7);
    expect(
      registry
        .read(id)
        .chunks.map((chunk) => chunk.text)
        .join(""),
    ).toBe("\u{10400}\n");
    expect(registry.get(id).output.spillPaths).toEqual([join(record.run_dir, "stdout.log")]);
    expect(
      registry
        .readAt(id, 0)
        .chunks.map((chunk) => chunk.text)
        .join(""),
    ).toBe("A\u{10400}\n");
  } finally {
    vi.useRealTimers();
    await execution.finish();
    await h.dispose();
  }
});

test("actual parent warns and stops replaced stdout while retaining prior output without external bytes", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  const warnings: string[] = [];
  try {
    h.ctx.logger.exporter({
      levels: { default: 2 }, // Cordis defaults to info; include warning exports.
      export(message) {
        if (message.type === "warn") warnings.push(message.args.map(String).join(" "));
      },
    });
    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const registry = actualRegistry(h.ctx);
    const record = await registry.submitShud(h.request, execution.start);
    const id = execution.handles[0].id;
    execution.append("prior\n");
    await vi.advanceTimersByTimeAsync(7);
    expect(
      registry
        .read(id)
        .chunks.map((chunk) => chunk.text)
        .join(""),
    ).toBe("prior\n");

    const path = join(record.run_dir, "stdout.log");
    const external = join(h.root, "external.txt");
    await writeFile(external, "prior\nHARMLESS_EXTERNAL_SENTINEL\n");
    await rm(path);
    await symlink(external, path);
    await vi.advanceTimersByTimeAsync(7);
    expect(registry.read(id).chunks).toEqual([]);
    expect(
      registry
        .readAt(id, 0)
        .chunks.map((chunk) => chunk.text)
        .join(""),
    ).toBe("prior\n");
    expect(warnings).toEqual([
      expect.stringContaining(`jobs: output source for ${id} failed; its stream stops here:`),
    ]);

    // Repairing the path must not restart a source after its first failure.
    await rm(path);
    await writeFile(path, "prior\nSHOULD_NOT_RESUME\n");
    await vi.advanceTimersByTimeAsync(21);
    expect(registry.read(id).chunks).toEqual([]);
    expect(warnings).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await execution.finish();
    await h.dispose();
  }
});
