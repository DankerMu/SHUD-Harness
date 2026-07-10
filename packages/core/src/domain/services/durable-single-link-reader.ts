import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

const DURABLE_READ_CHUNK_BYTES = 64 * 1024;
const DURABLE_READ_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

type DurableFileStat = Awaited<ReturnType<typeof lstat>>;

export type DurableSingleLinkReadFailureReason =
  | "inspect_failed"
  | "not_regular_file"
  | "multiple_links"
  | "too_large"
  | "open_failed"
  | "parent_not_safe"
  | "identity_changed"
  | "read_failed"
  | "changed_during_read";

export type DurableSingleLinkReadResult =
  | { status: "read"; bytes: Buffer }
  | { status: "missing"; reason: "missing" }
  | {
      status: "invalid";
      reason: DurableSingleLinkReadFailureReason;
      cause?: unknown;
    };

export interface ReadDurableSingleLinkFileOptions {
  path: string;
  maxBytes: number;
  validateParentPath?: () => Promise<boolean> | boolean;
}

export async function readDurableSingleLinkFile(
  options: ReadDurableSingleLinkFileOptions
): Promise<DurableSingleLinkReadResult> {
  assertTrustedMaxBytes(options.maxBytes);

  let pathEntry: DurableFileStat;
  try {
    pathEntry = await lstat(options.path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return { status: "missing", reason: "missing" };
    }
    return invalidRead("inspect_failed", error);
  }

  const pathFailure = validateBoundedSingleLinkFile(pathEntry, options.maxBytes);
  if (pathFailure) {
    return invalidRead(pathFailure);
  }

  const parentBeforeOpen = await validateParentPath(options.validateParentPath);
  if (parentBeforeOpen.status === "invalid") {
    return parentBeforeOpen;
  }

  let file: FileHandle;
  try {
    file = await open(options.path, DURABLE_READ_OPEN_FLAGS);
  } catch (error) {
    return invalidRead("open_failed", error);
  }

  try {
    const parentBeforeRead = await validateParentPath(options.validateParentPath);
    if (parentBeforeRead.status === "invalid") {
      return parentBeforeRead;
    }

    let beforeRead: DurableFileStat;
    try {
      beforeRead = await file.stat();
    } catch (error) {
      return invalidRead("inspect_failed", error);
    }
    const beforeFailure = validateBoundedSingleLinkFile(beforeRead, options.maxBytes);
    if (beforeFailure) {
      return invalidRead(beforeFailure);
    }
    if (!sameFileIdentity(pathEntry, beforeRead)) {
      return invalidRead("identity_changed");
    }

    let bytes: Buffer;
    try {
      bytes = await readBoundedChunks(file, options.maxBytes, beforeRead.size);
    } catch (error) {
      return invalidRead("read_failed", error);
    }

    let afterRead: DurableFileStat;
    try {
      afterRead = await file.stat();
    } catch (error) {
      return invalidRead("inspect_failed", error);
    }
    const afterFailure = validateBoundedSingleLinkFile(afterRead, options.maxBytes);
    if (afterFailure) {
      return invalidRead(afterFailure);
    }
    if (
      !sameFileIdentity(pathEntry, afterRead) ||
      !sameFileIdentity(beforeRead, afterRead)
    ) {
      return invalidRead("identity_changed");
    }
    if (
      pathEntry.size !== beforeRead.size ||
      beforeRead.size !== afterRead.size ||
      bytes.length !== afterRead.size
    ) {
      return invalidRead("changed_during_read");
    }

    const parentAfterRead = await validateParentPath(options.validateParentPath);
    if (parentAfterRead.status === "invalid") {
      return parentAfterRead;
    }

    return { status: "read", bytes };
  } finally {
    await file.close().catch(() => undefined);
  }
}

function validateBoundedSingleLinkFile(
  entry: DurableFileStat,
  maxBytes: number
): DurableSingleLinkReadFailureReason | undefined {
  if (!entry.isFile() || entry.isSymbolicLink()) {
    return "not_regular_file";
  }
  if (entry.nlink !== 1) {
    return "multiple_links";
  }
  if (entry.size > maxBytes) {
    return "too_large";
  }
  return undefined;
}

async function readBoundedChunks(
  file: FileHandle,
  maxBytes: number,
  checkedSize: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let offset = 0;

  for (;;) {
    const remaining = maxBytes + 1 - offset;
    if (remaining <= 0) {
      break;
    }
    const chunkSize =
      offset === 0
        ? Math.max(1, Math.min(remaining, checkedSize + 1, DURABLE_READ_CHUNK_BYTES))
        : Math.min(remaining, DURABLE_READ_CHUNK_BYTES);
    const chunk = Buffer.allocUnsafe(chunkSize);
    const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    offset += bytesRead;
    if (bytesRead < chunk.length) {
      break;
    }
  }

  return Buffer.concat(chunks, offset);
}

async function validateParentPath(
  validator: ReadDurableSingleLinkFileOptions["validateParentPath"]
): Promise<DurableSingleLinkReadResult | { status: "valid" }> {
  if (!validator) {
    return { status: "valid" };
  }
  try {
    return (await validator())
      ? { status: "valid" }
      : invalidRead("parent_not_safe");
  } catch (error) {
    return invalidRead("parent_not_safe", error);
  }
}

function invalidRead(
  reason: DurableSingleLinkReadFailureReason,
  cause?: unknown
): Extract<DurableSingleLinkReadResult, { status: "invalid" }> {
  return cause === undefined
    ? { status: "invalid", reason }
    : { status: "invalid", reason, cause };
}

function sameFileIdentity(left: DurableFileStat, right: DurableFileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertTrustedMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("Durable read maxBytes must be a nonnegative safe integer.");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
