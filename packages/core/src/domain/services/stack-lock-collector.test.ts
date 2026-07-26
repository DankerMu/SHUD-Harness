import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
      gitCommand,
      runtimeVersions: { os: "FixtureOS 1.0" }
    });

    expect(calls).toHaveLength(1);
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
      os: "FixtureOS 1.0",
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
    const beforeStatus = git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=no"]);
    const packageDocument = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };

    const result = await collectStackLockContext({ repositoryRoot });

    for (const repositoryName of ["SHUD", "rSHUD", "AutoSHUD", "zero"] as const) {
      expect(result.repos[repositoryName].commit).toMatch(/^[0-9a-f]{40}$/u);
      expect(result.repos[repositoryName].branch.length).toBeGreaterThan(0);
    }
    expect(result.repos.zero.commit).toBe(STACK_LOCK_ZERO_PIN);
    expect(result.harness.version).toBe(
      typeof packageDocument.version === "string" && packageDocument.version.trim().length > 0
        ? packageDocument.version.trim()
        : STACK_LOCK_UNKNOWN_VERSION
    );
    expect(result.llm).toMatchObject({
      provider: "glm-dmxapi",
      model_id: "glm-5.2",
      base_url: "https://www.dmxapi.cn/v1"
    });
    expect(git(repositoryRoot, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=no"])).toBe(
      beforeStatus
    );
  });

  test("services barrel exposes the collector contract and production does not read API-key environment values", async () => {
    const serviceExports = await import("./index");
    expect(serviceExports.collectStackLockContext).toBe(collectStackLockContext);
    const source = await readFile(join(import.meta.dir, "stack-lock-collector.ts"), "utf8");
    expect(source).not.toMatch(/process\.env|GLM_API_KEY|console\./u);
  });
});

async function createFixtureRepository(input: {
  version?: string;
  providerConfig?: Record<string, unknown>;
}): Promise<string> {
  const repositoryRoot = await createTempRoot("shud-stack-collector-");
  await mkdir(join(repositoryRoot, "config", "providers"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "package.json"),
    `${JSON.stringify({ name: "fixture", ...(input.version ? { version: input.version } : {}) }, null, 2)}\n`
  );
  await writeFile(
    join(repositoryRoot, "config", "providers", "glm.dmxapi.json"),
    `${JSON.stringify(input.providerConfig ?? providerConfigFixture(), null, 2)}\n`
  );
  return repositoryRoot;
}

function providerConfigFixture(input: { baseUrl?: string } = {}): Record<string, unknown> {
  return {
    schema_version: "m1.glm-provider.v1",
    default_provider: "glm-dmxapi",
    default_model: "glm-dmxapi/target",
    target_model_id: "glm-5.2",
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
            model_id: "glm-5.2"
          }
        }
      }
    }
  };
}

function fakeGitCommand(): StackLockGitCommand {
  return async () => ({ stdout: gitlinkOutput(["SHUD", "rSHUD", "AutoSHUD", "zero"]) });
}

function gitlinkOutput(order: ReadonlyArray<keyof typeof SHAS>): string {
  return order.map((name) => `160000 commit ${SHAS[name]}\t${name}\0`).join("");
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
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
