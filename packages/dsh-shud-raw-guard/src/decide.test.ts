import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { decideRawAccess, normalizeRawDirs, RAW_READ_PROVENANCE_REASON } from "./decide.ts";

test("rejects invalid rawDirs rather than silently using defaults", () => {
  for (const config of [
    null,
    [],
    "raw",
    { rawDir: ["raw"] },
    { rawDirs: [] },
    { rawDirs: [""] },
    { rawDirs: "raw" },
    { rawDirs: [1] },
  ]) {
    expect(() => normalizeRawDirs(config)).toThrow(/rawDirs/);
  }
  expect(normalizeRawDirs()).toEqual({ rawDirs: ["data/raw"] });
  expect(normalizeRawDirs({ rawDirs: ["data/raw/", "/"] })).toEqual({ rawDirs: ["data/raw", "/"] });
});

const cwd = mkdtempSync(join(tmpdir(), "shud-guard-"));
mkdirSync(join(cwd, "protected", "nested"), { recursive: true });
symlinkSync(join(cwd, "protected"), join(cwd, "alias"));
symlinkSync(cwd, join(cwd, "session"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
const options = normalizeRawDirs({ rawDirs: ["protected/"] });

test("file mutations use canonical containment, including new files and symlinked cwd", () => {
  for (const name of ["write", "edit", "str_replace_editor"]) {
    for (const target of [
      "protected/new.csv",
      "alias/new.csv",
      "alias/nested/../new.csv",
      join(realpathSync(cwd), "protected/new.csv"),
    ]) {
      const decision = decideRawAccess(
        {
          name,
          cwd: join(cwd, "session"),
          arguments: {
            file_path: target,
            path: target,
            command: "create",
            sandbox_permissions: "require_escalated",
          },
        },
        options,
      );
      expect(decision.kind).toBe("deny");
      expect(decision.reason).toMatch(/immutable/);
      expect(decision.reason).toMatch(/read/);
    }
    for (const target of ["protectedx/new.csv", "derived/new.csv"]) {
      expect(
        decideRawAccess(
          { name, cwd, arguments: { file_path: target, path: target, command: "create" } },
          options,
        ).kind,
      ).toBe("next");
    }
  }
  expect(
    decideRawAccess(
      { name: "str_replace_editor", cwd, arguments: { path: "protected/x", command: "view" } },
      options,
    ).kind,
  ).toBe("next");
});

test("shell raw reads ask while write verbs deny, including escalation and copy-out", () => {
  const writes = [
    "rm",
    "mv",
    "cp",
    "tee",
    "touch",
    "mkdir",
    "chmod",
    "chown",
    "truncate",
    "dd",
    "install",
    "rsync",
    "ln",
  ];
  const commands = [
    ...writes.map((verb) => `${verb} protected/x derived/x`),
    "echo bad > protected/x",
    "echo bad >> protected/x",
    "sed -i s/a/b/ protected/x",
    "sed --in-place s/a/b/ protected/x",
    "perl -i -pe s/a/b/ protected/x",
    "python3 -c 'open(\"protected/x\")'",
    "open(protected/x)",
  ];
  for (const name of ["bash", "pwsh"]) {
    for (const command of commands) {
      expect(
        decideRawAccess(
          { name, cwd, arguments: { command, sandbox_permissions: "require_escalated" } },
          options,
        ).kind,
      ).toBe("deny");
    }
    for (const command of [
      "cat protected/x",
      "ls -la protected",
      `head ${realpathSync(cwd)}/protected/x`,
    ]) {
      const result = decideRawAccess({ name, cwd, arguments: { command } }, options);
      expect(result.kind).toBe("ask");
      expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
      expect(result.displayReason?.en).toMatch(/raw/i);
      expect(result.displayReason?.zh).toMatch(/原始/);
    }
    for (const command of ["echo ok > derived.txt", "rm protectedx/x"]) {
      expect(decideRawAccess({ name, cwd, arguments: { command } }, options).kind).toBe("next");
    }
    for (const [command, kind] of [
      ["wc -l x", "ask"],
      ["rm x", "deny"],
    ]) {
      expect(
        decideRawAccess({ name, cwd, arguments: { command, workdir: "alias" } }, options).kind,
      ).toBe(kind);
    }
  }
  expect(
    decideRawAccess({ name: "bash", cwd, arguments: { command: "cd protected" } }, options).kind,
  ).toBe("ask");
  expect(decideRawAccess({ name: "bash", cwd, arguments: { command: "rm x" } }, options).kind).toBe(
    "next",
  );
});

test("missing paths, defaults, absolute and multiple roots retain decision boundaries", () => {
  const future = normalizeRawDirs({ rawDirs: ["absent/raw"] });
  const roots = normalizeRawDirs({ rawDirs: ["elsewhere", join(cwd, "protected")] });
  for (const config of [future, roots, normalizeRawDirs()]) {
    const raw = config.rawDirs.at(-1)!;
    expect(
      decideRawAccess({ name: "write", cwd, arguments: { file_path: `${raw}/new.csv` } }, config)
        .kind,
    ).toBe("deny");
    expect(
      decideRawAccess({ name: "write", cwd, arguments: { file_path: `${raw}x/new.csv` } }, config)
        .kind,
    ).toBe("next");
    expect(
      decideRawAccess({ name: "bash", cwd, arguments: { command: "echo ok" } }, config).kind,
    ).toBe("next");
  }
  expect(
    decideRawAccess(
      { name: "write", arguments: { file_path: "data/raw/new.csv" } },
      normalizeRawDirs(),
    ).kind,
  ).toBe("deny");
  expect(
    decideRawAccess(
      { name: "write", cwd, arguments: { file_path: "new.csv" } },
      normalizeRawDirs({ rawDirs: ["/"] }),
    ).kind,
  ).toBe("deny");
  expect(
    decideRawAccess(
      { name: "bash", cwd: join(cwd, "protected"), arguments: { command: "cat x" } },
      roots,
    ).kind,
  ).toBe("ask");
});

test("unrelated tools and malformed arguments delegate without touching paths", () => {
  for (const name of ["read", "run_code", "present", "write", "bash", "pwsh"]) {
    for (const args of [
      null,
      undefined,
      [],
      7,
      "raw",
      {},
      { file_path: 7, command: false, workdir: {} },
    ]) {
      expect(decideRawAccess({ name, cwd, arguments: args }, options).kind).toBe("next");
    }
  }
  for (const name of ["read", "run_code", "present"]) {
    expect(
      decideRawAccess(
        { name, cwd, arguments: { file_path: "protected/x", command: "rm protected/x" } },
        options,
      ).kind,
    ).toBe("next");
  }
});
