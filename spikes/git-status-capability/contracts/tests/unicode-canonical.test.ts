import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorReceipt, invoke, successReceipt } from "./authority-test-helpers";

async function withBytes(bytes: Uint8Array, run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "shud-unicode-"));
  try {
    const path = join(root, "input.json");
    await writeFile(path, bytes);
    await run(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("RFC-8785-compatible Unicode scalar ingress", () => {
  test("distinguishes ill-formed UTF-8 from escaped non-scalar JSON in keys and values", async () => {
    const malformed = [
      '{"schema_version":"\\uD800"}',
      '{"schema_version":"\\uDC00"}',
      '{"schema_version":"\\uDC00\\uD800"}',
      '{"schema_version":"\\uD83D\\u0041"}',
      '{"\\uD800":"value"}',
      '{"\\uDC00":"value"}',
      '{"\\uDC00\\uD800":"value"}',
      '{"\\uD83D\\u0041":"value"}'
    ];
    for (const input of malformed) {
      await withBytes(new TextEncoder().encode(input), async (path) => {
        expect(await invoke(["--input", path, "--kind", "schema"])).toEqual({
          exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_JSON_MALFORMED")
        });
      });
    }
    const illFormed = [
      Uint8Array.from([0x7b, 0x22, 0xed, 0xa0, 0x80, 0x22, 0x3a, 0x30, 0x7d]),
      Uint8Array.from([0x7b, 0x22, 0xed, 0xbf, 0xbf, 0x22, 0x3a, 0x30, 0x7d])
    ];
    for (const bytes of illFormed) {
      await withBytes(bytes, async (path) => {
        expect(await invoke(["--input", path, "--kind", "schema"])).toEqual({
          exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_UTF8_INVALID")
        });
      });
    }
  });

  test("accepts an escaped surrogate pair as one scalar with byte-stable canonical JSON and receipt", async () => {
    const path = join(import.meta.dir, "..", "fixtures", "valid", "source-input-record-paired-surrogate.json");
    const first = await invoke(["--input", path, "--kind", "source_input_record"]);
    const second = await invoke(["--input", path, "--kind", "source_input_record"]);
    expect(first).toEqual({ exit: 0, stdout: successReceipt("source_input_record"), stderr: "" });
    expect(second).toEqual(first);
    const { canonicalJson } = await import("../lib/canonical-json");
    const parsed = JSON.parse(await Bun.file(path).text());
    expect([...parsed.admitted_paths[0]].some((scalar: string) => scalar === "😀")).toBe(true);
    expect(canonicalJson({ path: "😀" })).toBe('{"path":"😀"}');
    const firstCanonical = new TextEncoder().encode(canonicalJson(parsed));
    const secondCanonical = new TextEncoder().encode(canonicalJson(parsed));
    expect(secondCanonical).toEqual(firstCanonical);
  });
});
