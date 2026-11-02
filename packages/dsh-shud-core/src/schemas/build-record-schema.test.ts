import { expect, test } from "vitest";
import { BuildRecordSchema } from "../index.ts";

function baseBuild() {
  return {
    build_id: "BUILD-20261102T100000-7b2d",
    task_id: "TASK-20261102T090000-3f9c",
    change_id: null,
    patch_sha256: null,
    source_path: "repos/SHUD",
    source_commit: "9a422e5eb708df7d2f8b4066a3083a031d679a82",
    source_branch: "replay/base",
    dirty_paths: [],
    make_argv: [
      "make",
      "-C",
      "builds/.tmp-BUILD-20261102T100000-7b2d/src",
      "shud",
      "SUNDIALS_DIR=/opt/sundials",
    ],
    sundials_dir: "/opt/sundials",
    rhs_openmp: false,
    compiler: "Apple clang version 17.0.0",
    exit_code: 0,
    duration_seconds: 8.25,
    binary_path: "builds/BUILD-20261102T100000-7b2d/shud",
    binary_sha256: "b".repeat(64),
    stdout_path: "builds/BUILD-20261102T100000-7b2d/make.stdout.log",
    stderr_path: "builds/BUILD-20261102T100000-7b2d/make.stderr.log",
    created_at: "2026-11-02T10:00:00Z",
  };
}

function candidateBuild() {
  return {
    ...baseBuild(),
    change_id: "CHG-20261102T093000-4a1f",
    patch_sha256: "a".repeat(64),
    dirty_paths: ["Makefile", "src/Model/MD_rhs_core.cpp"],
    rhs_openmp: true,
    make_argv: [...baseBuild().make_argv, "SHUD_ENABLE_OPENMP_RHS=1"],
  };
}

test("BuildRecord preserves the clean base identity and build metadata", () => {
  const input = baseBuild();
  expect(BuildRecordSchema.parse(input)).toEqual(input);
});

test("BuildRecord preserves the candidate patch, observed dirty paths and OpenMP metadata", () => {
  const input = candidateBuild();
  expect(BuildRecordSchema.parse(input)).toEqual(input);
});

test.each([
  { change_id: null, patch_sha256: null, dirty_paths: ["Makefile"], path: "dirty_paths" },
  { change_id: null, patch_sha256: "a".repeat(64), dirty_paths: [], path: "patch_sha256" },
  {
    change_id: "CHG-20261102T093000-4a1f",
    patch_sha256: null,
    dirty_paths: ["Makefile"],
    path: "patch_sha256",
  },
  {
    change_id: "CHG-20261102T093000-4a1f",
    patch_sha256: "a".repeat(64),
    dirty_paths: [],
    path: "dirty_paths",
  },
])("BuildRecord rejects inconsistent base/candidate evidence at $path", ({ path, ...fields }) => {
  const result = BuildRecordSchema.safeParse({ ...baseBuild(), ...fields });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([path]);
});

test("BuildRecord permits zero duration and does not turn producer OpenMP policy into a schema rule", () => {
  const input = { ...baseBuild(), duration_seconds: 0, rhs_openmp: true };
  expect(BuildRecordSchema.parse(input)).toEqual(input);
  const candidate = { ...candidateBuild(), rhs_openmp: false };
  expect(BuildRecordSchema.parse(candidate)).toEqual(candidate);
});

test("BuildRecord preserves code-point ordering and literal POSIX filename bytes", () => {
  const input = {
    ...candidateBuild(),
    dirty_paths: [
      "a b.cpp",
      "line\nbreak.cpp",
      "src/back\\slash.cpp",
      "\uE000.cpp",
      "\u{10000}.cpp",
    ],
  };
  expect(BuildRecordSchema.parse(input)).toEqual(input);
});

test.each([
  { paths: ["b.cpp", "a.cpp"], issue: ["dirty_paths"] },
  { paths: ["a.cpp", "a.cpp"], issue: ["dirty_paths"] },
  { paths: ["\u{10000}.cpp", "\uE000.cpp"], issue: ["dirty_paths"] },
  { paths: [""], issue: ["dirty_paths", 0] },
  { paths: ["/src/a.cpp"], issue: ["dirty_paths", 0] },
  { paths: ["../a.cpp"], issue: ["dirty_paths", 0] },
  { paths: ["src/../a.cpp"], issue: ["dirty_paths", 0] },
  { paths: ["a\0.cpp"], issue: ["dirty_paths", 0] },
])("BuildRecord rejects invalid observed dirty paths $paths", ({ paths, issue }) => {
  const result = BuildRecordSchema.safeParse({ ...candidateBuild(), dirty_paths: paths });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((entry) => entry.path)).toContainEqual(issue);
});

test.each([
  ["binary_path", "shud"],
  ["stdout_path", "make.stdout.log"],
  ["stderr_path", "make.stderr.log"],
])("BuildRecord binds %s to its own build identity", (field, filename) => {
  for (const value of [
    `builds/BUILD-20261102T100001-7b2d/${filename}`,
    `builds/BUILD-20261102T100000-7b2d/../${filename}`,
    `/builds/BUILD-20261102T100000-7b2d/${filename}`,
    `builds/BUILD-20261102T100000-7b2d/${filename}\0`,
    "",
  ]) {
    const result = BuildRecordSchema.safeParse({ ...baseBuild(), [field]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([field]);
  }
});

test("BuildRecord requires all output paths to follow a changed valid build id", () => {
  const input = { ...baseBuild(), build_id: "BUILD-20261102T110000-8c3e" };
  const result = BuildRecordSchema.safeParse(input);
  expect(result.success).toBe(false);
  for (const field of ["binary_path", "stdout_path", "stderr_path"]) {
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([field]);
  }
  const moved = {
    ...input,
    binary_path: "builds/BUILD-20261102T110000-8c3e/shud",
    stdout_path: "builds/BUILD-20261102T110000-8c3e/make.stdout.log",
    stderr_path: "builds/BUILD-20261102T110000-8c3e/make.stderr.log",
  };
  expect(BuildRecordSchema.parse(moved)).toEqual(moved);
});

test.each([
  ["build_id", "BUILD-1"],
  ["build_id", "build-20261102T100000-7b2d"],
  ["task_id", "TASK-0001"],
  ["change_id", "CHG-0001"],
  ["source_path", "SHUD"],
  ["source_path", "/repos/SHUD"],
  ["source_commit", "9a422e5"],
  ["source_commit", "9A422E5EB708DF7D2F8B4066A3083A031D679A82"],
  ["source_commit", "g".repeat(40)],
  ["source_branch", ""],
  ["compiler", ""],
  ["rhs_openmp", "false"],
  ["exit_code", 2],
  ["exit_code", "0"],
  ["duration_seconds", -0.1],
  ["duration_seconds", Infinity],
  ["duration_seconds", -Infinity],
  ["duration_seconds", NaN],
  ["duration_seconds", "8.25"],
  ["binary_sha256", "b".repeat(63)],
  ["binary_sha256", "b".repeat(65)],
  ["binary_sha256", "B".repeat(64)],
  ["binary_sha256", "g".repeat(64)],
  ["patch_sha256", "a".repeat(63)],
  ["patch_sha256", "A".repeat(64)],
  ["patch_sha256", "g".repeat(64)],
  ["make_argv", []],
  ["make_argv", ["make", ""]],
  ["make_argv", ["make", null]],
  ["make_argv", "make shud"],
  ["sundials_dir", ""],
  ["sundials_dir", "opt/sundials"],
  ["sundials_dir", "~/sundials"],
  ["created_at", "2026-11-02"],
  ["created_at", "not-a-time"],
] as const)("BuildRecord rejects invalid %s value %j", (field, value) => {
  const result = BuildRecordSchema.safeParse({ ...candidateBuild(), [field]: value });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field);
});

test.each(Object.keys(baseBuild()))("BuildRecord requires explicit %s", (field) => {
  const input: Record<string, unknown> = baseBuild();
  delete input[field];
  const result = BuildRecordSchema.safeParse(input);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([field]);
});

test("BuildRecord rejects unknown fields rather than stripping build evidence", () => {
  expect(BuildRecordSchema.safeParse({ ...baseBuild(), extra: true }).success).toBe(false);
});
