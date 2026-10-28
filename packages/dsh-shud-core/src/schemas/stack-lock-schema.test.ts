import { describe, expect, test } from "vitest";
import { StackIdSchema, StackLockSchema } from "../index.ts";

function validAlignedStackLock() {
  return {
    stack_id: StackIdSchema.parse("STACK-20261027T080000-3f9a"),
    repos: {
      SHUD: {
        commit: "1111111111111111111111111111111111111111",
        branch: "main",
        dirty: false,
        dirty_paths: [],
        dirty_paths_truncated: false,
      },
      rSHUD: {
        commit: "2222222222222222222222222222222222222222",
        branch: "main",
        dirty: false,
        dirty_paths: [],
        dirty_paths_truncated: false,
      },
      AutoSHUD: {
        commit: "3333333333333333333333333333333333333333",
        branch: "main",
        dirty: false,
        dirty_paths: [],
        dirty_paths_truncated: false,
      },
    },
    runtime: {
      os: "Darwin 25.6.0",
      sundials_version: null,
      host_version: "0.2.1-rc.2",
    },
    harness: { version: "0.9.0" },
    llm: {
      base_url: "https://www.dmxapi.cn",
      request_alias: "deepseek-flash-guan",
      response_model: "deepseek-flash-guan",
    },
    fingerprint: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    created_at: "2026-10-27T08:00:00Z",
  };
}

describe("StackLock schema alignment", () => {
  test("parses a minimal aligned StackLock with clean repositories", () => {
    const input = validAlignedStackLock();
    expect(StackLockSchema.parse(input)).toEqual(input);
  });

  test.each([
    { dirty: false, dirty_paths: ["notes.txt"], dirty_paths_truncated: false },
    { dirty: true, dirty_paths: [], dirty_paths_truncated: false },
    { dirty: false, dirty_paths: [], dirty_paths_truncated: true },
  ])("rejects inconsistent dirty paths and truncation state: %j", (revision) => {
    const input = validAlignedStackLock();
    const result = StackLockSchema.safeParse({
      ...input,
      repos: {
        ...input.repos,
        SHUD: { ...input.repos.SHUD, ...revision },
      },
    });
    expect(result.success).toBe(false);
  });

  test.each([
    { reason: "duplicate paths", paths: ["a.txt", "a.txt"] },
    { reason: "unsorted paths", paths: ["b.txt", "a.txt"] },
    { reason: "astral before BMP", paths: ["\u{10000}.txt", "\uE000.txt"] },
    { reason: "absolute path", paths: ["/notes.txt"] },
    { reason: "parent traversal", paths: ["../notes.txt"] },
    { reason: "nested parent traversal", paths: ["src/../notes.txt"] },
    { reason: "NUL in path", paths: ["notes\u0000.txt"] },
  ])("rejects noncanonical dirty paths: $reason", ({ paths }) => {
    const input = validAlignedStackLock();
    const result = StackLockSchema.safeParse({
      ...input,
      repos: {
        ...input.repos,
        SHUD: { ...input.repos.SHUD, dirty: true, dirty_paths: paths },
      },
    });
    expect(result.success).toBe(false);
  });

  test("preserves code-point-sorted Unicode, whitespace and POSIX filename bytes", () => {
    const base = validAlignedStackLock();
    const input = {
      ...base,
      repos: {
        ...base.repos,
        SHUD: {
          ...base.repos.SHUD,
          dirty: true,
          dirty_paths: [
            " leading.txt",
            "back\\slash.txt",
            "folder/",
            "line\nbreak.txt",
            "tab\tname.txt",
            "数据 a.txt",
            "\uE000.txt",
            "\u{10000}.txt",
          ],
        },
      },
    };
    expect(StackLockSchema.parse(input)).toEqual(input);
  });

  test("accepts a dirty truncated revision with no complete paths", () => {
    const base = validAlignedStackLock();
    const input = {
      ...base,
      repos: {
        ...base.repos,
        SHUD: { ...base.repos.SHUD, dirty: true, dirty_paths_truncated: true },
      },
    };
    expect(StackLockSchema.parse(input)).toEqual(input);
  });

  test.each([
    "STACK-0001",
    "STACK-11111111-1111-4111-8111-111111111111",
    "STACK-20261027T080000-3F9A",
    "TASK-20261027T080000-3f9a",
  ])("rejects an invalid StackId: %s", (stack_id) => {
    const result = StackLockSchema.safeParse({ ...validAlignedStackLock(), stack_id });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["stack_id"]);
  });

  test.each(["stack_id", "repos", "runtime", "harness", "llm", "fingerprint", "created_at"])(
    "requires the root field %s",
    (field) => {
      const input = validAlignedStackLock();
      Reflect.deleteProperty(input, field);
      const result = StackLockSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([field]);
    },
  );

  test.each([
    ["runtime", ["os", "sundials_version", "host_version"]],
    ["harness", ["version"]],
    ["llm", ["base_url", "request_alias", "response_model"]],
  ] as const)("requires every aligned %s field with its declared type", (group, fields) => {
    for (const field of fields) {
      const input = validAlignedStackLock();
      Reflect.deleteProperty(input[group], field);
      const missing = StackLockSchema.safeParse(input);
      expect(missing.success).toBe(false);
      expect(missing.error?.issues.map((issue) => issue.path)).toContainEqual([group, field]);
      for (const value of ["", 1, false, {}, [], ...(field === "sundials_version" ? [] : [null])]) {
        const base = validAlignedStackLock();
        const invalid = StackLockSchema.safeParse({
          ...base,
          [group]: { ...base[group], [field]: value },
        });
        expect(invalid.success).toBe(false);
        expect(invalid.error?.issues.map((issue) => issue.path)).toContainEqual([group, field]);
      }
    }
  });

  test.each(["SHUD", "rSHUD", "AutoSHUD"] as const)(
    "requires the canonical %s repository and all revision fields",
    (name) => {
      const input = validAlignedStackLock();
      Reflect.deleteProperty(input.repos, name);
      const missingRepo = StackLockSchema.safeParse(input);
      expect(missingRepo.success).toBe(false);
      expect(missingRepo.error?.issues.map((issue) => issue.path)).toContainEqual(["repos", name]);
      for (const field of ["commit", "branch", "dirty", "dirty_paths", "dirty_paths_truncated"]) {
        const base = validAlignedStackLock();
        Reflect.deleteProperty(base.repos[name], field);
        const missing = StackLockSchema.safeParse(base);
        expect(missing.success).toBe(false);
        expect(missing.error?.issues.map((issue) => issue.path)).toContainEqual([
          "repos",
          name,
          field,
        ]);
      }
    },
  );

  test.each([
    ["commit", ""],
    ["commit", 1],
    ["branch", ""],
    ["branch", null],
    ["dirty", "false"],
    ["dirty_paths", "notes.txt"],
    ["dirty_paths", [1]],
    ["dirty_paths", [""]],
    ["dirty_paths_truncated", "false"],
  ] as const)("rejects an invalid repository %s value: %j", (field, value) => {
    const input = validAlignedStackLock();
    const result = StackLockSchema.safeParse({
      ...input,
      repos: { ...input.repos, SHUD: { ...input.repos.SHUD, [field]: value } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.slice(0, 3))).toContainEqual([
      "repos",
      "SHUD",
      field,
    ]);
  });

  test.each([
    ["llm", "provider", "openai_compatible"],
    ["llm", "model_id", "legacy-model"],
    ["llm", "params_digest", "sha256:params"],
    ["llm", "prompt_pack_digest", "sha256:prompt"],
    ["runtime", "r_version", "4.4.1"],
    ["runtime", "r_packages_lock", "renv.lock"],
    ["runtime", "r_packages_lock", { path: "renv.lock", sha256: "sha256:renv-lock" }],
    ["runtime", "r_packages_lock", null],
    ["runtime", "python_version", "3.12.4"],
    ["runtime", "gcc_version", "14.1.0"],
    ["runtime", "gdal_version", "3.9.0"],
    ["runtime", "container", "docker"],
    ["harness", "cli_version", "legacy-cli"],
    ["harness", "prompt_pack", "legacy-prompt"],
    ["harness", "skills_version", "legacy-skills"],
  ] as const)("rejects removed %s.%s field: %j", (group, field, value) => {
    const input = validAlignedStackLock();
    expect(
      StackLockSchema.safeParse({ ...input, [group]: { ...input[group], [field]: value } }).success,
    ).toBe(false);
  });

  test.each(["limits", "policy_version", "degraded", "extra"])(
    "rejects unknown root field %s",
    (field) => {
      expect(StackLockSchema.safeParse({ ...validAlignedStackLock(), [field]: true }).success).toBe(
        false,
      );
    },
  );

  test("rejects unknown keys at every nested strict boundary", () => {
    const input = validAlignedStackLock();
    for (const group of ["repos", "runtime", "harness", "llm"] as const) {
      expect(
        StackLockSchema.safeParse({ ...input, [group]: { ...input[group], extra: true } }).success,
      ).toBe(false);
    }
    for (const name of ["SHUD", "rSHUD", "AutoSHUD"] as const) {
      expect(
        StackLockSchema.safeParse({
          ...input,
          repos: { ...input.repos, [name]: { ...input.repos[name], remote: "origin" } },
        }).success,
      ).toBe(false);
    }
  });

  test("accepts an installed SUNDIALS version and prefix-ordered dirty paths", () => {
    const base = validAlignedStackLock();
    const input = {
      ...base,
      runtime: { ...base.runtime, sundials_version: "6.0.0" },
      repos: {
        ...base.repos,
        AutoSHUD: {
          ...base.repos.AutoSHUD,
          dirty: true,
          dirty_paths: ["prefix", "prefix-a", "prefix/a"],
        },
      },
    };
    expect(StackLockSchema.parse(input)).toEqual(input);
  });
});
