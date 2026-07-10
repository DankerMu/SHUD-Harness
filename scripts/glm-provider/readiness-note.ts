import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_READINESS_NOTE_NAME = "glm_provider_smoke.json";
export const FIXTURE_READINESS_NOTE_NAME = "glm_provider_smoke.fixture.json";
export const MAX_PRIOR_READINESS_NOTE_BYTES = 64 * 1024;
const CANONICAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ReadinessNoteDocument {
  status: string;
}

export async function writeCanonicalReadinessNote(note: ReadinessNoteDocument): Promise<string> {
  return await writeOwnedReadinessNote(CANONICAL_REPO_ROOT, note, DEFAULT_READINESS_NOTE_NAME);
}

export async function writeFixtureReadinessNote(
  repoRoot: string,
  note: ReadinessNoteDocument
): Promise<string> {
  return await writeOwnedReadinessNote(repoRoot, note, FIXTURE_READINESS_NOTE_NAME);
}

export async function invalidatePassingReadinessNote(repoRoot: string): Promise<void> {
  const realRepoRoot = await realpath(repoRoot);
  const workspaceDir = join(realRepoRoot, "workspace");
  const readinessDir = join(workspaceDir, "readiness");
  if (!(await existingOwnedDirectory(workspaceDir, "workspace"))) {
    return;
  }
  if (!(await existingOwnedDirectory(readinessDir, "workspace/readiness"))) {
    return;
  }

  const realReadinessDir = await realpath(readinessDir);
  const expectedReadinessDir = join(realRepoRoot, "workspace", "readiness");
  if (realReadinessDir !== expectedReadinessDir) {
    throw new Error("Readiness note directory must resolve under workspace/readiness.");
  }

  const notePath = join(readinessDir, DEFAULT_READINESS_NOTE_NAME);
  if (!(await prepareReadinessNoteForInvalidation(notePath))) {
    return;
  }

  let raw: string;
  try {
    raw = await readFile(notePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return;
  }

  const note = readOptionalRecord(parsed);
  if (note?.status !== "passed") {
    return;
  }

  await assertSafeReadinessNoteTarget(notePath);
  try {
    await unlink(notePath);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function writeOwnedReadinessNote(
  repoRoot: string,
  note: ReadinessNoteDocument,
  noteName: typeof DEFAULT_READINESS_NOTE_NAME | typeof FIXTURE_READINESS_NOTE_NAME
): Promise<string> {
  const realRepoRoot = await realpath(repoRoot);
  const workspaceDir = join(realRepoRoot, "workspace");
  const readinessDir = join(workspaceDir, "readiness");
  await ensureOwnedDirectory(workspaceDir, "workspace");
  await ensureOwnedDirectory(readinessDir, "workspace/readiness");
  const realReadinessDir = await realpath(readinessDir);
  const expectedReadinessDir = join(realRepoRoot, "workspace", "readiness");
  if (realReadinessDir !== expectedReadinessDir) {
    throw new Error("Readiness note directory must resolve under workspace/readiness.");
  }

  const notePath = join(readinessDir, noteName);
  await assertSafeReadinessNoteTarget(notePath);
  const tempPath = join(readinessDir, `.${noteName}.${process.pid}.${randomUUID()}.tmp`);
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

async function prepareReadinessNoteForInvalidation(path: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }

  if (stat.isDirectory()) {
    throw new Error("Readiness note path must be an owned regular file.");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    try {
      await unlink(path);
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) {
        throw error;
      }
    }
    return false;
  }
  if (stat.size > MAX_PRIOR_READINESS_NOTE_BYTES) {
    try {
      await unlink(path);
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) {
        throw error;
      }
    }
    return false;
  }
  return true;
}

async function assertSafeReadinessNoteTarget(path: string): Promise<void> {
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

async function existingOwnedDirectory(path: string, label: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Readiness ${label} path must be an owned directory.`);
    }
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function ensureOwnedDirectory(path: string, label: string): Promise<void> {
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

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isNodeErrorWithCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && (error as Error & { code?: string }).code === code;
}
