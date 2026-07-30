import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { canonicalJson } from "../lib/canonical-json";
import { SOURCE_PROFILE } from "../lib/constants";
import {
  ContractError,
  parseBoundedJson,
  type DescriptorOperation
} from "../lib/ingress";
import { admitSourceInput } from "../lib/schemas";
import {
  capture,
  countedItems,
  descriptorCount,
  directCommand,
  failure,
  recordWithEntries,
  sourceRecord,
  success,
  validIdentityPath,
  validSourcePath,
  withTemporaryFile
} from "./helpers";

type Kind = "source_input_record" | "source_identity_projection";
type FailureScenario = "upper_symlink" | "parent_symlink" | "ancestor_replacement" | "final_replacement";

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected contract error");
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe(code);
  }
}

async function exerciseFailure(kind: Kind, fixturePath: string, scenario: FailureScenario): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shud-source-capability-"));
  const operations: DescriptorOperation[] = [];
  let replacementPath: string | undefined;
  const replacementBytes = Buffer.from('{"replacement":"must-not-be-read"}');
  try {
    const upper = join(root, "upper");
    const ancestor = join(upper, "ancestor");
    const parent = join(ancestor, "parent");
    await mkdir(parent, { recursive: true });
    const input = join(parent, basename(fixturePath));
    await writeFile(input, await readFile(fixturePath));
    let selectedInput = input;

    if (scenario === "upper_symlink") {
      const upperLink = join(root, "upper-link");
      await symlink(upper, upperLink);
      selectedInput = join(upperLink, "ancestor", "parent", basename(input));
    } else if (scenario === "parent_symlink") {
      const parentLink = join(ancestor, "parent-link");
      await symlink(parent, parentLink);
      selectedInput = join(parentLink, basename(input));
    }

    const result = await capture(["--input", selectedInput, "--kind", kind], {
      observe: (operation) => { operations.push(operation); },
      afterAdmission: async () => {
        if (scenario === "ancestor_replacement") {
          const retainedAncestor = join(upper, "ancestor.retained");
          await rename(ancestor, retainedAncestor);
          replacementPath = join(ancestor, "parent", basename(input));
          await mkdir(join(ancestor, "parent"), { recursive: true });
          await writeFile(replacementPath, replacementBytes);
        } else if (scenario === "final_replacement") {
          await rename(input, `${input}.retained`);
          replacementPath = input;
          await writeFile(replacementPath, replacementBytes);
        }
      }
    });

    expect(result).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
    expect(result.stderr.endsWith("\n")).toBe(true);
    if (replacementPath) expect(await readFile(replacementPath)).toEqual(replacementBytes);
    expect(operations.filter((operation) => operation.phase === "post_admission" && operation.operation === "read_retained")).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("descriptor-bound source ingress", () => {
  test("source record direct command emits the exact LF-terminated public receipt", async () => {
    const result = await directCommand(["--input", validSourcePath, "--kind", "source_input_record"]);
    expect(result).toEqual({ exit: 0, stdout: success("source_input_record"), stderr: "" });
    expect(result.stdout.endsWith("\n")).toBe(true);
  });

  test("canonical source records preserve canonical JSON and byte-identical repeat receipts", async () => {
    const bytes = await readFile(validSourcePath);
    expect(admitSourceInput("source_input_record", bytes)).toEqual(admitSourceInput("source_input_record", bytes));
    expect(new TextDecoder().decode(admitSourceInput("source_input_record", bytes))).toContain("😀.json");
    expect(canonicalJson({ "😀": "\ud83d\ude00" })).toBe('{"😀":"😀"}');
    const expected = { exit: 0, stdout: success("source_input_record"), stderr: "" };
    expect(await capture(["--input", validSourcePath, "--kind", "source_input_record"])).toEqual(expected);
    expect(await capture(["--input", validSourcePath, "--kind", "source_input_record"])).toEqual(expected);
  });

  test("direct commands preserve input bytes and implementation has no file-write or child-process authority", async () => {
    for (const [kind, path] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      const beforeBytes = await readFile(path);
      const beforeStat = await stat(path);
      expect((await directCommand(["--input", path, "--kind", kind])).exit).toBe(0);
      expect(await readFile(path)).toEqual(beforeBytes);
      const afterStat = await stat(path);
      expect(afterStat.mode).toBe(beforeStat.mode);
      expect(afterStat.size).toBe(beforeStat.size);
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    }
    const implementation = await Promise.all([
      readFile(new URL("../lib/ingress.ts", import.meta.url), "utf8"),
      readFile(new URL("../lib/checker.ts", import.meta.url), "utf8"),
      readFile(new URL("../check.ts", import.meta.url), "utf8")
    ]);
    expect(implementation.join("\n")).not.toMatch(/node:child_process|Bun\.spawn|spawnSync|execFile|execSync/);
    expect(implementation[0]).toContain("closeSync, constants, fstatSync, openSync, readSync");
    expect(implementation[0]).not.toMatch(/writeFile|writeSync|renameSync|unlinkSync|mkdirSync|rmSync/);
  });

  test("post-admission tripwire permits only retained-descriptor-relative opens and retained reads", async () => {
    for (const [kind, path] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      const operations: DescriptorOperation[] = [];
      expect(await capture(["--input", path, "--kind", kind], {
        observe: (operation) => { operations.push(operation); }
      })).toEqual({ exit: 0, stdout: success(kind), stderr: "" });
      const afterAdmission = operations.filter((operation) => operation.phase === "post_admission");
      expect(afterAdmission.length).toBeGreaterThan(0);
      expect(afterAdmission.some((operation) => operation.operation === "open_root")).toBe(false);
      for (const operation of afterAdmission) {
        expect(operation.path.startsWith("/")).toBe(false);
        if (operation.operation === "open_relative") {
          expect(operation.path.includes("/")).toBe(false);
          expect(operation.parentDescriptor).toBeNumber();
        } else {
          expect(operation.operation).toBe("read_retained");
          expect(operation.descriptor).toBeNumber();
        }
      }
    }
  });

  test("upper and parent symlinks plus ancestor and final replacements fail without reading replacement bytes", async () => {
    for (const [kind, path] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      for (const scenario of ["upper_symlink", "parent_symlink", "ancestor_replacement", "final_replacement"] as const) {
        await exerciseFailure(kind, path, scenario);
      }
    }
  });

  test("success and every named failure restore descriptor baseline across repeated loops", async () => {
    const baseline = await descriptorCount();
    for (let repeat = 0; repeat < 6; repeat += 1) {
      for (const [kind, path] of [
        ["source_input_record", validSourcePath],
        ["source_identity_projection", validIdentityPath]
      ] as const) {
        expect((await capture(["--input", path, "--kind", kind])).exit).toBe(0);
        for (const scenario of ["upper_symlink", "parent_symlink", "ancestor_replacement", "final_replacement"] as const) {
          await exerciseFailure(kind, path, scenario);
        }
      }
    }
    Bun.gc(true);
    expect(await descriptorCount()).toBe(baseline);
  });

  test("success, hook throw, byte bound, malformed JSON, and schema failure all restore descriptors", async () => {
    const baseline = await descriptorCount();
    expect((await capture(["--input", validSourcePath, "--kind", "source_input_record"])).exit).toBe(0);
    expect((await capture(["--input", validSourcePath, "--kind", "source_input_record"], {
      afterAdmission: () => { throw new Error("hook fault"); }
    })).exit).toBe(2);
    await withTemporaryFile(" ".repeat(SOURCE_PROFILE.bytes + 1), async (path) => {
      expect((await capture(["--input", path, "--kind", "source_input_record"])).stderr).toBe(failure("CONTRACT_BYTES_LIMIT"));
    });
    for (const text of ["{", "{}"] as const) {
      await withTemporaryFile(text, async (path) => {
        expect((await capture(["--input", path, "--kind", "source_input_record"])).exit).toBe(2);
      });
    }
    const directoryRoot = await mkdtemp(join(tmpdir(), "shud-source-directory-input-"));
    try {
      expect((await capture(["--input", directoryRoot, "--kind", "source_input_record"])).exit).toBe(2);
    } finally {
      await rm(directoryRoot, { recursive: true, force: true });
    }
    Bun.gc(true);
    expect(await descriptorCount()).toBe(baseline);
  });
});

describe("normalized source record and frozen capacity", () => {
  test("the admitted set appears once and encoder results contain the exact binding keys", async () => {
    const fixture = await sourceRecord();
    expect(Object.keys(fixture.primary_result).sort()).toEqual([
      "entry_count", "manifest_digest", "source_input_digest", "status"
    ]);
    expect(Object.keys(fixture.witness_result).sort()).toEqual([
      "entry_count", "manifest_digest", "source_input_digest", "status"
    ]);
    expect(JSON.stringify(fixture).match(/admitted_paths/g)).toHaveLength(1);
    expect(JSON.stringify(fixture).match(/admitted_modes/g)).toHaveLength(1);
  });

  test("each primary and witness tuple mismatch and any reintroduced admitted array is rejected", async () => {
    const fixture = await sourceRecord();
    const mutations: Array<(value: any) => void> = [];
    for (const result of ["primary_result", "witness_result"] as const) {
      mutations.push(
        (value) => { value[result].source_input_digest = "3".repeat(64); },
        (value) => { value[result].manifest_digest = "4".repeat(64); },
        (value) => { value[result].entry_count += 1; },
        (value) => { value[result].admitted_paths = [...value.admitted_paths]; },
        (value) => { value[result].admitted_modes = [...value.admitted_modes]; }
      );
    }
    for (const mutate of mutations) {
      const changed = structuredClone(fixture);
      mutate(changed);
      await withTemporaryFile(JSON.stringify(changed), async (path) => {
        expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
          exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID")
        });
      });
    }
  });

  test("237 entries are exactly 512 items and succeed while 238 are 514 and hit only the item limit", async () => {
    for (const [entries, itemCount, expected] of [
      [237, 512, { exit: 0, stdout: success("source_input_record"), stderr: "" }],
      [238, 514, { exit: 2, stdout: "", stderr: failure("CONTRACT_JSON_ITEM_LIMIT") }]
    ] as const) {
      const value = recordWithEntries(entries);
      const bytes = Buffer.from(JSON.stringify(value));
      expect(countedItems(value)).toBe(itemCount);
      expect(bytes.byteLength).toBeLessThan(SOURCE_PROFILE.bytes);
      await withTemporaryFile(bytes, async (path) => {
        expect(await directCommand(["--input", path, "--kind", "source_input_record"])).toEqual(expected);
      });
    }
  });

  test("parser node exact and plus one remain independent under a relaxed item ceiling", () => {
    const nodes = (count: number) => Buffer.from(`[${Array.from({ length: count - 1 }, () => "0").join(",")}]`);
    const profile = { ...SOURCE_PROFILE, items: SOURCE_PROFILE.nodes };
    expect(() => parseBoundedJson(nodes(SOURCE_PROFILE.nodes), profile)).not.toThrow();
    expectCode(() => parseBoundedJson(nodes(SOURCE_PROFILE.nodes + 1), profile), "CONTRACT_JSON_NODE_LIMIT");
  });

  test("byte, depth, item, UTF-8, malformed, duplicate, unknown, and missing failures retain exact receipts", async () => {
    const valid = await sourceRecord();
    const cases: Array<[Uint8Array | string, string]> = [
      [" ".repeat(SOURCE_PROFILE.bytes + 1), "CONTRACT_BYTES_LIMIT"],
      [Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xed, 0xa0, 0x80, 0x7d]), "CONTRACT_UTF8_INVALID"],
      ["{", "CONTRACT_JSON_MALFORMED"],
      ["{} trailing", "CONTRACT_JSON_MALFORMED"],
      ['{"x":1,"x":2}', "CONTRACT_JSON_DUPLICATE_KEY"],
      ["[".repeat(SOURCE_PROFILE.depth) + "0" + "]".repeat(SOURCE_PROFILE.depth), "CONTRACT_JSON_DEPTH_LIMIT"],
      [`[${Array.from({ length: SOURCE_PROFILE.items + 1 }, () => "0").join(",")}]`, "CONTRACT_JSON_ITEM_LIMIT"]
    ];
    const missing = structuredClone(valid); delete missing.source_sha;
    const unknown = structuredClone(valid); unknown.future = true;
    cases.push([JSON.stringify(missing), "CONTRACT_SCHEMA_INVALID"], [JSON.stringify(unknown), "CONTRACT_SCHEMA_INVALID"]);
    for (const [bytes, code] of cases) {
      await withTemporaryFile(bytes, async (path) => {
        expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
          exit: 2, stdout: "", stderr: failure(code)
        });
      });
    }
  });

  test("escaped surrogate failure classes and CR/LF path identities are rejected", async () => {
    for (const escaped of ["\\uD83D", "\\uDE00", "\\uDE00\\uD83D", "\\uD83D\\u0041"]) {
      for (const text of [`{"${escaped}":0}`, `{"x":"${escaped}"}`]) {
        await withTemporaryFile(text, async (path) => {
          expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
            exit: 2, stdout: "", stderr: failure("CONTRACT_JSON_MALFORMED")
          });
        });
      }
    }
    const fixture = await sourceRecord();
    for (const unsafePath of ["cr\r.json", "lf\n.json"]) {
      const changed = structuredClone(fixture);
      changed.admitted_paths[0] = unsafePath;
      await withTemporaryFile(JSON.stringify(changed), async (path) => {
        expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
          exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID")
        });
      });
    }
  });

  test("source byte ceiling remains inclusive", async () => {
    const base = JSON.stringify(await sourceRecord());
    const exact = base + " ".repeat(SOURCE_PROFILE.bytes - Buffer.byteLength(base));
    expect(Buffer.byteLength(exact)).toBe(SOURCE_PROFILE.bytes);
    await withTemporaryFile(exact, async (path) => {
      expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
        exit: 0, stdout: success("source_input_record"), stderr: ""
      });
    });
  });

  test("malformed argv and future-owned kinds have no partial output", async () => {
    for (const args of [
      ["--input", validSourcePath, "--kind", "dependency_graph"],
      ["--input", validSourcePath],
      ["--input", validSourcePath, "--kind", "source_input_record", "--kind", "source_input_record"],
      ["--repository-root", ".", "--check-current"]
    ]) {
      expect(await capture(args)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
    }
  });
});
