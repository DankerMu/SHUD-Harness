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

  test("parser node guard is inclusive at exact and rejects +1 when only the item ceiling is relaxed", () => {
    const nodes = (count: number) => Buffer.from(`[${Array.from({ length: count - 1 }, () => "0").join(",")}]`);
    for (const profile of [SOURCE_PROFILE, SOURCE_METADATA_PROFILE]) {
      const nodeProfile = { ...profile, items: profile.nodes };
      expect(() => parseBoundedJson(nodes(profile.nodes), nodeProfile)).not.toThrow();
      expectCode(() => parseBoundedJson(nodes(profile.nodes + 1), nodeProfile), "CONTRACT_JSON_NODE_LIMIT");
    }
  });

  test("exact source depth and items reach schema validation while +1 returns the matching limit code", async () => {
    const cases: Array<[string, string]> = [
      ["[".repeat(SOURCE_PROFILE.depth - 1) + "0" + "]".repeat(SOURCE_PROFILE.depth - 1), "CONTRACT_SCHEMA_INVALID"],
      ["[".repeat(SOURCE_PROFILE.depth) + "0" + "]".repeat(SOURCE_PROFILE.depth), "CONTRACT_JSON_DEPTH_LIMIT"],
      [`[${Array.from({ length: SOURCE_PROFILE.items }, () => "0").join(",")}]`, "CONTRACT_SCHEMA_INVALID"],
      [`[${Array.from({ length: SOURCE_PROFILE.items + 1 }, () => "0").join(",")}]`, "CONTRACT_JSON_ITEM_LIMIT"]
    ];
    for (const [text, code] of cases) {
      await withTemporaryFile(text, async (path) => {
        expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
          exit: 2, stdout: "", stderr: failure(code)
        });
      });
    }
  });

  test("source metadata profile retains exact/+1 byte, depth, and item boundaries", async () => {
    const metadata = await readFile(new URL("../contract-v1.json", import.meta.url));
    const padded = Buffer.concat([metadata, Buffer.alloc(SOURCE_METADATA_PROFILE.bytes - metadata.length, 0x20)]);
    expect(() => validateContractMetadata(padded)).not.toThrow();
    expectCode(() => validateContractMetadata(Buffer.concat([padded, Buffer.from(" ")])), "CONTRACT_BYTES_LIMIT");
    const depth = (count: number) => Buffer.from("[".repeat(count - 1) + "0" + "]".repeat(count - 1));
    expect(() => parseBoundedJson(depth(SOURCE_METADATA_PROFILE.depth), SOURCE_METADATA_PROFILE)).not.toThrow();
    expectCode(
      () => parseBoundedJson(depth(SOURCE_METADATA_PROFILE.depth + 1), SOURCE_METADATA_PROFILE),
      "CONTRACT_JSON_DEPTH_LIMIT"
    );
    const items = (count: number) => Buffer.from(`[${Array.from({ length: count }, () => "0").join(",")}]`);
    expect(() => parseBoundedJson(items(SOURCE_METADATA_PROFILE.items), SOURCE_METADATA_PROFILE)).not.toThrow();
    expectCode(
      () => parseBoundedJson(items(SOURCE_METADATA_PROFILE.items + 1), SOURCE_METADATA_PROFILE),
      "CONTRACT_JSON_ITEM_LIMIT"
    );
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

  test("source input records reject CR and LF path identities", async () => {
    const valid = JSON.parse(await sourceText());
    for (const path of ["cr\r.json", "lf\n.json"]) {
      const changed = structuredClone(valid);
      changed.admitted_paths[0] = path;
      changed.primary_result.admitted_paths[0] = path;
      changed.witness_result.admitted_paths[0] = path;
      await withTemporaryFile(JSON.stringify(changed), async (input) => {
        expect(await capture(["--input", input, "--kind", "source_input_record"])).toEqual({
          exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID")
        });
      });
    }
  });
});
