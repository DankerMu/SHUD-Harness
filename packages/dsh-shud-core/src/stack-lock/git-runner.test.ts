import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { collectRepositoryRevision, runGit } from "./repository-revision.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "controlled-git-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("runGit", () => {
  test("status preserves NUL path bytes with the exact current environment and fixed git prefix", async () => {
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const repo = join(root, "repo");
    const home = join(root, "home");
    const shimDir = join(root, "bin");
    const tracePath = join(root, "git-trace.bin");
    mkdirSync(home);
    mkdirSync(shimDir);
    const path = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;
    const expectedEnv = {
      PATH: path,
      HOME: home,
      LC_ALL: "C",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: "0",
    };
    execFileSync(realGit, ["init", "-q", "-b", "main", repo], {
      env: expectedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(join(repo, "space and\nnewline.txt"), "untracked\n");

    compileGitShim(realGit, shimDir, tracePath);
    vi.stubEnv("PATH", path);
    vi.stubEnv("HOME", home);
    vi.stubEnv("DMXAPI_KEY", "controlled-git-fake-secret");
    vi.stubEnv("GIT_DIR", join(root, "foreign.git"));
    vi.stubEnv("GIT_WORK_TREE", join(root, "foreign-worktree"));

    const result = await runGit(repo, ["status"]);

    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect(result).toEqual({ stdout: Buffer.from("?? space and\nnewline.txt\0") });
    const calls = readGitTrace(tracePath);
    const keys = [
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_OPTIONAL_LOCKS",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "LC_ALL",
      "PATH",
    ];
    const prefix = ["-C", repo, "-c", "core.fsmonitor=false"];
    expect(calls).toEqual([
      { args: [...prefix, "rev-parse", "--show-toplevel"], keys, env: expectedEnv },
      {
        args: [...prefix, "status", "--porcelain", "-z", "--untracked-files=all"],
        keys,
        env: expectedEnv,
      },
    ]);
  });

  test.each(["status", "diff", "archive", "apply"] as const)(
    "rejects a nested directory before executing %s",
    async (verb) => {
      const repo = committedRepo("outer");
      const nested = join(repo, "nested");
      mkdirSync(nested);
      const patch = join(root, "change.patch");
      writeFileSync(
        patch,
        "diff --git a/model.txt b/model.txt\n--- a/model.txt\n+++ b/model.txt\n@@ -1 +1 @@\n-before\n+after\n",
      );
      const args = {
        status: ["status"],
        diff: ["diff", "HEAD"],
        archive: ["archive", "--format=tar", "HEAD"],
        apply: ["apply", "--check", patch],
      }[verb];
      const trace = traceGit();

      await expect(runGit(nested, args)).rejects.toThrow("not a git repository root");

      expect(readGitTrace(trace).map((call) => call.args)).toEqual([
        ["-C", nested, "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
      ]);
    },
  );

  test.each([
    { label: "trailing space", name: "repo " },
    { label: "trailing LF", name: "repo\n" },
    { label: "path-list delimiter", name: `repo${delimiter}name` },
  ])("accepts a physical repository root with $label", async ({ name }) => {
    const repo = committedRepo(name);

    expect(await runGit(repo, ["status"])).toEqual({ stdout: Buffer.alloc(0) });
  });

  test("accepts a symlink alias of the same physical repository root", async () => {
    const repo = committedRepo("physical-root");
    const alias = join(root, "root-alias");
    symlinkSync(repo, alias, "dir");

    expect(await runGit(alias, ["status"])).toEqual({ stdout: Buffer.alloc(0) });
  });

  test("diff ignores external programs and color while preserving changed lines before a pathspec", async () => {
    const repo = committedRepo("configured-diff");
    writeFileSync(join(repo, ".gitattributes"), "model.txt diff=fixture\n");
    const markers: string[] = [];
    for (const config of ["diff.external", "diff.fixture.textconv", "core.fsmonitor"]) {
      const marker = join(root, `${config}.marker`);
      const script = join(root, `${config}.js`);
      markers.push(marker);
      writeFileSync(
        script,
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\nprocess.stdout.write("external-decoy\\\\n");\n`,
        { mode: 0o755 },
      );
      fixtureGit(repo, "config", config, JSON.stringify(script));
    }
    fixtureGit(repo, "config", "color.ui", "always");
    writeFileSync(join(repo, "model.txt"), "after\n");
    const trace = traceGit();

    const { stdout } = await runGit(repo, ["diff", "HEAD", "--", "model.txt"]);

    expect(Buffer.isBuffer(stdout)).toBe(true);
    const diff = stdout.toString("utf8");
    expect(diff).toContain("diff --git a/model.txt b/model.txt\n");
    expect(diff).toContain("--- a/model.txt\n+++ b/model.txt\n");
    expect(diff).toContain("@@ -1 +1 @@\n-before\n+after\n");
    expect(diff).not.toContain("\u001b");
    expect(diff).not.toContain("external-decoy");
    for (const marker of markers) expect(existsSync(marker)).toBe(false);
    expect(readGitTrace(trace).map((call) => call.args)).toEqual([
      ["-C", repo, "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
      [
        "-C",
        repo,
        "-c",
        "core.fsmonitor=false",
        "diff",
        "HEAD",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        "model.txt",
      ],
    ]);
  });

  test("applyCeiling resolves a physical ancestor alias and isolates patch application from the outer repository", async () => {
    const { repo, ceiling, source, patch } = applyFixture();
    const alias = join(root, "ceiling-alias");
    symlinkSync(ceiling, alias, "dir");
    const trace = traceGit();
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      LC_ALL: "C",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: "0",
    };
    const keys = [
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_OPTIONAL_LOCKS",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "LC_ALL",
      "PATH",
    ];
    const applyEnv = { ...env, GIT_CEILING_DIRECTORIES: realpathSync.native(ceiling) };
    const applyKeys = ["GIT_CEILING_DIRECTORIES", ...keys];

    expect(await runGit(source, ["apply", "--check", patch], { applyCeiling: alias })).toEqual({
      stdout: Buffer.alloc(0),
    });
    expect(readFileSync(join(source, "model.txt"), "utf8")).toBe("before\n");
    expect(readFileSync(join(repo, "model.txt"), "utf8")).toBe("before\n");

    expect(await runGit(source, ["apply", patch], { applyCeiling: alias })).toEqual({
      stdout: Buffer.alloc(0),
    });
    expect(readFileSync(join(source, "model.txt"), "utf8")).toBe("after\n");
    expect(readFileSync(join(repo, "model.txt"), "utf8")).toBe("before\n");
    expect(await runGit(repo, ["status", "--", "model.txt"])).toEqual({
      stdout: Buffer.alloc(0),
    });
    expect(readGitTrace(trace)).toEqual([
      {
        args: ["-C", source, "-c", "core.fsmonitor=false", "apply", "--check", patch],
        keys: applyKeys,
        env: applyEnv,
      },
      {
        args: ["-C", source, "-c", "core.fsmonitor=false", "apply", patch],
        keys: applyKeys,
        env: applyEnv,
      },
      {
        args: ["-C", repo, "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
        keys,
        env,
      },
      {
        args: [
          "-C",
          repo,
          "-c",
          "core.fsmonitor=false",
          "status",
          "--porcelain",
          "-z",
          "--untracked-files=all",
          "--",
          "model.txt",
        ],
        keys,
        env,
      },
    ]);
  });

  test.each(["status", "diff", "archive", "rev-parse"] as const)(
    "rejects applyCeiling for %s before spawning git",
    async (verb) => {
      const repo = committedRepo("non-apply");
      const trace = traceGit();
      const args = {
        status: ["status"],
        diff: ["diff", "HEAD"],
        archive: ["archive", "--format=tar", "HEAD"],
        "rev-parse": ["rev-parse", "HEAD"],
      }[verb];

      await expect(runGit(repo, args, { applyCeiling: root })).rejects.toThrow(/applyCeiling/u);

      expect(existsSync(trace)).toBe(false);
    },
  );

  test.each(["relative", "missing", "equal", "non-ancestor", "foreign alias"] as const)(
    "rejects an invalid %s applyCeiling before spawning git",
    async (kind) => {
      const { ceiling, source, patch } = applyFixture();
      const foreign = join(root, "foreign");
      mkdirSync(foreign);
      const foreignAlias = join(ceiling, "foreign-alias");
      symlinkSync(foreign, foreignAlias, "dir");
      const invalidCeiling = {
        relative: "tmp",
        missing: join(root, "missing"),
        equal: source,
        "non-ancestor": foreign,
        "foreign alias": foreignAlias,
      }[kind];
      const trace = traceGit();

      await expect(
        runGit(source, ["apply", "--check", patch], { applyCeiling: invalidCeiling }),
      ).rejects.toThrow(/applyCeiling/u);

      expect(existsSync(trace)).toBe(false);
      expect(readFileSync(join(source, "model.txt"), "utf8")).toBe("before\n");
    },
  );

  test("reads current PATH and HOME per call while retaining one environment snapshot across the root guard", async () => {
    const repo = committedRepo("changing-environment");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const hostPath = process.env.PATH;
    const fixtures = ["first", "second"].map((name) => {
      const bin = join(root, `${name}-bin`);
      const home = join(root, `${name}-home`);
      const trace = join(root, `${name}.bin`);
      mkdirSync(bin);
      mkdirSync(home);
      compileGitShim(realGit, bin, trace);
      return { home, trace, path: `${bin}${delimiter}${hostPath ?? ""}` };
    });
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "'color.ui=always'");
    for (const fixture of fixtures) {
      vi.stubEnv("PATH", fixture.path);
      vi.stubEnv("HOME", fixture.home);
      const pending = runGit(repo, ["status"]);
      vi.stubEnv("PATH", join(root, "no-executables"));
      vi.stubEnv("HOME", join(root, "changed-during-guard"));

      expect(await pending).toEqual({ stdout: Buffer.alloc(0) });
      const calls = readGitTrace(fixture.trace);
      expect(calls.map((call) => call.args)).toEqual([
        ["-C", repo, "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
        [
          "-C",
          repo,
          "-c",
          "core.fsmonitor=false",
          "status",
          "--porcelain",
          "-z",
          "--untracked-files=all",
        ],
      ]);
      for (const call of calls) {
        expect(call.keys).toEqual([
          "GIT_CONFIG_GLOBAL",
          "GIT_CONFIG_NOSYSTEM",
          "GIT_OPTIONAL_LOCKS",
          "GIT_TERMINAL_PROMPT",
          "HOME",
          "LC_ALL",
          "PATH",
        ]);
        expect(call.env).toEqual({
          PATH: fixture.path,
          HOME: fixture.home,
          LC_ALL: "C",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: devNull,
          GIT_TERMINAL_PROMPT: "0",
        });
      }
    }
  });

  test.each(["PATH", "HOME"] as const)("rejects missing %s before spawning git", async (name) => {
    const repo = committedRepo("missing-environment");
    const trace = traceGit();
    vi.stubEnv(name, undefined);

    await expect(runGit(repo, ["status"])).rejects.toThrow(name);

    expect(existsSync(trace)).toBe(false);
  });

  test.each([
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid maxBuffer %s before spawning git", async (maxBuffer) => {
    const repo = committedRepo("invalid-buffer");
    const trace = traceGit();

    await expect(runGit(repo, ["status"], { maxBuffer })).rejects.toThrow(/maxBuffer/u);

    expect(existsSync(trace)).toBe(false);
  });

  test("returns a real binary git object larger than one MiB without changing any byte", async () => {
    const repo = committedRepo("binary-output");
    const expected = Buffer.alloc(1024 * 1024 + 4097, Buffer.from([0, 255, 128, 10, 13, 65]));
    writeFileSync(join(repo, "binary.dat"), expected);
    const object = fixtureGit(repo, "hash-object", "-w", "--", "binary.dat").trim();

    const result = await runGit(repo, ["cat-file", "blob", object]);

    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect(result).toEqual({ stdout: expected });
    await expect(runGit(repo, ["cat-file", "blob", object], { maxBuffer: 1024 })).rejects.toThrow(
      /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/u,
    );
  });

  test.each([
    { label: "target stdout", verb: "status", fd: 1, guarded: false },
    { label: "target stderr", verb: "status", fd: 2, guarded: false },
    { label: "root guard stdout", verb: "rev-parse", fd: 1, guarded: true },
    { label: "root guard stderr", verb: "rev-parse", fd: 2, guarded: true },
  ])("fails closed on $label overflow without partial success", async ({ verb, fd, guarded }) => {
    const repo = committedRepo("overflow");
    const trace = faultGit(verb, `require("node:fs").writeSync(${fd}, Buffer.alloc(8192, "x"));`);

    const error = await rejectedBy(() => runGit(repo, ["status"], { maxBuffer: 1024 }));

    expect(error.message).toContain("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(error).not.toHaveProperty("stdout");
    expect(readGitTrace(trace).map((call) => call.args[4])).toEqual(
      guarded ? ["rev-parse"] : ["rev-parse", "status"],
    );
  });

  test.each(["status", "rev-parse"])(
    "bounds %s failure diagnostics without exposing stdout, host secrets or command arguments",
    async (verb) => {
      const repo = committedRepo("diagnostics");
      const discarded = "discarded-stderr-prefix";
      const tail = `${"t".repeat(4087)}TAIL-END!`;
      const stdoutBait = "stdout-must-not-escape";
      const secret = "unpassed-fake-environment-secret";
      const argument = "private-command-argument";
      const trace = faultGit(
        verb,
        `const fs = require("node:fs");
fs.writeSync(1, ${JSON.stringify(stdoutBait)});
fs.writeSync(2, ${JSON.stringify(discarded + tail)});
process.exit(23);`,
      );
      vi.stubEnv("DMXAPI_KEY", secret);

      const error = await rejectedBy(() => runGit(repo, ["status", "--", argument]));

      expect(error.message).toContain("exit 23");
      expect(error.message).toContain("[stderr truncated]");
      expect(error.message.endsWith(tail)).toBe(true);
      expect(Buffer.byteLength(tail)).toBe(4096);
      assertControlledError(error, [
        discarded,
        stdoutBait,
        secret,
        argument,
        `git -C ${repo} -c core.fsmonitor=false`,
      ]);
      expect(readGitTrace(trace).map((call) => call.args[4])).toEqual(
        verb === "rev-parse" ? ["rev-parse"] : ["rev-parse", "status"],
      );
    },
  );

  test("retains a numeric exit code when git supplies no stderr", async () => {
    const repo = committedRepo("empty-stderr");
    faultGit("status", "process.exit(17);");

    const error = await rejectedBy(() => runGit(repo, ["status"]));

    expect(error.message).toContain("exit 17");
    assertControlledError(error, []);
  });

  test("reports a controlled system code when git cannot be spawned", async () => {
    const repo = committedRepo("missing-git");
    const emptyPath = join(root, "empty-path");
    mkdirSync(emptyPath);
    vi.stubEnv("PATH", emptyPath);
    vi.stubEnv("DMXAPI_KEY", "spawn-fake-secret");

    const error = await rejectedBy(() => runGit(repo, ["rev-parse", "private-command-argument"]));

    expect(error.message).toContain("ENOENT");
    assertControlledError(error, ["spawn-fake-secret", "private-command-argument"]);
  });

  test("legacy collection honors the host global ignore while the controlled runner does not", async () => {
    const repo = committedRepo("host-ignore");
    const ignored = join(root, "host-ignore.txt");
    const config = join(root, "host.gitconfig");
    writeFileSync(ignored, "host-only.txt\n");
    writeFileSync(config, `[core]\n\texcludesFile = ${JSON.stringify(ignored)}\n`);
    writeFileSync(join(repo, "host-only.txt"), "ignored only by host configuration\n");
    const head = fixtureGit(repo, "rev-parse", "HEAD").trim();
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "no-xdg"));

    expect(collectRepositoryRevision(repo)).toEqual({
      commit: head,
      branch: "main",
      dirty: false,
      dirty_paths: [],
      dirty_paths_truncated: false,
    });
    expect(await runGit(repo, ["status"])).toEqual({
      stdout: Buffer.from("?? host-only.txt\0"),
    });
  });

  test.each(["physical", "alias"] as const)(
    "rejects an unrepresentable %s applyCeiling before spawning git",
    async (kind) => {
      const { repo, ceiling, source, patch } = applyFixture(`outer${delimiter}repository`);
      const alias = join(root, "delimiter-free-alias");
      symlinkSync(ceiling, alias, "dir");
      const trace = traceGit();

      await expect(
        runGit(source, ["apply", patch], { applyCeiling: kind === "alias" ? alias : ceiling }),
      ).rejects.toThrow(/applyCeiling/u);

      expect(existsSync(trace)).toBe(false);
      expect(readFileSync(join(source, "model.txt"), "utf8")).toBe("before\n");
      expect(readFileSync(join(repo, "model.txt"), "utf8")).toBe("before\n");
    },
  );
});

function readGitTrace(
  path: string,
): { args: string[]; keys: string[]; env: Record<string, string> }[] {
  const bytes = readFileSync(path);
  let offset = 0;
  const field = (): string => {
    const end = bytes.indexOf(0, offset);
    if (end === -1) throw new Error("unterminated git environment trace field");
    const value = bytes.toString("utf8", offset, end);
    offset = end + 1;
    return value;
  };
  const calls: { args: string[]; keys: string[]; env: Record<string, string> }[] = [];
  while (offset < bytes.length) {
    const args = Array.from({ length: Number(field()) }, field);
    const keys = Array.from({ length: Number(field()) }, field).sort();
    const env = Object.fromEntries(
      Array.from({ length: Number(field()) }, () => [field(), field()]),
    );
    calls.push({ args, keys, env });
  }
  return calls;
}

function compileGitShim(realGit: string, shimDir: string, tracePath: string): void {
  // Observe native environ before Node/Python runtime initialization can add Darwin keys.
  // Compile metadata into the fixture rather than contaminating the child environment.
  execFileSync(
    "cc",
    [
      "-std=c99",
      "-Wall",
      "-Wextra",
      "-Werror",
      `-DTRACE_PATH=${JSON.stringify(tracePath)}`,
      `-DREAL_GIT=${JSON.stringify(realGit)}`,
      fileURLToPath(new URL("../../../../scripts/fixtures/git-environment.c", import.meta.url)),
      "-o",
      join(shimDir, "git"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

function traceGit(
  realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
): string {
  const shimDir = join(root, "bin");
  const tracePath = join(root, "git-trace.bin");
  mkdirSync(shimDir);
  compileGitShim(realGit, shimDir, tracePath);
  vi.stubEnv("PATH", `${shimDir}${delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("HOME", root);
  return tracePath;
}

function fixtureGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function committedRepo(name: string): string {
  const repo = join(root, name);
  fixtureGit(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "model.txt"), "before\n");
  fixtureGit(repo, "add", "model.txt");
  fixtureGit(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  return repo;
}

function applyFixture(name = "outer"): {
  repo: string;
  ceiling: string;
  source: string;
  patch: string;
} {
  const repo = committedRepo(name);
  const ceiling = join(repo, "tmp");
  const source = join(ceiling, "src");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "model.txt"), "before\n");
  const patch = join(root, "change.patch");
  writeFileSync(
    patch,
    "diff --git a/model.txt b/model.txt\n--- a/model.txt\n+++ b/model.txt\n@@ -1 +1 @@\n-before\n+after\n",
  );
  return { repo, ceiling, source, patch };
}

function faultGit(verb: string, action: string): string {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const script = join(root, "fault-git");
  writeFileSync(
    script,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[4] === ${JSON.stringify(verb)}) {
  ${action}
  process.exit(0);
}
const result = require("node:child_process").spawnSync(${JSON.stringify(realGit)}, args, {
  env: process.env, stdio: "inherit"
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  return traceGit(script);
}

async function rejectedBy(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the action to reject");
}

function assertControlledError(error: Error, forbidden: readonly string[]): void {
  for (const property of ["cause", "stdout", "stderr", "env", "cmd"]) {
    expect(error).not.toHaveProperty(property);
  }
  const views = [
    error.message,
    error.stack ?? "",
    inspect(error, { depth: null, showHidden: true }),
    inspect(Object.getOwnPropertyDescriptors(error), { depth: null }),
    JSON.stringify(error),
  ];
  for (const value of forbidden) {
    for (const view of views) expect(view).not.toContain(value);
  }
}
