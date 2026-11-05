import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { makeReplayFixture } from "./replay/test-harness.ts";
import { BUFFER_LIMIT, save } from "./shud-web-driver.ts";

const EIGHT_MIB = 8 * 1024 * 1024;

test("compact stopped-session evidence roundtrips all content when pretty JSON exceeds 8 MiB", () => {
  const directory = fs.mkdtempSync(join(tmpdir(), "replay-save-"));
  try {
    const { root, children } = makeReplayFixture().snapshot;
    const message = root.events.find((event) => event.type === "assistant/message")!;
    message.data = {
      turn: 1,
      step: 1,
      message: {
        id: "synthetic-large-message",
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: Array.from({ length: 100_000 }, (_, index) => ({
          type: "text",
          text: `synthetic evidence ${index}`,
        })),
      },
    };
    const payload = { root, children };
    const compact = JSON.stringify(payload) + "\n";
    expect(BUFFER_LIMIT).toBe(EIGHT_MIB);
    expect(Buffer.byteLength(compact)).toBeLessThan(EIGHT_MIB);
    expect(Buffer.byteLength(JSON.stringify(payload, null, 2) + "\n")).toBeGreaterThan(EIGHT_MIB);
    const path = join(directory, "stopped-sessions.json");
    save(path, payload, 0);
    const retained = fs.readFileSync(path, "utf8");
    expect(retained).toBe(compact);
    expect(JSON.parse(retained) as unknown).toEqual(payload);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "compact evidence over the unchanged byte limit rejects before writing (existing file: %s)",
  (existing) => {
    const directory = fs.mkdtempSync(join(tmpdir(), "replay-save-"));
    try {
      const path = join(directory, "evidence.json");
      const original = '{"retained":"original evidence"}\n';
      if (existing) fs.writeFileSync(path, original);
      const payload = { text: "x".repeat(EIGHT_MIB) };
      expect(BUFFER_LIMIT).toBe(EIGHT_MIB);
      expect(Buffer.byteLength(JSON.stringify(payload) + "\n")).toBeGreaterThan(EIGHT_MIB);
      expect(() => save(path, payload, 0)).toThrow("Retained evidence exceeds byte budget");
      if (existing) expect(fs.readFileSync(path, "utf8")).toBe(original);
      else expect(fs.existsSync(path)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
