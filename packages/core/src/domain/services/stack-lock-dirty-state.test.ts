import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import {
  collectStackLockContext,
  type StackLockCollectionResult,
  type StackLockGitCommand,
  type StackLockGitCommandInput,
  type StackLockGitCommandResult
} from "./index";

const REPOSITORIES = ["SHUD", "rSHUD", "AutoSHUD", "zero"] as const;
const REPOSITORY_BRANCHES = Object.freeze({
  SHUD: "master",
  rSHUD: "master",
  AutoSHUD: "master",
  zero: "development"
});
const SECRET_DETAIL = "stack-lock-secret-process-detail";
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
type RepositoryName = (typeof REPOSITORIES)[number];
type RepositoryRevision = StackLockCollectionResult["repos"][RepositoryName];
const tempRoots: string[] = [];

describe("StackLock actual repository state", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test.each(REPOSITORIES)(
    "records %s actual HEAD and branch when checkout state differs from gitlink and declaration",
    async (repositoryName) => {
      const fixture = await createFixture();
      const repository = fixture.repositories[repositoryName];
      const oldPin = fixture.gitlinks[repositoryName];
      await writeFile(join(repository, "tracked.txt"), "second commit\n");
      git(repository, ["add", "tracked.txt"]);
      git(repository, ["commit", "--quiet", "--message", "advance actual checkout"]);
      const actualBranch = `feature/${repositoryName.toLowerCase()}-local-state`;
      git(repository, ["branch", "-M", actualBranch]);
      const actualHead = git(repository, ["rev-parse", "HEAD"]).trim();

      const result = await collectStackLockContext({ repositoryRoot: fixture.root });
      expect(result.repos).toEqual(withRepositoryRevision(fixture, repositoryName, {
        commit: actualHead,
        branch: actualBranch,
        dirty: false
      }));
      expect(result.repos[repositoryName].commit).not.toBe(oldPin);
    }
  );

  test.each(REPOSITORIES)(
    "marks a tracked modification in %s dirty while every sibling remains exact and clean",
    async (repositoryName) => {
      const fixture = await createFixture();
      await writeFile(join(fixture.repositories[repositoryName], "tracked.txt"), "modified\n");

      const result = await collectStackLockContext({ repositoryRoot: fixture.root });
      expect(result.repos).toEqual(withRepositoryRevision(fixture, repositoryName, {
        ...cleanRepositoryRevisions(fixture)[repositoryName],
        dirty: true
      }));
    }
  );

  test.each(REPOSITORIES)(
    "marks an untracked file in %s dirty while every sibling remains exact and clean",
    async (repositoryName) => {
      const fixture = await createFixture();
      await writeFile(join(fixture.repositories[repositoryName], "untracked.txt"), "new\n");

      const result = await collectStackLockContext({ repositoryRoot: fixture.root });
      expect(result.repos).toEqual(withRepositoryRevision(fixture, repositoryName, {
        ...cleanRepositoryRevisions(fixture)[repositoryName],
        dirty: true
      }));
    }
  );

  test.each(REPOSITORIES)(
    "uses the explicit detached label for %s while every sibling remains exact and clean",
    async (repositoryName) => {
      const fixture = await createFixture();
      git(fixture.repositories[repositoryName], ["checkout", "--quiet", "--detach", "HEAD"]);

      const result = await collectStackLockContext({ repositoryRoot: fixture.root });
      expect(result.repos).toEqual(withRepositoryRevision(fixture, repositoryName, {
        ...cleanRepositoryRevisions(fixture)[repositoryName],
        branch: "detached"
      }));
    }
  );

  test("fails closed when HEAD and branch do not bracket one repository status observation", async () => {
    const fixture = await createFixture();
    let shudHeadReads = 0;
    const gitCommand: StackLockGitCommand = async (input) => {
      const result = runFixtureGitCommand(input);
      if (
        input.cwd === fixture.repositories.SHUD &&
        isHeadCommand(input.args) &&
        ++shudHeadReads === 1
      ) {
        await writeFile(join(fixture.repositories.SHUD, "tracked.txt"), "advanced during read\n");
        git(fixture.repositories.SHUD, ["add", "tracked.txt"]);
        git(fixture.repositories.SHUD, ["commit", "--quiet", "--message", "drift during snapshot"]);
      }
      return result;
    };

    await expectCollectorFailure(fixture, gitCommand, "collection_state_changed");
  });

  test("fails closed when dirty state changes between the two complete snapshots", async () => {
    const fixture = await createFixture();
    let shudStatusReads = 0;
    const gitCommand: StackLockGitCommand = async (input) => {
      const result = runFixtureGitCommand(input);
      if (
        input.cwd === fixture.repositories.SHUD &&
        isStatusCommand(input.args) &&
        ++shudStatusReads === 1
      ) {
        await writeFile(join(fixture.repositories.SHUD, "drift.txt"), "drift\n");
      }
      return result;
    };

    await expectCollectorFailure(fixture, gitCommand, "collection_state_changed");
  });

  test("does not modify superproject or checkout HEAD, index, status, tracked, or untracked bytes", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "superproject-untracked.txt"), "superproject sentinel\n");
    for (const repositoryName of REPOSITORIES) {
      await writeFile(
        join(fixture.repositories[repositoryName], "untracked-sentinel.txt"),
        `${repositoryName} untracked sentinel\n`
      );
    }
    const before = await observeFixture(fixture);

    const result = await collectStackLockContext({ repositoryRoot: fixture.root });

    expect(Object.values(result.repos).every((repo) => repo.dirty)).toBe(true);
    expect(await observeFixture(fixture)).toEqual(before);
  });

  test("rejects a repository path replaced by a symlink without reading or modifying its unique target", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const original = fixture.repositories.SHUD;
    const displaced = join(fixture.container, "outside-shud");
    await rename(original, displaced);
    await symlink(displaced, original, "dir");
    const before = await readFile(join(displaced, "tracked.txt"), "utf8");

    await expectCollectorFailure(fixture, undefined, "collection_contract_invalid");
    expect(await readFile(join(displaced, "tracked.txt"), "utf8")).toBe(before);
  });

  test.each(["missing", "non-directory", "nested Git top-level"] as const)(
    "rejects a %s checkout without publishing partial repository state",
    async (failureKind) => {
      const fixture = await createFixture();
      const checkout = fixture.repositories.rSHUD;
      if (failureKind === "missing") {
        await rm(checkout, { recursive: true });
      } else if (failureKind === "non-directory") {
        await rm(checkout, { recursive: true });
        await writeFile(checkout, SECRET_DETAIL);
      } else {
        await rm(join(checkout, ".git"), { recursive: true });
      }

      const thrown = await expectCollectorFailure(
        fixture,
        undefined,
        "collection_contract_invalid"
      );
      expect(thrown.message).not.toContain(checkout);
      expect(thrown.message).not.toContain(SECRET_DETAIL);
    }
  );

  test("fails closed when a checkout is replaced at the same path during collection", async () => {
    const fixture = await createFixture();
    const checkout = fixture.repositories.SHUD;
    const displaced = join(fixture.container, "displaced-shud");
    const trackedBefore = await readFile(join(checkout, "tracked.txt"), "utf8");
    let replaced = false;
    const gitCommand: StackLockGitCommand = async (input) => {
      const result = runFixtureGitCommand(input);
      if (!replaced && input.cwd === checkout && isStatusCommand(input.args)) {
        replaced = true;
        await rename(checkout, displaced);
        await mkdir(checkout);
      }
      return result;
    };

    await expectCollectorFailure(fixture, gitCommand, "collection_state_changed");
    expect(await readFile(join(displaced, "tracked.txt"), "utf8")).toBe(trackedBefore);
  });

  test.each([
    ["empty", ""],
    ["unterminated", "1111111111111111111111111111111111111111"],
    ["multi-line", `1111111111111111111111111111111111111111\n${SECRET_DETAIL}\n`],
    ["non-UTF-8", Uint8Array.from([0xff, 0x0a])],
    ["over-64-KiB", `${SECRET_DETAIL}${"1".repeat(MAX_GIT_OUTPUT_BYTES)}\n`]
  ] as const)("rejects %s HEAD output at the public collector seam", async (_label, stdout) => {
    const fixture = await createFixture();
    const gitCommand = overrideRepositoryOutput(fixture, "HEAD", stdout);
    const thrown = await expectCollectorFailure(fixture, gitCommand, "git_output_invalid");
    assertNonDisclosing(thrown, fixture.root);
  });

  test.each([
    ["empty", ""],
    ["unterminated", "feature/local"],
    ["multi-line", `feature/local\n${SECRET_DETAIL}\n`],
    ["non-UTF-8", Uint8Array.from([0xff, 0x0a])],
    ["over-64-KiB", `${SECRET_DETAIL}${"b".repeat(MAX_GIT_OUTPUT_BYTES)}\n`]
  ] as const)("rejects %s branch output at the public collector seam", async (_label, stdout) => {
    const fixture = await createFixture();
    const gitCommand = overrideRepositoryOutput(fixture, "branch", stdout);
    const thrown = await expectCollectorFailure(fixture, gitCommand, "git_output_invalid");
    assertNonDisclosing(thrown, fixture.root);
  });

  test.each([
    ["empty", "", false],
    ["one porcelain record", " M tracked.txt\n", true],
    ["many porcelain records", " M tracked.txt\n?? untracked.txt\n", true]
  ] as const)("maps %s status output to the expected dirty boolean", async (_label, stdout, dirty) => {
    const fixture = await createFixture();
    const result = await collectStackLockContext({
      repositoryRoot: fixture.root,
      gitCommand: overrideRepositoryOutput(fixture, "status", stdout)
    });
    expect(result.repos).toEqual(withRepositoryRevision(fixture, "SHUD", {
      ...cleanRepositoryRevisions(fixture).SHUD,
      dirty
    }));
  });

  test.each([
    ["non-UTF-8", Uint8Array.from([0xff])],
    ["over-64-KiB", Uint8Array.from(Buffer.alloc(MAX_GIT_OUTPUT_BYTES + 1, 0x78))]
  ] as const)("rejects %s status output at the public collector seam", async (_label, stdout) => {
    const fixture = await createFixture();
    const gitCommand = overrideRepositoryOutput(fixture, "status", stdout);
    const thrown = await expectCollectorFailure(fixture, gitCommand, "git_output_invalid");
    assertNonDisclosing(thrown, fixture.root);
  });

  test.each(["throw", "timeout"] as const)(
    "maps an injected Git %s to git_read_failed without stdout, stderr, path, or partial output",
    async (failureKind) => {
      const fixture = await createFixture();
      const gitCommand: StackLockGitCommand = async () => {
        const error = new Error(SECRET_DETAIL);
        Object.assign(error, {
          ...(failureKind === "timeout" ? { code: "ETIMEDOUT" } : {}),
          stdout: `${SECRET_DETAIL}-stdout`,
          stderr: `${SECRET_DETAIL}-stderr`
        });
        throw error;
      };
      const thrown = await expectCollectorFailure(fixture, gitCommand, "git_read_failed");
      assertNonDisclosing(thrown, fixture.root);
    }
  );

  test("ignores hostile credential, askpass, and trace environment during real collection", async () => {
    const fixture = await createFixture();
    const tracePath = join(fixture.container, "git-trace.log");
    const askpassMarker = join(fixture.container, "askpass-ran");
    const hostile = {
      GIT_ASKPASS: join(fixture.container, "attacker-askpass"),
      SSH_ASKPASS: join(fixture.container, "attacker-askpass"),
      GIT_TERMINAL_PROMPT: "1",
      GIT_TRACE: tracePath,
      GIT_TRACE2_EVENT: tracePath,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: `!touch ${askpassMarker}`,
      GLM_API_KEY: SECRET_DETAIL
    } as const;
    const previous = Object.fromEntries(Object.keys(hostile).map((key) => [key, env[key]]));
    try {
      Object.assign(env, hostile);
      const result = await collectStackLockContext({ repositoryRoot: fixture.root });
      expect(result.repos).toEqual(cleanRepositoryRevisions(fixture));
    } finally {
      restoreEnvironment(previous);
    }
    await expect(access(tracePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(askpassMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface Fixture {
  container: string;
  root: string;
  repositories: Record<RepositoryName, string>;
  gitlinks: Record<RepositoryName, string>;
}

async function createFixture(): Promise<Fixture> {
  const container = await realpath(await mkdtemp(join(tmpdir(), "stack-lock-dirty-")));
  tempRoots.push(container);
  const root = join(container, "superproject");
  await mkdir(join(root, "config", "providers"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"fixture","version":"0.8.3"}\n');
  await writeFile(
    join(root, "config", "providers", "glm.dmxapi.json"),
    JSON.stringify({
      default_provider: "glm-dmxapi",
      default_model: "glm-dmxapi/target",
      target_model_id: "glm-5.2",
      providers: {
        "glm-dmxapi": {
          base_url: "https://www.dmxapi.cn/v1",
          models: { target: { model_id: "glm-5.2" } }
        }
      }
    }) + "\n"
  );

  const repositories = {} as Record<RepositoryName, string>;
  const gitlinks = {} as Record<RepositoryName, string>;
  for (const name of REPOSITORIES) {
    const repository = join(root, name);
    repositories[name] = repository;
    await mkdir(repository);
    git(repository, ["init", "--quiet"]);
    configureGit(repository);
    await writeFile(join(repository, "tracked.txt"), `${name}\n`);
    git(repository, ["add", "tracked.txt"]);
    git(repository, ["commit", "--quiet", "--message", `initial ${name}`]);
    git(repository, ["branch", "-M", REPOSITORY_BRANCHES[name]]);
    gitlinks[name] = git(repository, ["rev-parse", "HEAD"]).trim();
  }

  await writeFile(
    join(root, ".gitmodules"),
    REPOSITORIES.map((name) => [
      `[submodule "${name}"]`,
      `\tpath = ${name}`,
      `\turl = https://example.invalid/${name}.git`,
      `\tbranch = ${REPOSITORY_BRANCHES[name]}`
    ].join("\n")).join("\n") + "\n"
  );
  git(root, ["init", "--quiet"]);
  configureGit(root);
  git(root, ["add", "package.json", "config/providers/glm.dmxapi.json", ".gitmodules"]);
  for (const name of REPOSITORIES) {
    git(root, ["update-index", "--add", "--cacheinfo", `160000,${gitlinks[name]},${name}`]);
  }
  git(root, ["commit", "--quiet", "--message", "superproject fixture"]);
  return { container, root: await realpath(root), repositories, gitlinks };
}

function configureGit(root: string): void {
  git(root, ["config", "user.name", "StackLock Test"]);
  git(root, ["config", "user.email", "stack-lock@example.invalid"]);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runFixtureGitCommand(input: StackLockGitCommandInput): StackLockGitCommandResult {
  return {
    stdout: execFileSync("git", [...input.args], {
      cwd: input.cwd,
      encoding: "buffer",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    })
  };
}

function overrideRepositoryOutput(
  fixture: Fixture,
  command: "HEAD" | "branch" | "status",
  stdout: string | Uint8Array
): StackLockGitCommand {
  return async (input) => {
    const matches = command === "HEAD"
      ? isHeadCommand(input.args)
      : command === "branch"
        ? isBranchCommand(input.args)
        : isStatusCommand(input.args);
    if (input.cwd === fixture.repositories.SHUD && matches) {
      return { stdout, stderr: `${SECRET_DETAIL}-stderr` };
    }
    return runFixtureGitCommand(input);
  };
}

function isHeadCommand(args: readonly string[]): boolean {
  return JSON.stringify(args) === JSON.stringify(["--no-lazy-fetch", "rev-parse", "HEAD"]);
}

function isBranchCommand(args: readonly string[]): boolean {
  return JSON.stringify(args) === JSON.stringify([
    "--no-lazy-fetch",
    "rev-parse",
    "--abbrev-ref",
    "HEAD"
  ]);
}

function isStatusCommand(args: readonly string[]): boolean {
  return JSON.stringify(args) === JSON.stringify([
    "--no-lazy-fetch",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--"
  ]);
}

function cleanRepositoryRevisions(
  fixture: Fixture
): Record<RepositoryName, RepositoryRevision> {
  return Object.fromEntries(REPOSITORIES.map((name) => [
    name,
    {
      commit: fixture.gitlinks[name],
      branch: REPOSITORY_BRANCHES[name],
      dirty: false
    }
  ])) as Record<RepositoryName, RepositoryRevision>;
}

function withRepositoryRevision(
  fixture: Fixture,
  repositoryName: RepositoryName,
  revision: RepositoryRevision
): Record<RepositoryName, RepositoryRevision> {
  return { ...cleanRepositoryRevisions(fixture), [repositoryName]: revision };
}

async function expectCollectorFailure(
  fixture: Fixture,
  gitCommand: StackLockGitCommand | undefined,
  code: string
): Promise<Error> {
  let collection: Awaited<ReturnType<typeof collectStackLockContext>> | undefined;
  let thrown: unknown;
  try {
    collection = await collectStackLockContext({ repositoryRoot: fixture.root, gitCommand });
  } catch (error) {
    thrown = error;
  }
  expect(collection).toBeUndefined();
  expect(thrown).toMatchObject({
    name: "StackLockCollectionError",
    code,
    message: "StackLock context collection failed."
  });
  return thrown as Error;
}

function assertNonDisclosing(error: Error, repositoryRoot: string): void {
  expect(error.message).toBe("StackLock context collection failed.");
  expect(error.message).not.toContain(repositoryRoot);
  expect(error.message).not.toContain(SECRET_DETAIL);
  expect(JSON.stringify(error)).not.toContain(repositoryRoot);
  expect(JSON.stringify(error)).not.toContain(SECRET_DETAIL);
}

async function observeFixture(fixture: Fixture): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    superHead: git(fixture.root, ["rev-parse", "HEAD"]),
    superStatus: git(fixture.root, ["status", "--porcelain=v1", "--ignore-submodules=none"]),
    superIndex: (await readFile(join(fixture.root, ".git", "index"))).toString("base64"),
    superTracked: await readFile(join(fixture.root, "package.json"), "utf8"),
    superUntracked: await readFile(join(fixture.root, "superproject-untracked.txt"), "utf8")
  };
  for (const name of REPOSITORIES) {
    const repository = fixture.repositories[name];
    result[name] = {
      head: git(repository, ["rev-parse", "HEAD"]),
      status: git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
      index: (await readFile(join(repository, ".git", "index"))).toString("base64"),
      tracked: await readFile(join(repository, "tracked.txt"), "utf8"),
      untracked: await readFile(join(repository, "untracked-sentinel.txt"), "utf8")
    };
  }
  return result;
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}
