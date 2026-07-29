import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../lib/canonical-json";
import { SOURCE_METADATA_PROFILE, SOURCE_PROFILE } from "../lib/constants";
import { ContractError, parseBoundedJson } from "../lib/ingress";
import { admitSourceInput, validateContractMetadata } from "../lib/schemas";
import { capture, failure, sourceText, success, validSourcePath, withTemporaryFile } from "./helpers";

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected contract error");
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe(code);
  }
}

describe("strict source ingress", () => {
  test("paired surrogate is one scalar with byte-identical canonical bytes and repeat receipts", async () => {
    const bytes = await readFile(validSourcePath);
    const first = admitSourceInput("source_input_record", bytes);
    const second = admitSourceInput("source_input_record", bytes);
    expect(first).toEqual(second);
    expect(new TextDecoder().decode(first)).toContain("😀.json");
    expect(await capture(["--input", validSourcePath, "--kind", "source_input_record"])).toEqual({
      exit: 0, stdout: success("source_input_record"), stderr: ""
    });
    expect(await capture(["--input", validSourcePath, "--kind", "source_input_record"])).toEqual({
      exit: 0, stdout: success("source_input_record"), stderr: ""
    });
    expect(canonicalJson({ "😀": "\ud83d\ude00" })).toBe('{"😀":"😀"}');
  });

  test("ill-formed UTF-8 fails before JSON", async () => {
    await withTemporaryFile(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xed, 0xa0, 0x80, 0x7d]), async (path) => {
      expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
        exit: 2, stdout: "", stderr: failure("CONTRACT_UTF8_INVALID")
      });
    });
  });

  test("every escaped surrogate failure class in a key and value is malformed", async () => {
    const classes = ["\\uD83D", "\\uDE00", "\\uDE00\\uD83D", "\\uD83D\\u0041"];
    for (const escaped of classes) {
      for (const text of [`{"${escaped}":0}`, `{"x":"${escaped}"}`]) {
        expectCode(() => parseBoundedJson(Buffer.from(text), SOURCE_PROFILE), "CONTRACT_JSON_MALFORMED");
        await withTemporaryFile(text, async (path) => {
          expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
            exit: 2, stdout: "", stderr: failure("CONTRACT_JSON_MALFORMED")
          });
        });
      }
    }
  });

  test("malformed, trailing, duplicate, deep, wide, and unknown or missing schema fail with frozen codes", async () => {
    const cases: Array<[string, string]> = [
      ["{", "CONTRACT_JSON_MALFORMED"],
      ["{} trailing", "CONTRACT_JSON_MALFORMED"],
      ['{"x":1,"x":2}', "CONTRACT_JSON_DUPLICATE_KEY"]
    ];
    for (const [text, code] of cases) expectCode(() => parseBoundedJson(Buffer.from(text), SOURCE_PROFILE), code);
    for (const [text, code] of cases) {
      await withTemporaryFile(text, async (path) => {
        expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({ exit: 2, stdout: "", stderr: failure(code) });
      });
    }
    expectCode(() => parseBoundedJson(Buffer.from("[".repeat(13) + "0" + "]".repeat(13)), SOURCE_PROFILE), "CONTRACT_JSON_DEPTH_LIMIT");
    expectCode(() => parseBoundedJson(Buffer.from(`[${Array.from({ length: 513 }, () => "0").join(",")}]`), SOURCE_PROFILE), "CONTRACT_JSON_ITEM_LIMIT");
    for (const [text, code] of [
      ["[".repeat(13) + "0" + "]".repeat(13), "CONTRACT_JSON_DEPTH_LIMIT"],
      [`[${Array.from({ length: 513 }, () => "0").join(",")}]`, "CONTRACT_JSON_ITEM_LIMIT"]
    ]) {
      await withTemporaryFile(text, async (path) => {
        expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({ exit: 2, stdout: "", stderr: failure(code) });
      });
    }
    const valid = JSON.parse(await sourceText());
    for (const mutate of [(value: any) => { delete value.source_sha; }, (value: any) => { value.future = true; }]) {
      const changed = structuredClone(valid);
      mutate(changed);
      await withTemporaryFile(JSON.stringify(changed), async (path) => {
        expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
          exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID")
        });
      });
    }
  });

  test("source byte ceiling is inclusive and +1 is rejected", async () => {
    const base = await sourceText();
    for (const [size, expectedExit, expected] of [
      [SOURCE_PROFILE.bytes, 0, success("source_input_record")],
      [SOURCE_PROFILE.bytes + 1, 2, failure("CONTRACT_BYTES_LIMIT")]
    ] as const) {
      const text = base + " ".repeat(size - Buffer.byteLength(base));
      expect(Buffer.byteLength(text)).toBe(size);
      await withTemporaryFile(text, async (path) => {
        const result = await capture(["--input", path, "--kind", "source_input_record"]);
        expect(result.exit).toBe(expectedExit);
        expect(expectedExit === 0 ? result.stdout : result.stderr).toBe(expected);
        expect(expectedExit === 0 ? result.stderr : result.stdout).toBe("");
      });
    }
  });

  test("every source depth, node, and item exact/+1 counter is inclusive independently", () => {
    const depth = (count: number) => Buffer.from("[".repeat(count - 1) + "0" + "]".repeat(count - 1));
    expect(() => parseBoundedJson(depth(12), { ...SOURCE_PROFILE, nodes: 10_000, items: 10_000 })).not.toThrow();
    expectCode(() => parseBoundedJson(depth(13), { ...SOURCE_PROFILE, nodes: 10_000, items: 10_000 }), "CONTRACT_JSON_DEPTH_LIMIT");
    const nodes = (count: number) => Buffer.from(`[${Array.from({ length: count - 1 }, () => "0").join(",")}]`);
    expect(() => parseBoundedJson(nodes(2_048), { ...SOURCE_PROFILE, bytes: 100_000, items: 10_000 })).not.toThrow();
    expectCode(() => parseBoundedJson(nodes(2_049), { ...SOURCE_PROFILE, bytes: 100_000, items: 10_000 }), "CONTRACT_JSON_NODE_LIMIT");
    const items = (count: number) => Buffer.from(`[${Array.from({ length: count }, () => "0").join(",")}]`);
    expect(() => parseBoundedJson(items(512), { ...SOURCE_PROFILE, nodes: 10_000 })).not.toThrow();
    expectCode(() => parseBoundedJson(items(513), { ...SOURCE_PROFILE, nodes: 10_000 }), "CONTRACT_JSON_ITEM_LIMIT");
  });

  test("source metadata profile has exact/+1 byte, depth, node, and item boundaries", async () => {
    const metadata = await readFile(new URL("../contract-v1.json", import.meta.url));
    const padded = Buffer.concat([metadata, Buffer.alloc(SOURCE_METADATA_PROFILE.bytes - metadata.length, 0x20)]);
    expect(() => validateContractMetadata(padded)).not.toThrow();
    expectCode(() => validateContractMetadata(Buffer.concat([padded, Buffer.from(" ")])), "CONTRACT_BYTES_LIMIT");
    const relaxed = { ...SOURCE_METADATA_PROFILE, bytes: 1_000_000, nodes: 100_000, items: 100_000 };
    const depth = (count: number) => Buffer.from("[".repeat(count - 1) + "0" + "]".repeat(count - 1));
    expect(() => parseBoundedJson(depth(32), relaxed)).not.toThrow();
    expectCode(() => parseBoundedJson(depth(33), relaxed), "CONTRACT_JSON_DEPTH_LIMIT");
    const nodes = (count: number) => Buffer.from(`[${Array.from({ length: count - 1 }, () => "0").join(",")}]`);
    expect(() => parseBoundedJson(nodes(32_768), { ...relaxed, depth: 32, nodes: 32_768 })).not.toThrow();
    expectCode(() => parseBoundedJson(nodes(32_769), { ...SOURCE_METADATA_PROFILE, bytes: 1_000_000, items: 100_000 }), "CONTRACT_JSON_NODE_LIMIT");
    const items = (count: number) => Buffer.from(`[${Array.from({ length: count }, () => "0").join(",")}]`);
    expect(() => parseBoundedJson(items(8_192), { ...SOURCE_METADATA_PROFILE, bytes: 1_000_000, nodes: 100_000 })).not.toThrow();
    expectCode(() => parseBoundedJson(items(8_193), { ...SOURCE_METADATA_PROFILE, bytes: 1_000_000, nodes: 100_000 }), "CONTRACT_JSON_ITEM_LIMIT");
  });

  test("future-owned input kinds and malformed argv are rejected without partial output", async () => {
    for (const args of [
      ["--input", validSourcePath, "--kind", "dependency_graph"],
      ["--input", validSourcePath],
      ["--input", validSourcePath, "--kind", "source_input_record", "--kind", "source_input_record"]
    ]) {
      expect(await capture(args)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
    }
  });
});
