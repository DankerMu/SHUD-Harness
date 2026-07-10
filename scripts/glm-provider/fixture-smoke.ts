import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_CONFIG_RELATIVE_PATH,
  DEFAULT_REPO_ROOT,
  DEFAULT_TIMEOUT_MS,
  runSmokeCore,
  type SmokeCoreResult,
  type SmokeFetch
} from "./smoke-core";
import {
  FIXTURE_READINESS_NOTE_NAME,
  type FixtureReadinessNote,
  type FixtureSmokeRunResult
} from "./readiness-note";

export interface RunSmokeFixtureOptions {
  repoRoot: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: SmokeFetch;
  timeoutMs?: number;
  now?: () => Date;
}

export async function runGlmProviderSmokeFixture(
  options: RunSmokeFixtureOptions
): Promise<FixtureSmokeRunResult> {
  const repoRoot = resolveFixtureRepoRoot(options);
  await assertFixtureRepoRoot(repoRoot);
  const timeoutMs = readFixtureTimeoutMs(options.timeoutMs);
  const coreResult = await runSmokeCore({
    configPath: join(repoRoot, DEFAULT_CONFIG_RELATIVE_PATH),
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
    timeoutMs,
    now: options.now ?? (() => new Date())
  });
  const note = createFixtureReadinessNote(coreResult);
  const readinessNotePath = await writeFixtureReadinessNote(repoRoot, note);
  return fixtureResultFromCore(coreResult, note, readinessNotePath);
}

function resolveFixtureRepoRoot(options: RunSmokeFixtureOptions): string {
  if (!options || typeof options.repoRoot !== "string" || options.repoRoot.trim().length === 0) {
    throw new Error("Fixture smoke requires a noncanonical repo root.");
  }
  return resolve(options.repoRoot);
}

async function assertFixtureRepoRoot(repoRoot: string): Promise<void> {
  const [fixtureRoot, canonicalRoot] = await Promise.all([
    realpath(repoRoot),
    realpath(DEFAULT_REPO_ROOT)
  ]);
  if (fixtureRoot === canonicalRoot) {
    throw new Error("Fixture smoke repo root must not resolve to the canonical repository root.");
  }
}

function readFixtureTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > DEFAULT_TIMEOUT_MS
  ) {
    throw new Error(
      `Fixture smoke timeout must be a safe integer from 1 to ${DEFAULT_TIMEOUT_MS} ms.`
    );
  }
  return timeoutMs;
}

async function writeFixtureReadinessNote(
  repoRoot: string,
  note: FixtureReadinessNote
): Promise<string> {
  assertFixtureReadinessNote(note);
  const realRepoRoot = await realpath(repoRoot);
  const workspaceDir = join(realRepoRoot, "workspace");
  const readinessDir = join(workspaceDir, "readiness");
  await ensureOwnedFixtureDirectory(workspaceDir, "workspace");
  await ensureOwnedFixtureDirectory(readinessDir, "workspace/readiness");
  const realReadinessDir = await realpath(readinessDir);
  const expectedReadinessDir = join(realRepoRoot, "workspace", "readiness");
  if (realReadinessDir !== expectedReadinessDir) {
    throw new Error("Readiness note directory must resolve under workspace/readiness.");
  }

  const notePath = join(readinessDir, FIXTURE_READINESS_NOTE_NAME);
  await assertSafeFixtureFinalEntry(notePath);
  const tempPath = join(readinessDir, `.${FIXTURE_READINESS_NOTE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(note, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await rename(tempPath, notePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  return notePath;
}

async function ensureOwnedFixtureDirectory(path: string, label: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Readiness ${label} path must be an owned directory.`);
    }
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
    await mkdir(path, { mode: 0o700 });
  }
}

async function assertSafeFixtureFinalEntry(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
      throw new Error("Readiness note path must be an owned regular file.");
    }
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function createFixtureReadinessNote(coreResult: SmokeCoreResult): FixtureReadinessNote {
  const base = {
    schema_version: "m1.glm-provider-smoke.fixture.v1" as const,
    kind: "glm_provider_smoke_fixture" as const,
    evidence_scope: "fixture" as const,
    checked_at: coreResult.checkedAt,
    provider_name: coreResult.config.providerName,
    api_type: coreResult.config.apiType,
    base_url: coreResult.config.baseUrl,
    endpoint: coreResult.endpoint,
    smoke_model: coreResult.config.smokeModel,
    target_model_id: coreResult.config.targetModelId,
    status: coreResult.status,
    model_admission: false as const,
    secret_ref: coreResult.config.apiKeyRef,
    attempts: coreResult.attempts,
    configured_base_url_hit: coreResult.configuredBaseUrlHit,
    completion_nonempty: coreResult.completionNonempty
  };
  if (coreResult.ok) {
    return {
      ...base,
      status: "passed",
      configured_base_url_hit: true,
      completion_nonempty: true,
      response_url: coreResult.responseUrl
    };
  }
  return {
    ...base,
    status: "failed",
    completion_nonempty: false,
    failure: coreResult.error
  };
}

function fixtureResultFromCore(
  coreResult: SmokeCoreResult,
  note: FixtureReadinessNote,
  readinessNotePath: string
): FixtureSmokeRunResult {
  const shared = {
    evidenceScope: "fixture" as const,
    readinessNoteName: FIXTURE_READINESS_NOTE_NAME as typeof FIXTURE_READINESS_NOTE_NAME,
    config: coreResult.config,
    endpoint: coreResult.endpoint,
    attempts: coreResult.attempts,
    note,
    readinessNotePath
  };
  if (coreResult.ok) {
    return {
      ...shared,
      ok: true,
      status: "passed",
      responseUrl: coreResult.responseUrl,
      completionNonempty: true
    };
  }
  return {
    ...shared,
    ok: false,
    status: "failed",
    error: coreResult.error
  };
}

function assertFixtureReadinessNote(note: FixtureReadinessNote): void {
  if (
    note.schema_version !== "m1.glm-provider-smoke.fixture.v1" ||
    note.kind !== "glm_provider_smoke_fixture" ||
    note.evidence_scope !== "fixture"
  ) {
    throw new Error("Fixture readiness note must carry the fixture schema identity.");
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && (error as Error & { code?: string }).code === code;
}
