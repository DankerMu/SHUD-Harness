import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse, resolve, sep } from "node:path";
import { canonicalJson } from "../lib/canonical-json";
import {
  ContractCapabilities,
  type CloseAttempt,
  type ContractAuthorityFault
} from "../lib/capabilities";
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
  withTemporaryFile,
  type SourceRecordFixture
} from "./helpers";

type Kind = "source_input_record" | "source_identity_projection";
type FailureScenario = "upper_symlink" | "parent_symlink" | "ancestor_replacement" | "final_replacement";

function componentCount(path: string): number {
  const absolute = resolve(path);
  const normalized = process.platform === "darwin" && ["/etc", "/tmp", "/var"].some(
    (alias) => absolute === alias || absolute.startsWith(`${alias}/`)
  ) ? `/private${absolute}` : absolute;
  const root = parse(normalized).root;
  return 1 + normalized.slice(root.length).split(sep).filter(Boolean).length;
}

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
    expect(operations.filter((operation) => operation.phase === "post_admission" && operation.operation === "read_retained"))
      .toHaveLength(0);
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
    const canonicalOracle = await readFile(new URL(
      "../fixtures/valid/source-input-record-paired-surrogate.canonical.json",
      import.meta.url
    ));
    expect(Buffer.from(admitSourceInput("source_input_record", bytes))).toEqual(canonicalOracle.subarray(0, -1));
    expect(new TextDecoder().decode(canonicalOracle)).toContain("😀.json");
    expect(canonicalJson({ "😀": "\ud83d\ude00" })).toBe('{"😀":"😀"}');
    const expected = { exit: 0, stdout: success("source_input_record"), stderr: "" };
    expect(await capture(["--input", validSourcePath, "--kind", "source_input_record"])).toEqual(expected);
    expect(await capture(["--input", validSourcePath, "--kind", "source_input_record"])).toEqual(expected);
  });

  test("direct ingress exposes only retained read capabilities, preserves input bytes, and spawns no child", async () => {
    expect(Object.getOwnPropertyNames(ContractCapabilities.prototype).sort()).toEqual([
      "close", "constructor", "openRelative", "openRoot", "readRetained", "rejectForbidden", "stat"
    ]);
    const originalSpawn = Bun.spawn;
    let spawnAttempts = 0;
    Bun.spawn = (..._args: Parameters<typeof Bun.spawn>): never => {
      spawnAttempts += 1;
      throw new Error("unexpected contract child process");
    };
    try {
      for (const [kind, path] of [
        ["source_input_record", validSourcePath],
        ["source_identity_projection", validIdentityPath]
      ] as const) {
        const beforeBytes = await readFile(path);
        const beforeStat = await stat(path);
        expect(await capture(["--input", path, "--kind", kind])).toEqual({
          exit: 0, stdout: success(kind), stderr: ""
        });
        expect(await readFile(path)).toEqual(beforeBytes);
        const afterStat = await stat(path);
        expect(afterStat.mode).toBe(beforeStat.mode);
        expect(afterStat.size).toBe(beforeStat.size);
        expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
      }
    } finally {
      Bun.spawn = originalSpawn;
    }
    expect(spawnAttempts).toBe(0);
  });

  test("narrow post-admission hook observes only retained-descriptor-relative opens and reads", async () => {
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

  test("central capability gate rejects injected ambient, replacement, write, and child controls", async () => {
    const faults: ContractAuthorityFault[] = [
      "ambient_absolute_open", "replacement_object_read", "file_write", "child_spawn"
    ];
    for (const [kind, path] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      for (const fault of faults) {
        const violations: ContractAuthorityFault[] = [];
        expect(await capture(["--input", path, "--kind", kind], {
          authorityFault: fault,
          onAuthorityViolation: (violation) => { violations.push(violation); }
        })).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
        expect(violations).toEqual([fault]);
      }
      expect(await capture(["--input", path, "--kind", kind])).toEqual({
        exit: 0, stdout: success(kind), stderr: ""
      });
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

  test("success, hook throw, byte bound, malformed JSON, schema failure, and directory input restore descriptors", async () => {
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

  test("close faults preserve primary errors, settle every descriptor, and make cleanup-only failure stable", async () => {
    for (const [kind, path] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      const components = componentCount(path);
      const cleanupOnly: CloseAttempt[] = [];
      expect(await capture(["--input", path, "--kind", kind], {
        closeFault: (attempt) => attempt.owner === "retained",
        onCloseAttempt: (attempt) => { cleanupOnly.push(attempt); }
      })).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
      expect(cleanupOnly).toHaveLength(3 * components - 2);
      expect(cleanupOnly.filter((attempt) => attempt.owner === "verification")).toHaveLength(2 * (components - 1));
      expect(cleanupOnly.filter((attempt) => attempt.owner === "retained")).toHaveLength(components);
      expect(cleanupOnly.map((attempt) => attempt.ordinal)).toEqual(
        Array.from({ length: cleanupOnly.length }, (_, index) => index + 1)
      );

      const verificationFault: CloseAttempt[] = [];
      expect(await capture(["--input", path, "--kind", kind], {
        closeFault: (attempt) => attempt.owner === "verification",
        onCloseAttempt: (attempt) => { verificationFault.push(attempt); }
      })).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
      expect(verificationFault).toHaveLength(3 * components - 2);
      expect(verificationFault.filter((attempt) => attempt.owner === "verification")).toHaveLength(2 * (components - 1));
      expect(verificationFault.filter((attempt) => attempt.owner === "retained")).toHaveLength(components);
      expect(verificationFault.map((attempt) => attempt.ordinal)).toEqual(
        Array.from({ length: verificationFault.length }, (_, index) => index + 1)
      );
    }

    for (const kind of ["source_input_record", "source_identity_projection"] as const) {
      await withTemporaryFile(" ".repeat(SOURCE_PROFILE.bytes + 1), async (path) => {
        const attempts: CloseAttempt[] = [];
        const components = componentCount(path);
        expect(await capture(["--input", path, "--kind", kind], {
          closeFault: (attempt) => attempt.owner === "retained",
          onCloseAttempt: (attempt) => { attempts.push(attempt); }
        })).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_BYTES_LIMIT") });
        expect(attempts).toHaveLength(3 * components - 2);
        expect(attempts.filter((attempt) => attempt.owner === "retained")).toHaveLength(components);
      });

      const directoryRoot = await mkdtemp(join(tmpdir(), "shud-source-admission-close-"));
      try {
        const attempts: CloseAttempt[] = [];
        const components = componentCount(directoryRoot);
        expect(await capture(["--input", directoryRoot, "--kind", kind], {
          closeFault: () => true,
          onCloseAttempt: (attempt) => { attempts.push(attempt); }
        })).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
        expect(attempts).toHaveLength(components);
        expect(attempts[0]?.owner).toBe("unretained");
        expect(attempts.slice(1).every((attempt) => attempt.owner === "retained")).toBe(true);
      } finally {
        await rm(directoryRoot, { recursive: true, force: true });
      }
    }
  });
  test("cleanup faults wait for both input kinds to select exact semantic receipts", async () => {
    const baseline = await descriptorCount();
    const cases = [
      { bytes: "{", code: "CONTRACT_JSON_MALFORMED", verificationPasses: 2 },
      {
        bytes: Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xed, 0xa0, 0x80, 0x7d]),
        code: "CONTRACT_UTF8_INVALID",
        verificationPasses: 2
      },
      { bytes: '{"x":1,"x":2}', code: "CONTRACT_JSON_DUPLICATE_KEY", verificationPasses: 2 },
      {
        bytes: "[".repeat(SOURCE_PROFILE.depth) + "0" + "]".repeat(SOURCE_PROFILE.depth),
        code: "CONTRACT_JSON_DEPTH_LIMIT",
        verificationPasses: 2
      },
      { bytes: "{}", code: "CONTRACT_SCHEMA_INVALID", verificationPasses: 2 },
      { bytes: " ".repeat(SOURCE_PROFILE.bytes + 1), code: "CONTRACT_BYTES_LIMIT", verificationPasses: 2 }
    ] as const;
    const observed: unknown[] = [];
    const expected: unknown[] = [];

    for (const [kind, validPath] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      for (const { bytes, code, verificationPasses } of cases) {
        await withTemporaryFile(bytes, async (path) => {
          const attempts: CloseAttempt[] = [];
          const components = componentCount(path);
          observed.push(await capture(["--input", path, "--kind", kind], {
            closeFault: (attempt) => attempt.owner === "retained",
            onCloseAttempt: (attempt) => { attempts.push(attempt); }
          }));
          expected.push({ exit: 2, stdout: "", stderr: failure(code) });
          expect(attempts).toHaveLength(verificationPasses * (components - 1) + components);
          expect(attempts.filter((attempt) => attempt.owner === "retained")).toHaveLength(components);
          expect(attempts.map((attempt) => attempt.ordinal)).toEqual(
            Array.from({ length: attempts.length }, (_, index) => index + 1)
          );
        });
      }

      const attempts: CloseAttempt[] = [];
      const components = componentCount(validPath);
      observed.push(await capture(["--input", validPath, "--kind", kind], {
        closeFault: (attempt) => attempt.owner === "retained",
        onCloseAttempt: (attempt) => { attempts.push(attempt); }
      }));
      expected.push({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
      expect(attempts).toHaveLength(3 * components - 2);
      expect(attempts.filter((attempt) => attempt.owner === "retained")).toHaveLength(components);
      expect(attempts.map((attempt) => attempt.ordinal)).toEqual(
        Array.from({ length: attempts.length }, (_, index) => index + 1)
      );
    }

    Bun.gc(true);
    expect(await descriptorCount()).toBe(baseline);
    expect(observed).toEqual(expected);
  });
  test("second-pass verification cleanup faults wait for exact semantic receipts from both input kinds", async () => {
    const baseline = await descriptorCount();
    const cases = [
      { bytes: "{", code: "CONTRACT_JSON_MALFORMED" },
      {
        bytes: Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xed, 0xa0, 0x80, 0x7d]),
        code: "CONTRACT_UTF8_INVALID"
      },
      { bytes: '{"x":1,"x":2}', code: "CONTRACT_JSON_DUPLICATE_KEY" },
      {
        bytes: "[".repeat(SOURCE_PROFILE.depth) + "0" + "]".repeat(SOURCE_PROFILE.depth),
        code: "CONTRACT_JSON_DEPTH_LIMIT"
      },
      {
        bytes: `[${Array.from({ length: SOURCE_PROFILE.items + 1 }, () => "0").join(",")}]`,
        code: "CONTRACT_JSON_ITEM_LIMIT"
      },
      { bytes: "{}", code: "CONTRACT_SCHEMA_INVALID" }
    ] as const;

    const expectSecondPassCleanupReceipt = async (kind: Kind, path: string, code: string): Promise<void> => {
      const attempts: CloseAttempt[] = [];
      const components = componentCount(path);
      const finalVerificationCloseOrdinal = 2 * (components - 1);
      const result = await capture(["--input", path, "--kind", kind], {
        closeFault: (attempt) =>
          attempt.owner === "verification" && attempt.ordinal === finalVerificationCloseOrdinal,
        onCloseAttempt: (attempt) => { attempts.push(attempt); }
      });

      expect(result).toEqual({ exit: 2, stdout: "", stderr: failure(code) });
      expect(result.stderr.endsWith("\n")).toBe(true);
      expect(attempts).toHaveLength(3 * components - 2);
      expect(attempts.filter((attempt) => attempt.owner === "verification")).toHaveLength(2 * (components - 1));
      expect(attempts.filter((attempt) => attempt.owner === "retained")).toHaveLength(components);
      expect(attempts[finalVerificationCloseOrdinal - 1]).toEqual(
        expect.objectContaining({ owner: "verification", ordinal: finalVerificationCloseOrdinal })
      );
      expect(attempts.map((attempt) => attempt.ordinal)).toEqual(
        Array.from({ length: attempts.length }, (_, index) => index + 1)
      );
    };

    // A JSON tree has at most items + 1 nodes. Under the frozen option-1
    // profile, the 512-item ceiling therefore wins before NODE_LIMIT; the
    // relaxed-profile parser exact/+1 coverage below owns that unreachable direct-kind boundary.
    for (const [kind, validPath] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      for (const { bytes, code } of cases) {
        await withTemporaryFile(bytes, async (path) => {
          await expectSecondPassCleanupReceipt(kind, path, code);
        });
      }
      await expectSecondPassCleanupReceipt(kind, validPath, "CONTRACT_SCHEMA_INVALID");
    }

    Bun.gc(true);
    expect(await descriptorCount()).toBe(baseline);
  });
  test("first-pass verification cleanup faults wait for exact byte and semantic receipts from both input kinds", async () => {
    const baseline = await descriptorCount();
    const cases = [
      { bytes: " ".repeat(SOURCE_PROFILE.bytes + 1), code: "CONTRACT_BYTES_LIMIT" },
      { bytes: "{", code: "CONTRACT_JSON_MALFORMED" },
      {
        bytes: Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xed, 0xa0, 0x80, 0x7d]),
        code: "CONTRACT_UTF8_INVALID"
      },
      { bytes: '{"x":1,"x":2}', code: "CONTRACT_JSON_DUPLICATE_KEY" },
      {
        bytes: "[".repeat(SOURCE_PROFILE.depth) + "0" + "]".repeat(SOURCE_PROFILE.depth),
        code: "CONTRACT_JSON_DEPTH_LIMIT"
      },
      {
        bytes: `[${Array.from({ length: SOURCE_PROFILE.items + 1 }, () => "0").join(",")}]`,
        code: "CONTRACT_JSON_ITEM_LIMIT"
      },
      { bytes: "{}", code: "CONTRACT_SCHEMA_INVALID" }
    ] as const;

    const expectFirstPassCleanupReceipt = async (kind: Kind, path: string, code: string): Promise<void> => {
      const attempts: CloseAttempt[] = [];
      const components = componentCount(path);
      const finalFirstVerificationCloseOrdinal = components - 1;
      const result = await capture(["--input", path, "--kind", kind], {
        closeFault: (attempt) =>
          attempt.owner === "verification" && attempt.ordinal === finalFirstVerificationCloseOrdinal,
        onCloseAttempt: (attempt) => { attempts.push(attempt); }
      });
      const verificationAttempts = attempts.filter((attempt) => attempt.owner === "verification");
      const retainedAttempts = attempts.filter((attempt) => attempt.owner === "retained");

      expect(result).toEqual({ exit: 2, stdout: "", stderr: failure(code) });
      expect(result.stderr.endsWith("\n")).toBe(true);
      expect(attempts).toHaveLength(3 * components - 2);
      expect(verificationAttempts).toHaveLength(2 * (components - 1));
      expect(retainedAttempts).toHaveLength(components);
      expect(verificationAttempts.map((attempt) => attempt.ordinal)).toEqual(
        Array.from({ length: 2 * (components - 1) }, (_, index) => index + 1)
      );
      expect(retainedAttempts.map((attempt) => attempt.ordinal)).toEqual(
        Array.from({ length: components }, (_, index) => 2 * (components - 1) + index + 1)
      );
      expect(attempts[finalFirstVerificationCloseOrdinal - 1]).toEqual(
        expect.objectContaining({ owner: "verification", ordinal: finalFirstVerificationCloseOrdinal })
      );
    };

    for (const [kind, validPath] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      for (const { bytes, code } of cases) {
        await withTemporaryFile(bytes, async (path) => {
          for (let repeat = 0; repeat < 2; repeat += 1) {
            await expectFirstPassCleanupReceipt(kind, path, code);
          }
        });
      }
      for (let repeat = 0; repeat < 2; repeat += 1) {
        await expectFirstPassCleanupReceipt(kind, validPath, "CONTRACT_SCHEMA_INVALID");
      }
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
    const mutations: Array<(value: SourceRecordFixture) => void> = [];
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
    const profile = { ...SOURCE_PROFILE, items: SOURCE_PROFILE.nodes };
    const exactNodes = Buffer.from(`[${Array.from({ length: SOURCE_PROFILE.nodes - 1 }, () => "0").join(",")}]`);
    const plusOneNodes = Buffer.from(`[${Array.from({ length: SOURCE_PROFILE.nodes }, () => "0").join(",")}]`);
    expect(() => parseBoundedJson(exactNodes, profile)).not.toThrow();
    expectCode(() => parseBoundedJson(plusOneNodes, profile), "CONTRACT_JSON_NODE_LIMIT");
  });

  test("malformed array values and object members override pending item or node limits", async () => {
    const nodeBoundary =
      `[${Array.from({ length: SOURCE_PROFILE.nodes - 1 }, () => "0").join(",")},"unterminated]`;
    const cases = [
      `[${Array.from({ length: SOURCE_PROFILE.items }, () => "0").join(",")},]`,
      `[${Array.from({ length: SOURCE_PROFILE.items }, () => "0").join(",")},truX]`,
      `{${Array.from({ length: SOURCE_PROFILE.items }, (_, index) => `"k${index}":0`).join(",")},"tail"}`,
      nodeBoundary
    ];
    const observed: unknown[] = [];
    const expected: unknown[] = [];
    for (const kind of ["source_input_record", "source_identity_projection"] as const) {
      for (const text of cases) {
        await withTemporaryFile(text, async (path) => {
          observed.push(await capture(["--input", path, "--kind", kind]));
          expected.push({ exit: 2, stdout: "", stderr: failure("CONTRACT_JSON_MALFORMED") });
        });
      }
    }
    try {
      parseBoundedJson(Buffer.from(nodeBoundary), { ...SOURCE_PROFILE, items: SOURCE_PROFILE.nodes });
      observed.push("parsed");
    } catch (error) {
      observed.push(error instanceof ContractError ? error.code : "unknown");
    }
    expected.push("CONTRACT_JSON_MALFORMED");
    expect(observed).toEqual(expected);
  });

  test("pending item or node limits override later nonfinite number semantics", async () => {
    const itemBoundary =
      `[${Array.from({ length: SOURCE_PROFILE.items }, () => "0").join(",")},1e9999]`;
    const observed: unknown[] = [];
    const expected: unknown[] = [];
    for (const kind of ["source_input_record", "source_identity_projection"] as const) {
      for (const [text, code] of [
        [itemBoundary, "CONTRACT_JSON_ITEM_LIMIT"],
        ["1e9999", "CONTRACT_SCHEMA_INVALID"],
        ["1e9999 trailing", "CONTRACT_JSON_MALFORMED"]
      ] as const) {
        await withTemporaryFile(text, async (path) => {
          observed.push(await capture(["--input", path, "--kind", kind]));
          expected.push({ exit: 2, stdout: "", stderr: failure(code) });
        });
      }
    }
    const nodeBoundary = Buffer.from(
      `[${Array.from({ length: SOURCE_PROFILE.nodes - 1 }, () => "0").join(",")},1e9999]`
    );
    try {
      parseBoundedJson(nodeBoundary, { ...SOURCE_PROFILE, items: SOURCE_PROFILE.nodes });
      observed.push("parsed");
    } catch (error) {
      observed.push(error instanceof ContractError ? error.code : "unknown");
    }
    expected.push("CONTRACT_JSON_NODE_LIMIT");
    expect(observed).toEqual(expected);
  });

  test("legal depth 12 reaches schema validation and depth 13 returns only the depth limit for both kinds", async () => {
    const exact = "[".repeat(SOURCE_PROFILE.depth - 1) + "0" + "]".repeat(SOURCE_PROFILE.depth - 1);
    const plusOne = "[".repeat(SOURCE_PROFILE.depth) + "0" + "]".repeat(SOURCE_PROFILE.depth);
    for (const kind of ["source_input_record", "source_identity_projection"] as const) {
      for (const [text, code] of [
        [exact, "CONTRACT_SCHEMA_INVALID"],
        [plusOne, "CONTRACT_JSON_DEPTH_LIMIT"]
      ] as const) {
        await withTemporaryFile(text, async (path) => {
          expect(await capture(["--input", path, "--kind", kind])).toEqual({
            exit: 2, stdout: "", stderr: failure(code)
          });
        });
      }
    }
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
    const missing = structuredClone(valid);
    delete missing.source_sha;
    const unknown = structuredClone(valid);
    unknown.future = true;
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
