import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
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
  API_TYPE,
  CANONICAL_BASE_URL,
  CANONICAL_SMOKE_MODEL,
  CANONICAL_TARGET_MODEL,
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
  readReadinessNote,
  readReadinessStatus,
  readinessNotePath
} from "./test-helpers";

if (false) {
  // @ts-expect-error canonical smoke intentionally exposes no authority override options.
  runGlmProviderSmoke({ repoRoot: "/tmp/alternate", timeoutMs: 1 });
}

const tempRoots = createTempRootTracker();
const darwinTest = process.platform === "darwin" ? test : test.skip;

describe("glm provider canonical authority boundaries", () => {
  afterEach(async () => {
    await tempRoots.cleanup();
  });

  test("canonical public surface has no authority override options", () => {
    expect(runGlmProviderSmoke.length).toBe(0);
    expect(runGlmProviderSmokeFixture.length).toBe(1);
  });

  test("production exports expose no direct canonical writer and core has no write surface", async () => {
    const productionNamespaces = [
      await import("./smoke"),
      await import("./canonical-smoke"),
      await import("./fixture-smoke"),
      await import("./readiness-note"),
      await import("./smoke-core")
    ];
    for (const namespace of productionNamespaces) {
      const forbiddenExports = Object.keys(namespace).filter((name) =>
        /write.*canonical|canonical.*writer|writecanonical|seedpassingreadiness|passingreadinessnotetext/i.test(name)
      );
      expect(forbiddenExports).toEqual([]);
    }

    const testHelpers = await import("./test-helpers");
    expect("withCanonicalReadinessBackup" in testHelpers).toBe(false);
    expect("seedPassingReadinessNote" in testHelpers).toBe(false);
    expect("passingReadinessNoteText" in testHelpers).toBe(false);

    const coreSource = await readFile(join(import.meta.dir, "smoke-core.ts"), "utf8");
    for (const forbidden of [
      "writeFile",
      "appendFile",
      "rename",
      "unlink",
      "mkdir",
      "rm(",
      "rmdir",
      "createWriteStream"
    ]) {
      expect(coreSource.includes(forbidden)).toBe(false);
    }
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

  test("unsupported CLI removes symlinked canonical workspace without mutating external pass", async () => {
    await withCanonicalWorkspaceEntryBackup(async () => {
      const externalWorkspace = await tempRoots.createTempRepo();
      const externalNote = join(externalWorkspace.repoRoot, "readiness", DEFAULT_READINESS_NOTE_NAME);
      const externalContent = passingReadinessNoteText();
      await mkdir(join(externalWorkspace.repoRoot, "readiness"), { recursive: true });
      await writeFile(externalNote, externalContent, "utf8");
      await symlink(externalWorkspace.repoRoot, join(DEFAULT_REPO_ROOT, "workspace"));

      const child = runSmokeCli(["--repo-root", externalWorkspace.repoRoot], {
        ...process.env,
        [GLM_API_KEY_ENV]: makeFakeSecret()
      });
      const { exitCode, stdout, stderr } = await collectChild(child);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe(`GLM provider smoke failed: ${CLI_UNSUPPORTED_ARGUMENT_MESSAGE}\n`);
      expectNoExternalText(`${stdout}${stderr}`, ["--repo-root", externalWorkspace.repoRoot]);
      expect(await pathExists(join(DEFAULT_REPO_ROOT, "workspace"))).toBe(false);
      expect(await readFile(externalNote, "utf8")).toBe(externalContent);
      expect(await readReadinessStatus(DEFAULT_REPO_ROOT)).not.toBe("passed");
    });
  });

  test("missing-key CLI replaces symlinked canonical workspace with current failed note", async () => {
    await withCanonicalWorkspaceEntryBackup(async () => {
      const externalWorkspace = await tempRoots.createTempRepo();
      const externalNote = join(externalWorkspace.repoRoot, "readiness", DEFAULT_READINESS_NOTE_NAME);
      const externalContent = passingReadinessNoteText();
      await mkdir(join(externalWorkspace.repoRoot, "readiness"), { recursive: true });
      await writeFile(externalNote, externalContent, "utf8");
      await symlink(externalWorkspace.repoRoot, join(DEFAULT_REPO_ROOT, "workspace"));

      const child = runSmokeCli([], envWithoutGlmKey());
      const { exitCode, stdout, stderr } = await collectChild(child);
      const note = await readReadinessNote(DEFAULT_REPO_ROOT);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(`Missing required environment variable ${GLM_API_KEY_ENV}.`);
      expect(await isLocalDirectory(join(DEFAULT_REPO_ROOT, "workspace"))).toBe(true);
      expect(await isLocalDirectory(join(DEFAULT_REPO_ROOT, "workspace", "readiness"))).toBe(true);
      expect(note.status).toBe("failed");
      expect(note.failure).toMatchObject({ category: "missing_key" });
      expect(await readFile(externalNote, "utf8")).toBe(externalContent);
    });
  });

  test("unsupported CLI removes symlinked canonical readiness directory without mutating external pass", async () => {
    await withCanonicalWorkspaceEntryBackup(async () => {
      const externalReadiness = await tempRoots.createTempRepo();
      const externalNote = join(externalReadiness.repoRoot, DEFAULT_READINESS_NOTE_NAME);
      const externalContent = passingReadinessNoteText();
      await mkdir(join(DEFAULT_REPO_ROOT, "workspace"), { recursive: true });
      await writeFile(externalNote, externalContent, "utf8");
      await symlink(externalReadiness.repoRoot, join(DEFAULT_REPO_ROOT, "workspace", "readiness"));

      const child = runSmokeCli(["--config", "/tmp/ignored.json"], {
        ...process.env,
        [GLM_API_KEY_ENV]: makeFakeSecret()
      });
      const { exitCode, stdout, stderr } = await collectChild(child);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe(`GLM provider smoke failed: ${CLI_UNSUPPORTED_ARGUMENT_MESSAGE}\n`);
      expectNoExternalText(`${stdout}${stderr}`, ["--config", "/tmp/ignored.json"]);
      expect(await isLocalDirectory(join(DEFAULT_REPO_ROOT, "workspace"))).toBe(true);
      expect(await pathExists(join(DEFAULT_REPO_ROOT, "workspace", "readiness"))).toBe(false);
      expect(await readFile(externalNote, "utf8")).toBe(externalContent);
      expect(await readReadinessStatus(DEFAULT_REPO_ROOT)).not.toBe("passed");
    });
  });

  test("missing-key CLI replaces symlinked canonical readiness directory with current failed note", async () => {
    await withCanonicalWorkspaceEntryBackup(async () => {
      const externalReadiness = await tempRoots.createTempRepo();
      const externalNote = join(externalReadiness.repoRoot, DEFAULT_READINESS_NOTE_NAME);
      const externalContent = passingReadinessNoteText();
      await mkdir(join(DEFAULT_REPO_ROOT, "workspace"), { recursive: true });
      await writeFile(externalNote, externalContent, "utf8");
      await symlink(externalReadiness.repoRoot, join(DEFAULT_REPO_ROOT, "workspace", "readiness"));

      const child = runSmokeCli([], envWithoutGlmKey());
      const { exitCode } = await collectChild(child);
      const note = await readReadinessNote(DEFAULT_REPO_ROOT);

      expect(exitCode).toBe(1);
      expect(await isLocalDirectory(join(DEFAULT_REPO_ROOT, "workspace", "readiness"))).toBe(true);
      expect(note.status).toBe("failed");
      expect(note.failure).toMatchObject({ category: "missing_key" });
      expect(await readFile(externalNote, "utf8")).toBe(externalContent);
    });
  });

  test("missing-key CLI replaces local non-directory canonical ancestors with owned dirs", async () => {
    await withCanonicalWorkspaceEntryBackup(async () => {
      await writeFile(join(DEFAULT_REPO_ROOT, "workspace"), "not a directory", "utf8");

      const workspaceFileChild = runSmokeCli([], envWithoutGlmKey());
      const first = await collectChild(workspaceFileChild);
      expect(first.exitCode).toBe(1);
      expect(await isLocalDirectory(join(DEFAULT_REPO_ROOT, "workspace"))).toBe(true);
      expect((await readReadinessNote(DEFAULT_REPO_ROOT)).status).toBe("failed");

      await rm(join(DEFAULT_REPO_ROOT, "workspace"), { recursive: true, force: true });
      await mkdir(join(DEFAULT_REPO_ROOT, "workspace"), { recursive: true });
      await writeFile(join(DEFAULT_REPO_ROOT, "workspace", "readiness"), "not a directory", "utf8");

      const readinessFileChild = runSmokeCli([], envWithoutGlmKey());
      const second = await collectChild(readinessFileChild);
      expect(second.exitCode).toBe(1);
      expect(await isLocalDirectory(join(DEFAULT_REPO_ROOT, "workspace", "readiness"))).toBe(true);
      expect((await readReadinessNote(DEFAULT_REPO_ROOT)).status).toBe("failed");
    });
  });

  test("owned mode-restricted canonical directories are restored before stale pass invalidation", async () => {
    await withCanonicalWorkspaceEntryBackup(async () => {
      for (const flow of ["unsupported", "missing-key"] as const) {
        await withModeRestrictedCanonicalWorkspace(async ({
          workspaceDir,
          readinessDir,
          siblingPath,
          siblingContent
        }) => {
          const child = flow === "unsupported"
            ? runSmokeCli(["--timeout-ms", "999999"], {
                ...process.env,
                [GLM_API_KEY_ENV]: makeFakeSecret()
              })
            : runSmokeCli([], envWithoutGlmKey());
          const { exitCode, stdout, stderr } = await collectChild(child);

          expect(exitCode).toBe(1);
          expect(stdout).toBe("");
          if (flow === "unsupported") {
            expect(stderr).toBe(`GLM provider smoke failed: ${CLI_UNSUPPORTED_ARGUMENT_MESSAGE}\n`);
            expect(await pathExists(readinessNotePath(DEFAULT_REPO_ROOT))).toBe(false);
          } else {
            const note = await readReadinessNote(DEFAULT_REPO_ROOT);
            expect(note.status).toBe("failed");
            expect(note.failure).toMatchObject({ category: "missing_key" });
          }
          expect(await readReadinessStatus(DEFAULT_REPO_ROOT)).not.toBe("passed");
          expect(Buffer.compare(await readFile(siblingPath), siblingContent)).toBe(0);
          expect(restoredOwnerRwxPreservingOtherBits(await modeOf(workspaceDir))).toBe(true);
          expect(restoredOwnerRwxPreservingOtherBits(await modeOf(readinessDir))).toBe(true);
        });
      }
    });
  });

  darwinTest("Darwin delete ACL denial tombstones a stale pass before cleanup", async () => {
    await withCanonicalWorkspaceEntryBackup(async () => {
      for (const aclKind of ["parent-delete-child", "leaf-delete"] as const) {
        for (const flow of ["unsupported", "missing-key"] as const) {
          await withDarwinDeleteAclCanonicalWorkspace(aclKind, async ({
            aclPath,
            permission,
            siblingPath,
            siblingContent
          }) => {
            const child = flow === "unsupported"
              ? runSmokeCli(["--repo-root", "/tmp/ignored"], {
                  ...process.env,
                  [GLM_API_KEY_ENV]: makeFakeSecret()
                })
              : runSmokeCli([], envWithoutGlmKey());
            const { exitCode, stdout, stderr } = await collectChild(child);

            expect(exitCode).toBe(1);
            expect(stdout).toBe("");
            if (flow === "unsupported") {
              expect(stderr).toBe(`GLM provider smoke failed: ${CLI_UNSUPPORTED_ARGUMENT_MESSAGE}\n`);
            } else {
              expect(stderr).toMatch(
                /GLM provider smoke failed: (Missing required environment variable GLM_API_KEY|Smoke command failed before provider readiness could be recorded)\./
              );
            }
            await expectDarwinDenyAcl(aclPath, permission);
            await expectCanonicalTombstoneStillPresent();
            expect(await readReadinessStatus(DEFAULT_REPO_ROOT)).not.toBe("passed");
            expect(Buffer.compare(await readFile(siblingPath), siblingContent)).toBe(0);
            await clearDarwinAcl(aclPath);
            await expectNoDarwinDenyAcl(aclPath, permission);
          });
        }
      }
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

  test("canonical exact-URL 304 publishes current redacted failed note", async () => {
    await withCanonicalReadinessBackup(async () => {
      await seedPassingReadinessNote(DEFAULT_REPO_ROOT);
      const fakeSecret = makeFakeSecret();
      const providerSentinel = "HTTP_304_PROVIDER_SENTINEL";
      const preloadRoot = await tempRoots.createTempRepo();
      const preloadPath = join(preloadRoot.repoRoot, "fetch-304-preload.ts");
      await writeFile(preloadPath, httpStatusPreload(304, providerSentinel), "utf8");

      const child = runSmokeCli([], {
        ...process.env,
        [GLM_API_KEY_ENV]: fakeSecret
      }, preloadPath);
      const { exitCode, stdout, stderr } = await collectChild(child);
      const note = await readReadinessNote(DEFAULT_REPO_ROOT);
      const serialized = JSON.stringify(note);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("GLM provider smoke failed: Provider returned HTTP 304");
      expect(note.status).toBe("failed");
      expect(note.failure).toEqual({
        category: "http_error",
        message: "Provider returned HTTP 304 from configured endpoint.",
        http_status: 304
      });
      expectNoExternalText(`${stdout}${stderr}${serialized}`, [
        providerSentinel,
        fakeSecret
      ]);
    });
  });

  test("in-cap unreadable canonical pass leaf is removed or replaced without preserving pass", async () => {
    await withCanonicalReadinessBackup(async () => {
      for (const flow of ["unsupported", "missing-key"] as const) {
        await seedPassingReadinessNote(DEFAULT_REPO_ROOT);
        const notePath = readinessNotePath(DEFAULT_REPO_ROOT);
        await chmod(notePath, 0o000);
        try {
          const child = flow === "unsupported"
            ? runSmokeCli(["--repo-root", "/tmp/ignored"], {
                ...process.env,
                [GLM_API_KEY_ENV]: makeFakeSecret()
              })
            : runSmokeCli([], envWithoutGlmKey());
          const { exitCode } = await collectChild(child);

          expect(exitCode).toBe(1);
          if (flow === "unsupported") {
            expect(await pathExists(notePath)).toBe(false);
          } else {
            const note = await readReadinessNote(DEFAULT_REPO_ROOT);
            expect(note.status).toBe("failed");
            expect(note.failure).toMatchObject({ category: "missing_key" });
          }
          expect(await readReadinessStatus(DEFAULT_REPO_ROOT)).not.toBe("passed");
        } finally {
          await chmod(notePath, 0o600).catch(() => undefined);
        }
      }
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

async function seedPassingReadinessNote(repoRoot: string): Promise<void> {
  await mkdir(join(repoRoot, "workspace", "readiness"), { recursive: true });
  await writeFile(readinessNotePath(repoRoot), passingReadinessNoteText(), "utf8");
}

async function withCanonicalReadinessBackup<T>(run: () => Promise<T>): Promise<T> {
  const notePath = readinessNotePath(DEFAULT_REPO_ROOT);
  await rm(notePath, { force: true, recursive: true });
  try {
    return await run();
  } finally {
    await rm(notePath, { force: true, recursive: true });
  }
}

async function withModeRestrictedCanonicalWorkspace<T>(run: (paths: {
  workspaceDir: string;
  readinessDir: string;
  siblingPath: string;
  siblingContent: Buffer;
}) => Promise<T>): Promise<T> {
  const workspaceDir = join(DEFAULT_REPO_ROOT, "workspace");
  const readinessDir = join(workspaceDir, "readiness");
  const siblingPath = join(readinessDir, "sibling-note.txt");
  const siblingContent = Buffer.from("sibling readiness note remains byte-identical\n");
  await rm(workspaceDir, { recursive: true, force: true });
  await mkdir(readinessDir, { recursive: true });
  await chmod(workspaceDir, 0o700);
  await chmod(readinessDir, 0o700);
  await writeFile(siblingPath, siblingContent);
  await writeFile(readinessNotePath(DEFAULT_REPO_ROOT), passingReadinessNoteText(), "utf8");
  await chmod(readinessDir, 0o055);
  await chmod(workspaceDir, 0o055);
  try {
    return await run({ workspaceDir, readinessDir, siblingPath, siblingContent });
  } finally {
    await chmod(workspaceDir, 0o700).catch(() => undefined);
    await chmod(readinessDir, 0o700).catch(() => undefined);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function withDarwinDeleteAclCanonicalWorkspace<T>(
  aclKind: "parent-delete-child" | "leaf-delete",
  run: (paths: {
    aclPath: string;
    permission: "delete" | "delete_child";
    siblingPath: string;
    siblingContent: Buffer;
  }) => Promise<T>
): Promise<T> {
  const workspaceDir = join(DEFAULT_REPO_ROOT, "workspace");
  const readinessDir = join(workspaceDir, "readiness");
  const notePath = readinessNotePath(DEFAULT_REPO_ROOT);
  const siblingPath = join(readinessDir, "darwin-acl-sibling-note.txt");
  const siblingContent = Buffer.from("darwin acl sibling remains byte-identical\n");
  const aclPath = aclKind === "parent-delete-child" ? readinessDir : notePath;
  const permission = aclKind === "parent-delete-child" ? "delete_child" : "delete";

  await rm(workspaceDir, { recursive: true, force: true });
  await mkdir(readinessDir, { recursive: true });
  await writeFile(siblingPath, siblingContent);
  await writeFile(notePath, passingReadinessNoteText(), "utf8");
  await addDarwinDenyAcl(aclPath, permission);
  try {
    return await run({ aclPath, permission, siblingPath, siblingContent });
  } finally {
    await clearDarwinAcl(aclPath).catch(() => undefined);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function modeOf(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

function restoredOwnerRwxPreservingOtherBits(mode: number): boolean {
  return (mode & 0o700) === 0o700 && (mode & 0o077) === 0o055;
}

function passingReadinessNoteText(): string {
  return `${JSON.stringify({
    schema_version: "m1.glm-provider-smoke.v1",
    kind: "glm_provider_smoke",
    evidence_scope: "canonical",
    checked_at: "2026-07-08T10:00:00.000Z",
    provider_name: "glm-dmxapi",
    api_type: API_TYPE,
    base_url: CANONICAL_BASE_URL,
    endpoint: "https://www.dmxapi.cn/v1/chat/completions",
    smoke_model: CANONICAL_SMOKE_MODEL,
    target_model_id: CANONICAL_TARGET_MODEL,
    status: "passed",
    model_admission: false,
    secret_ref: GLM_API_KEY_REF,
    attempts: 1,
    configured_base_url_hit: true,
    completion_nonempty: true,
    response_url: "https://www.dmxapi.cn/v1/chat/completions"
  })}\n`;
}

function httpStatusPreload(status: number, sentinel: string): string {
  return `globalThis.fetch = async () => {
  const response = new Response(null, {
    status: ${status},
    statusText: ${JSON.stringify(`${sentinel} status text`)},
    headers: { "x-provider-debug": ${JSON.stringify(sentinel)} }
  });
  Object.defineProperty(response, "url", {
    value: "https://www.dmxapi.cn/v1/chat/completions",
    configurable: true
  });
  return response;
};`;
}

async function withCanonicalWorkspaceEntryBackup<T>(run: () => Promise<T>): Promise<T> {
  const workspacePath = join(DEFAULT_REPO_ROOT, "workspace");
  const backupParent = await mkdtemp(join(DEFAULT_REPO_ROOT, ".glm-provider-workspace-backup-"));
  const backupPath = join(backupParent, "workspace");
  let hadOriginal = false;
  try {
    await rename(workspacePath, backupPath);
    hadOriginal = true;
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      await rm(backupParent, { recursive: true, force: true });
      throw error;
    }
  }

  try {
    return await run();
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
    if (hadOriginal) {
      await rename(backupPath, workspacePath);
    }
    await removeCanonicalPassingReadinessNote();
    await rm(backupParent, { recursive: true, force: true });
  }
}

async function removeCanonicalPassingReadinessNote(): Promise<void> {
  if (await readReadinessStatus(DEFAULT_REPO_ROOT) === "passed") {
    await rm(readinessNotePath(DEFAULT_REPO_ROOT), { force: true, recursive: true });
  }
}

async function addDarwinDenyAcl(
  path: string,
  permission: "delete" | "delete_child"
): Promise<void> {
  const user = (await runDarwinCommand(["id", "-un"])).stdout.trim();
  await runDarwinCommand(["chmod", "+a", `user:${user} deny ${permission}`, path]);
}

async function clearDarwinAcl(path: string): Promise<void> {
  await runDarwinCommand(["chmod", "-N", path]);
}

async function expectDarwinDenyAcl(
  path: string,
  permission: "delete" | "delete_child"
): Promise<void> {
  expect(await pathExists(path)).toBe(true);
  const listing = await runDarwinCommand(["ls", "-lde", path]);
  expect(hasDarwinDenyAcl(listing.stdout, permission)).toBe(true);
}

async function expectNoDarwinDenyAcl(
  path: string,
  permission: "delete" | "delete_child"
): Promise<void> {
  expect(await pathExists(path)).toBe(true);
  const listing = await runDarwinCommand(["ls", "-lde", path]);
  expect(hasDarwinDenyAcl(listing.stdout, permission)).toBe(false);
}

async function expectCanonicalTombstoneStillPresent(): Promise<void> {
  const notePath = readinessNotePath(DEFAULT_REPO_ROOT);
  expect(await pathExists(notePath)).toBe(true);
  const noteBytes = await readFile(notePath);
  expect(JSON.parse(noteBytes.toString("utf8"))).toEqual({
    schema_version: "m1.glm-provider-smoke.tombstone.v1",
    kind: "glm_provider_smoke_tombstone",
    evidence_scope: "canonical",
    status: "failed",
    reason: "stale_pass_invalidated"
  });
}

function hasDarwinDenyAcl(
  listing: string,
  permission: "delete" | "delete_child"
): boolean {
  return new RegExp(`\\bdeny\\s+${permission}\\b`).test(listing);
}

async function runDarwinCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text()
  ]);
  if (exitCode !== 0) {
    throw new Error(`Darwin ACL command failed: ${args[0]}`);
  }
  return { stdout, stderr };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function isLocalDirectory(path: string): Promise<boolean> {
  const stat = await lstat(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function isNodeErrorWithCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && (error as Error & { code?: string }).code === code;
}
