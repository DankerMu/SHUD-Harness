import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
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
import { setTimeout as delay } from "node:timers/promises";
import {
  collectStackLockContext,
  type StackLockCollectionResult,
  type StackLockGitCommand,
  type StackLockGitCommandInput,
  type StackLockGitCommandResult
} from "./index";
import {
  __collectStackLockContextWithHasherForTest,
  __resolveRepositoryCheckoutAuthorityForTest
} from "./stack-lock-collector";
import { hashFile } from "./hashing-service";

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
        detached: false,
        dirty: false
      }));
      expect(result.repos[repositoryName].commit).not.toBe(oldPin);
    }
  );

  test("keeps an attached branch literally named detached attached", async () => {
    const fixture = await createFixture();
    git(fixture.repositories.SHUD, ["branch", "-M", "detached"]);

    const attached = await collectStackLockContext({ repositoryRoot: fixture.root });
    expect(attached.repos.SHUD).toMatchObject({ branch: "detached", detached: false });
  }, { timeout: 30_000 });

  test("records a real detached HEAD with the explicit detached discriminator", async () => {
    const fixture = await createFixture();

    git(fixture.repositories.SHUD, ["checkout", "--quiet", "--detach", "HEAD"]);
    const detached = await collectStackLockContext({ repositoryRoot: fixture.root });
    expect(detached.repos.SHUD).toMatchObject({ branch: "detached", detached: true });
  }, { timeout: 30_000 });

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

  test("marks a staged tracked modification dirty", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repositories.SHUD, "tracked.txt"), "staged modification\n");
    git(fixture.repositories.SHUD, ["add", "tracked.txt"]);

    const result = await collectStackLockContext({ repositoryRoot: fixture.root });

    expect(result.repos.SHUD.dirty).toBe(true);
  });

  test.each(REPOSITORIES)(
    "uses the explicit detached label for %s while every sibling remains exact and clean",
    async (repositoryName) => {
      const fixture = await createFixture();
      git(fixture.repositories[repositoryName], ["checkout", "--quiet", "--detach", "HEAD"]);

      const result = await collectStackLockContext({ repositoryRoot: fixture.root });
      expect(result.repos).toEqual(withRepositoryRevision(fixture, repositoryName, {
        ...cleanRepositoryRevisions(fixture)[repositoryName],
        branch: "detached",
        detached: true
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
        ++shudStatusReads === 2
      ) {
        await writeFile(join(fixture.repositories.SHUD, "drift.txt"), "drift\n");
      }
      return result;
    };

    await expectCollectorFailure(fixture, gitCommand, "collection_state_changed");
  });

  test.each(["commit", "branch"] as const)(
    "fails the publication barrier on independent %s-only drift after the second snapshot",
    async (driftKind) => {
      const fixture = await createFixture();
      let shudStatusReads = 0;
      const gitCommand: StackLockGitCommand = async (input) => {
        const result = runFixtureGitCommand(input);
        if (
          input.cwd === fixture.repositories.SHUD &&
          isStatusCommand(input.args) &&
          ++shudStatusReads === 4
        ) {
          if (driftKind === "commit") {
            await writeFile(join(fixture.repositories.SHUD, "tracked.txt"), "commit-only drift\n");
            git(fixture.repositories.SHUD, ["add", "tracked.txt"]);
            git(fixture.repositories.SHUD, ["commit", "--quiet", "--message", "publication drift"]);
          } else {
            git(fixture.repositories.SHUD, ["branch", "-M", "publication-only"]);
          }
        }
        return result;
      };

      await expectCollectorFailure(fixture, gitCommand, "collection_state_changed");
    }
  );

  test("fails the publication barrier when dirty state changes during the second renv hash", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "renv.lock"), "{}\n");
    let hashCalls = 0;
    let collection: Awaited<ReturnType<typeof collectStackLockContext>> | undefined;
    let thrown: unknown;
    try {
      collection = await __collectStackLockContextWithHasherForTest(
        { repositoryRoot: fixture.root },
        async (input) => {
          const digest = await hashFile(input);
          if (++hashCalls === 2) {
            await writeFile(join(fixture.repositories.zero, "publication-dirty.txt"), "drift\n");
          }
          return digest;
        }
      );
    } catch (error) {
      thrown = error;
    }
    expect(collection).toBeUndefined();
    expect(hashCalls).toBe(2);
    expect(thrown).toMatchObject({ code: "collection_state_changed" });
  });

  test.each(
    REPOSITORIES.slice(0, -1).flatMap((repositoryName, index) =>
      (["dirty", "commit", "branch", "identity"] as const).map((driftKind) => [
        repositoryName,
        driftKind,
        REPOSITORIES[index + 1]!
      ] as const)
    )
  )(
    "rejects first-sweep %s %s drift when its next sibling %s starts and the second sweep or final identity observes it",
    async (repositoryName, driftKind, nextRepositoryName) => {
      const fixture = await createFixture();
      const repository = fixture.repositories[repositoryName];
      let statusReads = 0;
      let drifted = false;
      const gitCommand: StackLockGitCommand = async (input) => {
        if (input.cwd === repository && isStatusCommand(input.args)) statusReads += 1;
        if (
          !drifted &&
          statusReads === 6 &&
          input.cwd === fixture.repositories[nextRepositoryName] &&
          isHeadCommand(input.args)
        ) {
          drifted = true;
          if (driftKind === "dirty") {
            await writeFile(join(repository, "publication-window.txt"), "dirty\n");
          } else if (driftKind === "commit") {
            await writeFile(join(repository, "tracked.txt"), "next sibling commit drift\n");
            git(repository, ["add", "tracked.txt"]);
            git(repository, ["commit", "--quiet", "--message", "next sibling drift"]);
          } else if (driftKind === "branch") {
            git(repository, ["branch", "-M", "next-sibling-drift"]);
          } else {
            await rename(repository, join(fixture.container, `displaced-${repositoryName}`));
            await mkdir(repository);
          }
        }
        return runFixtureGitCommand(input);
      };

      await expectCollectorFailure(fixture, gitCommand, "collection_state_changed");
      expect(drifted).toBe(true);
    }
  );

  test.each(
    REPOSITORIES.slice(0, -1).flatMap((repositoryName) =>
      (["dirty", "commit", "branch"] as const).map((driftKind) => [
        repositoryName,
        driftKind
      ] as const)
    )
  )(
    "documents the public exclusion when %s %s mutates after its second-sweep final logical observation",
    async (repositoryName, driftKind) => {
      const fixture = await createFixture();
      const repository = fixture.repositories[repositoryName];
      let statusReads = 0;
      let drifted = false;
      const gitCommand: StackLockGitCommand = async (input) => {
        const result = runFixtureGitCommand(input);
        if (
          !drifted &&
          input.cwd === repository &&
          isStatusCommand(input.args) &&
          ++statusReads === 8
        ) {
          drifted = true;
          if (driftKind === "dirty") {
            await writeFile(join(repository, "post-final-observation.txt"), "dirty\n");
          } else if (driftKind === "commit") {
            await writeFile(join(repository, "tracked.txt"), "post-final commit\n");
            git(repository, ["add", "tracked.txt"]);
            git(repository, ["commit", "--quiet", "--message", "post-final observation"]);
          } else {
            git(repository, ["branch", "-M", "post-final-observation"]);
          }
        }
        return result;
      };

      const result = await collectStackLockContext({ repositoryRoot: fixture.root, gitCommand });

      expect(drifted).toBe(true);
      expect(statusReads).toBe(8);
      expect(result.repos[repositoryName]).toEqual(cleanRepositoryRevisions(fixture)[repositoryName]);
    }
  );

  test("settles repository collection serially and never dispatches a later checkout after failure", async () => {
    const fixture = await createFixture();
    const checkoutCalls: string[] = [];
    const gitCommand: StackLockGitCommand = async (input) => {
      if (REPOSITORIES.some((name) => input.cwd === fixture.repositories[name])) {
        checkoutCalls.push(input.cwd);
      }
      if (input.cwd === fixture.repositories.SHUD && isHeadCommand(input.args)) {
        throw new Error("first checkout failed");
      }
      return runFixtureGitCommand(input);
    };

    await expectCollectorFailure(fixture, gitCommand, "git_read_failed");
    expect(checkoutCalls.every((cwd) => cwd === fixture.repositories.SHUD)).toBe(true);
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

  test("rejects a symlink checkout before any checkout realpath observation", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const checkout = fixture.repositories.SHUD;
    const target = join(fixture.container, "no-follow-target");
    await rename(checkout, target);
    await symlink(target, checkout, "dir");
    let realpathCalls = 0;

    await expect(
      __resolveRepositoryCheckoutAuthorityForTest(fixture.root, "SHUD", {
        realpathCheckoutPath: async (path) => {
          realpathCalls += 1;
          return await realpath(path);
        }
      })
    ).rejects.toMatchObject({ code: "collection_contract_invalid" });
    expect(realpathCalls).toBe(0);
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
  }, { timeout: 30_000 });

  test("a transient checkout swap cannot redirect a Git producer to the replacement target", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const checkout = fixture.repositories.SHUD;
    const displaced = join(fixture.container, "displaced-shud");
    const target = join(fixture.container, "replacement-target");
    await mkdir(target);
    git(target, ["init", "--quiet"]);
    configureGit(target);
    await writeFile(join(target, "tracked.txt"), "target\n");
    git(target, ["add", "tracked.txt"]);
    git(target, ["commit", "--quiet", "--message", "target"]);
    await writeFile(join(target, "target-only-untracked.txt"), "must not be observed\n");

    const wrapperRoot = join(fixture.container, "git-wrapper");
    await mkdir(wrapperRoot);
    const wrapper = join(wrapperRoot, "git");
    const ready = join(wrapperRoot, "ready");
    const release = join(wrapperRoot, "release");
    const done = join(wrapperRoot, "done");
    const restored = join(wrapperRoot, "restored");
    const once = join(wrapperRoot, "once");
    const output = join(wrapperRoot, "output");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await writeFile(wrapper, `#!/bin/sh
is_status=false
for arg in "$@"; do
  if [ "$arg" = "status" ]; then is_status=true; fi
done
if [ "$is_status" = "true" ] && [ ! -e ${shellQuote(once)} ]; then
  : > ${shellQuote(once)}
  : > ${shellQuote(ready)}
  while [ ! -e ${shellQuote(release)} ]; do sleep 0.01; done
  ${shellQuote(realGit)} "$@" > ${shellQuote(output)}
  status=$?
  : > ${shellQuote(done)}
  while [ ! -e ${shellQuote(restored)} ]; do sleep 0.01; done
  cat ${shellQuote(output)}
  exit "$status"
fi
exec ${shellQuote(realGit)} "$@"
`);
    await chmod(wrapper, 0o700);
    const previousPath = env.PATH;
    env.PATH = `${wrapperRoot}:${previousPath ?? ""}`;
    let pending: Promise<StackLockCollectionResult> | undefined;
    let restoredCheckout = false;
    try {
      pending = collectStackLockContext({ repositoryRoot: fixture.root });
      await waitForPath(ready);
      await rename(checkout, displaced);
      await symlink(target, checkout, "dir");
      await writeFile(release, "release\n");
      await waitForPath(done);
      await rm(checkout);
      await rename(displaced, checkout);
      restoredCheckout = true;
      await writeFile(restored, "restored\n");

      const result = await pending;
      expect(result.repos.SHUD.dirty).toBe(false);
    } finally {
      await writeFile(release, "release\n").catch(() => undefined);
      if (!restoredCheckout) {
        await rm(checkout, { recursive: true, force: true }).catch(() => undefined);
        await rename(displaced, checkout).catch(() => undefined);
      }
      await writeFile(restored, "restored\n").catch(() => undefined);
      await pending?.catch(() => undefined);
      if (previousPath === undefined) delete env.PATH;
      else env.PATH = previousPath;
    }
  }, { timeout: 30_000 });

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

  test("disables a real repo-local fsmonitor command while collecting status", async () => {
    const fixture = await createFixture();
    const marker = join(fixture.container, "fsmonitor-ran");
    const hook = join(fixture.container, "fsmonitor-hook");
    await writeFile(hook, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
    await chmod(hook, 0o700);
    git(fixture.repositories.SHUD, ["config", "core.fsmonitor", hook]);

    const result = await collectStackLockContext({ repositoryRoot: fixture.root });

    expect(result.repos.SHUD.dirty).toBe(false);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["clean", "process"] as const)(
    "rejects a real repo-local filter.%s command before status can execute it",
    async (filterKind) => {
      const fixture = await createFixture();
      const marker = join(fixture.container, `${filterKind}-filter-ran`);
      const helper = join(fixture.container, `${filterKind}-filter-helper`);
      await writeFile(helper, `#!/bin/sh\n: > ${JSON.stringify(marker)}\ncat\n`);
      await chmod(helper, 0o700);
      await writeFile(join(fixture.repositories.SHUD, ".gitattributes"), "tracked.txt filter=attack\n");
      git(fixture.repositories.SHUD, ["add", ".gitattributes"]);
      git(fixture.repositories.SHUD, ["commit", "--quiet", "--message", "configure attributes"]);
      if (filterKind === "clean") {
        git(fixture.repositories.SHUD, ["config", "filter.attack.clean", helper]);
      } else {
        const includedConfig = join(fixture.container, "included-filter-config");
        await writeFile(
          includedConfig,
          `[filter "attack"]\n\tprocess = ${helper}\n`
        );
        git(fixture.repositories.SHUD, ["config", "include.path", includedConfig]);
      }
      await writeFile(join(fixture.repositories.SHUD, "tracked.txt"), "would execute helper\n");

      await expectCollectorFailure(fixture, undefined, "collection_contract_invalid");
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  test("does not execute a filter injected after audit and before dirty observation", async () => {
    const fixture = await createFixture();
    const repository = fixture.repositories.SHUD;
    const marker = join(fixture.container, "post-audit-filter-ran");
    const helper = join(fixture.container, "post-audit-filter-helper");
    await writeFile(helper, `#!/bin/sh\n: > ${JSON.stringify(marker)}\ncat\n`);
    await chmod(helper, 0o700);
    await writeFile(join(repository, ".gitattributes"), "tracked.txt filter=attack\n");
    git(repository, ["add", ".gitattributes"]);
    git(repository, ["commit", "--quiet", "--message", "configure attributes"]);
    await writeFile(join(repository, "tracked.txt"), "would execute injected helper\n");
    let injected = false;

    const thrown = await expectCollectorFailureWithHooks(
      fixture,
      {
        afterRepositoryDirtyAudit: async (path) => {
          if (!injected && path === repository) {
            injected = true;
            git(repository, ["config", "filter.attack.clean", helper]);
          }
        }
      },
      "collection_contract_invalid"
    );

    expect(injected).toBe(true);
    assertNonDisclosing(thrown, fixture.root);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    ["main", "clean"],
    ["main", "process"],
    ["linked", "clean"],
    ["linked", "process"],
    ["nested", "clean"],
    ["nested", "process"]
  ] as const)(
    "rejects a real %s checkout worktree-config filter.%s including included config before observation",
    async (scope, filterKind) => {
      const fixture = await createFixture();
      let repository: string;
      if (scope === "linked") {
        repository = await replaceWithLinkedCheckout(fixture, "SHUD");
      } else if (scope === "nested") {
        repository = await addNestedSubmodule(fixture, "nested-worktree-config");
      } else {
        repository = fixture.repositories.SHUD;
      }
      const marker = join(fixture.container, `${scope}-${filterKind}-worktree-filter-ran`);
      const helper = join(fixture.container, `${scope}-${filterKind}-worktree-filter-helper`);
      await writeFile(helper, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`);
      await chmod(helper, 0o700);
      await writeFile(join(repository, ".gitattributes"), "tracked.txt filter=attack\n");
      git(repository, ["add", ".gitattributes"]);
      git(repository, ["commit", "--quiet", "--message", "configure worktree filter"]);
      git(repository, ["config", "extensions.worktreeConfig", "true"]);
      if (filterKind === "clean") {
        git(repository, ["config", "--worktree", "filter.attack.clean", helper]);
      } else {
        const includedConfig = join(fixture.container, `${scope}-included-worktree-filter-config`);
        await writeFile(includedConfig, `[filter "attack"]\n\tprocess = ${helper}\n`);
        git(repository, ["config", "--worktree", "include.path", includedConfig]);
      }
      await writeFile(join(repository, "tracked.txt"), "would execute worktree helper\n");

      await expectCollectorFailure(fixture, undefined, "collection_contract_invalid");
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  test("rejects a nested submodule process filter before parent status can execute it", async () => {
    const fixture = await createFixture();
    const nestedSource = join(fixture.container, "filter-nested-source");
    await mkdir(nestedSource);
    git(nestedSource, ["init", "--quiet"]);
    configureGit(nestedSource);
    await writeFile(join(nestedSource, "tracked.txt"), "nested\n");
    git(nestedSource, ["add", "tracked.txt"]);
    git(nestedSource, ["commit", "--quiet", "--message", "nested initial"]);
    git(fixture.repositories.SHUD, [
      "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", nestedSource, "nested"
    ]);
    git(fixture.repositories.SHUD, ["commit", "--quiet", "-am", "add nested submodule"]);
    const nested = join(fixture.repositories.SHUD, "nested");
    const marker = join(fixture.container, "nested-process-filter-ran");
    const helper = join(fixture.container, "nested-process-filter-helper");
    await writeFile(helper, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`);
    await chmod(helper, 0o700);
    await writeFile(join(nested, ".gitattributes"), "tracked.txt filter=attack\n");
    git(nested, ["add", ".gitattributes"]);
    git(nested, ["commit", "--quiet", "-m", "nested attributes"]);
    git(nested, ["config", "filter.attack.process", helper]);
    await writeFile(join(nested, "tracked.txt"), "would run\n");

    await expectCollectorFailure(fixture, undefined, "collection_contract_invalid");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports a modified nested submodule dirty despite repo-local ignore=all", async () => {
    const fixture = await createFixture();
    const nestedSource = join(fixture.container, "nested-source");
    await mkdir(nestedSource);
    git(nestedSource, ["init", "--quiet"]);
    configureGit(nestedSource);
    await writeFile(join(nestedSource, "tracked.txt"), "nested\n");
    git(nestedSource, ["add", "tracked.txt"]);
    git(nestedSource, ["commit", "--quiet", "--message", "nested initial"]);
    git(fixture.repositories.SHUD, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      nestedSource,
      "nested"
    ]);
    git(fixture.repositories.SHUD, ["commit", "--quiet", "-am", "add nested submodule"]);
    git(fixture.repositories.SHUD, ["config", "submodule.nested.ignore", "all"]);
    await writeFile(join(fixture.repositories.SHUD, "nested", "tracked.txt"), "nested changed\n");

    const result = await collectStackLockContext({ repositoryRoot: fixture.root });

    expect(result.repos.SHUD.dirty).toBe(true);
  });

  test("keeps a clean nested checkout clean and disables its repo-local fsmonitor", async () => {
    const fixture = await createFixture();
    const nested = await addNestedSubmodule(fixture, "nested-clean-fsmonitor");
    const marker = join(fixture.container, "nested-fsmonitor-ran");
    const hook = join(fixture.container, "nested-fsmonitor-hook");
    await writeFile(hook, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
    await chmod(hook, 0o700);
    git(nested, ["config", "core.fsmonitor", hook]);

    const result = await collectStackLockContext({ repositoryRoot: fixture.root });

    expect(result.repos.SHUD.dirty).toBe(false);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    ["LF", "nested\nline"],
    ["U+2028", "nested\u2028line"],
    ["U+2029", "nested\u2029line"]
  ] as const)("preserves a %s pathname in a stage-0 gitlink for recursive filter rejection", async (_label, nestedPath) => {
    const fixture = await createFixture();
    const nested = await addNestedGitlink(fixture, nestedPath);
    const marker = join(fixture.container, `${_label}-gitlink-helper-ran`);
    const helper = join(fixture.container, `${_label}-gitlink-helper`);
    await writeFile(helper, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`);
    await chmod(helper, 0o700);
    await writeFile(join(nested, ".gitattributes"), "tracked.txt filter=attack\n");
    git(nested, ["add", ".gitattributes"]);
    git(nested, ["commit", "--quiet", "--message", "nested attributes"]);
    git(nested, ["config", "filter.attack.clean", helper]);
    await writeFile(join(nested, "tracked.txt"), "nested changed\n");

    await expectCollectorFailure(fixture, undefined, "collection_contract_invalid");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([1, 2, 3] as const)(
    "rejects a stage-%i gitlink conflict before any status or nested helper can execute",
    async (stage) => {
      const fixture = await createFixture();
      const nested = await addNestedSubmodule(fixture, "conflicted-gitlink");
      const marker = join(fixture.container, `stage-${stage}-nested-helper-ran`);
      const helper = join(fixture.container, `stage-${stage}-nested-helper`);
      await writeFile(helper, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`);
      await chmod(helper, 0o700);
      git(nested, ["config", "filter.attack.clean", helper]);
      git(fixture.repositories.SHUD, ["update-index", "--force-remove", "--", "conflicted-gitlink"]);
      gitWithInput(
        fixture.repositories.SHUD,
        ["update-index", "--index-info"],
        `160000 ${git(nested, ["rev-parse", "HEAD"]).trim()} ${stage}\tconflicted-gitlink\n`
      );
      let statusReads = 0;
      const gitCommand: StackLockGitCommand = async (input) => {
        if (input.cwd === fixture.repositories.SHUD && isStatusCommand(input.args)) {
          statusReads += 1;
        }
        return runFixtureGitCommand(input);
      };

      await expectCollectorFailure(fixture, gitCommand, "collection_contract_invalid");
      expect(statusReads).toBe(0);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  test.each([
    ["unknown stage", "160000 1111111111111111111111111111111111111111 4\tnested\0", "git_output_invalid"],
    ["malformed header", "160000 1111111111111111111111111111111111111111 0 nested\0", "git_output_invalid"]
  ] as const)("fails closed on a %s gitlink index record", async (_label, indexOutput, code) => {
    const fixture = await createFixture();
    let statusReads = 0;
    const gitCommand: StackLockGitCommand = async (input) => {
      if (input.cwd === fixture.repositories.SHUD && isIndexCommand(input.args)) {
        return { stdout: indexOutput };
      }
      if (input.cwd === fixture.repositories.SHUD && isStatusCommand(input.args)) statusReads += 1;
      return runFixtureGitCommand(input);
    };

    await expectCollectorFailure(fixture, gitCommand, code);
    expect(statusReads).toBe(0);
  });

  test("uses committed .gitmodules authority when the worktree file is dirty", async () => {
    const fixture = await createFixture();
    const worktreeOnly = (await readFile(join(fixture.root, ".gitmodules"), "utf8"))
      .replace("branch = master", "branch = worktree-only");
    await writeFile(join(fixture.root, ".gitmodules"), worktreeOnly);

    const result = await collectStackLockContext({ repositoryRoot: fixture.root });

    expect(result.repos).toEqual(cleanRepositoryRevisions(fixture));
    expect(git(fixture.root, ["status", "--porcelain=v1", "--", ".gitmodules"])).toContain(".gitmodules");
  });

  test("maps a real status output above 64 KiB to git_output_invalid", async () => {
    const fixture = await createFixture();
    const untracked = join(fixture.repositories.SHUD, "untracked");
    await mkdir(untracked);
    for (let index = 0; index < 700; index += 1) {
      await writeFile(join(untracked, `${index.toString().padStart(4, "0")}-${"x".repeat(100)}`), "x");
    }

    await expectCollectorFailure(fixture, undefined, "git_output_invalid");
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

function gitWithInput(root: string, args: string[], input: string): string {
  return execFileSync("git", args, {
    cwd: root,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
}

async function addNestedSubmodule(fixture: Fixture, nestedPath: string): Promise<string> {
  const nestedSource = join(fixture.container, `nested-source-${Date.now()}-${Math.random()}`);
  await mkdir(nestedSource);
  git(nestedSource, ["init", "--quiet"]);
  configureGit(nestedSource);
  await writeFile(join(nestedSource, "tracked.txt"), "nested\n");
  git(nestedSource, ["add", "tracked.txt"]);
  git(nestedSource, ["commit", "--quiet", "--message", "nested initial"]);
  git(fixture.repositories.SHUD, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    nestedSource,
    nestedPath
  ]);
  git(fixture.repositories.SHUD, ["commit", "--quiet", "-am", "add nested submodule"]);
  return join(fixture.repositories.SHUD, nestedPath);
}

async function addNestedGitlink(fixture: Fixture, nestedPath: string): Promise<string> {
  const nested = join(fixture.repositories.SHUD, nestedPath);
  await mkdir(nested);
  git(nested, ["init", "--quiet"]);
  configureGit(nested);
  await writeFile(join(nested, "tracked.txt"), "nested\n");
  git(nested, ["add", "tracked.txt"]);
  git(nested, ["commit", "--quiet", "--message", "nested initial"]);
  git(fixture.repositories.SHUD, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${git(nested, ["rev-parse", "HEAD"]).trim()},${nestedPath}`
  ]);
  git(fixture.repositories.SHUD, ["commit", "--quiet", "--message", "add nested gitlink"]);
  return nested;
}

async function replaceWithLinkedCheckout(
  fixture: Fixture,
  repositoryName: RepositoryName
): Promise<string> {
  const checkout = fixture.repositories[repositoryName];
  const main = join(fixture.container, `${repositoryName}-main-worktree`);
  await rename(checkout, main);
  git(main, ["worktree", "add", "--quiet", "--detach", checkout, "HEAD"]);
  return checkout;
}

function runFixtureGitCommand(input: StackLockGitCommandInput): StackLockGitCommandResult {
  return {
    stdout: execFileSync("git", [...input.args], {
      cwd: input.cwd,
      encoding: "buffer",
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_LAZY_FETCH: "1",
        ...(input.gitObjectDirectory === undefined
          ? {}
          : { GIT_OBJECT_DIRECTORY: input.gitObjectDirectory })
      },
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
  return args.includes("status") && args.includes("--porcelain=v1");
}

function isIndexCommand(args: readonly string[]): boolean {
  return args.includes("ls-files") && args.includes("--stage") && args.includes("-z");
}

function cleanRepositoryRevisions(
  fixture: Fixture
): Record<RepositoryName, RepositoryRevision> {
  return Object.fromEntries(REPOSITORIES.map((name) => [
    name,
    {
      commit: fixture.gitlinks[name],
      branch: REPOSITORY_BRANCHES[name],
      detached: false,
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

async function expectCollectorFailureWithHooks(
  fixture: Fixture,
  hooks: Parameters<typeof __collectStackLockContextWithHasherForTest>[2],
  code: string
): Promise<Error> {
  let collection: Awaited<ReturnType<typeof collectStackLockContext>> | undefined;
  let thrown: unknown;
  try {
    collection = await __collectStackLockContextWithHasherForTest(
      { repositoryRoot: fixture.root },
      hashFile,
      hooks
    );
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

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Git wrapper readiness.");
    await delay(10);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
