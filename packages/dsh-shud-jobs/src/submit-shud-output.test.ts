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
    execution.finish();
    try {
      await h.dispose();
    } finally {
      vi.useRealTimers();
    }
  }
});
