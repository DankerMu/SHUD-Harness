import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CANONICAL_BASE_URL,
  CANONICAL_ENDPOINT,
  CANONICAL_PROVIDER_NAME,
  CANONICAL_SMOKE_MODEL,
  CANONICAL_TARGET_MODEL,
  DEFAULT_PROVIDER_CONFIG_PATH,
  DEFAULT_REPO_ROOT,
  DEFAULT_TIMEOUT_MS,
  GLM_API_KEY_ENV,
  GLM_API_KEY_REF,
  LocalSmokeError,
  MAX_RETRIES,
  MAX_RESPONSE_BYTES,
  isReachableHttpErrorStatus,
  runSmokeCore,
  type GlmProviderConfig,
  type SmokeCoreResult
} from "./smoke-core";
import {
  DEFAULT_READINESS_NOTE_NAME,
  MAX_PRIOR_READINESS_NOTE_BYTES,
  type CanonicalReadinessNote,
  type CanonicalSmokeRunResult,
  type SmokeFailure,
  type SmokeFailureCategory
} from "./readiness-note";

type FileHandle = Awaited<ReturnType<typeof open>>;
type FsStats = Awaited<ReturnType<typeof lstat>>;

export type CanonicalSmokeCommandOutcome =
  | {
      kind: "help";
      exitCode: 0;
      stdout: string;
      stderr: "";
    }
  | {
      kind: "unsupported";
      exitCode: 1;
      stdout: "";
      stderr: string;
      message: typeof CLI_UNSUPPORTED_ARGUMENT_MESSAGE;
    }
  | {
      kind: "smoke";
      result: CanonicalSmokeRunResult;
    };

const OWNER_RWX_BITS = 0o700;
const OWNER_RW_BITS = 0o600;
export const CLI_UNSUPPORTED_ARGUMENT_MESSAGE = "Unsupported or incomplete CLI argument.";
const AUTHORITY_UNSUPPORTED_UID_MESSAGE =
  "Canonical readiness authority requires a local uid.";
const AUTHORITY_NOT_OWNED_MESSAGE =
  "Canonical readiness directory is not owned by the current uid.";
const AUTHORITY_LEAF_NOT_OWNED_MESSAGE =
  "Canonical readiness leaf is not owned by the current uid.";
const AUTHORITY_REALPATH_MESSAGE =
  "Canonical readiness directory did not resolve to its expected local path.";
const AUTHORITY_IN_PLACE_INVALIDATION_MESSAGE =
  "Canonical readiness pass could not be invalidated in place.";
const AUTHORITY_UNSAFE_FINAL_ENTRY_MESSAGE =
  "Canonical readiness unsafe final entry could not be removed by local authority.";
const STALE_PASS_TOMBSTONE_TEXT = `${JSON.stringify({
  schema_version: "m1.glm-provider-smoke.tombstone.v1",
  kind: "glm_provider_smoke_tombstone",
  evidence_scope: "canonical",
  status: "failed",
  reason: "stale_pass_invalidated"
})}\n`;

export async function runCanonicalGlmProviderSmoke(): Promise<CanonicalSmokeRunResult> {
  const outcome = await runCanonicalGlmProviderSmokeCommand([]);
  if (outcome.kind !== "smoke") {
    throw new LocalSmokeError("Canonical smoke command returned a non-smoke outcome.");
  }
  return outcome.result;
}

export async function runCanonicalGlmProviderSmokeCommand(
  args: readonly string[]
): Promise<CanonicalSmokeCommandOutcome> {
  if (isHelpInvocation(args)) {
    return {
      kind: "help",
      exitCode: 0,
      stdout: canonicalSmokeHelpText(),
      stderr: ""
    };
  }

  if (args.length > 0) {
    await invalidatePassingCanonicalReadinessNote();
    return {
      kind: "unsupported",
      exitCode: 1,
      stdout: "",
      stderr: `GLM provider smoke failed: ${CLI_UNSUPPORTED_ARGUMENT_MESSAGE}`,
      message: CLI_UNSUPPORTED_ARGUMENT_MESSAGE
    };
  }

  return {
    kind: "smoke",
    result: await executeCanonicalGlmProviderSmoke()
  };
}

async function executeCanonicalGlmProviderSmoke(): Promise<CanonicalSmokeRunResult> {
  await invalidatePassingCanonicalReadinessNote();
  const coreResult = await runSmokeCore({
    configPath: DEFAULT_PROVIDER_CONFIG_PATH,
    env: process.env,
    fetchImpl: globalThis.fetch.bind(globalThis),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    now: () => new Date()
  });
  const note = createCanonicalReadinessNote(coreResult);
  const readinessNotePath = await writeCanonicalReadinessNote(note);
  return canonicalResultFromCore(coreResult, note, readinessNotePath);
}

function isHelpInvocation(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === "--help";
}

function canonicalSmokeHelpText(): string {
  return [
    "Usage: bun scripts/glm-provider/smoke.ts [--help]",
    "",
    "Runs one non-stream OpenAI-compatible chat-completions smoke against the configured GLM provider.",
    `The canonical checkout is ${DEFAULT_REPO_ROOT}.`,
    `Each provider attempt uses a fixed ${DEFAULT_TIMEOUT_MS} ms timeout.`,
    `The API key must be provided through ${GLM_API_KEY_ENV}; only ${GLM_API_KEY_REF} is persisted.`
  ].join("\n");
}

async function invalidatePassingCanonicalReadinessNote(): Promise<void> {
  const realRepoRoot = await realpath(DEFAULT_REPO_ROOT);
  const readinessDir = await sanitizeCanonicalAncestorsForInvalidation(realRepoRoot);
  if (!readinessDir) {
    return;
  }

  const notePath = join(readinessDir, DEFAULT_READINESS_NOTE_NAME);
  await invalidateCanonicalReadinessLeaf(notePath);
}

async function invalidateCanonicalReadinessLeaf(path: string): Promise<void> {
  let stat: FsStats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  if (stat.isDirectory()) {
    return;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    await unlinkUnsafeFinalEntry(path);
    return;
  }
  if (stat.size > MAX_PRIOR_READINESS_NOTE_BYTES) {
    await unlinkLocalEntry(path);
    return;
  }

  await invalidateBoundCanonicalReadinessLeaf(path, stat);
}

async function invalidateBoundCanonicalReadinessLeaf(path: string, initialStat: FsStats): Promise<void> {
  const readHandle = await openCanonicalReadinessLeafReadOnly(path);
  if (!readHandle) {
    return;
  }
  try {
    const fdStat = await readHandle.stat();
    assertCurrentOwnedBoundCanonicalLeaf(initialStat, fdStat);
    await restoreOwnerReadWriteOnBoundLeaf(readHandle, fdStat);
  } finally {
    await readHandle.close().catch(() => undefined);
  }

  const writeHandle = await openCanonicalReadinessLeafReadWrite(path);
  if (!writeHandle) {
    return;
  }
  let wroteTombstone = false;
  try {
    const fdStat = await writeHandle.stat();
    assertCurrentOwnedBoundCanonicalLeaf(initialStat, fdStat);

    const note = await readBoundReadinessNote(writeHandle);
    if (note?.status !== "passed") {
      return;
    }

    await writeStalePassTombstone(writeHandle);
    wroteTombstone = true;
  } finally {
    await writeHandle.close().catch(() => undefined);
  }

  if (wroteTombstone) {
    if (await canonicalPathParsesAsPassed(path)) {
      throw new LocalSmokeError(AUTHORITY_IN_PLACE_INVALIDATION_MESSAGE);
    }
    await unlinkLocalEntryAfterVerifiedInvalidation(path);
  }
}

async function openCanonicalReadinessLeafReadOnly(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    if (isNodeErrorWithCode(error, "ELOOP")) {
      await unlinkLocalEntry(path);
      return undefined;
    }
    if (isNodeErrorWithCode(error, "EACCES") || isNodeErrorWithCode(error, "EPERM")) {
      await unlinkDeniedReadLeaf(path);
      return undefined;
    }
    throw error;
  }
}

async function openCanonicalReadinessLeafReadWrite(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    if (
      isNodeErrorWithCode(error, "ELOOP") ||
      isNodeErrorWithCode(error, "EACCES") ||
      isNodeErrorWithCode(error, "EPERM")
    ) {
      throw new LocalSmokeError(AUTHORITY_IN_PLACE_INVALIDATION_MESSAGE);
    }
    throw error;
  }
}

async function unlinkDeniedReadLeaf(path: string): Promise<void> {
  try {
    await unlinkLocalEntry(path);
  } catch (error) {
    if (isNodeErrorWithCode(error, "EACCES") || isNodeErrorWithCode(error, "EPERM")) {
      throw new LocalSmokeError(AUTHORITY_IN_PLACE_INVALIDATION_MESSAGE);
    }
    throw error;
  }
}

function assertCurrentOwnedBoundCanonicalLeaf(initialStat: FsStats, fdStat: FsStats): void {
  if (
    !initialStat.isFile() ||
    initialStat.nlink !== 1 ||
    initialStat.size > MAX_PRIOR_READINESS_NOTE_BYTES ||
    !fdStat.isFile() ||
    fdStat.nlink !== 1 ||
    fdStat.size > MAX_PRIOR_READINESS_NOTE_BYTES
  ) {
    throw new LocalSmokeError(AUTHORITY_IN_PLACE_INVALIDATION_MESSAGE);
  }
  if (
    typeof initialStat.uid !== "number" ||
    typeof initialStat.mode !== "number" ||
    typeof fdStat.uid !== "number" ||
    typeof fdStat.mode !== "number"
  ) {
    throw new LocalSmokeError(AUTHORITY_UNSUPPORTED_UID_MESSAGE);
  }
  const uid = currentUid();
  if (initialStat.uid !== uid || fdStat.uid !== uid) {
    throw new LocalSmokeError(AUTHORITY_LEAF_NOT_OWNED_MESSAGE);
  }
  if (!sameFileIdentity(initialStat, fdStat)) {
    throw new LocalSmokeError(AUTHORITY_IN_PLACE_INVALIDATION_MESSAGE);
  }
}

function sameFileIdentity(left: FsStats, right: FsStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function restoreOwnerReadWriteOnBoundLeaf(handle: FileHandle, fdStat: FsStats): Promise<void> {
  if (typeof fdStat.mode !== "number") {
    throw new LocalSmokeError(AUTHORITY_UNSUPPORTED_UID_MESSAGE);
  }
  const permissionBits = fdStat.mode & 0o7777;
  if ((permissionBits & OWNER_RW_BITS) === OWNER_RW_BITS) {
    return;
  }

  try {
    await handle.chmod(permissionBits | OWNER_RW_BITS);
  } catch (error) {
    if (isNodeErrorWithCode(error, "EACCES") || isNodeErrorWithCode(error, "EPERM")) {
      throw new LocalSmokeError(AUTHORITY_IN_PLACE_INVALIDATION_MESSAGE);
    }
    throw error;
  }
}

async function readBoundReadinessNote(handle: FileHandle): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (isNodeErrorWithCode(error, "EACCES") || isNodeErrorWithCode(error, "EPERM")) {
      throw new LocalSmokeError(AUTHORITY_IN_PLACE_INVALIDATION_MESSAGE);
    }
    throw error;
  }

  try {
    return readOptionalRecord(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

async function writeStalePassTombstone(handle: FileHandle): Promise<void> {
  const tombstone = Buffer.from(STALE_PASS_TOMBSTONE_TEXT, "utf8");
  try {
    await handle.truncate(0);
    await handle.write(tombstone, 0, tombstone.byteLength, 0);
    await handle.sync();
  } catch (error) {
    if (isNodeErrorWithCode(error, "EACCES") || isNodeErrorWithCode(error, "EPERM")) {
      throw new LocalSmokeError(AUTHORITY_IN_PLACE_INVALIDATION_MESSAGE);
    }
    throw error;
  }
}

async function canonicalPathParsesAsPassed(path: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1 || stat.size > MAX_PRIOR_READINESS_NOTE_BYTES) {
    return true;
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "EACCES") || isNodeErrorWithCode(error, "EPERM")) {
      return true;
    }
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return readOptionalRecord(parsed)?.status === "passed";
  } catch {
    return false;
  }
}

async function unlinkLocalEntryAfterVerifiedInvalidation(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return;
    }
    if (
      (isNodeErrorWithCode(error, "EACCES") || isNodeErrorWithCode(error, "EPERM")) &&
      !(await canonicalPathParsesAsPassed(path))
    ) {
      return;
    }
    throw error;
  }
}

async function sanitizeCanonicalAncestorsForInvalidation(
  realRepoRoot: string
): Promise<string | undefined> {
  const workspaceDir = join(realRepoRoot, "workspace");
  const readinessDir = join(workspaceDir, "readiness");
  if (!(await keepOwnedDirectoryOrRemoveLocalEntry(workspaceDir, workspaceDir))) {
    return undefined;
  }
  if (!(await keepOwnedDirectoryOrRemoveLocalEntry(readinessDir, readinessDir))) {
    return undefined;
  }
  return readinessDir;
}

async function keepOwnedDirectoryOrRemoveLocalEntry(
  path: string,
  expectedRealPath: string
): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      await unlinkLocalEntry(path);
      return false;
    }
    await assertAndRestoreOwnedDirectoryAuthority(path, expectedRealPath, stat);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function writeCanonicalReadinessNote(note: CanonicalReadinessNote): Promise<string> {
  assertCanonicalReadinessNote(note);
  const realRepoRoot = await realpath(DEFAULT_REPO_ROOT);
  const readinessDir = await ensureCanonicalAncestorsForPublish(realRepoRoot);
  const notePath = join(readinessDir, DEFAULT_READINESS_NOTE_NAME);
  await assertSafeCanonicalFinalEntry(notePath);
  const tempPath = join(readinessDir, `.${DEFAULT_READINESS_NOTE_NAME}.${process.pid}.${randomUUID()}.tmp`);
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

async function ensureCanonicalAncestorsForPublish(realRepoRoot: string): Promise<string> {
  const workspaceDir = join(realRepoRoot, "workspace");
  const readinessDir = join(workspaceDir, "readiness");
  await ensureOwnedDirectoryReplacingLocalEntry(workspaceDir, workspaceDir);
  await ensureOwnedDirectoryReplacingLocalEntry(readinessDir, readinessDir);
  const realReadinessDir = await realpath(readinessDir);
  const expectedReadinessDir = join(realRepoRoot, "workspace", "readiness");
  if (realReadinessDir !== expectedReadinessDir) {
    throw new Error("Readiness note directory must resolve under workspace/readiness.");
  }
  return readinessDir;
}

async function ensureOwnedDirectoryReplacingLocalEntry(
  path: string,
  expectedRealPath: string
): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      await unlinkLocalEntry(path);
      await mkdir(path, { mode: 0o700 });
      await assertAndRestoreOwnedDirectoryAuthority(path, expectedRealPath);
      return;
    }
    await assertAndRestoreOwnedDirectoryAuthority(path, expectedRealPath, stat);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
    await mkdir(path, { mode: 0o700 });
    await assertAndRestoreOwnedDirectoryAuthority(path, expectedRealPath);
  }
}

async function assertAndRestoreOwnedDirectoryAuthority(
  path: string,
  expectedRealPath: string,
  existingStat?: Awaited<ReturnType<typeof lstat>>
): Promise<void> {
  const uid = currentUid();
  const stat = existingStat ?? await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new LocalSmokeError(AUTHORITY_REALPATH_MESSAGE);
  }
  if (typeof stat.uid !== "number" || typeof stat.mode !== "number") {
    throw new LocalSmokeError(AUTHORITY_UNSUPPORTED_UID_MESSAGE);
  }
  if (stat.uid !== uid) {
    throw new LocalSmokeError(AUTHORITY_NOT_OWNED_MESSAGE);
  }
  const permissionBits = stat.mode & 0o7777;
  if ((permissionBits & OWNER_RWX_BITS) !== OWNER_RWX_BITS) {
    await chmod(path, permissionBits | OWNER_RWX_BITS);
  }
  const actualRealPath = await realpath(path);
  if (actualRealPath !== expectedRealPath) {
    throw new LocalSmokeError(AUTHORITY_REALPATH_MESSAGE);
  }
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new LocalSmokeError(AUTHORITY_UNSUPPORTED_UID_MESSAGE);
  }
  return process.getuid();
}

async function assertSafeCanonicalFinalEntry(path: string): Promise<void> {
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

function createCanonicalReadinessNote(coreResult: SmokeCoreResult): CanonicalReadinessNote {
  const base = {
    schema_version: "m1.glm-provider-smoke.v1" as const,
    kind: "glm_provider_smoke" as const,
    evidence_scope: "canonical" as const,
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

function canonicalResultFromCore(
  coreResult: SmokeCoreResult,
  note: CanonicalReadinessNote,
  readinessNotePath: string
): CanonicalSmokeRunResult {
  const shared = {
    evidenceScope: "canonical" as const,
    readinessNoteName: DEFAULT_READINESS_NOTE_NAME as typeof DEFAULT_READINESS_NOTE_NAME,
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

function assertCanonicalReadinessNote(note: CanonicalReadinessNote): void {
  const record = note as unknown as Record<string, unknown>;
  const requiredShared = [
    "schema_version",
    "kind",
    "evidence_scope",
    "checked_at",
    "provider_name",
    "api_type",
    "base_url",
    "endpoint",
    "smoke_model",
    "target_model_id",
    "status",
    "model_admission",
    "secret_ref",
    "attempts",
    "configured_base_url_hit",
    "completion_nonempty"
  ];
  const allowedKeys = note.status === "passed"
    ? [...requiredShared, "response_url"]
    : [...requiredShared, "failure"];
  assertExactKeys(record, allowedKeys, "canonical readiness note");
  assertEquals(record.schema_version, "m1.glm-provider-smoke.v1", "schema_version");
  assertEquals(record.kind, "glm_provider_smoke", "kind");
  assertEquals(record.evidence_scope, "canonical", "evidence_scope");
  assertIsoTimestamp(record.checked_at, "checked_at");
  assertEquals(record.provider_name, CANONICAL_PROVIDER_NAME, "provider_name");
  assertEquals(record.api_type, "openai_chat_completions", "api_type");
  assertEquals(record.base_url, CANONICAL_BASE_URL, "base_url");
  assertEquals(record.endpoint, CANONICAL_ENDPOINT, "endpoint");
  assertEquals(record.smoke_model, CANONICAL_SMOKE_MODEL, "smoke_model");
  assertEquals(record.target_model_id, CANONICAL_TARGET_MODEL, "target_model_id");
  assertEquals(record.model_admission, false, "model_admission");
  assertEquals(record.secret_ref, GLM_API_KEY_REF, "secret_ref");
  assertSafeAttempts(record.attempts, "attempts");
  assertEquals(typeof record.configured_base_url_hit, "boolean", "configured_base_url_hit type");

  if (note.status === "passed") {
    assertEquals(record.status, "passed", "status");
    assertEquals(record.configured_base_url_hit, true, "configured_base_url_hit");
    assertEquals(record.completion_nonempty, true, "completion_nonempty");
    assertEquals(record.response_url, CANONICAL_ENDPOINT, "response_url");
    return;
  }

  assertEquals(record.status, "failed", "status");
  assertEquals(record.completion_nonempty, false, "completion_nonempty");
  assertCanonicalFailure(record.failure);
}

function assertCanonicalFailure(value: unknown): void {
  const failure = readRecord(value, "failure");
  const category = failure.category;
  assertFailureCategory(category);
  const allowedKeys = category === "http_error"
    ? ["category", "message", "http_status"]
    : ["category", "message"];
  assertExactKeys(failure, allowedKeys, "failure");
  if (typeof failure.message !== "string" || failure.message.length === 0) {
    throw new Error("Invalid canonical readiness failure.message.");
  }
  if (category === "http_error") {
    const httpStatus = failure.http_status;
    if (!isReachableHttpErrorStatus(httpStatus)) {
      throw new Error("Invalid canonical readiness failure.http_status.");
    }
    assertEquals(
      failure.message,
      `Provider returned HTTP ${httpStatus} from configured endpoint.`,
      "failure.message"
    );
    return;
  }

  if (category === "base_url_mismatch") {
    if (!isKnownBaseUrlMismatchMessage(failure.message)) {
      throw new Error("Invalid canonical readiness failure.message.");
    }
    return;
  }

  if (failure.message !== expectedFailureMessage(category)) {
    throw new Error("Invalid canonical readiness failure.message.");
  }
}

function expectedFailureMessage(category: Exclude<SmokeFailureCategory, "base_url_mismatch" | "http_error">): string {
  switch (category) {
    case "missing_key":
      return `Missing required environment variable ${GLM_API_KEY_ENV}.`;
    case "invalid_response":
      return "Provider response was not valid JSON.";
    case "empty_completion":
      return "Provider response did not contain a nonempty completion.";
    case "oversized_response":
      return `Provider response exceeded ${MAX_RESPONSE_BYTES} bytes.`;
    case "timeout":
      return "Provider request timed out.";
    case "network_error":
      return "Provider request failed before a valid response was received.";
  }
}

function isKnownBaseUrlMismatchMessage(message: string): boolean {
  return [
    "Computed chat completions endpoint does not use the configured base URL.",
    "Provider response was redirected away from the configured endpoint.",
    "Provider response did not expose a final URL for configured endpoint validation.",
    "Provider response URL could not be validated against the configured endpoint.",
    "Provider response URL did not match the configured endpoint."
  ].includes(message);
}

function assertFailureCategory(category: unknown): asserts category is SmokeFailureCategory {
  if (
    category !== "missing_key" &&
    category !== "base_url_mismatch" &&
    category !== "http_error" &&
    category !== "invalid_response" &&
    category !== "empty_completion" &&
    category !== "oversized_response" &&
    category !== "timeout" &&
    category !== "network_error"
  ) {
    throw new Error("Invalid canonical readiness failure.category.");
  }
}

function assertExactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${label} keys.`);
  }
}

function assertIsoTimestamp(value: unknown, label: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid canonical readiness ${label}.`);
  }
}

function assertSafeAttempts(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_RETRIES + 1) {
    throw new Error(`Invalid canonical readiness ${label}.`);
  }
}

function assertEquals(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`Invalid canonical readiness ${label}.`);
  }
}

function readRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected object at ${context}.`);
  }
  return value as Record<string, unknown>;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

async function unlinkLocalEntry(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function unlinkUnsafeFinalEntry(path: string): Promise<void> {
  try {
    await unlinkLocalEntry(path);
  } catch (error) {
    if (isLocalAuthorityDenied(error)) {
      throw new LocalSmokeError(AUTHORITY_UNSAFE_FINAL_ENTRY_MESSAGE);
    }
    throw error;
  }
}

function isLocalAuthorityDenied(error: unknown): boolean {
  return isNodeErrorWithCode(error, "EACCES") || isNodeErrorWithCode(error, "EPERM");
}

function isNodeErrorWithCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && (error as Error & { code?: string }).code === code;
}
