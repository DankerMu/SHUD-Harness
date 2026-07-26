import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env } from "node:process";
import {
  STACK_LOCK_PARAMS_DIGEST,
  STACK_LOCK_PROMPT_PACK,
  STACK_LOCK_PROMPT_PACK_DIGEST,
  STACK_LOCK_RENV_MISSING,
  STACK_LOCK_SKILLS_VERSION,
  STACK_LOCK_UNKNOWN_VERSION,
  STACK_LOCK_ZERO_PIN,
  StackLockCollectionError,
  collectStackLockContext,
  type StackLockGitCommand,
  type StackLockGitCommandInput
} from "./index";
import {
  __runReadOnlyGitCommandForTest,
  type StackLockGitProcessExecutor
} from "./stack-lock-collector";

const tempRoots: string[] = [];
const SECRET_API_KEY = "super-secret-provider-value";
const SHAS = Object.freeze({
  SHUD: "1111111111111111111111111111111111111111",
  rSHUD: "2222222222222222222222222222222222222222",
  AutoSHUD: "3333333333333333333333333333333333333333",
  zero: STACK_LOCK_ZERO_PIN
});
const GITMODULES_OBJECT_ID = "4444444444444444444444444444444444444444";
const ALTERNATE_GITMODULES_OBJECT_ID = "5555555555555555555555555555555555555555";

describe("StackLock context collector", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("collects four gitlinks, explicit placeholders, provider identity, and missing-renv degradation", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const calls: StackLockGitCommandInput[] = [];
    const gitCommand = gitCommandWithRootIdentity(repositoryRoot, async () => {
      return { stdout: gitlinkOutput(["zero", "SHUD", "AutoSHUD", "rSHUD"]) };
    }, calls);

    const result = await collectStackLockContext({
      repositoryRoot,
      gitCommand
    });

    expect(calls).toHaveLength(6);
    expect(calls[0]).toEqual({
      cwd: resolve(repositoryRoot),
      args: ["--no-lazy-fetch", "rev-parse", "--show-toplevel"]
    });
    expect(calls[1]).toEqual({
      cwd: resolve(repositoryRoot),
      args: [
        "--no-lazy-fetch",
        "ls-tree",
        "-z",
        "--full-tree",
        "HEAD",
        "--",
        ".gitmodules",
        "SHUD",
        "rSHUD",
        "AutoSHUD",
        "zero"
      ]
    });
    expect(calls[2]).toEqual({
      cwd: resolve(repositoryRoot),
      args: ["--no-lazy-fetch", "cat-file", "blob", GITMODULES_OBJECT_ID]
    });
    expect(calls[3]).toEqual(calls[0]);
    expect(calls[4]).toEqual(calls[1]);
    expect(calls[5]).toEqual(calls[2]);
    expect(result.repos).toEqual({
      SHUD: { commit: SHAS.SHUD, branch: "master" },
      rSHUD: { commit: SHAS.rSHUD, branch: "master" },
      AutoSHUD: { commit: SHAS.AutoSHUD, branch: "master" },
      zero: { commit: SHAS.zero, branch: "development" }
    });
    expect(result.runtime).toEqual({
      os: `${platform()} ${release()}`,
      r_version: STACK_LOCK_UNKNOWN_VERSION,
      r_packages_lock: null,
      python_version: STACK_LOCK_UNKNOWN_VERSION,
      sundials_version: STACK_LOCK_UNKNOWN_VERSION,
      gcc_version: STACK_LOCK_UNKNOWN_VERSION,
      gdal_version: STACK_LOCK_UNKNOWN_VERSION
    });
    expect(result.harness).toEqual({
      version: "0.8.0",
      cli_version: STACK_LOCK_UNKNOWN_VERSION,
      prompt_pack: STACK_LOCK_PROMPT_PACK,
      skills_version: STACK_LOCK_SKILLS_VERSION
    });
    expect(result.llm).toEqual({
      provider: "glm-dmxapi",
      model_id: "glm-5.2",
      base_url: "https://www.dmxapi.cn/v1",
      params_digest: createHash("sha256").update("{}", "utf8").digest("hex"),
      prompt_pack_digest: createHash("sha256").update(Buffer.alloc(0)).digest("hex")
    });
    expect(result.llm.params_digest).toBe(STACK_LOCK_PARAMS_DIGEST);
    expect(result.llm.prompt_pack_digest).toBe(STACK_LOCK_PROMPT_PACK_DIGEST);
    expect(result.llm.params_digest).not.toBe(result.llm.prompt_pack_digest);
    expect(result.degraded).toEqual([STACK_LOCK_RENV_MISSING]);
    expect(JSON.stringify(result)).not.toContain(SECRET_API_KEY);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.repos.zero)).toBe(true);
    expect(Object.isFrozen(result.degraded)).toBe(true);
  });

  test("hashes an existing renv.lock through the shared file hashing service and is change-sensitive", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const lockPath = join(repositoryRoot, "renv.lock");
    await writeFile(lockPath, '{"R":{"Version":"4.4.1"}}\n');

    const first = await collectStackLockContext({ repositoryRoot, gitCommand: fakeGitCommand() });
    const firstOracle = createHash("sha256")
      .update('{"R":{"Version":"4.4.1"}}\n')
      .digest("hex");
    expect(first.runtime.r_packages_lock).toEqual({ path: "renv.lock", sha256: firstOracle });
    expect(first.degraded).toEqual([]);

    await writeFile(lockPath, '{"R":{"Version":"4.4.2"}}\n');
    const second = await collectStackLockContext({ repositoryRoot, gitCommand: fakeGitCommand() });
    expect(second.runtime.r_packages_lock?.sha256).toBe(
      createHash("sha256").update('{"R":{"Version":"4.4.2"}}\n').digest("hex")
    );
    expect(second.runtime.r_packages_lock?.sha256).not.toBe(firstOracle);
  });

  test("rejects malformed gitlink inventories before publishing partial collection output", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const malformed = gitCommandWithRootIdentity(repositoryRoot, async () => ({
      stdout: [
        `160000 commit ${SHAS.SHUD}\tSHUD\0`,
        `160000 commit ${SHAS.rSHUD}\trSHUD\0`,
        `100644 blob ${SHAS.AutoSHUD}\tAutoSHUD\0`,
        `160000 commit ${SHAS.zero}\tzero\0`
      ].join("")
    }));

    await expect(collectStackLockContext({ repositoryRoot, gitCommand: malformed })).rejects.toMatchObject({
      name: "StackLockCollectionError",
      code: "git_output_invalid",
      message: "StackLock context collection failed."
    });
  });

  test.each([
    ["missing", ["SHUD", "rSHUD", "zero"] as const],
    ["duplicate", ["SHUD", "rSHUD", "AutoSHUD", "zero", "zero"] as const]
  ])("rejects %s gitlink inventory entries", async (_label, order) => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    await expect(
      collectStackLockContext({
        repositoryRoot,
        gitCommand: gitCommandWithRootIdentity(
          repositoryRoot,
          async () => ({ stdout: gitlinkOutput([...order]) })
        )
      })
    ).rejects.toMatchObject({ code: "git_output_invalid" });
  });

  test("rejects a generation transition between collection and revalidation", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    let generation = 0;
    let collection: Awaited<ReturnType<typeof collectStackLockContext>> | undefined;
    const gitCommand = gitCommandWithRootIdentity(repositoryRoot, async () => {
      generation += 1;
      return {
        stdout:
          generation === 1
            ? gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"])
            : gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"], {
                SHUD: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
              })
      };
    });

    let thrown: unknown;
    try {
      collection = await collectStackLockContext({ repositoryRoot, gitCommand });
    } catch (error) {
      thrown = error;
    }

    expect(collection).toBeUndefined();
    expect(thrown).toMatchObject({
      code: "collection_state_changed",
      message: "StackLock context collection failed."
    });
  });

  test("rejects a byte-only package source transition at the revalidation barrier", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    let callCount = 0;
    const gitCommand = gitCommandWithRootIdentity(repositoryRoot, async () => {
      callCount += 1;
      if (callCount === 2) {
        writeFileSync(
          join(repositoryRoot, "package.json"),
          `${JSON.stringify({ name: "fixture", version: "0.8.0" })}\n`
        );
      }
      return { stdout: gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]) };
    });

    await expect(collectStackLockContext({ repositoryRoot, gitCommand })).rejects.toMatchObject({
      code: "collection_state_changed",
      message: "StackLock context collection failed."
    });
  });

  test("rejects provider byte-only drift even when its public projection is unchanged", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const providerPath = join(repositoryRoot, "config", "providers", "glm.dmxapi.json");
    let callCount = 0;
    const gitCommand = gitCommandWithRootIdentity(repositoryRoot, async () => {
      if (++callCount === 2) {
        writeFileSync(providerPath, `${JSON.stringify(providerConfigFixture())}\n`);
      }
      return { stdout: gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]) };
    });

    await expectStateChanged(repositoryRoot, gitCommand);
  });

  test("keeps an invalid second provider observation source-specific", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    let callCount = 0;
    const gitCommand = gitCommandWithRootIdentity(repositoryRoot, async () => {
      if (++callCount === 2) {
        writeFileSync(join(repositoryRoot, "config", "providers", "glm.dmxapi.json"), "{}\n");
      }
      return { stdout: gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]) };
    });

    await expect(collectStackLockContext({ repositoryRoot, gitCommand })).rejects.toMatchObject({
      code: "provider_config_invalid",
      message: "StackLock context collection failed."
    });
  });

  test.each([
    ["renv A to B", "present", "change"],
    ["renv missing to present", "missing", "create"],
    ["renv present to missing", "present", "remove"]
  ] as const)("rejects %s across the two-snapshot generation barrier", async (_label, initial, mutation) => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const lockPath = join(repositoryRoot, "renv.lock");
    if (initial === "present") await writeFile(lockPath, "generation-a\n");
    let callCount = 0;
    const gitCommand = gitCommandWithRootIdentity(repositoryRoot, async () => {
      if (++callCount === 2) {
        if (mutation === "remove") rmSync(lockPath);
        else writeFileSync(lockPath, mutation === "change" ? "generation-b\n" : "created\n");
      }
      return { stdout: gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]) };
    });

    await expectStateChanged(repositoryRoot, gitCommand);
  });

  test.each([
    ["byte-only", () => `${gitmodulesFixture()}# generation two\n`],
    ["branch-authority", () => gitmodulesFixture({ zero: { branch: "main" } })]
  ] as const)("rejects .gitmodules %s drift across the generation barrier", async (_label, changed) => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    let callCount = 0;
    const gitCommand = gitCommandWithRootIdentity(repositoryRoot, async () => {
      if (++callCount === 2) writeFileSync(join(repositoryRoot, ".gitmodules"), changed());
      return { stdout: gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]) };
    });

    await expectStateChanged(repositoryRoot, gitCommand);
  });

  test.each([
    ["missing declaration", () => gitmodulesFixture().replace(/\[submodule "zero"\][\s\S]*$/u, "")],
    ["duplicate declaration", () => `${gitmodulesFixture()}${gitmodulesFixture().split("[submodule \"rSHUD\"]")[0]}`],
    ["unknown declaration", () => gitmodulesFixture().replace('[submodule "zero"]', '[submodule "other"]')],
    ["mismatched path", () => gitmodulesFixture({ SHUD: { path: "other" } })],
    ["mismatched branch", () => gitmodulesFixture({ zero: { branch: "main" } })]
  ] as const)("rejects stable .gitmodules %s with a typed non-disclosing error", async (_label, content) => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    let collection: Awaited<ReturnType<typeof collectStackLockContext>> | undefined;
    let thrown: unknown;
    try {
      collection = await collectStackLockContext({
        repositoryRoot,
        gitCommand: fakeGitCommand(content())
      });
    } catch (error) {
      thrown = error;
    }
    expect(collection).toBeUndefined();
    expect(thrown).toMatchObject({
      code: "gitmodules_invalid",
      message: "StackLock context collection failed."
    });
    expect((thrown as Error).message).not.toContain(repositoryRoot);
  });

  test.each([
    ["missing", gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"], {}, null)],
    [
      "wrong-mode",
      gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]).replace(
        "100644 blob",
        "100755 blob"
      )
    ]
  ] as const)("rejects a %s HEAD .gitmodules inventory entry", async (_label, inventory) => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const gitCommand = gitCommandWithRootIdentity(repositoryRoot, async () => ({ stdout: inventory }));

    await expect(collectStackLockContext({ repositoryRoot, gitCommand })).rejects.toMatchObject({
      code: "gitmodules_invalid",
      message: "StackLock context collection failed."
    });
  });

  test.each([
    ["malformed", "[submodule \"SHUD\"]\npath = SHUD\n"],
    ["non-UTF-8", Buffer.from([0xff])]
  ] as const)("rejects a %s HEAD .gitmodules blob", async (_label, blob) => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const gitCommand: StackLockGitCommand = async (input) => {
      if (isTopLevelCommand(input)) return { stdout: `${await realpath(repositoryRoot)}\n` };
      if (isGitmodulesBlobCommand(input)) return { stdout: blob };
      return { stdout: gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]) };
    };

    await expect(collectStackLockContext({ repositoryRoot, gitCommand })).rejects.toMatchObject({
      code: "gitmodules_invalid",
      message: "StackLock context collection failed."
    });
  });

  test("accepts an exact 64 KiB HEAD .gitmodules blob and rejects the next byte", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const prefix = gitmodulesFixture();
    const exact = `${prefix}#${"x".repeat(64 * 1024 - Buffer.byteLength(prefix) - 2)}\n`;
    expect(Buffer.byteLength(exact)).toBe(64 * 1024);

    const accepted = await collectStackLockContext({
      repositoryRoot,
      gitCommand: fakeGitCommand(exact)
    });
    expect(accepted.repos.zero.branch).toBe("development");

    await expect(
      collectStackLockContext({
        repositoryRoot,
        gitCommand: fakeGitCommand(`${exact}x`)
      })
    ).rejects.toMatchObject({
      code: "gitmodules_invalid",
      message: "StackLock context collection failed."
    });
  });

  test("rejects an oversized HEAD authority inventory before reading its blob", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    let blobReads = 0;
    const gitCommand: StackLockGitCommand = async (input) => {
      if (isTopLevelCommand(input)) return { stdout: `${await realpath(repositoryRoot)}\n` };
      if (isGitmodulesBlobCommand(input)) {
        blobReads += 1;
        return { stdout: gitmodulesFixture() };
      }
      return { stdout: `${"x".repeat(64 * 1024)}\0` };
    };

    await expect(collectStackLockContext({ repositoryRoot, gitCommand })).rejects.toMatchObject({
      code: "git_output_invalid",
      message: "StackLock context collection failed."
    });
    expect(blobReads).toBe(0);
  });

  test("rejects a committed .gitmodules object generation transition", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    let inventoryReads = 0;
    const gitCommand: StackLockGitCommand = async (input) => {
      if (isTopLevelCommand(input)) return { stdout: `${await realpath(repositoryRoot)}\n` };
      if (isGitmodulesBlobCommand(input)) {
        return {
          stdout: input.args.at(-1) === GITMODULES_OBJECT_ID
            ? gitmodulesFixture()
            : `${gitmodulesFixture()}# committed generation two\n`
        };
      }
      inventoryReads += 1;
      return {
        stdout: gitlinkOutput(
          ["SHUD", "rSHUD", "AutoSHUD", "zero"],
          {},
          inventoryReads === 1 ? GITMODULES_OBJECT_ID : ALTERNATE_GITMODULES_OBJECT_ID
        )
      };
    };

    await expectStateChanged(repositoryRoot, gitCommand);
  });

  test.each([
    ["null", async () => null as never],
    [
      "throwing stdout getter",
      async () =>
        Object.defineProperty({}, "stdout", {
          get() {
            throw new Error("sensitive-getter-detail");
          }
        }) as never
    ]
  ])("maps injected git %s results to the stable output error", async (_label, gitCommand) => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    await expect(collectStackLockContext({ repositoryRoot, gitCommand })).rejects.toMatchObject({
      code: "git_output_invalid",
      message: "StackLock context collection failed."
    });
  });

  test("maps injected git process failures to a stable non-disclosing error without collection output", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const processDetail = "git-process-sensitive-detail";
    let collection: Awaited<ReturnType<typeof collectStackLockContext>> | undefined;
    let thrown: unknown;

    try {
      collection = await collectStackLockContext({
        repositoryRoot,
        gitCommand: async () => {
          throw new Error(processDetail);
        }
      });
    } catch (error) {
      thrown = error;
    }

    expect(collection).toBeUndefined();
    expect(thrown).toBeInstanceOf(StackLockCollectionError);
    expect(thrown).toMatchObject({
      code: "git_read_failed",
      message: "StackLock context collection failed."
    });
    expect((thrown as Error).message).not.toContain(processDetail);
    expect((thrown as Error).message).not.toContain(repositoryRoot);
  });

  test("fails closed on an old Git client before dispatching ls-tree or a remote operation", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    let lsTreeDispatched = false;
    let remoteDispatched = false;
    const calls: string[][] = [];

    await expect(
      collectStackLockContext({
        repositoryRoot,
        gitCommand: async (input) => {
          calls.push([...input.args]);
          if (input.args.includes("ls-tree")) lsTreeDispatched = true;
          if (input.args.includes("fetch") || input.args.includes("remote")) {
            remoteDispatched = true;
          }
          if (input.args[0] === "--no-lazy-fetch") {
            throw new Error("unknown option: --no-lazy-fetch");
          }
          return { stdout: "must-not-be-reached" };
        }
      })
    ).rejects.toMatchObject({
      code: "git_read_failed",
      message: "StackLock context collection failed."
    });

    expect(calls).toEqual([["--no-lazy-fetch", "rev-parse", "--show-toplevel"]]);
    expect(lsTreeDispatched).toBe(false);
    expect(remoteDispatched).toBe(false);
  });

  test("passes the no-lazy-fetch global option to the default Git process seam before its subcommand", async () => {
    let observedFile: string | undefined;
    let observedArgs: readonly string[] | undefined;
    await __runReadOnlyGitCommandForTest(
      {
        cwd: "/trusted/repo",
        args: ["--no-lazy-fetch", "rev-parse", "--show-toplevel"]
      },
      (file, args, _options, callback) => {
        observedFile = file;
        observedArgs = args;
        callback(null, "/trusted/repo\n", "");
      }
    );
    expect(observedFile).toBe("git");
    expect(observedArgs).toEqual(["--no-lazy-fetch", "rev-parse", "--show-toplevel"]);
  });

  test.each(["timeout", "maxBuffer"])(
    "maps default Git runner %s callback failures without disclosing process details",
    async (failureKind) => {
      const sensitiveDetail = `sensitive-${failureKind}-detail`;
      let observedOptions:
        | Parameters<StackLockGitProcessExecutor>[2]
        | undefined;
      const executor: StackLockGitProcessExecutor = (_file, _args, options, callback) => {
        observedOptions = options;
        const error = new Error(sensitiveDetail);
        Object.assign(error, {
          code: failureKind === "timeout" ? "ETIMEDOUT" : "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        });
        callback(error, `${sensitiveDetail}\0`, sensitiveDetail);
      };

      let thrown: unknown;
      try {
        await __runReadOnlyGitCommandForTest(
          { cwd: "/bounded-fixture", args: ["ls-tree", "HEAD"] },
          executor
        );
      } catch (error) {
        thrown = error;
      }

      expect(observedOptions).toMatchObject({
        encoding: null,
        timeout: 10_000,
        maxBuffer: 64 * 1024
      });
      expect(thrown).toMatchObject({
        code: "git_read_failed",
        message: "StackLock context collection failed."
      });
      expect((thrown as Error).message).not.toContain(sensitiveDetail);
    }
  );

  test("default Git wrapper derives a minimal non-secret child environment", async () => {
    const hostile = {
      GLM_API_KEY: "provider-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      HOME: "/attacker/home",
      XDG_CONFIG_HOME: "/attacker/xdg",
      SSH_AUTH_SOCK: "/attacker/agent",
      LD_PRELOAD: "/attacker/preload",
      DYLD_INSERT_LIBRARIES: "/attacker/dylib",
      GIT_DIR: "/attacker/repo",
      GIT_WORK_TREE: "/attacker/tree",
      GIT_COMMON_DIR: "/attacker/common",
      GIT_INDEX_FILE: "/attacker/index",
      GIT_OBJECT_DIRECTORY: "/attacker/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/attacker/alternates",
      GIT_CEILING_DIRECTORIES: "/",
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
      GIT_ICASE_PATHSPECS: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: "/attacker/tree",
      GIT_TRACE_REFS: "/attacker/refs.trace",
      GIT_TRACE_PACKFILE: "/attacker/pack.trace",
      GIT_TRACE2_EVENT_NESTING: "99"
    } as const;
    const previous = Object.fromEntries(
      Object.keys(hostile).map((key) => [key, env[key]])
    );
    let childEnvironment: NodeJS.ProcessEnv | undefined;

    try {
      Object.assign(env, hostile);
      await __runReadOnlyGitCommandForTest(
        { cwd: "/trusted/repo", args: ["ls-tree", "HEAD"] },
        (_file, _args, options, callback) => {
          childEnvironment = options.env;
          callback(null, gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]), "");
        }
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    }

    for (const key of Object.keys(hostile)) {
      expect(childEnvironment?.[key]).toBeUndefined();
    }
    expect(childEnvironment).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never"
    });
    expect(childEnvironment?.GIT_CONFIG_GLOBAL).toBeTruthy();
    expect(Object.keys(childEnvironment ?? {}).every((key) =>
      [
        "PATH", "Path", "LANG", "LC_ALL", "LC_CTYPE", "SystemRoot", "WINDIR",
        "ComSpec", "PATHEXT", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL",
        "GIT_NO_LAZY_FETCH", "GIT_NO_REPLACE_OBJECTS", "GIT_OPTIONAL_LOCKS",
        "GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE"
      ].includes(key)
    )).toBe(true);
  });

  test("rejects injected git stdout above 64 KiB without disclosing output or publishing collection", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const outputDetail = "oversized-git-output-sensitive-detail";
    let collection: Awaited<ReturnType<typeof collectStackLockContext>> | undefined;
    let thrown: unknown;

    try {
      collection = await collectStackLockContext({
        repositoryRoot,
        gitCommand: async () => ({ stdout: `${outputDetail}${"x".repeat(70_000)}\0` })
      });
    } catch (error) {
      thrown = error;
    }

    expect(collection).toBeUndefined();
    expect(thrown).toBeInstanceOf(StackLockCollectionError);
    expect(thrown).toMatchObject({
      code: "git_output_invalid",
      message: "StackLock context collection failed."
    });
    expect((thrown as Error).message).not.toContain(outputDetail);
    expect((thrown as Error).message).not.toContain(repositoryRoot);
  });

  test("rejects an oversized root package.json without disclosing its path or content", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const packageDetail = "oversized-package-sensitive-detail";
    await writeFile(
      join(repositoryRoot, "package.json"),
      JSON.stringify({ version: `${packageDetail}${"x".repeat(70_000)}` })
    );

    let thrown: unknown;
    try {
      await collectStackLockContext({ repositoryRoot, gitCommand: fakeGitCommand() });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StackLockCollectionError);
    expect(thrown).toMatchObject({
      code: "package_json_invalid",
      message: "StackLock context collection failed."
    });
    expect((thrown as Error).message).not.toContain(packageDetail);
    expect((thrown as Error).message).not.toContain(join(repositoryRoot, "package.json"));
  });

  test.each([
    ["missing", undefined],
    ["blank", "   "],
    ["non-string", 83]
  ])("rejects a %s canonical harness version", async (_label, version) => {
    const repositoryRoot = await createFixtureRepository({ version });
    await expect(
      collectStackLockContext({ repositoryRoot, gitCommand: fakeGitCommand() })
    ).rejects.toMatchObject({
      code: "package_json_invalid",
      message: "StackLock context collection failed."
    });
  });

  test("rejects oversized provider JSON without disclosing its path or content", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const providerDetail = "oversized-provider-sensitive-detail";
    const providerPath = join(repositoryRoot, "config", "providers", "glm.dmxapi.json");
    await writeFile(providerPath, JSON.stringify({ payload: `${providerDetail}${"y".repeat(70_000)}` }));

    let thrown: unknown;
    try {
      await collectStackLockContext({ repositoryRoot, gitCommand: fakeGitCommand() });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StackLockCollectionError);
    expect(thrown).toMatchObject({
      code: "provider_config_invalid",
      message: "StackLock context collection failed."
    });
    expect((thrown as Error).message).not.toContain(providerDetail);
    expect((thrown as Error).message).not.toContain(providerPath);
  });

  test("rejects unsafe provider identity without echoing config secrets or absolute paths", async () => {
    const repositoryRoot = await createFixtureRepository({
      version: "0.8.0",
      providerConfig: providerConfigFixture({
        baseUrl: `https://${SECRET_API_KEY}@www.dmxapi.cn/v1`
      })
    });

    let thrown: unknown;
    try {
      await collectStackLockContext({ repositoryRoot, gitCommand: fakeGitCommand() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StackLockCollectionError);
    expect((thrown as StackLockCollectionError).code).toBe("provider_config_invalid");
    expect((thrown as Error).message).not.toContain(SECRET_API_KEY);
    expect((thrown as Error).message).not.toContain(repositoryRoot);
  });

  test.each([
    [
      "selector provider drift",
      providerConfigFixture({ defaultModel: "other-provider/target" })
    ],
    ["selector model missing", providerConfigFixture({ defaultModel: "glm-dmxapi/missing" })],
    ["selector syntax drift", providerConfigFixture({ defaultModel: "glm-dmxapi/target/extra" })],
    ["target model id drift", providerConfigFixture({ targetModelId: "glm-other" })],
    ["nested model id drift", providerConfigFixture({ nestedModelId: "glm-other" })]
  ])("rejects provider %s without leaking config credentials", async (_label, providerConfig) => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0", providerConfig });
    let thrown: unknown;
    try {
      await collectStackLockContext({ repositoryRoot, gitCommand: fakeGitCommand() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "provider_config_invalid",
      message: "StackLock context collection failed."
    });
    expect((thrown as Error).message).not.toContain(SECRET_API_KEY);
  });

  test("rejects a symlink renv.lock without reading or modifying its target", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const outsidePath = join(await createTempRoot("shud-stack-outside-"), "outside.lock");
    await writeFile(outsidePath, "outside bytes\n");
    await symlink(outsidePath, join(repositoryRoot, "renv.lock"));

    await expect(
      collectStackLockContext({ repositoryRoot, gitCommand: fakeGitCommand() })
    ).rejects.toMatchObject({ code: "renv_lock_invalid" });
    expect(await readFile(outsidePath, "utf8")).toBe("outside bytes\n");
  });

  test("hashes an exact 16 MiB regular renv.lock against an independent SHA256 oracle", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const lockPath = join(repositoryRoot, "renv.lock");
    await writeFile(lockPath, "");
    await truncate(lockPath, 16 * 1024 * 1024);

    const result = await collectStackLockContext({
      repositoryRoot,
      gitCommand: fakeGitCommand()
    });

    expect(result.runtime.r_packages_lock).toEqual({
      path: "renv.lock",
      sha256: "080acf35a507ac9849cfcba47dc2ad83e01b75663a516279c8b9d243b719643e"
    });
    expect(result.degraded).toEqual([]);
  });

  test("maps the 16 MiB renv.lock descriptor bound to renv_lock_invalid", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const lockPath = join(repositoryRoot, "renv.lock");
    await writeFile(lockPath, "");
    await truncate(lockPath, 16 * 1024 * 1024 + 1);

    await expect(
      collectStackLockContext({ repositoryRoot, gitCommand: fakeGitCommand() })
    ).rejects.toMatchObject({
      code: "renv_lock_invalid",
      message: "StackLock context collection failed."
    });
  });

  test("does not start renv hashing when an earlier bounded producer fails", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    await writeFile(join(repositoryRoot, "renv.lock"), "must-not-be-hashed\n");
    let hashCalls = 0;
    const collectorInternals = await import("./stack-lock-collector");

    await expect(
      collectorInternals.__collectStackLockContextWithHasherForTest(
        {
          repositoryRoot,
          gitCommand: async () => {
            throw new Error("sensitive git failure");
          }
        },
        async () => {
          hashCalls += 1;
          throw new Error("hash should not start");
        }
      )
    ).rejects.toMatchObject({ code: "git_read_failed" });
    expect(hashCalls).toBe(0);
  });

  test("hostile inherited Git trace sinks are not created by real collection", async () => {
    const repositoryRoot = resolve(import.meta.dir, "../../../../..");
    const traceRoot = await createTempRoot("shud-stack-traces-");
    const refsTrace = join(traceRoot, "refs.trace");
    const packTrace = join(traceRoot, "pack.trace");
    const previous = {
      GIT_TRACE_REFS: env.GIT_TRACE_REFS,
      GIT_TRACE_PACKFILE: env.GIT_TRACE_PACKFILE,
      GIT_TRACE2_EVENT_NESTING: env.GIT_TRACE2_EVENT_NESTING
    };
    try {
      env.GIT_TRACE_REFS = refsTrace;
      env.GIT_TRACE_PACKFILE = packTrace;
      env.GIT_TRACE2_EVENT_NESTING = "99";
      await collectStackLockContext({ repositoryRoot });
    } finally {
      restoreEnvironment(previous);
    }

    await expect(access(refsTrace)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(packTrace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a local promisor fixture with a missing tree fails without lazy fetch or pack growth", async () => {
    const repositoryRoot = await createMissingTreePromisorFixture();
    const packDirectory = join(repositoryRoot, ".git", "objects", "pack");
    const beforePacks = (await readdir(packDirectory)).sort();

    await expect(collectStackLockContext({ repositoryRoot })).rejects.toMatchObject({
      code: "git_read_failed",
      message: "StackLock context collection failed."
    });
    expect((await readdir(packDirectory)).sort()).toEqual(beforePacks);
  });

  test("rejects a nested directory even when it contains a complete valid-looking collector fixture", async () => {
    const repositoryRoot = await createGitBackedFixtureRepository();
    const nestedRoot = join(repositoryRoot, "nested-fixture");
    await writeFixtureRepositoryFiles(nestedRoot, { version: "0.8.0" });
    let collection: Awaited<ReturnType<typeof collectStackLockContext>> | undefined;
    let thrown: unknown;

    try {
      collection = await collectStackLockContext({ repositoryRoot: nestedRoot });
    } catch (error) {
      thrown = error;
    }

    expect(collection).toBeUndefined();
    expect(thrown).toMatchObject({
      code: "repository_root_invalid",
      message: "StackLock context collection failed."
    });
    expect((thrown as Error).message).not.toContain(repositoryRoot);
    expect((thrown as Error).message).not.toContain(nestedRoot);
  });

  test("revalidates the physical repository top-level before the second cheap snapshot", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const changedRoot = await createTempRoot("shud-stack-changed-root-");
    let rootObservations = 0;
    let gitlinkReads = 0;
    let collection: Awaited<ReturnType<typeof collectStackLockContext>> | undefined;
    let thrown: unknown;

    try {
      collection = await collectStackLockContext({
        repositoryRoot,
        gitCommand: async (input) => {
          if (isTopLevelCommand(input)) {
            rootObservations += 1;
            return {
              stdout: `${rootObservations === 1 ? repositoryRoot : changedRoot}\n`
            };
          }
          if (isGitmodulesBlobCommand(input)) return { stdout: gitmodulesFixture() };
          gitlinkReads += 1;
          return { stdout: gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]) };
        }
      });
    } catch (error) {
      thrown = error;
    }

    expect(collection).toBeUndefined();
    expect(rootObservations).toBe(2);
    expect(gitlinkReads).toBe(1);
    expect(thrown).toMatchObject({
      code: "repository_root_invalid",
      message: "StackLock context collection failed."
    });
    expect((thrown as Error).message).not.toContain(changedRoot);
  });

  test("collects normally from a linked-worktree physical top-level", async () => {
    const repositoryRoot = await createGitBackedFixtureRepository();
    const linkedRoot = join(dirname(repositoryRoot), "linked-worktree");
    git(repositoryRoot, ["worktree", "add", "--quiet", "--detach", linkedRoot, "HEAD"]);

    const result = await collectStackLockContext({ repositoryRoot: linkedRoot });

    expect(result.repos).toEqual({
      SHUD: { commit: SHAS.SHUD, branch: "master" },
      rSHUD: { commit: SHAS.rSHUD, branch: "master" },
      AutoSHUD: { commit: SHAS.AutoSHUD, branch: "master" },
      zero: { commit: SHAS.zero, branch: "development" }
    });
    expect(result.harness.version).toBe("0.8.0");
  });

  test("derives branches from HEAD while a stable dirty worktree .gitmodules disagrees", async () => {
    const repositoryRoot = await createGitBackedFixtureRepository();
    await writeFile(
      join(repositoryRoot, ".gitmodules"),
      gitmodulesFixture({ zero: { branch: "worktree-only" } })
    );

    const result = await collectStackLockContext({ repositoryRoot });

    expect(result.repos.zero).toEqual({
      commit: STACK_LOCK_ZERO_PIN,
      branch: "development"
    });
    expect(git(repositoryRoot, ["status", "--porcelain=v1", "--", ".gitmodules"])).toContain(
      ".gitmodules"
    );
  });

  test("rejects an untracked canonical worktree .gitmodules when HEAD has no branch authority", async () => {
    const repositoryRoot = await createGitBackedFixtureRepository();
    git(repositoryRoot, ["rm", "--quiet", "--cached", ".gitmodules"]);
    git(repositoryRoot, ["commit", "--quiet", "--message", "remove committed branch authority"]);
    await writeFile(join(repositoryRoot, ".gitmodules"), gitmodulesFixture());

    await expect(collectStackLockContext({ repositoryRoot })).rejects.toMatchObject({
      code: "gitmodules_invalid",
      message: "StackLock context collection failed."
    });
  });

  test("rejects committed branch authority drift despite a stable canonical worktree .gitmodules", async () => {
    const repositoryRoot = await createGitBackedFixtureRepository();
    await writeFile(
      join(repositoryRoot, ".gitmodules"),
      gitmodulesFixture({ zero: { branch: "main" } })
    );
    git(repositoryRoot, ["add", ".gitmodules"]);
    git(repositoryRoot, ["commit", "--quiet", "--message", "change committed branch authority"]);
    await writeFile(join(repositoryRoot, ".gitmodules"), gitmodulesFixture());

    let collection: Awaited<ReturnType<typeof collectStackLockContext>> | undefined;
    let thrown: unknown;
    try {
      collection = await collectStackLockContext({ repositoryRoot });
    } catch (error) {
      thrown = error;
    }

    expect(collection).toBeUndefined();
    expect(thrown).toMatchObject({
      code: "gitmodules_invalid",
      message: "StackLock context collection failed."
    });
    expect((thrown as Error).message).not.toContain(repositoryRoot);
  });

  test("rejects a committed byte-only .gitmodules generation transition between snapshots", async () => {
    const repositoryRoot = await createGitBackedFixtureRepository();
    let rootReads = 0;
    const gitCommand: StackLockGitCommand = async (input) => {
      if (isTopLevelCommand(input) && ++rootReads === 2) {
        await writeFile(join(repositoryRoot, ".gitmodules"), `${gitmodulesFixture()}# generation two\n`);
        git(repositoryRoot, ["add", ".gitmodules"]);
        git(repositoryRoot, ["commit", "--quiet", "--message", "advance branch authority bytes"]);
      }
      return { stdout: git(input.cwd, [...input.args]) };
    };

    await expectStateChanged(repositoryRoot, gitCommand);
  });

  test("default git reader observes the real four gitlinks including the frozen zero pin without git mutation", async () => {
    const repositoryRoot = resolve(import.meta.dir, "../../../../..");
    const beforeHead = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const beforeStatus = git(repositoryRoot, ["status", "--porcelain=v1"]);
    const packageDocument = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };

    const previousGitDir = env.GIT_DIR;
    const previousGitWorkTree = env.GIT_WORK_TREE;
    let result: Awaited<ReturnType<typeof collectStackLockContext>>;
    try {
      env.GIT_DIR = join(repositoryRoot, ".hostile-missing-git-dir");
      env.GIT_WORK_TREE = join(repositoryRoot, ".hostile-missing-work-tree");
      result = await collectStackLockContext({ repositoryRoot });
    } finally {
      if (previousGitDir === undefined) delete env.GIT_DIR;
      else env.GIT_DIR = previousGitDir;
      if (previousGitWorkTree === undefined) delete env.GIT_WORK_TREE;
      else env.GIT_WORK_TREE = previousGitWorkTree;
    }

    for (const repositoryName of ["SHUD", "rSHUD", "AutoSHUD", "zero"] as const) {
      expect(result.repos[repositoryName].commit).toMatch(/^[0-9a-f]{40}$/u);
    }
    expect(Object.fromEntries(Object.entries(result.repos).map(([name, value]) => [name, value.branch])))
      .toEqual({ SHUD: "master", rSHUD: "master", AutoSHUD: "master", zero: "development" });
    expect(result.repos.zero.commit).toBe(STACK_LOCK_ZERO_PIN);
    expect(result.harness.version).toBe(packageDocument.version);
    expect(result.llm).toMatchObject({
      provider: "glm-dmxapi",
      model_id: "glm-5.2",
      base_url: "https://www.dmxapi.cn/v1"
    });
    expect(git(repositoryRoot, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(repositoryRoot, ["status", "--porcelain=v1"])).toBe(beforeStatus);
  });

  test("services barrel exposes the collector contract and production does not read API-key environment values", async () => {
    const serviceExports = await import("./index");
    expect(serviceExports.collectStackLockContext).toBe(collectStackLockContext);
    expect("__runReadOnlyGitCommandForTest" in serviceExports).toBe(false);
    expect("__collectStackLockContextWithHasherForTest" in serviceExports).toBe(false);
    const source = await readFile(join(import.meta.dir, "stack-lock-collector.ts"), "utf8");
    expect(source).not.toMatch(/process\.env|GLM_API_KEY|console\./u);
    expect(source).not.toMatch(/runtimeVersions/u);
  });
});

async function createFixtureRepository(input: {
  version?: unknown;
  providerConfig?: Record<string, unknown>;
}): Promise<string> {
  const repositoryRoot = await createTempRoot("shud-stack-collector-");
  await writeFixtureRepositoryFiles(repositoryRoot, input);
  return repositoryRoot;
}

async function writeFixtureRepositoryFiles(
  repositoryRoot: string,
  input: {
    version?: unknown;
    providerConfig?: Record<string, unknown>;
  }
): Promise<void> {
  await mkdir(join(repositoryRoot, "config", "providers"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "package.json"),
    `${JSON.stringify(
      { name: "fixture", ...(input.version !== undefined ? { version: input.version } : {}) },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(repositoryRoot, "config", "providers", "glm.dmxapi.json"),
    `${JSON.stringify(input.providerConfig ?? providerConfigFixture(), null, 2)}\n`
  );
  await writeFile(join(repositoryRoot, ".gitmodules"), gitmodulesFixture());
}

async function createGitBackedFixtureRepository(): Promise<string> {
  const container = await createTempRoot("shud-stack-git-root-");
  const repositoryRoot = join(container, "source");
  await writeFixtureRepositoryFiles(repositoryRoot, { version: "0.8.0" });
  git(repositoryRoot, ["init", "--quiet"]);
  git(repositoryRoot, ["config", "user.name", "StackLock Test"]);
  git(repositoryRoot, ["config", "user.email", "stack-lock@example.invalid"]);
  git(repositoryRoot, ["add", "package.json", "config/providers/glm.dmxapi.json", ".gitmodules"]);
  for (const name of ["SHUD", "rSHUD", "AutoSHUD", "zero"] as const) {
    git(repositoryRoot, ["update-index", "--add", "--cacheinfo", `160000,${SHAS[name]},${name}`]);
  }
  git(repositoryRoot, ["commit", "--quiet", "--message", "collector fixture"]);
  return await realpath(repositoryRoot);
}

function gitmodulesFixture(
  overrides: Partial<Record<keyof typeof SHAS, { path?: string; branch?: string }>> = {}
): string {
  return (["SHUD", "rSHUD", "AutoSHUD", "zero"] as const).map((name) => {
    const expectedBranch = name === "zero" ? "development" : "master";
    return [
      `[submodule "${name}"]`,
      `\tpath = ${overrides[name]?.path ?? name}`,
      `\turl = https://example.invalid/${name}.git`,
      `\tbranch = ${overrides[name]?.branch ?? expectedBranch}`
    ].join("\n");
  }).join("\n") + "\n";
}

function providerConfigFixture(
  input: {
    baseUrl?: string;
    defaultModel?: string;
    targetModelId?: string;
    nestedModelId?: string;
  } = {}
): Record<string, unknown> {
  return {
    schema_version: "m1.glm-provider.v1",
    default_provider: "glm-dmxapi",
    default_model: input.defaultModel ?? "glm-dmxapi/target",
    target_model_id: input.targetModelId ?? "glm-5.2",
    providers: {
      "glm-dmxapi": {
        api_type: "openai_chat_completions",
        base_url: input.baseUrl ?? "https://www.dmxapi.cn/v1",
        auth: {
          type: "api_key",
          api_key_ref: "env:GLM_API_KEY",
          api_key: SECRET_API_KEY
        },
        models: {
          target: {
            model_id: input.nestedModelId ?? "glm-5.2"
          }
        }
      }
    }
  };
}

function fakeGitCommand(gitmodulesContent = gitmodulesFixture()): StackLockGitCommand {
  return async (input) => {
    if (isTopLevelCommand(input)) return { stdout: `${await realpath(input.cwd)}\n` };
    if (isGitmodulesBlobCommand(input)) return { stdout: gitmodulesContent };
    return { stdout: gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]) };
  };
}

function gitCommandWithRootIdentity(
  repositoryRoot: string,
  collectGitlinks: StackLockGitCommand,
  calls?: StackLockGitCommandInput[]
): StackLockGitCommand {
  return async (input) => {
    calls?.push(input);
    if (isTopLevelCommand(input)) return { stdout: `${await realpath(repositoryRoot)}\n` };
    if (isGitmodulesBlobCommand(input)) {
      return { stdout: await readFile(join(repositoryRoot, ".gitmodules"), "utf8") };
    }
    return await collectGitlinks(input);
  };
}

function isTopLevelCommand(input: StackLockGitCommandInput): boolean {
  return JSON.stringify(input.args) === JSON.stringify([
    "--no-lazy-fetch",
    "rev-parse",
    "--show-toplevel"
  ]);
}

function isGitmodulesBlobCommand(input: StackLockGitCommandInput): boolean {
  return (
    input.args.length === 4 &&
    input.args[0] === "--no-lazy-fetch" &&
    input.args[1] === "cat-file" &&
    input.args[2] === "blob" &&
    /^[0-9a-f]{40}$/u.test(input.args[3] ?? "")
  );
}

function gitlinkOutput(
  order: ReadonlyArray<keyof typeof SHAS>,
  overrides: Partial<Record<keyof typeof SHAS, string>> = {},
  gitmodulesObjectId: string | null = GITMODULES_OBJECT_ID
): string {
  return [
    ...(gitmodulesObjectId === null
      ? []
      : [`100644 blob ${gitmodulesObjectId}\t.gitmodules\0`]),
    ...order
    .map((name) => `160000 commit ${overrides[name] ?? SHAS[name]}\t${name}\0`)
  ].join("");
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function expectStateChanged(
  repositoryRoot: string,
  gitCommand: StackLockGitCommand
): Promise<void> {
  let collection: Awaited<ReturnType<typeof collectStackLockContext>> | undefined;
  let thrown: unknown;
  try {
    collection = await collectStackLockContext({ repositoryRoot, gitCommand });
  } catch (error) {
    thrown = error;
  }
  expect(collection).toBeUndefined();
  expect(thrown).toMatchObject({
    code: "collection_state_changed",
    message: "StackLock context collection failed."
  });
  expect((thrown as Error).message).not.toContain(repositoryRoot);
  expect((thrown as Error).message).not.toContain(SECRET_API_KEY);
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

async function createMissingTreePromisorFixture(): Promise<string> {
  const root = await createTempRoot("shud-stack-promisor-");
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  await mkdir(join(source, "config", "providers"), { recursive: true });
  git(source, ["init", "--quiet"]);
  git(source, ["config", "user.name", "StackLock Test"]);
  git(source, ["config", "user.email", "stack-lock@example.invalid"]);
  await writeFile(join(source, "package.json"), '{"name":"fixture","version":"0.8.0"}\n');
  await writeFile(
    join(source, "config", "providers", "glm.dmxapi.json"),
    `${JSON.stringify(providerConfigFixture())}\n`
  );
  await writeFile(join(source, ".gitmodules"), gitmodulesFixture());
  git(source, ["add", "package.json", "config/providers/glm.dmxapi.json", ".gitmodules"]);
  for (const name of ["SHUD", "rSHUD", "AutoSHUD", "zero"] as const) {
    git(source, ["update-index", "--add", "--cacheinfo", `160000,${SHAS[name]},${name}`]);
  }
  git(source, ["commit", "--quiet", "--message", "promisor fixture"]);
  git(root, ["clone", "--quiet", "--bare", source, origin]);
  git(origin, ["config", "uploadpack.allowFilter", "true"]);
  git(root, ["clone", "--quiet", "--filter=tree:0", "--no-checkout", `file://${origin}`, clone]);

  await mkdir(join(clone, "config", "providers"), { recursive: true });
  await writeFile(join(clone, "package.json"), '{"name":"fixture","version":"0.8.0"}\n');
  await writeFile(
    join(clone, "config", "providers", "glm.dmxapi.json"),
    `${JSON.stringify(providerConfigFixture())}\n`
  );
  await writeFile(join(clone, ".gitmodules"), gitmodulesFixture());
  return clone;
}
