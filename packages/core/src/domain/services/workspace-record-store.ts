import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { TaskServiceError, type TaskServiceErrorCode } from "./task-card-service";

export const MAX_SERVICE_RECORD_BYTES = 1024 * 1024;

const SAFE_RECORD_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SERVICE_RECORD_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

type FileStat = Awaited<ReturnType<typeof lstat>>;
type RecordFileHandle = Awaited<ReturnType<typeof open>>;

export function assertSafeRecordSegment(segment: string, evidenceRef: string): void {
  if (SAFE_RECORD_SEGMENT_PATTERN.test(segment)) {
    return;
  }

  throw new TaskServiceError({
    code: "record_id_not_safe",
    status: 400,
    category: "schema_error",
    message: "Record id is not a safe workspace path segment.",
    userMessage: "The record id contains unsupported path characters.",
    evidenceRefs: [evidenceRef],
    recommendedNextActions: ["Use an id made from letters, numbers, dots, dashes, or underscores."]
  });
}

export function assertSafeRelativeRecordPath(path: string, evidenceRef: string): void {
  const normalizedPath = normalize(path);
  const segments = normalizedPath.split(sep).filter(Boolean);
  if (
    path.trim().length > 0 &&
    !isAbsolute(path) &&
    normalizedPath !== "." &&
    normalizedPath !== ".." &&
    !normalizedPath.startsWith(`..${sep}`) &&
    !segments.includes("..")
  ) {
    return;
  }

  throw new TaskServiceError({
    code: "record_id_not_safe",
    status: 400,
    category: "schema_error",
    message: "Record path is not a safe workspace-relative path.",
    userMessage: "The record path must stay inside the workspace.",
    evidenceRefs: [evidenceRef],
    recommendedNextActions: ["Use a workspace-relative path without parent-directory traversal."]
  });
}

export function workspaceRecordPath(
  workspaceRoot: string,
  relativeSegments: readonly string[],
  evidenceRef: string
): string {
  const resolvedRoot = resolve(workspaceRoot);
  const targetPath = join(resolvedRoot, ...relativeSegments);
  assertPathInsideWorkspace(resolvedRoot, targetPath, evidenceRef);
  return targetPath;
}

export async function ensureWorkspaceRecordDirectory(
  workspaceRoot: string,
  relativeSegments: readonly string[],
  evidenceRef: string
): Promise<string> {
  const resolvedRoot = resolve(workspaceRoot);
  await ensureSafeDirectory(resolvedRoot, "workspace");

  let currentPath = resolvedRoot;
  for (const segment of relativeSegments) {
    currentPath = join(currentPath, segment);
    assertPathInsideWorkspace(resolvedRoot, currentPath, evidenceRef);
    await ensureSafeDirectory(currentPath, evidenceRef);
  }

  return currentPath;
}

export async function readJsonRecord<T>(
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<T | undefined> {
  const existingEntry = await maybeLstat(path);
  if (!existingEntry) {
    return undefined;
  }
  if (!existingEntry.isFile() || existingEntry.isSymbolicLink()) {
    throw serviceWorkspaceError(
      "record_malformed",
      "Record path is not a safe regular file.",
      "A workspace record cannot be read safely.",
      [evidenceRef]
    );
  }
  if (existingEntry.size > MAX_SERVICE_RECORD_BYTES) {
    throw serviceWorkspaceError(
      "record_malformed",
      "Record exceeds the M1 bounded read size.",
      "A workspace record is too large to read safely.",
      [evidenceRef]
    );
  }
  if (!(await isSafeExistingDirectoryPath(dirname(path)))) {
    throw serviceWorkspaceError(
      "record_malformed",
      "Record parent path is not a safe directory.",
      "A workspace record cannot be read safely.",
      [evidenceRef]
    );
  }

  let recordFile: RecordFileHandle;
  try {
    recordFile = await open(path, SERVICE_RECORD_OPEN_FLAGS);
  } catch (error) {
    throw serviceWorkspaceError(
      "record_malformed",
      "Record cannot be opened safely.",
      "A workspace record cannot be read safely.",
      [evidenceRef],
      error
    );
  }

  let rawText: string;
  try {
    if (!(await isSafeExistingDirectoryPath(dirname(path)))) {
      throw serviceWorkspaceError(
        "record_malformed",
        "Record parent path is not a safe directory.",
        "A workspace record cannot be read safely.",
        [evidenceRef]
      );
    }

    const recordEntry = await recordFile.stat().catch((error: unknown) => {
      throw serviceWorkspaceError(
        "record_malformed",
        "Record cannot be inspected.",
        "A workspace record cannot be read safely.",
        [evidenceRef],
        error
      );
    });
    if (!recordEntry.isFile() || recordEntry.isSymbolicLink()) {
      throw serviceWorkspaceError(
        "record_malformed",
        "Record path is not a safe regular file.",
        "A workspace record cannot be read safely.",
        [evidenceRef]
      );
    }
    if (recordEntry.size > MAX_SERVICE_RECORD_BYTES) {
      throw serviceWorkspaceError(
        "record_malformed",
        "Record exceeds the M1 bounded read size.",
        "A workspace record is too large to read safely.",
        [evidenceRef]
      );
    }

    rawText = await readBoundedJsonRecord(recordFile, evidenceRef);
  } finally {
    await recordFile.close().catch(() => undefined);
  }

  let rawRecord: unknown;
  try {
    rawRecord = JSON.parse(rawText) as unknown;
  } catch (error) {
    throw serviceWorkspaceError(
      "record_malformed",
      "Record is not valid JSON.",
      "A workspace record is malformed.",
      [evidenceRef],
      error
    );
  }

  const parsedRecord = schema.safeParse(rawRecord);
  if (!parsedRecord.success) {
    throw new TaskServiceError({
      code: "record_schema_error",
      status: 400,
      category: "schema_error",
      message: "Workspace record failed schema validation.",
      userMessage: "A workspace record has invalid fields.",
      evidenceRefs: toSchemaEvidenceRefs(parsedRecord.error, evidenceRef),
      recommendedNextActions: ["Inspect and repair the workspace record before retrying."]
    });
  }

  return parsedRecord.data;
}

async function readBoundedJsonRecord(
  recordFile: RecordFileHandle,
  evidenceRef: string
): Promise<string> {
  const buffer = Buffer.allocUnsafe(MAX_SERVICE_RECORD_BYTES + 1);
  let offset = 0;

  try {
    while (offset < buffer.length) {
      const { bytesRead } = await recordFile.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
  } catch (error) {
    throw serviceWorkspaceError(
      "record_malformed",
      "Record cannot be read safely.",
      "A workspace record cannot be read safely.",
      [evidenceRef],
      error
    );
  }

  if (offset > MAX_SERVICE_RECORD_BYTES) {
    throw serviceWorkspaceError(
      "record_malformed",
      "Record exceeds the M1 bounded read size.",
      "A workspace record is too large to read safely.",
      [evidenceRef]
    );
  }

  return buffer.subarray(0, offset).toString("utf8");
}

export async function writeJsonRecord<T>(
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  record: T,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<T> {
  const parsedRecord = schema.safeParse(record);
  if (!parsedRecord.success) {
    throw new TaskServiceError({
      code: "record_schema_error",
      status: 400,
      category: "schema_error",
      message: "Workspace record failed schema validation.",
      userMessage: "The record is missing required fields or contains invalid values.",
      evidenceRefs: toSchemaEvidenceRefs(parsedRecord.error, evidenceRef),
      recommendedNextActions: ["Fix the record fields and retry."]
    });
  }

  assertSafeRecordSegment(fileName.replace(/\.json$/, ""), `${evidenceRef}:file`);

  const directoryPath = await ensureWorkspaceRecordDirectory(
    workspaceRoot,
    relativeDirectorySegments,
    evidenceRef
  );
  const recordPath = join(directoryPath, fileName);
  assertPathInsideWorkspace(resolve(workspaceRoot), recordPath, evidenceRef);

  const recordText = `${JSON.stringify(parsedRecord.data, null, 2)}\n`;
  if (Buffer.byteLength(recordText, "utf8") > MAX_SERVICE_RECORD_BYTES) {
    throw new TaskServiceError({
      code: "record_schema_error",
      status: 400,
      category: "schema_error",
      message: "Workspace record would exceed the M1 bounded size.",
      userMessage: "The record is too large to persist safely.",
      evidenceRefs: [evidenceRef],
      recommendedNextActions: ["Reduce record field sizes and retry."]
    });
  }

  const temporaryPath = join(directoryPath, `.${fileName}-${process.pid}-${randomUUID()}.tmp`);
  let wroteTemporary = false;
  try {
    await writeFile(temporaryPath, recordText, { flag: "wx" });
    wroteTemporary = true;
    if (!(await isSafeExistingDirectoryPath(directoryPath))) {
      throw serviceWorkspaceError(
        "workspace_path_not_safe",
        "Record directory is not a safe directory.",
        "A workspace record directory is not usable.",
        [evidenceRef]
      );
    }
    await rename(temporaryPath, recordPath);
    wroteTemporary = false;
  } catch (error) {
    if (error instanceof TaskServiceError) {
      throw error;
    }
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Failed to persist workspace record.",
      "The workspace record could not be written safely.",
      [evidenceRef],
      error
    );
  } finally {
    if (wroteTemporary) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  return parsedRecord.data;
}

export function assertPathInsideWorkspace(
  workspaceRoot: string,
  targetPath: string,
  evidenceRef: string
): void {
  const relativePath = relative(resolve(workspaceRoot), resolve(targetPath));
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return;
  }

  throw serviceWorkspaceError(
    "workspace_path_not_safe",
    "Resolved path escapes the configured workspace.",
    "A workspace path resolved outside the configured workspace.",
    [evidenceRef]
  );
}

function serviceWorkspaceError(
  code: Extract<
    TaskServiceErrorCode,
    "workspace_path_not_safe" | "record_malformed"
  >,
  message: string,
  userMessage: string,
  evidenceRefs: string[],
  cause?: unknown
): TaskServiceError {
  const error = new TaskServiceError({
    code,
    status: 500,
    category: "workspace_error",
    message,
    userMessage,
    evidenceRefs,
    retryable: false,
    recommendedNextActions: ["Inspect the workspace record state before retrying."]
  });

  if (cause instanceof Error) {
    error.cause = cause;
  }

  return error;
}

async function ensureSafeDirectory(path: string, evidenceRef: string): Promise<void> {
  const existingEntry = await maybeLstat(path);
  if (existingEntry) {
    if (!(await isSafeExistingDirectoryPath(path))) {
      throw serviceWorkspaceError(
        "workspace_path_not_safe",
        "Path is not a safe directory.",
        "A required workspace path is not a safe directory.",
        [evidenceRef]
      );
    }
    return;
  }

  const parentPath = dirname(path);
  if (parentPath === path || !(await isSafeExistingDirectoryPath(parentPath))) {
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Parent path is not a safe directory.",
      "A required workspace parent path is not a safe directory.",
      [`${evidenceRef}:parent`]
    );
  }

  try {
    await mkdir(path);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST") && (await isSafeExistingDirectoryPath(path))) {
      return;
    }

    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Failed to create workspace directory.",
      "A required workspace directory could not be created safely.",
      [evidenceRef],
      error
    );
  }

  if (!(await isSafeExistingDirectoryPath(path))) {
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Created path is not a safe directory.",
      "A required workspace path is not a safe directory.",
      [evidenceRef]
    );
  }
}

async function isSafeExistingDirectoryPath(path: string): Promise<boolean> {
  const { rootPath, segments } = getPathParts(path);
  const rootEntry = await maybeLstat(rootPath);
  if (!isSafeDirectoryEntry(rootEntry)) {
    return false;
  }

  let currentPath = rootPath;
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    const entry = await maybeLstat(currentPath);
    if (!isSafeDirectoryEntry(entry)) {
      return false;
    }
  }

  return true;
}

function getPathParts(path: string): { rootPath: string; segments: string[] } {
  const resolvedPath = resolve(path);
  const rootPath = parse(resolvedPath).root;
  return {
    rootPath,
    segments: resolvedPath.slice(rootPath.length).split(sep).filter(Boolean)
  };
}

function isSafeDirectoryEntry(entry: FileStat | undefined): boolean {
  return Boolean(entry?.isDirectory() && !entry.isSymbolicLink());
}

async function maybeLstat(path: string): Promise<FileStat | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

function toSchemaEvidenceRefs(error: z.ZodError, prefix: string): string[] {
  return Array.from(
    new Set(
      error.issues.map((issue) =>
        issue.path.length > 0 ? `${prefix}.${issue.path.join(".")}` : prefix
      )
    )
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
