import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  ChangeIdSchema,
  ChangeRequestSchema,
  TaskIdSchema,
  type SemanticLevel,
} from "@shud-harness/dsh-shud-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { deriveChangeRequest } from "./index.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    lstatSync: vi.fn(actual.lstatSync),
  };
});
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof crypto>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

const input = {
  change_id: ChangeIdSchema.parse("CHG-20261102T090000-a1b2"),
  task_id: TaskIdSchema.parse("TASK-20261102T090000-c3d4"),
  base_commit: "9a422e5eb708df7d2f8b4066a3083a031d679a82",
  files_changed: ["Makefile", "src/Model/MD_rhs_core.cpp"],
  created_by: "coder",
  created_at: "2026-11-02T09:00:00Z",
  patch: new Uint8Array([97, 98, 99]),
};
// Published SHA-256("abc") vector, not computed through the implementation under test.
const abcSha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("deriveChangeRequest", () => {
  test("derives the complete proposed record from explicit identity, metadata and exact bytes", () => {
    const result = deriveChangeRequest(input);
    expect(result).toEqual({
      record: {
        change_id: "CHG-20261102T090000-a1b2",
        task_id: "TASK-20261102T090000-c3d4",
        source_path: "repos/SHUD",
        base_commit: "9a422e5eb708df7d2f8b4066a3083a031d679a82",
        files_changed: ["Makefile", "src/Model/MD_rhs_core.cpp"],
        semantic_level: "numerical_implementation",
        semantic_floor: "numerical_implementation",
        floor_categories: ["numerical_implementation"],
        risk: "high",
        patch_path: "patches/CHG-20261102T090000-a1b2.patch",
        patch_sha256: abcSha256,
        status: "proposed",
        approval_ref: null,
        approved_at: null,
        description: null,
        created_by: "coder",
        created_at: "2026-11-02T09:00:00Z",
        updated_at: "2026-11-02T09:00:00Z",
      },
      level_adjustment: null,
    });
    expect(ChangeRequestSchema.parse(result.record)).toEqual(result.record);
  });

  test.each([
    { declared: undefined, effective: "numerical_implementation", adjustment: null },
    {
      declared: "pure_engineering",
      effective: "numerical_implementation",
      adjustment: { declared: "pure_engineering", effective: "numerical_implementation" },
    },
    {
      declared: "numerical_implementation",
      effective: "numerical_implementation",
      adjustment: null,
    },
    { declared: "physical_equation", effective: "physical_equation", adjustment: null },
  ] as const)(
    "declaration $declared yields $effective with only an actual raise explained",
    ({ declared, effective, adjustment }) => {
      const result = deriveChangeRequest({ ...input, semantic_level: declared });
      expect(result.record.semantic_level).toBe(effective);
      expect(result.record.semantic_floor).toBe("numerical_implementation");
      expect(result.record.risk).toBe("high");
      expect(result.level_adjustment).toEqual(adjustment);
    },
  );

  test.each([
    {
      paths: ["docs/x.md", "scripts/a.sh"],
      floor: "pure_engineering",
      categories: ["pure_engineering"],
      risk: "low",
    },
    { paths: ["src/IO.cpp"], floor: "io_format", categories: ["io_format"], risk: "medium" },
    {
      paths: ["README.md"],
      floor: "numerical_implementation",
      categories: ["numerical_implementation"],
      risk: "high",
    },
    {
      paths: ["docs/x.md", "src/classes/Model_Control.cpp"],
      floor: "numerical_implementation",
      categories: ["pure_engineering", "output_semantics", "numerical_implementation"],
      risk: "high",
    },
    {
      paths: ["src/Equations/print.hpp"],
      floor: "physical_equation",
      categories: ["output_semantics", "physical_equation"],
      risk: "high",
    },
    {
      paths: ["input/a/b/model.para"],
      floor: "parameter_default",
      categories: ["parameter_default"],
      risk: "high",
    },
  ])("preserves every floor category for $paths", ({ paths, floor, categories, risk }) => {
    const { record, level_adjustment } = deriveChangeRequest({ ...input, files_changed: paths });
    expect(record.semantic_floor).toBe(floor);
    expect(record.semantic_level).toBe(floor);
    expect(record.floor_categories).toEqual(categories);
    expect(record.risk).toBe(risk);
    expect(level_adjustment).toBeNull();
  });

  test.each([
    ["pure_engineering", "low"],
    ["io_format", "medium"],
    ["output_semantics", "high"],
    ["numerical_implementation", "high"],
    ["parameter_default", "high"],
    ["physical_equation", "high"],
    ["model_assumption", "high"],
  ] as const)("risk follows the effective declaration %s", (semantic_level, risk) => {
    const { record, level_adjustment } = deriveChangeRequest({
      ...input,
      files_changed: ["docs/x.md"],
      semantic_level,
    });
    expect(record.semantic_level).toBe(semantic_level);
    expect(record.semantic_floor).toBe("pure_engineering");
    expect(record.risk).toBe(risk);
    expect(level_adjustment).toBeNull();
  });

  test("keeps optional description and Unicode path identity without normalizing metadata", () => {
    const files_changed = ["docs/\ue000.md", "docs/\u{10000}.md"];
    const { record } = deriveChangeRequest({
      ...input,
      files_changed,
      description: "  Preserve this description.  ",
      created_by: "custom-coder",
    });
    expect(record.files_changed).toEqual(files_changed);
    expect(record.description).toBe("  Preserve this description.  ");
    expect(record.created_by).toBe("custom-coder");
  });

  test("is deterministic without IO, entropy or ambient time and does not share mutable input/output arrays", () => {
    const candidate = {
      ...input,
      files_changed: [...input.files_changed],
      patch: input.patch.slice(),
    };
    const before = structuredClone(candidate);
    Object.freeze(candidate.files_changed);
    Object.freeze(candidate);
    const read = vi.spyOn(fs, "readFileSync");
    const write = vi.spyOn(fs, "writeFileSync");
    const stat = vi.spyOn(fs, "lstatSync");
    const entropy = vi.spyOn(crypto, "randomBytes");
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const first = deriveChangeRequest(candidate);
    vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
    const second = deriveChangeRequest(candidate);
    expect(first).toEqual(second);
    expect(candidate).toEqual(before);
    expect(first.record.files_changed).not.toBe(candidate.files_changed);
    expect(first.record.files_changed).not.toBe(second.record.files_changed);
    expect(first.record.floor_categories).not.toBe(second.record.floor_categories);
    first.record.files_changed.push("unrelated.cpp");
    first.record.floor_categories.push("model_assumption");
    expect(second).toEqual(deriveChangeRequest(candidate));
    expect(candidate).toEqual(before);
    for (const operation of [read, write, stat, entropy]) expect(operation).not.toHaveBeenCalled();
  });

  test("hashes only the supplied Uint8Array view, not its backing buffer", () => {
    const backing = new Uint8Array([0xff, 97, 98, 99, 0xfe]);
    const { record } = deriveChangeRequest({ ...input, patch: backing.subarray(1, 4) });
    expect(record.patch_sha256).toBe(abcSha256);
    expect(backing).toEqual(new Uint8Array([0xff, 97, 98, 99, 0xfe]));
  });

  test.each([
    ["change_id", undefined],
    ["change_id", "../outside"],
    ["change_id", "CHG-0001"],
    ["change_id", "CHG-20261102T090000-A1B2"],
    ["change_id", "VC-20261102T090000-a1b2"],
    ["task_id", "TASK-0001"],
    ["task_id", undefined],
    ["base_commit", "9a422e5"],
    ["base_commit", "A".repeat(40)],
    ["base_commit", "g".repeat(40)],
    ["files_changed", []],
    ["files_changed", ["a.cpp", "a.cpp"]],
    ["files_changed", ["z.cpp", "a.cpp"]],
    ["files_changed", ["\u{10000}.cpp", "\ue000.cpp"]],
    ["files_changed", ["/absolute.cpp"]],
    ["files_changed", ["src/../outside.cpp"]],
    ["files_changed", ["nul\0.cpp"]],
    ["files_changed", [""]],
    ["semantic_level", "bogus"],
    ["semantic_level", null],
    ["semantic_level", 0],
    ["created_at", undefined],
    ["created_at", "yesterday"],
    ["created_by", ""],
    ["description", 42],
    ["patch", "abc"],
    ["patch", [97, 98, 99]],
    ["patch", null],
    ["patch", new ArrayBuffer(3)],
  ])("rejects invalid %s input %# rather than repairing it", (field, value) => {
    const invalid = { ...input, [field]: value };
    expect(() =>
      deriveChangeRequest(invalid as Parameters<typeof deriveChangeRequest>[0]),
    ).toThrow();
  });

  test("does not treat an invalid declared level as an absent or lowest declaration", () => {
    expect(() =>
      deriveChangeRequest({
        ...input,
        files_changed: ["docs/x.md"],
        semantic_level: "not-a-level" as SemanticLevel,
      }),
    ).toThrow();
  });
});
