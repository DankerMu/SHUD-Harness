import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

describe("StackLock context collector", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("collects four gitlinks, explicit placeholders, provider identity, and missing-renv degradation", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    const calls: StackLockGitCommandInput[] = [];
    const gitCommand: StackLockGitCommand = async (input) => {
      calls.push(input);
      return { stdout: gitlinkOutput(["zero", "SHUD", "AutoSHUD", "rSHUD"]) };
    };

    const result = await collectStackLockContext({
      repositoryRoot,
      gitCommand
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      cwd: resolve(repositoryRoot),
      args: [
        "ls-tree",
        "-z",
        "--full-tree",
        "HEAD",
        "--",
        "SHUD",
        "rSHUD",
        "AutoSHUD",
        "zero"
      ]
    });
    expect(result.repos).toEqual({
      SHUD: { commit: SHAS.SHUD, branch: "master" },
      rSHUD: { commit: SHAS.rSHUD, branch: "master" },
      AutoSHUD: { commit: SHAS.AutoSHUD, branch: "master" },
      zero: { commit: SHAS.zero, branch: "main" }
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
    const malformed: StackLockGitCommand = async () => ({
      stdout: [
        `160000 commit ${SHAS.SHUD}\tSHUD\0`,
        `160000 commit ${SHAS.rSHUD}\trSHUD\0`,
        `100644 blob ${SHAS.AutoSHUD}\tAutoSHUD\0`,
        `160000 commit ${SHAS.zero}\tzero\0`
      ].join("")
    });

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
        gitCommand: async () => ({ stdout: gitlinkOutput([...order]) })
      })
    ).rejects.toMatchObject({ code: "git_output_invalid" });
  });

  test("rejects a generation transition between collection and revalidation", async () => {
    const repositoryRoot = await createFixtureRepository({ version: "0.8.0" });
    let generation = 0;
    let collection: Awaited<ReturnType<typeof collectStackLockContext>> | undefined;
    const gitCommand: StackLockGitCommand = async () => {
      generation += 1;
      return {
        stdout:
          generation === 1
            ? gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"])
            : gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"], {
                SHUD: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
              })
      };
    };

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
    const gitCommand: StackLockGitCommand = async () => {
      callCount += 1;
      if (callCount === 2) {
        writeFileSync(
          join(repositoryRoot, "package.json"),
          `${JSON.stringify({ name: "fixture", version: "0.8.0" })}\n`
        );
      }
      return { stdout: gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]) };
    };

    await expect(collectStackLockContext({ repositoryRoot, gitCommand })).rejects.toMatchObject({
      code: "collection_state_changed",
      message: "StackLock context collection failed."
    });
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

      expect(observedOptions).toMatchObject({ timeout: 10_000, maxBuffer: 64 * 1024 });
      expect(thrown).toMatchObject({
        code: "git_read_failed",
        message: "StackLock context collection failed."
      });
      expect((thrown as Error).message).not.toContain(sensitiveDetail);
    }
  );

  test("default Git wrapper removes inherited repository-authority environment", async () => {
    const hostile = {
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
      GIT_CONFIG_VALUE_0: "/attacker/tree"
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
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never"
    });
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
      expect(result.repos[repositoryName].branch.length).toBeGreaterThan(0);
    }
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
  return repositoryRoot;
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

function fakeGitCommand(): StackLockGitCommand {
  return async () => ({ stdout: gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]) });
}

function gitlinkOutput(
  order: ReadonlyArray<keyof typeof SHAS>,
  overrides: Partial<Record<keyof typeof SHAS, string>> = {}
): string {
  return order
    .map((name) => `160000 commit ${overrides[name] ?? SHAS[name]}\t${name}\0`)
    .join("");
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
