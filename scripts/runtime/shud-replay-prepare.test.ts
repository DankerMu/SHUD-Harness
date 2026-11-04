import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const harness = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const script = join(harness, "scripts", "runtime", "shud-replay-prepare.sh");
const pinnedCommit = "9a422e5eb708df7d2f8b4066a3083a031d679a82";
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

type Prepared = {
  source: string;
  files: Record<string, { before_sha256: string; after_sha256: string }>;
};

type ConstructedInput = {
  basin: string;
  source: string;
  forcing: string;
  originalCfg: string;
  expectedCfg: string;
  originalForc: string;
  expectedForc: string;
  unchanged: Buffer;
};

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, "-c", "core.fsmonitor=false", ...args], {
    env: gitEnv,
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function files(directory: string, prefix = ""): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = join(prefix, entry.name);
      return entry.isDirectory() ? files(join(directory, entry.name), relative) : [relative];
    })
    .sort();
}

function bytes(directory: string): Record<string, Buffer> {
  return Object.fromEntries(
    files(directory).map((name) => [name, fs.readFileSync(join(directory, name))]),
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function rootState(rootShud = join(harness, "SHUD")) {
  const gitDir = git(rootShud, "rev-parse", "--absolute-git-dir");
  const dotGit = join(rootShud, ".git");
  return {
    head: git(rootShud, "rev-parse", "HEAD"),
    status: git(rootShud, "status", "--porcelain", "--untracked-files=all"),
    diff: git(rootShud, "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"),
    gitDir,
    inventory: files(gitDir),
    gitlink: fs.lstatSync(dotGit).isFile() ? fs.readFileSync(dotGit) : null,
  };
}

function constructedInput(root: string): ConstructedInput {
  const basin = join(root, "constructed-basin");
  const source = join(basin, "input", "keliya");
  const forcing = join(basin, "forcing.trimmed");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(forcing);
  const originalCfg =
    "# constructed input\r\nSTART  12053\r\nNUM_OPENMP 8\r\nEND\t12143\r\n# keep  spacing \r\n";
  const expectedCfg =
    "# constructed input\r\nSTART  12053\r\nNUM_OPENMP\t1\r\nEND\t12143\r\n# keep  spacing \r\n";
  const stations = Array.from({ length: 32 }, (_, index) => `station-${index + 1}.csv`);
  const table =
    "ID\tLon\tLat\tX\tY\tZ\tFilename\r\n" +
    stations.map((name, index) => `${index + 1}\t80.5\t35.5\t0\t0\t1000\t${name}\r\n`).join("");
  const originalForc = `32 19510101\r\n/obsolete/machine/forcing\r\n${table}`;
  const expectedForc = `32 19510101\r\n${forcing}\r\n${table}`;
  const unchanged = Buffer.from([0, 255, 13, 10, 32, 128]);
  fs.writeFileSync(join(source, "keliya.cfg.para"), originalCfg);
  fs.writeFileSync(join(source, "keliya.tsd.forc"), originalForc);
  fs.writeFileSync(join(source, "keliya.mesh"), unchanged);
  for (const name of stations) fs.writeFileSync(join(forcing, name), `placeholder ${name}\n`);
  return {
    basin,
    source,
    forcing,
    originalCfg,
    expectedCfg,
    originalForc,
    expectedForc,
    unchanged,
  };
}

type Fixture = ConstructedInput & {
  root: string;
  cwd: string;
  workspace: string;
};

function withFixture(run: (fixture: Fixture) => void): void {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "shud-replay-boundary-")));
  try {
    const cwd = join(root, "unrelated cwd");
    fs.mkdirSync(cwd);
    run({ ...constructedInput(root), root, cwd, workspace: join(root, "workspace") });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function tree(directory: string, prefix = ""): Record<string, string | Buffer> {
  const result: Record<string, string | Buffer> = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const key = join(prefix, entry.name);
    if (entry.isDirectory()) {
      result[key] = "directory";
      Object.assign(result, tree(path, key));
    } else if (entry.isSymbolicLink()) {
      result[key] = fs.readlinkSync(path);
    } else if (entry.isFile()) {
      result[key] = fs.readFileSync(path);
    } else {
      result[key] = `special:${fs.lstatSync(path).mode}`;
    }
  }
  return result;
}

function invoke(cwd: string, args: string[], overrides: NodeJS.ProcessEnv = {}, entry = script) {
  const env: NodeJS.ProcessEnv = { ...gitEnv };
  delete env.SHUD_REPLAY_KELIYA;
  Object.assign(env, overrides);
  const before = rootState();
  const result = spawnSync("sh", [entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 90000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  const diagnostic = `${result.stdout}\n${result.stderr}`;
  expect(result.error, diagnostic).toBeUndefined();
  expect(result.signal, diagnostic).toBeNull();
  expect(rootState()).toEqual(before);
  return result;
}

function expectPreflightFailure(
  fixture: Fixture,
  args: string[],
  diagnostic: RegExp,
  env: NodeJS.ProcessEnv = {},
): void {
  const before = tree(fixture.root);
  const result = invoke(fixture.cwd, args, env);
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toMatch(diagnostic);
  expect(tree(fixture.root)).toEqual(before);
}

function isolatedHarness(root: string) {
  const isolated = join(root, "isolated-harness");
  const runtime = join(isolated, "scripts", "runtime");
  const entry = join(runtime, "shud-replay-prepare.sh");
  const repo = join(isolated, "SHUD");
  fs.mkdirSync(runtime, { recursive: true });
  fs.copyFileSync(script, entry);
  git(root, "clone", "--local", "--no-hardlinks", "--", join(harness, "SHUD"), repo);
  return { entry, repo };
}

test("prepares an independent pinned checkout and exactly two input rewrites without changing sources", () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "shud-replay-prepare-")));
  try {
    const cwd = join(root, "unrelated cwd");
    const workspace = join(root, "replay workspace");
    const { basin, source, originalCfg, expectedCfg, originalForc, expectedForc, unchanged } =
      constructedInput(root);
    fs.mkdirSync(cwd);
    const sourceBefore = bytes(basin);
    const rootBefore = rootState();

    const result = spawnSync("sh", [script, workspace, "--keliya", source], {
      cwd,
      env: { ...gitEnv, SHUD_REPLAY_KELIYA: "" },
      encoding: "utf8",
      timeout: 90000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    expect(result.error, diagnostic).toBeUndefined();
    expect(result.signal, diagnostic).toBeNull();
    expect(result.status, diagnostic).toBe(0);

    const checkout = join(fs.realpathSync(workspace), "repos", "SHUD");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(pinnedCommit);
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(checkout, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(checkout, "rev-parse", "--absolute-git-dir")).toBe(join(checkout, ".git"));
    expect(fs.lstatSync(join(checkout, ".git")).isDirectory()).toBe(true);
    expect(fs.realpathSync(join(checkout, ".git"))).toBe(join(checkout, ".git"));

    const input = join(workspace, "input", "keliya");
    expect(fs.readdirSync(workspace).sort()).toEqual(["input", "repos"]);
    expect(fs.readdirSync(join(workspace, "input"))).toEqual(["keliya"]);
    expect(files(input)).toEqual([
      "PREPARED.json",
      "keliya.cfg.para",
      "keliya.mesh",
      "keliya.tsd.forc",
    ]);
    expect(fs.readFileSync(join(input, "keliya.cfg.para"))).toEqual(Buffer.from(expectedCfg));
    expect(fs.readFileSync(join(input, "keliya.tsd.forc"))).toEqual(Buffer.from(expectedForc));
    expect(fs.readFileSync(join(input, "keliya.mesh"))).toEqual(unchanged);
    const prepared = JSON.parse(fs.readFileSync(join(input, "PREPARED.json"), "utf8")) as Prepared;
    expect(prepared).toEqual({
      source,
      files: {
        "keliya.cfg.para": {
          before_sha256: sha256(originalCfg),
          after_sha256: sha256(expectedCfg),
        },
        "keliya.tsd.forc": {
          before_sha256: sha256(originalForc),
          after_sha256: sha256(expectedForc),
        },
      },
    });
    expect(bytes(basin)).toEqual(sourceBefore);
    expect(rootState()).toEqual(rootBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);

test("prepares through a workspace parent alias using physical checkout and input paths", () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "shud-replay-alias-")));
  try {
    const { basin, source, expectedForc } = constructedInput(root);
    const cwd = join(root, "unrelated cwd");
    const parent = join(root, "physical parent");
    const alias = join(root, "workspace alias");
    fs.mkdirSync(cwd);
    fs.mkdirSync(parent);
    fs.symlinkSync(parent, alias, "dir");
    const workspace = join(alias, "new ancestor", "replay workspace");
    const physicalWorkspace = join(parent, "new ancestor", "replay workspace");
    const sourceBefore = bytes(basin);
    const rootBefore = rootState();

    const result = spawnSync("sh", [script, workspace, "--keliya", source], {
      cwd,
      env: { ...gitEnv, SHUD_REPLAY_KELIYA: "" },
      encoding: "utf8",
      timeout: 90000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    expect(result.error, diagnostic).toBeUndefined();
    expect(result.signal, diagnostic).toBeNull();
    expect(result.status, diagnostic).toBe(0);

    expect(fs.realpathSync(workspace)).toBe(physicalWorkspace);
    const checkout = join(physicalWorkspace, "repos", "SHUD");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(pinnedCommit);
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(checkout, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(checkout, "rev-parse", "--absolute-git-dir")).toBe(join(checkout, ".git"));
    expect(fs.lstatSync(join(checkout, ".git")).isDirectory()).toBe(true);
    expect(fs.realpathSync(join(checkout, ".git"))).toBe(join(checkout, ".git"));
    const input = join(physicalWorkspace, "input", "keliya");
    const recordPath = join(input, "PREPARED.json");
    expect(fs.realpathSync(join(workspace, "input", "keliya", "PREPARED.json"))).toBe(recordPath);
    const prepared = JSON.parse(fs.readFileSync(recordPath, "utf8")) as Prepared;
    expect(prepared.source).toBe(source);
    expect(fs.readFileSync(join(input, "keliya.tsd.forc"))).toEqual(Buffer.from(expectedForc));
    expect(result.stdout).toContain(checkout);
    expect(result.stdout).toContain(input);
    expect(result.stdout).not.toContain(alias);
    expect(fs.readlinkSync(alias)).toBe(parent);
    expect(bytes(basin)).toEqual(sourceBefore);
    expect(rootState()).toEqual(rootBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);

test("rejects 32 forcing rows that reference only 31 distinct files before creating outputs", () => {
  withFixture((fixture) => {
    fs.writeFileSync(
      join(fixture.source, "keliya.tsd.forc"),
      fixture.originalForc.replace("station-32.csv", "station-1.csv"),
    );
    fs.rmSync(join(fixture.forcing, "station-32.csv"));
    expectPreflightFailure(
      fixture,
      [fixture.workspace, "--keliya", fixture.source],
      /distinct|duplicate|32.*(?:file|reference)/i,
    );
  });
}, 120000);

test("rejects a physical forcing path with whitespace before creating outputs", () => {
  withFixture((fixture) => {
    const basin = join(fixture.root, "physical basin");
    fs.renameSync(fixture.basin, basin);
    const source = join(basin, "input", "keliya");
    const before = tree(fixture.root);
    const result = invoke(fixture.cwd, [fixture.workspace, "--keliya", source]);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/forcing.*(?:whitespace|space)/i);
    expect(result.stderr).toMatch(/move|relocat|without/i);
    expect(tree(fixture.root)).toEqual(before);
  });
}, 120000);

test.each(["missing", "blank environment", "blank flag"])(
  "rejects %s source without creating outputs",
  (kind) => {
    withFixture((fixture) => {
      const args = [fixture.workspace];
      const env: NodeJS.ProcessEnv = {};
      if (kind === "blank environment") env.SHUD_REPLAY_KELIYA = " \t ";
      if (kind === "blank flag") {
        args.push("--keliya", " \t ");
        env.SHUD_REPLAY_KELIYA = fixture.source;
      }
      expectPreflightFailure(fixture, args, /missing.*source|keliya.*source/i, env);
    });
  },
  120000,
);

test.each(["no workspace", "unknown option", "missing flag value", "extra argument"])(
  "rejects malformed invocation: %s",
  (kind) => {
    withFixture((fixture) => {
      const args =
        kind === "no workspace"
          ? []
          : kind === "unknown option"
            ? [fixture.workspace, "--unknown", fixture.source]
            : kind === "missing flag value"
              ? [fixture.workspace, "--keliya"]
              : [fixture.workspace, "--keliya", fixture.source, "extra"];
      expectPreflightFailure(fixture, args, /usage|argument|option/i);
    });
  },
  120000,
);

test.each(["environment source", "flag overrides environment"])(
  "prepares with %s",
  (kind) => {
    withFixture((fixture) => {
      const args = [fixture.workspace];
      const env = { SHUD_REPLAY_KELIYA: fixture.source };
      if (kind === "flag overrides environment") {
        args.push("--keliya", fixture.source);
        env.SHUD_REPLAY_KELIYA = join(fixture.root, "nonexistent environment source");
      }
      const before = bytes(fixture.basin);
      const result = invoke(fixture.cwd, args, env);
      expect(result.status, result.stderr).toBe(0);
      expect(git(join(fixture.workspace, "repos", "SHUD"), "rev-parse", "HEAD")).toBe(pinnedCommit);
      const input = join(fixture.workspace, "input", "keliya");
      const prepared = JSON.parse(
        fs.readFileSync(join(input, "PREPARED.json"), "utf8"),
      ) as Prepared;
      expect(prepared.source).toBe(fixture.source);
      expect(fs.readFileSync(join(input, "keliya.tsd.forc"))).toEqual(
        Buffer.from(fixture.expectedForc),
      );
      expect(bytes(fixture.basin)).toEqual(before);
    });
  },
  120000,
);

test.each([
  ["repos", "SHUD"],
  ["input", "keliya"],
])(
  "preserves an existing %s/%s destination and unrelated workspace files",
  (parent, name) => {
    withFixture((fixture) => {
      const existing = join(fixture.workspace, parent, name);
      fs.mkdirSync(existing, { recursive: true });
      fs.writeFileSync(join(existing, "keep.bin"), Buffer.from([0, 255, 128]));
      fs.writeFileSync(
        join(fixture.workspace, "unrelated.txt"),
        "keep unrelated workspace bytes\n",
      );
      expectPreflightFailure(
        fixture,
        [fixture.workspace, "--keliya", fixture.source],
        /already exists|existing destination/i,
      );
    });
  },
  120000,
);

test.each(["missing directory", "missing file", "nonregular reference"])(
  "rejects forcing with %s before creating outputs",
  (kind) => {
    withFixture((fixture) => {
      if (kind === "missing directory") {
        fs.rmSync(fixture.forcing, { recursive: true });
      } else {
        const referenced = join(fixture.forcing, "station-1.csv");
        fs.rmSync(referenced);
        if (kind === "nonregular reference") fs.mkdirSync(referenced);
      }
      expectPreflightFailure(
        fixture,
        [fixture.workspace, "--keliya", fixture.source],
        /forcing|referenced.*file|ordinary.*file/i,
      );
    });
  },
  120000,
);

test.each([
  ["repos", "symlink"],
  ["input", "symlink"],
  ["repos", "file"],
  ["input", "file"],
])(
  "rejects a %s %s ancestor beneath the physical workspace",
  (name, kind) => {
    withFixture((fixture) => {
      fs.mkdirSync(fixture.workspace);
      const ancestor = join(fixture.workspace, name);
      if (kind === "symlink") {
        const target = join(fixture.root, "owned link target");
        fs.mkdirSync(target);
        fs.writeFileSync(join(target, "keep.txt"), "keep target bytes\n");
        fs.symlinkSync(target, ancestor, "dir");
      } else {
        fs.writeFileSync(ancestor, "keep ancestor bytes\n");
      }
      expectPreflightFailure(
        fixture,
        [fixture.workspace, "--keliya", fixture.source],
        /unsafe|non-directory|ancestor/i,
      );
    });
  },
  120000,
);

test.each(["basin", "input descendant"])(
  "rejects synthetic source overlap at %s without modifying source",
  (kind) => {
    withFixture((fixture) => {
      const workspace = kind === "basin" ? fixture.basin : join(fixture.source, "nested workspace");
      expectPreflightFailure(fixture, [workspace, "--keliya", fixture.source], /overlap|readonly/i);
    });
  },
  120000,
);

test("retains a real clone and preserves sources when checkout fails", () => {
  withFixture((fixture) => {
    const realGit = execFileSync("sh", ["-c", "command -v git"], {
      env: gitEnv,
      encoding: "utf8",
      timeout: 10000,
    }).trim();
    expect(isAbsolute(realGit)).toBe(true);
    const bin = join(fixture.root, "shim bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      join(bin, "git"),
      '#!/bin/sh\nfor arg do\n  if [ "$arg" = checkout ]; then\n' +
        "    printf '%s\\n' 'fixture checkout failure (55)' >&2\n    exit 55\n  fi\ndone\n" +
        'exec "$SHUD_REPLAY_REAL_GIT" "$@"\n',
      { mode: 0o755 },
    );
    const sourceBefore = bytes(fixture.basin);
    const result = invoke(fixture.cwd, [fixture.workspace, "--keliya", fixture.source], {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      SHUD_REPLAY_REAL_GIT: realGit,
    });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("fixture checkout failure (55)");
    expect(result.stderr).toMatch(/retain|kept/i);
    expect(result.stderr).toContain(fixture.workspace);
    const checkout = join(fixture.workspace, "repos", "SHUD");
    expect(fs.lstatSync(join(checkout, ".git")).isDirectory()).toBe(true);
    expect(git(checkout, "rev-parse", "--absolute-git-dir")).toBe(join(checkout, ".git"));
    expect(git(checkout, "rev-parse", "HEAD")).toBe(
      git(join(harness, "SHUD"), "rev-parse", "HEAD"),
    );
    expect(git(checkout, "cat-file", "-t", pinnedCommit)).toBe("commit");
    expect(git(checkout, "remote", "get-url", "origin")).toBe(join(harness, "SHUD"));
    expect(fs.existsSync(join(fixture.workspace, "input"))).toBe(false);
    expect(bytes(fixture.basin)).toEqual(sourceBefore);
  });
}, 120000);

test("does not invoke a configured fsmonitor command while observing the source repository", () => {
  withFixture((fixture) => {
    const { entry, repo } = isolatedHarness(fixture.root);
    const monitor = join(fixture.root, "fsmonitor-command");
    const sentinel = join(fixture.root, "fsmonitor-invoked");
    fs.writeFileSync(
      monitor,
      '#!/bin/sh\nprintf "%s\\n" invoked > "$SHUD_REPLAY_MONITOR_SENTINEL"\n' +
        "printf 'fixture-token\\0/\\0'\n",
      { mode: 0o755 },
    );
    git(repo, "config", "core.fsmonitor", monitor);
    git(repo, "config", "core.fsmonitorHookVersion", "2");
    const before = rootState(repo);
    const inputBefore = bytes(fixture.basin);
    expect(fs.existsSync(sentinel)).toBe(false);
    const result = invoke(
      fixture.cwd,
      [fixture.workspace, "--keliya", fixture.source],
      { SHUD_REPLAY_MONITOR_SENTINEL: sentinel },
      entry,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(rootState(repo)).toEqual(before);
    expect(bytes(fixture.basin)).toEqual(inputBefore);
    expect(git(join(fixture.workspace, "repos", "SHUD"), "rev-parse", "HEAD")).toBe(pinnedCommit);
  });
}, 120000);

test.each([
  "missing directory",
  "wrong layout",
  "non-directory",
  "existing PREPARED",
  "symlink input",
  "special input",
])(
  "rejects source with %s before creating outputs",
  (kind) => {
    withFixture((fixture) => {
      let source = fixture.source;
      if (kind === "missing directory") {
        source = join(fixture.root, "nonexistent-source");
      } else if (kind === "wrong layout") {
        source = join(fixture.root, "misplaced-keliya");
        fs.renameSync(fixture.source, source);
      } else if (kind === "non-directory") {
        fs.rmSync(source, { recursive: true });
        fs.writeFileSync(source, "not a source directory\n");
      } else if (kind === "existing PREPARED") {
        fs.writeFileSync(join(source, "PREPARED.json"), '{"keep":"existing metadata"}\n');
      } else if (kind === "symlink input") {
        fs.symlinkSync(join(source, "keliya.mesh"), join(source, "linked.mesh"));
      } else {
        execFileSync("mkfifo", [join(source, "special.mesh")], { timeout: 10000 });
      }
      expectPreflightFailure(
        fixture,
        [fixture.workspace, "--keliya", source],
        /ENOENT|directory|PREPARED|ordinary/i,
      );
    });
  },
  120000,
);

test.each(["missing", "duplicate"])(
  "rejects %s NUM_OPENMP lines before outputs",
  (kind) => {
    withFixture((fixture) => {
      fs.writeFileSync(
        join(fixture.source, "keliya.cfg.para"),
        kind === "missing"
          ? fixture.originalCfg.replace("NUM_OPENMP 8\r\n", "")
          : fixture.originalCfg + "NUM_OPENMP 4\r\n",
      );
      expectPreflightFailure(
        fixture,
        [fixture.workspace, "--keliya", fixture.source],
        /exactly one.*NUM_OPENMP|NUM_OPENMP.*(?:one|exactly)/i,
      );
    });
  },
  120000,
);

test.each([
  {
    name: "invalid UTF-8",
    mutate: (value: string) => Buffer.concat([Buffer.from(value), Buffer.from([0xc3, 0x28])]),
    diagnostic: /utf|encoded/i,
  },
  {
    name: "NUL",
    mutate: (value: string) => value.replace("obsolete", "obsolete\0"),
    diagnostic: /forc|reference/i,
  },
  {
    name: "wrong declared count",
    mutate: (value: string) => value.replace("32 19510101", "31 19510101"),
    diagnostic: /32|reference/i,
  },
  {
    name: "missing lines",
    mutate: () => "32 19510101\r\n/unused\r\n",
    diagnostic: /32|reference/i,
  },
  {
    name: "wrong header",
    mutate: (value: string) => value.replace("Filename", "File"),
    diagnostic: /Filename|table/i,
  },
  {
    name: "too few rows",
    mutate: (value: string) => value.split("\r\n").slice(0, -2).join("\r\n") + "\r\n",
    diagnostic: /32|table/i,
  },
  {
    name: "too many rows",
    mutate: (value: string) => value + "33\t80.5\t35.5\t0\t0\t1000\tstation-1.csv\r\n",
    diagnostic: /32|table/i,
  },
  {
    name: "short row",
    mutate: (value: string) => value.replace("1\t80.5\t35.5\t0\t0\t1000\t", "1\t"),
    diagnostic: /matching|table/i,
  },
  {
    name: "wide row",
    mutate: (value: string) =>
      value.replace("1\t80.5\t35.5\t0\t0\t1000\t", "1\t80.5\t35.5\t0\t0\t1000\t0\t"),
    diagnostic: /matching|table/i,
  },
])(
  "rejects a manifest with $name before outputs",
  ({ mutate, diagnostic }) => {
    withFixture((fixture) => {
      fs.writeFileSync(join(fixture.source, "keliya.tsd.forc"), mutate(fixture.originalForc));
      expectPreflightFailure(fixture, [fixture.workspace, "--keliya", fixture.source], diagnostic);
    });
  },
  120000,
);

test.each(["absolute", "escaping", "canonical alias"])(
  "rejects a %s forcing reference without source changes",
  (kind) => {
    withFixture((fixture) => {
      const outside = join(fixture.root, "outside.csv");
      fs.writeFileSync(outside, "keep outside forcing bytes\n");
      const filename =
        kind === "absolute"
          ? join(fixture.forcing, "station-1.csv")
          : kind === "escaping"
            ? "../../outside.csv"
            : "./station-1.csv";
      fs.writeFileSync(
        join(fixture.source, "keliya.tsd.forc"),
        fixture.originalForc.replace("station-32.csv", filename),
      );
      expectPreflightFailure(
        fixture,
        [fixture.workspace, "--keliya", fixture.source],
        /unsafe|distinct/i,
      );
    });
  },
  120000,
);

test.each([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
])(
  "isolates %s from source observation and destination creation",
  (variable) => {
    withFixture((fixture) => {
      const bogus = join(fixture.root, "bogus-git-location");
      fs.mkdirSync(bogus);
      fs.writeFileSync(join(bogus, "keep"), "keep bogus locator bytes\n");
      const before = tree(bogus);
      const sourceBefore = bytes(fixture.basin);
      const result = invoke(fixture.cwd, [fixture.workspace, "--keliya", fixture.source], {
        [variable]: join(bogus, "redirect-target"),
      });
      expect(result.status, result.stderr).toBe(0);
      const checkout = join(fixture.workspace, "repos", "SHUD");
      expect(git(checkout, "rev-parse", "HEAD")).toBe(pinnedCommit);
      expect(git(checkout, "rev-parse", "--absolute-git-dir")).toBe(join(checkout, ".git"));
      expect(git(checkout, "remote", "get-url", "origin")).toBe(join(harness, "SHUD"));
      expect(tree(bogus)).toEqual(before);
      expect(bytes(fixture.basin)).toEqual(sourceBefore);
    });
  },
  120000,
);

test("reports an isolated source preservation mismatch after a real clone and retains outputs", () => {
  withFixture((fixture) => {
    const { entry, repo } = isolatedHarness(fixture.root);
    const realGit = execFileSync("sh", ["-c", "command -v git"], {
      env: gitEnv,
      encoding: "utf8",
      timeout: 10000,
    }).trim();
    expect(isAbsolute(realGit)).toBe(true);
    const marker = join(repo, ".git", "injected-preservation-marker");
    const bin = join(fixture.root, "preservation-shim");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      join(bin, "git"),
      '#!/bin/sh\nfor arg do\n  if [ "$arg" = clone ]; then\n' +
        '    "$SHUD_REPLAY_REAL_GIT" "$@" || exit "$?"\n' +
        '    printf "%s\\n" injected > "$SHUD_REPLAY_PRESERVATION_MARKER"\n' +
        '    exit 0\n  fi\ndone\nexec "$SHUD_REPLAY_REAL_GIT" "$@"\n',
      { mode: 0o755 },
    );
    const before = rootState(repo);
    const inputBefore = bytes(fixture.basin);
    const result = invoke(
      fixture.cwd,
      [fixture.workspace, "--keliya", fixture.source],
      {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        SHUD_REPLAY_REAL_GIT: realGit,
        SHUD_REPLAY_PRESERVATION_MARKER: marker,
      },
      entry,
    );
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/root SHUD.*(?:preservation|changed)/i);
    expect(result.stderr).toMatch(/retain|kept/i);
    expect(result.stderr).toContain(fixture.workspace);
    expect(fs.readFileSync(marker, "utf8")).toBe("injected\n");
    expect(rootState(repo)).toEqual({
      ...before,
      inventory: [...before.inventory, "injected-preservation-marker"].sort(),
    });
    const checkout = join(fixture.workspace, "repos", "SHUD");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(pinnedCommit);
    expect(git(checkout, "remote", "get-url", "origin")).toBe(repo);
    expect(fs.existsSync(join(fixture.workspace, "input", "keliya", "PREPARED.json"))).toBe(true);
    expect(bytes(fixture.basin)).toEqual(inputBefore);
  });
}, 120000);
