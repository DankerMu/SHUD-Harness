import { expect, test } from "vitest";
import { ChangeRequestSchema } from "../index.ts";

function proposedChange() {
  return {
    change_id: "CHG-20261102T093000-4a1f",
    task_id: "TASK-20261102T090000-3f9c",
    source_path: "repos/SHUD",
    base_commit: "9a422e5eb708df7d2f8b4066a3083a031d679a82",
    files_changed: ["Makefile", "src/Model/MD_rhs_core.cpp"],
    semantic_level: "numerical_implementation",
    semantic_floor: "numerical_implementation",
    floor_categories: ["numerical_implementation"],
    risk: "high",
    patch_path: "patches/CHG-20261102T093000-4a1f.patch",
    patch_sha256: "a".repeat(64),
    status: "proposed",
    approval_ref: null,
    approved_at: null,
    description: "Restore the RHS build flag for the replay.",
    created_by: "coder",
    created_at: "2026-11-02T09:30:00Z",
    updated_at: "2026-11-02T09:30:00Z",
  };
}

function rejectsChange(overrides: Record<string, unknown>, path: string) {
  const result = ChangeRequestSchema.safeParse({ ...proposedChange(), ...overrides });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(path);
}

test("ChangeRequest preserves a proposed patch and its governance evidence", () => {
  const input = proposedChange();
  expect(ChangeRequestSchema.parse(input)).toEqual(input);
});

test("ChangeRequest accepts approved evidence and nullable or empty descriptions", () => {
  for (const description of [null, "", "Approved replay patch"]) {
    const input = {
      ...proposedChange(),
      status: "approved",
      approval_ref: "call-change-submit-1",
      approved_at: "2026-11-02T09:35:00Z",
      description,
    };
    expect(ChangeRequestSchema.parse(input)).toEqual(input);
  }
});

test.each([
  ["pure_engineering", "low"],
  ["io_format", "medium"],
  ["output_semantics", "high"],
  ["numerical_implementation", "high"],
  ["parameter_default", "high"],
  ["physical_equation", "high"],
  ["model_assumption", "high"],
])("ChangeRequest accepts %s with risk %s and rejects another risk", (level, risk) => {
  const input = {
    ...proposedChange(),
    semantic_level: level,
    semantic_floor: level,
    floor_categories: [level],
    risk,
  };
  expect(ChangeRequestSchema.parse(input)).toEqual(input);
  rejectsChange({ ...input, risk: risk === "high" ? "medium" : "high" }, "risk");
});

test("ChangeRequest risk follows an uplifted declaration, not its lower floor", () => {
  const input = {
    ...proposedChange(),
    files_changed: ["docs/build.md"],
    semantic_floor: "pure_engineering",
    floor_categories: ["pure_engineering"],
    semantic_level: "physical_equation",
    risk: "high",
  };
  expect(ChangeRequestSchema.parse(input)).toEqual(input);
  rejectsChange({ ...input, risk: "low" }, "risk");
});

test.each([
  ["io_format", "pure_engineering", "low"],
  ["output_semantics", "io_format", "medium"],
  ["numerical_implementation", "output_semantics", "high"],
  ["parameter_default", "numerical_implementation", "high"],
  ["physical_equation", "parameter_default", "high"],
  ["model_assumption", "physical_equation", "high"],
  ["numerical_implementation", "pure_engineering", "low"],
])("ChangeRequest rejects floor %s above declaration %s", (floor, level, risk) => {
  rejectsChange(
    { semantic_floor: floor, floor_categories: [floor], semantic_level: level, risk },
    "semantic_level",
  );
});

test("ChangeRequest retains all ordered categories ending at its floor", () => {
  const input = {
    ...proposedChange(),
    floor_categories: ["pure_engineering", "output_semantics", "numerical_implementation"],
  };
  expect(ChangeRequestSchema.parse(input)).toEqual(input);
});

test.each([
  { categories: [] },
  { categories: ["output_semantics"] },
  { categories: ["numerical_implementation", "output_semantics"] },
  { categories: ["numerical_implementation", "numerical_implementation"] },
  { categories: ["numerical_implementation", "physical_equation"] },
])("ChangeRequest rejects inconsistent floor categories $categories", ({ categories }) => {
  rejectsChange({ floor_categories: categories }, "floor_categories");
});

test.each([
  ["proposed", "call-1", null, "approval_ref"],
  ["proposed", null, "2026-11-02T09:35:00Z", "approved_at"],
  ["approved", null, "2026-11-02T09:35:00Z", "approval_ref"],
  ["approved", "call-1", null, "approved_at"],
] as const)("ChangeRequest rejects inconsistent %s approval evidence", (status, ref, at, path) => {
  rejectsChange({ status, approval_ref: ref, approved_at: at }, path);
});

test("ChangeRequest preserves code-point-ordered non-BMP and literal POSIX filenames", () => {
  const input = {
    ...proposedChange(),
    files_changed: [
      "a b.cpp",
      "line\nbreak.cpp",
      "src/back\\slash.cpp",
      "\uE000.cpp",
      "\u{10000}.cpp",
    ],
  };
  expect(ChangeRequestSchema.parse(input)).toEqual(input);
});

test.each([
  { paths: [], path: "files_changed" },
  { paths: ["b.cpp", "a.cpp"], path: "files_changed" },
  { paths: ["a.cpp", "a.cpp"], path: "files_changed" },
  { paths: ["\u{10000}.cpp", "\uE000.cpp"], path: "files_changed" },
  { paths: [""], path: "files_changed.0" },
  { paths: ["/src/a.cpp"], path: "files_changed.0" },
  { paths: ["../a.cpp"], path: "files_changed.0" },
  { paths: ["src/../a.cpp"], path: "files_changed.0" },
  { paths: ["a\0.cpp"], path: "files_changed.0" },
])("ChangeRequest rejects invalid changed paths $paths", ({ paths, path }) => {
  rejectsChange({ files_changed: paths }, path);
});

test.each([
  ["change_id", "CHG-0001"],
  ["change_id", "../tasks/x"],
  ["task_id", "TASK-0001"],
  ["source_path", "repos/Other"],
  ["source_path", "/repos/SHUD"],
  ["base_commit", "9a422e5"],
  ["base_commit", "9A422E5EB708DF7D2F8B4066A3083A031D679A82"],
  ["base_commit", "g".repeat(40)],
  ["patch_sha256", "a".repeat(63)],
  ["patch_sha256", "A".repeat(64)],
  ["patch_sha256", "g".repeat(64)],
  ["patch_path", "patches/CHG-20261102T093001-4a1f.patch"],
  ["patch_path", "patches/../CHG-20261102T093000-4a1f.patch"],
  ["patch_path", "/patches/CHG-20261102T093000-4a1f.patch"],
  ["semantic_level", "engineering"],
  ["semantic_floor", "engineering"],
  ["floor_categories", ["engineering"]],
  ["risk", "critical"],
  ["status", "rejected"],
  ["approval_ref", ""],
  ["approved_at", "yesterday"],
  ["description", 42],
  ["created_by", ""],
  ["created_by", null],
  ["created_at", "2026-11-02"],
  ["updated_at", "not-a-time"],
] as const)("ChangeRequest rejects invalid %s value %j", (field, value) => {
  const result = ChangeRequestSchema.safeParse({ ...proposedChange(), [field]: value });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field);
});

test("ChangeRequest binds patch_path to a changed valid identity", () => {
  rejectsChange({ change_id: "CHG-20261102T094000-5b2e" }, "patch_path");
  const input = {
    ...proposedChange(),
    change_id: "CHG-20261102T094000-5b2e",
    patch_path: "patches/CHG-20261102T094000-5b2e.patch",
  };
  expect(ChangeRequestSchema.parse(input)).toEqual(input);
});

test.each(Object.keys(proposedChange()))("ChangeRequest requires explicit %s", (field) => {
  const input: Record<string, unknown> = proposedChange();
  delete input[field];
  const result = ChangeRequestSchema.safeParse(input);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([field]);
});

test.each([
  "extra",
  "interface_impact",
  "compat_checks",
  "gates",
  "patch_bundle",
  "theory_bundle_id",
  "verification_case_ids",
  "pi_gate_required",
])("ChangeRequest rejects unknown or removed field %s", (field) => {
  expect(ChangeRequestSchema.safeParse({ ...proposedChange(), [field]: true }).success).toBe(false);
});
