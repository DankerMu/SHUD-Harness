import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
function decide(name: string, args: unknown, config = options, sessionCwd = cwd) {
  return decideRawAccess({ name, arguments: args, cwd: sessionCwd }, config);
}

test("file mutations use canonical containment, including new files and symlinked cwd", () => {
  for (const name of ["write", "edit", "str_replace_editor"]) {
    for (const target of [
      "protected/new.csv",
      "alias/new.csv",
      "alias/nested/../new.csv",
      join(realpathSync(cwd), "protected/new.csv"),
    ]) {
      const args = {
        file_path: target,
        path: target,
        command: "create",
        sandbox_permissions: "require_escalated",
      };
      const decision = decide(name, args, options, join(cwd, "session"));
      expect(decision.kind).toBe("deny");
      expect(decision.reason).toMatch(/immutable/);
      expect(decision.reason).toMatch(/read/);
    }
    for (const target of ["protectedx/new.csv", "derived/new.csv"]) {
      expect(decide(name, { file_path: target, path: target, command: "create" }).kind).toBe(
        "next",
      );
    }
  }
  expect(decide("str_replace_editor", { path: "protected/x", command: "view" }).kind).toBe("next");
});

test("shell raw reads ask while write verbs deny, including escalation and copy-out", () => {
  const writes = "rm mv cp tee touch mkdir chmod chown truncate dd install rsync ln".split(" ");
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
      expect(decide(name, { command, sandbox_permissions: "require_escalated" }).kind).toBe("deny");
    }
    for (const command of [
      "cat protected/x",
      "ls -la protected",
      `head ${realpathSync(cwd)}/protected/x`,
    ]) {
      const result = decide(name, { command });
      expect(result.kind).toBe("ask");
      expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
      expect(result.displayReason?.en).toMatch(/raw/i);
      expect(result.displayReason?.zh).toMatch(/原始/);
    }
    for (const command of ["echo ok > derived.txt", "rm protectedx/x"]) {
      expect(decide(name, { command }).kind).toBe("next");
    }
    for (const [command, kind] of [
      ["wc -l x", "ask"],
      ["rm x", "deny"],
    ]) {
      expect(decide(name, { command, workdir: "alias" }).kind).toBe(kind);
    }
  }
  expect(decide("bash", { command: "cd protected" }).kind).toBe("ask");
  expect(decide("bash", { command: "rm x" }).kind).toBe("next");
});

test("missing paths, defaults, absolute and multiple roots retain decision boundaries", () => {
  const future = normalizeRawDirs({ rawDirs: ["absent/raw"] });
  const roots = normalizeRawDirs({ rawDirs: ["elsewhere", join(cwd, "protected")] });
  for (const config of [future, roots, normalizeRawDirs()]) {
    const raw = config.rawDirs.at(-1)!;
    expect(decide("write", { file_path: `${raw}/new.csv` }, config).kind).toBe("deny");
    expect(decide("write", { file_path: `${raw}x/new.csv` }, config).kind).toBe("next");
    expect(decide("bash", { command: "echo ok" }, config).kind).toBe("next");
  }
  const call = { name: "write", arguments: { file_path: "data/raw/new.csv" } };
  expect(decideRawAccess(call, normalizeRawDirs()).kind).toBe("deny");
  expect(decide("write", { file_path: "new.csv" }, normalizeRawDirs({ rawDirs: ["/"] })).kind).toBe(
    "deny",
  );
  expect(decide("bash", { command: "cat x" }, roots, join(cwd, "protected")).kind).toBe("ask");
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
      expect(decide(name, args).kind).toBe("next");
    }
  }
  for (const name of ["read", "run_code", "present"]) {
    expect(decide(name, { file_path: "protected/x", command: "rm protected/x" }).kind).toBe("next");
  }
});

test("physical symlink-parent traversal agrees across targets, roots and workdirs", () => {
  symlinkSync(join(cwd, "protected/nested"), join(cwd, "deep-link"));
  mkdirSync(join(cwd, "outside/nested"), { recursive: true });
  symlinkSync(join(cwd, "outside/nested"), join(cwd, "protected/out-link"));
  writeFileSync(join(cwd, "protected/existing.csv"), "fixture");
  for (const name of ["write", "edit", "str_replace_editor"]) {
    for (const leaf of ["existing.csv", "new.csv"]) {
      const path = `deep-link/../${leaf}`;
      expect(decide(name, { file_path: path, path, command: "create" }).kind).toBe("deny");
    }
    const path = "protected/out-link/../new.csv";
    expect(decide(name, { file_path: path, path, command: "create" }).kind).toBe("next");
  }
  const physicalRoot = normalizeRawDirs({ rawDirs: ["deep-link/.."] });
  expect(decide("write", { file_path: "protected/new.csv" }, physicalRoot).kind).toBe("deny");
  expect(decide("write", { file_path: "outside/new.csv" }, physicalRoot).kind).toBe("next");
  for (const [command, kind] of [
    ["cat existing.csv", "ask"],
    ["rm existing.csv", "deny"],
  ]) {
    expect(decide("bash", { command, workdir: "deep-link/.." }).kind).toBe(kind);
    const config = normalizeRawDirs({ rawDirs: [join(cwd, "protected")] });
    expect(decide("bash", { command }, config, `${cwd}/deep-link/..`).kind).toBe(kind);
  }
});

test.runIf(process.platform === "darwin")(
  "macOS var alias and private spelling share raw identity",
  () => {
    const aliasCwd = mkdtempSync("/var/tmp/shud-guard-");
    try {
      const physical = realpathSync.native(aliasCwd);
      expect(physical.startsWith("/private/var/")).toBe(true);
      const config = normalizeRawDirs({ rawDirs: [join(physical, "protected")] });
      expect(decide("write", { file_path: "protected/new.csv" }, config, aliasCwd).kind).toBe(
        "deny",
      );
    } finally {
      rmSync(aliasCwd, { recursive: true, force: true });
    }
  },
);
