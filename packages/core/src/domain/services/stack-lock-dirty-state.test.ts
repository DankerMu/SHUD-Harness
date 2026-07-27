import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectStackLockContext, type StackLockGitCommand } from "./index";

const REPOSITORIES = ["SHUD", "rSHUD", "AutoSHUD", "zero"] as const;
type RepositoryName = (typeof REPOSITORIES)[number];
const tempRoots: string[] = [];

describe("StackLock actual repository state", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("records actual HEAD and branch when checkout state differs from the superproject gitlink", async () => {
    const fixture = await createFixture();
    const oldPin = fixture.gitlinks.SHUD;
    await writeFile(join(fixture.repositories.SHUD, "tracked.txt"), "second commit\n");
    git(fixture.repositories.SHUD, ["add", "tracked.txt"]);
    git(fixture.repositories.SHUD, ["commit", "--quiet", "--message", "advance actual checkout"]);
    git(fixture.repositories.SHUD, ["branch", "-M", "feature/local-state"]);
    const actualHead = git(fixture.repositories.SHUD, ["rev-parse", "HEAD"]).trim();

    const result = await collectStackLockContext({ repositoryRoot: fixture.root });
    expect(result.repos.SHUD).toEqual({
      commit: actualHead,
      branch: "feature/local-state",
      dirty: false
    });
    expect(result.repos.SHUD.commit).not.toBe(oldPin);
  });

  test("marks tracked and untracked changes dirty while preserving clean siblings", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repositories.SHUD, "tracked.txt"), "modified\n");
    await writeFile(join(fixture.repositories.rSHUD, "untracked.txt"), "new\n");

    const result = await collectStackLockContext({ repositoryRoot: fixture.root });
    expect(result.repos.SHUD.dirty).toBe(true);
    expect(result.repos.rSHUD.dirty).toBe(true);
    expect(result.repos.AutoSHUD.dirty).toBe(false);
    expect(result.repos.zero.dirty).toBe(false);
  });

  test("uses the explicit detached label for a detached checkout", async () => {
    const fixture = await createFixture();
    git(fixture.repositories.AutoSHUD, ["checkout", "--quiet", "--detach", "HEAD"]);
    const result = await collectStackLockContext({ repositoryRoot: fixture.root });
    expect(result.repos.AutoSHUD.branch).toBe("detached");
    expect(result.repos.AutoSHUD.dirty).toBe(false);
  });

  test("fails closed when a repository changes between the two snapshots", async () => {
    const fixture = await createFixture();
    let shudStatusReads = 0;
    const gitCommand: StackLockGitCommand = async (input) => {
      const stdout = execFileSync("git", [...input.args], {
        cwd: input.cwd,
        encoding: "buffer",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" }
      });
      if (
        input.cwd === fixture.repositories.SHUD &&
        input.args.includes("status") &&
        ++shudStatusReads === 1
      ) {
        await writeFile(join(fixture.repositories.SHUD, "drift.txt"), "drift\n");
      }
      return { stdout };
    };

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
      code: "collection_state_changed",
      message: "StackLock context collection failed."
    });
  });

  test("does not modify repository HEAD, index, status, or tracked bytes", async () => {
    const fixture = await createFixture();
    const before = await observeFixture(fixture);
    const result = await collectStackLockContext({ repositoryRoot: fixture.root });
    expect(Object.values(result.repos).every((repo) => repo.dirty === false)).toBe(true);
    expect(await observeFixture(fixture)).toEqual(before);
  });

  test("rejects a repository path replaced by a symlink without reading or modifying the target", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const original = fixture.repositories.SHUD;
    const displaced = join(dirname(fixture.root), "outside-shud");
    await rename(original, displaced);
    await symlink(displaced, original, "dir");
    const before = await readFile(join(displaced, "tracked.txt"), "utf8");

    await expect(collectStackLockContext({ repositoryRoot: fixture.root })).rejects.toMatchObject({
      name: "StackLockCollectionError",
      code: "collection_contract_invalid"
    });
    expect(await readFile(join(displaced, "tracked.txt"), "utf8")).toBe(before);
  });
});

interface Fixture {
  root: string;
  repositories: Record<RepositoryName, string>;
  gitlinks: Record<RepositoryName, string>;
}

async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "stack-lock-dirty-")));
  tempRoots.push(root);
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
    git(repository, ["branch", "-M", name === "zero" ? "development" : "master"]);
    gitlinks[name] = git(repository, ["rev-parse", "HEAD"]).trim();
  }

  await writeFile(
    join(root, ".gitmodules"),
    REPOSITORIES.map((name) => [
      `[submodule "${name}"]`,
      `\tpath = ${name}`,
      `\turl = https://example.invalid/${name}.git`,
      `\tbranch = ${name === "zero" ? "development" : "master"}`
    ].join("\n")).join("\n") + "\n"
  );
  git(root, ["init", "--quiet"]);
  configureGit(root);
  git(root, ["add", "package.json", "config/providers/glm.dmxapi.json", ".gitmodules"]);
  for (const name of REPOSITORIES) {
    git(root, ["update-index", "--add", "--cacheinfo", `160000,${gitlinks[name]},${name}`]);
  }
  git(root, ["commit", "--quiet", "--message", "superproject fixture"]);
  return { root, repositories, gitlinks };
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

async function observeFixture(fixture: Fixture): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    superHead: git(fixture.root, ["rev-parse", "HEAD"]),
    superStatus: git(fixture.root, ["status", "--porcelain=v1", "--ignore-submodules=none"]),
    superIndex: (await readFile(join(fixture.root, ".git", "index"))).toString("base64")
  };
  for (const name of REPOSITORIES) {
    const repository = fixture.repositories[name];
    result[name] = {
      head: git(repository, ["rev-parse", "HEAD"]),
      status: git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
      index: (await readFile(join(repository, ".git", "index"))).toString("base64"),
      tracked: await readFile(join(repository, "tracked.txt"), "utf8")
    };
  }
  return result;
}
