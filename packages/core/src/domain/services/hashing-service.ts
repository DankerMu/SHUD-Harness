import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  WorkspacePathSafetyError,
  resolveWorkspacePath
} from "./workspace-path-safety";

const HASH_STREAM_CHUNK_BYTES = 64 * 1024;
const HASH_FILE_OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

export interface HashingServiceInput {
  workspaceRoot: string;
  inputPath: string;
  evidenceRef: string;
  allowedReadonlyRoots?: readonly string[];
}

export interface HashingServiceHooks {
  afterDirectoryEnumeration?: (
    input: Readonly<{
      directoryPath: string;
      relativeFilePaths: readonly string[];
    }>
  ) => Promise<void> | void;
  beforeFileOpen?: (
    input: Readonly<{
      absolutePath: string;
      relativePath?: string;
    }>
  ) => Promise<void> | void;
}

type ObservedEntryKind = "directory" | "file";

interface ObservedEntry {
  absolutePath: string;
  relativePath: string;
  kind: ObservedEntryKind;
  stat: BigIntStats;
}

interface DirectoryObservation {
  entries: readonly ObservedEntry[];
  files: readonly ObservedEntry[];
}

const hashingServiceHookStorage = new AsyncLocalStorage<HashingServiceHooks>();

export async function runWithHashingServiceHooksForTest<T>(
  hooks: HashingServiceHooks,
  action: () => Promise<T>
): Promise<T> {
  return await hashingServiceHookStorage.run(hooks, action);
}

export async function hashFile(input: HashingServiceInput): Promise<string> {
  try {
    const resolution = await resolveHashingPath(input);
    const observed = await observeExpectedEntry(
      resolution.absolutePath,
      "file",
      input.evidenceRef
    );
    return await hashObservedFile(input, {
      absolutePath: resolution.absolutePath,
      relativePath: "",
      kind: "file",
      stat: observed
    });
  } catch (error) {
    throw hashingSafetyError(error, input.evidenceRef, "File hashing failed safely.");
  }
}

export async function hashDirectory(input: HashingServiceInput): Promise<string> {
  try {
    const resolution = await resolveHashingPath(input);
    const rootStat = await observeExpectedEntry(
      resolution.absolutePath,
      "directory",
      input.evidenceRef
    );
    const initial = await observeDirectoryTree(
      input,
      resolution.absolutePath,
      rootStat
    );
    if (initial.files.length === 0) {
      throw new WorkspacePathSafetyError(
        "Hash directory contains no regular files.",
        input.evidenceRef
      );
    }

    await invokeAfterDirectoryEnumerationHook(resolution.absolutePath, initial.files);

    const directoryHash = createHash("sha256");
    for (const file of initial.files) {
      const fileDigest = await hashObservedFile(input, file);
      directoryHash.update(file.relativePath, "utf8");
      directoryHash.update("\n", "utf8");
      directoryHash.update(fileDigest, "ascii");
      directoryHash.update("\n", "utf8");
    }

    const finalRootStat = await observeExpectedEntry(
      resolution.absolutePath,
      "directory",
      input.evidenceRef
    );
    const finalObservation = await observeDirectoryTree(
      input,
      resolution.absolutePath,
      finalRootStat
    );
    assertSameDirectoryObservation(initial, finalObservation, input.evidenceRef);
    return directoryHash.digest("hex");
  } catch (error) {
    throw hashingSafetyError(error, input.evidenceRef, "Directory hashing failed safely.");
  }
}

async function resolveHashingPath(input: HashingServiceInput) {
  return await resolveWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    inputPath: input.inputPath,
    evidenceRef: input.evidenceRef,
    access: "read",
    allowedReadonlyRoots: input.allowedReadonlyRoots
  });
}

async function observeDirectoryTree(
  input: HashingServiceInput,
  rootPath: string,
  rootStat: BigIntStats
): Promise<DirectoryObservation> {
  const entries: ObservedEntry[] = [
    { absolutePath: rootPath, relativePath: "", kind: "directory", stat: rootStat }
  ];
  const files: ObservedEntry[] = [];
  await observeDirectory(input, rootPath, [], rootStat, entries, files);
  entries.sort(compareObservedEntries);
  files.sort(compareObservedEntries);
  return Object.freeze({
    entries: Object.freeze(entries),
    files: Object.freeze(files)
  });
}

async function observeDirectory(
  input: HashingServiceInput,
  directoryPath: string,
  relativeSegments: readonly string[],
  expectedDirectory: BigIntStats,
  entries: ObservedEntry[],
  files: ObservedEntry[]
): Promise<void> {
  await assertPathStillInsideBoundary(input, directoryPath);
  const beforeEnumeration = await observeExpectedEntry(
    directoryPath,
    "directory",
    input.evidenceRef
  );
  assertStableEntry(expectedDirectory, beforeEnumeration, input.evidenceRef);

  const children = await readdir(directoryPath, { withFileTypes: true });
  const afterEnumeration = await observeExpectedEntry(
    directoryPath,
    "directory",
    input.evidenceRef
  );
  assertStableEntry(beforeEnumeration, afterEnumeration, input.evidenceRef);

  children.sort((left, right) => compareCanonicalPath(left.name, right.name));
  for (const child of children) {
    const childSegments = [...relativeSegments, child.name];
    const relativePath = childSegments.join("/");
    const absolutePath = join(directoryPath, child.name);
    const childStat = await observeSupportedTreeEntry(absolutePath, input.evidenceRef);
    const kind: ObservedEntryKind = childStat.isDirectory() ? "directory" : "file";
    const observed = { absolutePath, relativePath, kind, stat: childStat } as const;
    entries.push(observed);
    if (kind === "file") {
      files.push(observed);
      continue;
    }
    await observeDirectory(
      input,
      absolutePath,
      childSegments,
      childStat,
      entries,
      files
    );
  }

  const afterChildren = await observeExpectedEntry(
    directoryPath,
    "directory",
    input.evidenceRef
  );
  assertStableEntry(afterEnumeration, afterChildren, input.evidenceRef);
}

async function hashObservedFile(
  input: HashingServiceInput,
  observed: ObservedEntry
): Promise<string> {
  await assertPathStillInsideBoundary(input, observed.absolutePath);
  const pathBeforeOpen = await observeExpectedEntry(
    observed.absolutePath,
    "file",
    input.evidenceRef
  );
  assertStableEntry(observed.stat, pathBeforeOpen, input.evidenceRef);
  await invokeBeforeFileOpenHook(observed);

  let file: FileHandle | undefined;
  let digest: string | undefined;
  let failure: unknown;
  try {
    file = await open(observed.absolutePath, HASH_FILE_OPEN_FLAGS);
    const descriptorBeforeRead = await file.stat({ bigint: true });
    assertExpectedKind(descriptorBeforeRead, "file", input.evidenceRef);
    assertStableEntry(pathBeforeOpen, descriptorBeforeRead, input.evidenceRef);

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_STREAM_CHUNK_BYTES);
    let bytesHashed = 0n;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytesHashed += BigInt(bytesRead);
    }

    const descriptorAfterRead = await file.stat({ bigint: true });
    assertExpectedKind(descriptorAfterRead, "file", input.evidenceRef);
    assertStableEntry(descriptorBeforeRead, descriptorAfterRead, input.evidenceRef);
    if (bytesHashed !== descriptorAfterRead.size) {
      throw new WorkspacePathSafetyError(
        "Hash source changed while it was being read.",
        input.evidenceRef
      );
    }
    digest = hash.digest("hex");
  } catch (error) {
    failure = hashingSafetyError(error, input.evidenceRef, "Hash source could not be read safely.");
  }

  if (file) {
    try {
      await file.close();
    } catch (error) {
      failure ??= hashingSafetyError(
        error,
        input.evidenceRef,
        "Hash source descriptor could not be closed safely."
      );
    }
  }
  if (failure !== undefined) throw failure;

  await assertPathStillInsideBoundary(input, observed.absolutePath);
  const pathAfterRead = await observeExpectedEntry(
    observed.absolutePath,
    "file",
    input.evidenceRef
  );
  assertStableEntry(pathBeforeOpen, pathAfterRead, input.evidenceRef);
  if (digest === undefined) {
    throw new WorkspacePathSafetyError(
      "Hash source did not produce a complete digest.",
      input.evidenceRef
    );
  }
  return digest;
}

async function assertPathStillInsideBoundary(
  input: HashingServiceInput,
  absolutePath: string
): Promise<void> {
  const resolution = await resolveWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    inputPath: absolutePath,
    evidenceRef: input.evidenceRef,
    access: "read",
    allowedReadonlyRoots: input.allowedReadonlyRoots
  });
  if (resolution.absolutePath !== absolutePath) {
    throw new WorkspacePathSafetyError(
      "Hash source path identity changed during validation.",
      input.evidenceRef
    );
  }
}

async function observeExpectedEntry(
  path: string,
  kind: ObservedEntryKind,
  evidenceRef: string
): Promise<BigIntStats> {
  let entry: BigIntStats;
  try {
    entry = await lstat(path, { bigint: true });
  } catch (error) {
    throw hashingSafetyError(error, evidenceRef, "Hash source could not be inspected safely.");
  }
  assertExpectedKind(entry, kind, evidenceRef);
  return entry;
}

async function observeSupportedTreeEntry(
  path: string,
  evidenceRef: string
): Promise<BigIntStats> {
  let entry: BigIntStats;
  try {
    entry = await lstat(path, { bigint: true });
  } catch (error) {
    throw hashingSafetyError(error, evidenceRef, "Hash directory entry could not be inspected safely.");
  }
  if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
    throw new WorkspacePathSafetyError(
      "Hash directory contains a symlink or non-regular entry.",
      evidenceRef
    );
  }
  return entry;
}

function assertExpectedKind(
  entry: BigIntStats,
  kind: ObservedEntryKind,
  evidenceRef: string
): void {
  const matches =
    !entry.isSymbolicLink() &&
    (kind === "file" ? entry.isFile() : entry.isDirectory());
  if (!matches) {
    throw new WorkspacePathSafetyError(
      `Hash source is not a regular ${kind}.`,
      evidenceRef
    );
  }
}

function assertStableEntry(
  expected: BigIntStats,
  actual: BigIntStats,
  evidenceRef: string
): void {
  if (!sameStableEntry(expected, actual)) {
    throw new WorkspacePathSafetyError(
      "Hash source identity or contents changed during validation.",
      evidenceRef
    );
  }
}

function sameStableEntry(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.isFile() === right.isFile() &&
    left.isDirectory() === right.isDirectory() &&
    left.isSymbolicLink() === right.isSymbolicLink()
  );
}

function assertSameDirectoryObservation(
  initial: DirectoryObservation,
  finalObservation: DirectoryObservation,
  evidenceRef: string
): void {
  if (initial.entries.length !== finalObservation.entries.length) {
    throw new WorkspacePathSafetyError(
      "Hash directory entries changed during hashing.",
      evidenceRef
    );
  }
  for (let index = 0; index < initial.entries.length; index += 1) {
    const expected = initial.entries[index]!;
    const actual = finalObservation.entries[index]!;
    if (
      expected.relativePath !== actual.relativePath ||
      expected.kind !== actual.kind ||
      !sameStableEntry(expected.stat, actual.stat)
    ) {
      throw new WorkspacePathSafetyError(
        "Hash directory entries changed during hashing.",
        evidenceRef
      );
    }
  }
}

function compareObservedEntries(left: ObservedEntry, right: ObservedEntry): number {
  return compareCanonicalPath(left.relativePath, right.relativePath);
}

function compareCanonicalPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function invokeAfterDirectoryEnumerationHook(
  directoryPath: string,
  files: readonly ObservedEntry[]
): Promise<void> {
  await hashingServiceHookStorage.getStore()?.afterDirectoryEnumeration?.(
    Object.freeze({
      directoryPath,
      relativeFilePaths: Object.freeze(files.map((file) => file.relativePath))
    })
  );
}

async function invokeBeforeFileOpenHook(observed: ObservedEntry): Promise<void> {
  await hashingServiceHookStorage.getStore()?.beforeFileOpen?.(
    Object.freeze({
      absolutePath: observed.absolutePath,
      relativePath: observed.relativePath || undefined
    })
  );
}

function hashingSafetyError(
  error: unknown,
  evidenceRef: string,
  fallbackMessage: string
): WorkspacePathSafetyError {
  if (error instanceof WorkspacePathSafetyError) return error;
  return new WorkspacePathSafetyError(fallbackMessage, evidenceRef);
}
