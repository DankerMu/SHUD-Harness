import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_READINESS_NOTE_NAME,
  FIXTURE_READINESS_NOTE_NAME,
  MAX_PRIOR_READINESS_NOTE_BYTES
} from "./readiness-note";
import {
  CLI_UNSUPPORTED_ARGUMENT_MESSAGE,
  DEFAULT_REPO_ROOT,
  DEFAULT_TIMEOUT_MS,
  GLM_API_KEY_ENV,
  GLM_API_KEY_REF,
  runGlmProviderSmoke,
  runGlmProviderSmokeFixture,
  type SmokeFetch
} from "./smoke";
import {
  cliFetchPreload,
  createTempRootTracker,
  expectNoExternalText,
  fixedNow,
  jsonResponse,
  makeFakeSecret,
  passingReadinessNoteText,
  readReadinessNote,
  readReadinessStatus,
  readinessNotePath,
  seedPassingReadinessNote,
  withCanonicalReadinessBackup
} from "./test-helpers";

if (false) {
  // @ts-expect-error canonical smoke intentionally exposes no authority override options.
  runGlmProviderSmoke({ repoRoot: "/tmp/alternate", timeoutMs: 1 });
}

const tempRoots = createTempRootTracker();

describe("glm provider canonical authority boundaries", () => {
  afterEach(async () => {
    await tempRoots.cleanup();
  });

  test("canonical public surface has no authority override options", () => {
    expect(runGlmProviderSmoke.length).toBe(0);
    expect(runGlmProviderSmokeFixture.length).toBe(1);
  });

  test("fixture smoke writes only fixture readiness evidence", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    const result = await runGlmProviderSmokeFixture({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
      fetchImpl: async () => jsonResponse({
        choices: [{ message: { role: "assistant", content: "ready" } }]
      }),
      now: fixedNow,
      timeoutMs: 5
    });

    expect(result.ok).toBe(true);
    expect(result.evidenceScope).toBe("fixture");
    expect(result.readinessNoteName).toBe(FIXTURE_READINESS_NOTE_NAME);
    expect(result.readinessNotePath.endsWith(FIXTURE_READINESS_NOTE_NAME)).toBe(true);
    expect(await readReadinessStatus(repo.repoRoot, DEFAULT_READINESS_NOTE_NAME)).toBeUndefined();

    const note = await readReadinessNote(repo.repoRoot, FIXTURE_READINESS_NOTE_NAME);
    expect(note).toMatchObject({
      schema_version: "m1.glm-provider-smoke.fixture.v1",
      kind: "glm_provider_smoke_fixture",
      evidence_scope: "fixture",
      status: "passed",
      secret_ref: GLM_API_KEY_REF,
      model_admission: false
    });
  });

  test("fixture smoke rejects canonical root and symlink aliases before fetch or write", async () => {
    let fetchCalls = 0;
    const fetchImpl: SmokeFetch = async () => {
      fetchCalls += 1;
      throw new Error("Fixture guard must reject before fetch.");
    };

    await expect(
      runGlmProviderSmokeFixture({
        repoRoot: DEFAULT_REPO_ROOT,
        env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
        fetchImpl,
        now: fixedNow,
        timeoutMs: 5
      })
    ).rejects.toThrow("Fixture smoke repo root must not resolve to the canonical repository root.");

    const aliasParent = await tempRoots.createTempRepo();
    const alias = join(aliasParent.repoRoot, "canonical-alias");
    await symlink(DEFAULT_REPO_ROOT, alias);
    await expect(
      runGlmProviderSmokeFixture({
        repoRoot: alias,
        env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
        fetchImpl,
        now: fixedNow,
        timeoutMs: 5
      })
    ).rejects.toThrow("Fixture smoke repo root must not resolve to the canonical repository root.");

    expect(fetchCalls).toBe(0);
  });

  test("fixture smoke rejects invalid timeout values before fetch or write", async () => {
    for (const timeoutMs of [0, -1, 15001, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const repo = await tempRoots.createTempRepoWithProviderConfig();
      let fetchCalls = 0;
      await expect(
        runGlmProviderSmokeFixture({
          repoRoot: repo.repoRoot,
          env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("Fixture timeout guard must reject before fetch.");
          },
          now: fixedNow,
          timeoutMs
        })
      ).rejects.toThrow(
        `Fixture smoke timeout must be a safe integer from 1 to ${DEFAULT_TIMEOUT_MS} ms.`
      );
      expect(fetchCalls).toBe(0);
      expect(await readReadinessStatus(repo.repoRoot, FIXTURE_READINESS_NOTE_NAME)).toBeUndefined();
    }
  });

  test("CLI preflight failures invalidate canonical stale pass without raw argv evidence", async () => {
    await withCanonicalReadinessBackup(async () => {
      const externalRepo = await tempRoots.createTempRepoWithProviderConfig();
      const externalConfigPath = join(externalRepo.repoRoot, "config", "providers", "glm.dmxapi.json");
      const secretSentinel = "ROUND5_CLI_SECRET_SENTINEL";
      for (const fixture of [
        { args: ["--repo-root", externalRepo.repoRoot], forbidden: ["--repo-root", externalRepo.repoRoot] },
        { args: ["--repo-root"], forbidden: ["--repo-root"] },
        { args: ["--config", externalConfigPath], forbidden: ["--config", externalConfigPath] },
        { args: ["--timeout-ms", "999999"], forbidden: ["--timeout-ms", "999999"] },
        { args: [`--api-key=${secretSentinel}`], forbidden: ["--api-key", secretSentinel] }
      ]) {
        await seedPassingReadinessNote(DEFAULT_REPO_ROOT);
        const child = runSmokeCli(fixture.args, {
          ...process.env,
          [GLM_API_KEY_ENV]: secretSentinel
        });
        const { exitCode, stdout, stderr } = await collectChild(child);

        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toBe(`GLM provider smoke failed: ${CLI_UNSUPPORTED_ARGUMENT_MESSAGE}\n`);
        expectNoExternalText(`${stdout}${stderr}`, [...fixture.forbidden, secretSentinel]);
        expect(await readReadinessStatus(DEFAULT_REPO_ROOT)).not.toBe("passed");
      }
    });
  });

  test("CLI help is static and does not invalidate or mint readiness evidence", async () => {
    await withCanonicalReadinessBackup(async () => {
      await seedPassingReadinessNote(DEFAULT_REPO_ROOT);
      const child = runSmokeCli(["--help"], { ...process.env });
      const { exitCode, stdout, stderr } = await collectChild(child);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("Usage: bun scripts/glm-provider/smoke.ts [--help]");
      expect(stdout).not.toContain("smoke passed");
      expect(await readReadinessStatus(DEFAULT_REPO_ROOT)).toBe("passed");
    });
  });

  test("canonical CLI provider failure omits provider body, status text, headers, and secrets", async () => {
    await withCanonicalReadinessBackup(async () => {
      const fakeSecret = makeFakeSecret();
      const providerSentinel = "ROUND5_PROVIDER_SENTINEL";
      const preloadRoot = await tempRoots.createTempRepo();
      const preloadPath = join(preloadRoot.repoRoot, "fetch-preload.ts");
      await writeFile(preloadPath, cliFetchPreload(providerSentinel, fakeSecret), "utf8");

      const child = runSmokeCli([], {
        ...process.env,
        [GLM_API_KEY_ENV]: fakeSecret
      }, preloadPath);
      const { exitCode, stdout, stderr } = await collectChild(child);
      const forbidden = [providerSentinel, fakeSecret, "BEGIN PRIVATE KEY"];

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("GLM provider smoke failed: Provider returned HTTP 503");
      expectNoExternalText(`${stdout}${stderr}`, forbidden);

      const noteText = await readFile(readinessNotePath(DEFAULT_REPO_ROOT), "utf8");
      expect(noteText).toContain('"http_status": 503');
      expectNoExternalText(noteText, forbidden);
    });
  });

  test("canonical symlink and hardlink stale passes are removed without mutating targets", async () => {
    await withCanonicalReadinessBackup(async () => {
      for (const entryKind of ["symlink", "hardlink"] as const) {
        await rm(readinessNotePath(DEFAULT_REPO_ROOT), { force: true, recursive: true });
        const outside = await tempRoots.createTempRepo();
        const externalNote = join(outside.repoRoot, `${entryKind}-pass.json`);
        const externalContent = passingReadinessNoteText();
        await writeFile(externalNote, externalContent, "utf8");
        if (entryKind === "symlink") {
          await symlink(externalNote, readinessNotePath(DEFAULT_REPO_ROOT));
        } else {
          await link(externalNote, readinessNotePath(DEFAULT_REPO_ROOT));
        }

        const child = runSmokeCli([], envWithoutGlmKey());
        const { exitCode } = await collectChild(child);

        expect(exitCode).toBe(1);
        expect(await readFile(externalNote, "utf8")).toBe(externalContent);
        expect(await readReadinessStatus(DEFAULT_REPO_ROOT)).toBe("failed");
      }
    });
  });

  test("canonical directory final entry fails closed without preserving a pass", async () => {
    await withCanonicalReadinessBackup(async () => {
      await rm(readinessNotePath(DEFAULT_REPO_ROOT), { force: true, recursive: true });
      await mkdir(readinessNotePath(DEFAULT_REPO_ROOT), { recursive: true });

      const child = runSmokeCli([], envWithoutGlmKey());
      const { exitCode, stdout, stderr } = await collectChild(child);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Smoke command failed before provider readiness could be recorded.");
      expect(await readReadinessStatus(DEFAULT_REPO_ROOT)).not.toBe("passed");
    });
  });

  test("canonical oversized unreadable prior note is replaced without reading content", async () => {
    await withCanonicalReadinessBackup(async () => {
      const notePath = readinessNotePath(DEFAULT_REPO_ROOT);
      await rm(notePath, { force: true, recursive: true });
      await writeFile(notePath, "", "utf8");
      await truncate(notePath, MAX_PRIOR_READINESS_NOTE_BYTES + 1);
      await chmod(notePath, 0o000);

      const child = runSmokeCli([], envWithoutGlmKey());
      const { exitCode } = await collectChild(child);
      const note = await readReadinessNote(DEFAULT_REPO_ROOT);

      expect(exitCode).toBe(1);
      expect(note.status).toBe("failed");
      expect(note.failure).toMatchObject({
        category: "missing_key"
      });
    });
  });
});

function runSmokeCli(
  args: string[],
  env: Record<string, string | undefined>,
  preloadPath?: string
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    [
      process.execPath,
      ...(preloadPath ? ["--preload", preloadPath] : []),
      join(import.meta.dir, "smoke.ts"),
      ...args
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env
    }
  );
}

async function collectChild(child: ReturnType<typeof Bun.spawn>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text()
  ]);
  return { exitCode, stdout, stderr };
}

function envWithoutGlmKey(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env[GLM_API_KEY_ENV];
  return env;
}
