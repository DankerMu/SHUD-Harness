import { dlopen, read as ffiRead, toBuffer, type Pointer } from "bun:ffi";
import { createHash } from "node:crypto";
import { constants, fstat, read, type BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";
import {
  WorkspacePathSafetyError,
  resolveWorkspacePath,
  type WorkspacePathResolution
} from "./workspace-path-safety";

const HASH_STREAM_CHUNK_BYTES = 64 * 1024;
const HASH_FILE_OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
const HASH_DIRECTORY_OPEN_FLAGS = HASH_FILE_OPEN_FLAGS | (constants.O_DIRECTORY ?? 0);
const DIRECTORY_ENTRY_BUFFER_BYTES = 4 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface HashingServiceInput {
  workspaceRoot: string;
  inputPath: string;
  evidenceRef: string;
  allowedReadonlyRoots?: readonly string[];
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

interface DirectorySyscalls {
  openAt(parentDescriptor: number, path: Buffer, flags: number): number;
  duplicate(descriptor: number): number;
  closeDescriptor(descriptor: number): number;
  openDirectoryStream(descriptor: number): Pointer | null;
  readDirectoryEntry(stream: Pointer): Pointer | null;
  closeDirectoryStream(stream: Pointer): number;
  errnoPointer(): Pointer;
  clearErrno(pointer: Pointer): void;
}

let directorySyscalls: DirectorySyscalls | undefined;

export async function hashFile(input: HashingServiceInput): Promise<string> {
  let boundaryDescriptor: number | undefined;
  let boundaryRoot: string | undefined;
  let failure: unknown;
  let digest: string | undefined;
  try {
    const resolution = await resolveHashingPath(input);
    boundaryRoot = resolution.boundaryRoot;
    const observed = await observeExpectedEntry(
      resolution.absolutePath,
      "file",
      input.evidenceRef
    );
    boundaryDescriptor = await openPinnedAbsoluteDirectory(
      resolution.boundaryRoot,
      input.evidenceRef
    );
    digest = await hashObservedFile(
      input,
      resolution,
      boundaryDescriptor,
      {
        absolutePath: resolution.absolutePath,
        relativePath: "",
        kind: "file",
        stat: observed
      }
    );
  } catch (error) {
    failure = hashingSafetyError(error, input.evidenceRef, "File hashing failed safely.");
  }
  if (failure === undefined && boundaryDescriptor !== undefined && boundaryRoot !== undefined) {
    try {
      await assertPinnedDirectoryPath(boundaryDescriptor, boundaryRoot, input.evidenceRef);
    } catch (error) {
      failure = error;
    }
  }
  failure = closeOwnedDescriptor(boundaryDescriptor, input.evidenceRef, failure);
  if (failure !== undefined) throw failure;
  if (digest === undefined) {
    throw new WorkspacePathSafetyError(
      "Hash source did not produce a complete digest.",
      input.evidenceRef
    );
  }
  return digest;
}

export async function hashDirectory(input: HashingServiceInput): Promise<string> {
  let boundaryDescriptor: number | undefined;
  let boundaryRoot: string | undefined;
  let failure: unknown;
  let digest: string | undefined;
  try {
    const resolution = await resolveHashingPath(input);
    boundaryRoot = resolution.boundaryRoot;
    const rootStat = await observeExpectedEntry(
      resolution.absolutePath,
      "directory",
      input.evidenceRef
    );
    boundaryDescriptor = await openPinnedAbsoluteDirectory(
      resolution.boundaryRoot,
      input.evidenceRef
    );
    const initial = await observeDirectoryTree(
      input,
      resolution,
      boundaryDescriptor,
      resolution.absolutePath,
      rootStat
    );
    if (initial.files.length === 0) {
      throw new WorkspacePathSafetyError(
        "Hash directory contains no regular files.",
        input.evidenceRef
      );
    }

    const directoryHash = createHash("sha256");
    for (const file of initial.files) {
      const fileDigest = await hashObservedFile(input, resolution, boundaryDescriptor, file);
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
      resolution,
      boundaryDescriptor,
      resolution.absolutePath,
      finalRootStat
    );
    assertSameDirectoryObservation(initial, finalObservation, input.evidenceRef);
    digest = directoryHash.digest("hex");
  } catch (error) {
    failure = hashingSafetyError(error, input.evidenceRef, "Directory hashing failed safely.");
  }
  if (failure === undefined && boundaryDescriptor !== undefined && boundaryRoot !== undefined) {
    try {
      await assertPinnedDirectoryPath(boundaryDescriptor, boundaryRoot, input.evidenceRef);
    } catch (error) {
      failure = error;
    }
  }
  failure = closeOwnedDescriptor(boundaryDescriptor, input.evidenceRef, failure);
  if (failure !== undefined) throw failure;
  if (digest === undefined) {
    throw new WorkspacePathSafetyError(
      "Hash directory did not produce a complete digest.",
      input.evidenceRef
    );
  }
  return digest;
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
  resolution: WorkspacePathResolution,
  boundaryDescriptor: number,
  rootPath: string,
  rootStat: BigIntStats
): Promise<DirectoryObservation> {
  const entries: ObservedEntry[] = [
    { absolutePath: rootPath, relativePath: "", kind: "directory", stat: rootStat }
  ];
  const files: ObservedEntry[] = [];
  const canonicalPaths = new Set<string>([""]);
  await observeDirectory(
    input,
    resolution,
    boundaryDescriptor,
    rootPath,
    [],
    rootStat,
    undefined,
    entries,
    files,
    canonicalPaths
  );
  entries.sort(compareObservedEntries);
  files.sort(compareObservedEntries);
  return Object.freeze({
    entries: Object.freeze(entries),
    files: Object.freeze(files)
  });
}

async function observeDirectory(
  input: HashingServiceInput,
  resolution: WorkspacePathResolution,
  boundaryDescriptor: number,
  directoryPath: string,
  relativeSegments: readonly string[],
  expectedDirectory: BigIntStats,
  pinnedDirectoryDescriptor: number | undefined,
  entries: ObservedEntry[],
  files: ObservedEntry[],
  canonicalPaths: Set<string>
): Promise<void> {
  let directoryDescriptor = pinnedDirectoryDescriptor;
  let failure: unknown;
  try {
    await assertPathStillInsideBoundary(input, directoryPath);
    const beforeEnumeration = await observeExpectedEntry(
      directoryPath,
      "directory",
      input.evidenceRef
    );
    assertStableEntry(expectedDirectory, beforeEnumeration, input.evidenceRef);

    directoryDescriptor ??= await openRelativeDirectory(
      boundaryDescriptor,
      resolution.boundaryRoot,
      boundaryRelativeSegments(resolution.boundaryRoot, directoryPath),
      input.evidenceRef
    );
    const descriptorBeforeEnumeration = await descriptorStat(
      directoryDescriptor,
      input.evidenceRef
    );
    assertExpectedKind(descriptorBeforeEnumeration, "directory", input.evidenceRef);
    assertStableEntry(beforeEnumeration, descriptorBeforeEnumeration, input.evidenceRef);

    const childNames = readDirectoryNames(directoryDescriptor, input.evidenceRef);
    const descriptorAfterEnumeration = await descriptorStat(
      directoryDescriptor,
      input.evidenceRef
    );
    assertStableEntry(descriptorBeforeEnumeration, descriptorAfterEnumeration, input.evidenceRef);
    const afterEnumeration = await observeExpectedEntry(
      directoryPath,
      "directory",
      input.evidenceRef
    );
    assertStableEntry(beforeEnumeration, afterEnumeration, input.evidenceRef);

    childNames.sort(compareCanonicalPath);
    for (const childName of childNames) {
      assertSupportedRelativeSegment(childName, input.evidenceRef);
      const childSegments = [...relativeSegments, childName];
      const relativePath = childSegments.join("/");
      if (canonicalPaths.has(relativePath)) {
        throw new WorkspacePathSafetyError(
          "Hash directory contains duplicate canonical paths.",
          input.evidenceRef
        );
      }
      canonicalPaths.add(relativePath);
      const absolutePath = join(directoryPath, childName);
      const childStat = await observeSupportedTreeEntry(absolutePath, input.evidenceRef);
      const childDescriptor = openRelativeEntryDescriptor(
        directoryDescriptor,
        childName,
        input.evidenceRef
      );
      let childDescriptorOwned = true;
      try {
        const descriptorStatValue = await descriptorStat(childDescriptor, input.evidenceRef);
        const kind: ObservedEntryKind = childStat.isDirectory() ? "directory" : "file";
        assertExpectedKind(descriptorStatValue, kind, input.evidenceRef);
        assertStableEntry(childStat, descriptorStatValue, input.evidenceRef);
        const observed = { absolutePath, relativePath, kind, stat: childStat } as const;
        entries.push(observed);
        if (kind === "file") {
          files.push(observed);
        } else {
          childDescriptorOwned = false;
          await observeDirectory(
            input,
            resolution,
            boundaryDescriptor,
            absolutePath,
            childSegments,
            childStat,
            childDescriptor,
            entries,
            files,
            canonicalPaths
          );
        }
      } finally {
        if (childDescriptorOwned) {
          const closeFailure = closeOwnedDescriptor(
            childDescriptor,
            input.evidenceRef,
            undefined
          );
          if (closeFailure !== undefined) throw closeFailure;
        }
      }
    }

    const descriptorAfterChildren = await descriptorStat(directoryDescriptor, input.evidenceRef);
    assertStableEntry(descriptorAfterEnumeration, descriptorAfterChildren, input.evidenceRef);
    const afterChildren = await observeExpectedEntry(
      directoryPath,
      "directory",
      input.evidenceRef
    );
    assertStableEntry(afterEnumeration, afterChildren, input.evidenceRef);
  } catch (error) {
    failure = error;
  }
  failure = closeOwnedDescriptor(directoryDescriptor, input.evidenceRef, failure);
  if (failure !== undefined) throw failure;
}

async function hashObservedFile(
  input: HashingServiceInput,
  resolution: WorkspacePathResolution,
  boundaryDescriptor: number,
  observed: ObservedEntry
): Promise<string> {
  await assertPathStillInsideBoundary(input, observed.absolutePath);
  const pathBeforeOpen = await observeExpectedEntry(
    observed.absolutePath,
    "file",
    input.evidenceRef
  );
  assertStableEntry(observed.stat, pathBeforeOpen, input.evidenceRef);

  let descriptor: number | undefined;
  let digest: string | undefined;
  let failure: unknown;
  try {
    descriptor = await openRelativeFile(
      boundaryDescriptor,
      resolution.boundaryRoot,
      boundaryRelativeSegments(resolution.boundaryRoot, observed.absolutePath),
      input.evidenceRef
    );
    const descriptorBeforeRead = await descriptorStat(descriptor, input.evidenceRef);
    assertExpectedKind(descriptorBeforeRead, "file", input.evidenceRef);
    assertStableEntry(pathBeforeOpen, descriptorBeforeRead, input.evidenceRef);

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_STREAM_CHUNK_BYTES);
    let bytesHashed = 0n;
    while (bytesHashed < descriptorBeforeRead.size) {
      const remaining = descriptorBeforeRead.size - bytesHashed;
      const requestedBytes = Number(
        remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length)
      );
      const bytesRead = await descriptorRead(
        descriptor,
        buffer,
        requestedBytes,
        bytesHashed,
        input.evidenceRef
      );
      if (bytesRead === 0) {
        throw new WorkspacePathSafetyError(
          "Hash source ended before its initially observed size.",
          input.evidenceRef
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      bytesHashed += BigInt(bytesRead);
    }

    const descriptorAfterRead = await descriptorStat(descriptor, input.evidenceRef);
    assertExpectedKind(descriptorAfterRead, "file", input.evidenceRef);
    assertStableEntry(descriptorBeforeRead, descriptorAfterRead, input.evidenceRef);
    if (bytesHashed !== descriptorBeforeRead.size) {
      throw new WorkspacePathSafetyError(
        "Hash source changed while it was being read.",
        input.evidenceRef
      );
    }
    digest = hash.digest("hex");
  } catch (error) {
    failure = hashingSafetyError(error, input.evidenceRef, "Hash source could not be read safely.");
  }

  failure = closeOwnedDescriptor(descriptor, input.evidenceRef, failure);
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

async function openPinnedAbsoluteDirectory(
  path: string,
  evidenceRef: string
): Promise<number> {
  const expected = await observeExpectedEntry(path, "directory", evidenceRef);
  const syscalls = getDirectorySyscalls();
  let descriptor = syscallOpenAt(
    syscalls,
    platformCurrentWorkingDirectoryDescriptor(),
    parse(resolve(path)).root,
    HASH_DIRECTORY_OPEN_FLAGS,
    evidenceRef
  );
  try {
    for (const segment of absolutePathSegments(path)) {
      const child = syscallOpenAt(
        syscalls,
        descriptor,
        segment,
        HASH_DIRECTORY_OPEN_FLAGS,
        evidenceRef
      );
      const closeFailure = closeOwnedDescriptor(descriptor, evidenceRef, undefined);
      if (closeFailure !== undefined) {
        const childCloseFailure = closeOwnedDescriptor(child, evidenceRef, closeFailure);
        throw childCloseFailure;
      }
      descriptor = child;
      const observed = await descriptorStat(descriptor, evidenceRef);
      assertExpectedKind(observed, "directory", evidenceRef);
    }
    const actual = await descriptorStat(descriptor, evidenceRef);
    assertStableEntry(expected, actual, evidenceRef);
    return descriptor;
  } catch (error) {
    const failure = closeOwnedDescriptor(descriptor, evidenceRef, error);
    throw failure;
  }
}

async function assertPinnedDirectoryPath(
  descriptor: number,
  path: string,
  evidenceRef: string
): Promise<void> {
  const [pathStat, descriptorStatValue] = await Promise.all([
    observeExpectedEntry(path, "directory", evidenceRef),
    descriptorStat(descriptor, evidenceRef)
  ]);
  assertExpectedKind(descriptorStatValue, "directory", evidenceRef);
  assertStableEntry(descriptorStatValue, pathStat, evidenceRef);
}

async function openRelativeDirectory(
  boundaryDescriptor: number,
  boundaryRoot: string,
  segments: readonly string[],
  evidenceRef: string
): Promise<number> {
  return await openRelativeDescriptor(
    boundaryDescriptor,
    boundaryRoot,
    segments,
    HASH_DIRECTORY_OPEN_FLAGS,
    "directory",
    evidenceRef
  );
}

async function openRelativeFile(
  boundaryDescriptor: number,
  boundaryRoot: string,
  segments: readonly string[],
  evidenceRef: string
): Promise<number> {
  if (segments.length === 0) {
    throw new WorkspacePathSafetyError(
      "Hash file path cannot be the configured directory boundary.",
      evidenceRef
    );
  }
  return await openRelativeDescriptor(
    boundaryDescriptor,
    boundaryRoot,
    segments,
    HASH_FILE_OPEN_FLAGS,
    "file",
    evidenceRef
  );
}

async function openRelativeDescriptor(
  boundaryDescriptor: number,
  boundaryRoot: string,
  segments: readonly string[],
  finalFlags: number,
  finalKind: ObservedEntryKind,
  evidenceRef: string
): Promise<number> {
  const syscalls = getDirectorySyscalls();
  let descriptor =
    segments.length === 0
      ? syscallOpenAt(syscalls, boundaryDescriptor, ".", finalFlags, evidenceRef)
      : syscallDuplicate(syscalls, boundaryDescriptor, evidenceRef);
  let observedPath = resolve(boundaryRoot);
  try {
    if (segments.length === 0) {
      const expected = await observeExpectedEntry(observedPath, finalKind, evidenceRef);
      const observed = await descriptorStat(descriptor, evidenceRef);
      assertExpectedKind(observed, finalKind, evidenceRef);
      assertStableEntry(expected, observed, evidenceRef);
      return descriptor;
    }
    for (let index = 0; index < segments.length; index += 1) {
      const isFinal = index === segments.length - 1;
      observedPath = join(observedPath, segments[index]!);
      const expected = await observeExpectedEntry(
        observedPath,
        isFinal ? finalKind : "directory",
        evidenceRef
      );
      const child = syscallOpenAt(
        syscalls,
        descriptor,
        segments[index]!,
        isFinal ? finalFlags : HASH_DIRECTORY_OPEN_FLAGS,
        evidenceRef
      );
      const closeFailure = closeOwnedDescriptor(descriptor, evidenceRef, undefined);
      if (closeFailure !== undefined) {
        const childCloseFailure = closeOwnedDescriptor(child, evidenceRef, closeFailure);
        throw childCloseFailure;
      }
      descriptor = child;
      const observed = await descriptorStat(descriptor, evidenceRef);
      assertExpectedKind(observed, isFinal ? finalKind : "directory", evidenceRef);
      assertStableEntry(expected, observed, evidenceRef);
    }
    return descriptor;
  } catch (error) {
    const failure = closeOwnedDescriptor(descriptor, evidenceRef, error);
    throw failure;
  }
}

function openRelativeEntryDescriptor(
  parentDescriptor: number,
  name: string,
  evidenceRef: string
): number {
  return syscallOpenAt(
    getDirectorySyscalls(),
    parentDescriptor,
    name,
    HASH_FILE_OPEN_FLAGS,
    evidenceRef
  );
}

function readDirectoryNames(descriptor: number, evidenceRef: string): string[] {
  const syscalls = getDirectorySyscalls();
  const streamDescriptor = syscallDuplicate(syscalls, descriptor, evidenceRef);
  const stream = syscalls.openDirectoryStream(streamDescriptor);
  if (stream === null) {
    closeOwnedDescriptor(streamDescriptor, evidenceRef, undefined);
    throw new WorkspacePathSafetyError(
      "Hash directory descriptor could not be enumerated safely.",
      evidenceRef
    );
  }

  const names: string[] = [];
  const decodedNames = new Set<string>();
  let failure: unknown;
  try {
    for (;;) {
      const errnoPointer = syscalls.errnoPointer();
      syscalls.clearErrno(errnoPointer);
      const entry = syscalls.readDirectoryEntry(stream);
      if (entry === null) {
        if (ffiRead.i32(errnoPointer) !== 0) {
          throw new WorkspacePathSafetyError(
            "Hash directory descriptor enumeration failed safely.",
            evidenceRef
          );
        }
        break;
      }
      const name = decodeDirectoryEntryName(entry, evidenceRef);
      if (name === "." || name === "..") continue;
      if (decodedNames.has(name)) {
        throw new WorkspacePathSafetyError(
          "Hash directory contains duplicate decoded entry names.",
          evidenceRef
        );
      }
      decodedNames.add(name);
      names.push(name);
    }
  } catch (error) {
    failure = error;
  }
  if (syscalls.closeDirectoryStream(stream) !== 0) {
    failure ??= new WorkspacePathSafetyError(
      "Hash directory descriptor could not be closed safely.",
      evidenceRef
    );
  }
  if (failure !== undefined) throw failure;
  return names;
}

function decodeDirectoryEntryName(entry: Pointer, evidenceRef: string): string {
  try {
    if (process.platform === "darwin") {
      const nameLength = ffiRead.u16(entry, 18);
      if (nameLength === 0 || nameLength > DIRECTORY_ENTRY_BUFFER_BYTES - 21) {
        throw new Error("invalid Darwin directory entry length");
      }
      return UTF8_DECODER.decode(toBuffer(entry, 21, nameLength));
    }
    if (process.platform === "linux") {
      const recordLength = ffiRead.u16(entry, 16);
      if (recordLength <= 19 || recordLength > DIRECTORY_ENTRY_BUFFER_BYTES) {
        throw new Error("invalid Linux directory entry length");
      }
      const bytes = toBuffer(entry, 19, recordLength - 19);
      const terminator = bytes.indexOf(0);
      if (terminator <= 0) throw new Error("unterminated Linux directory entry name");
      return UTF8_DECODER.decode(bytes.subarray(0, terminator));
    }
  } catch {
    throw new WorkspacePathSafetyError(
      "Hash directory contains an unsupported filename encoding.",
      evidenceRef
    );
  }
  throw new WorkspacePathSafetyError(
    "Descriptor-bound directory enumeration is unsupported on this platform.",
    evidenceRef
  );
}

function getDirectorySyscalls(): DirectorySyscalls {
  if (directorySyscalls) return directorySyscalls;
  const commonSymbols = {
    openat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    dup: { args: ["i32"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
    fdopendir: { args: ["i32"], returns: "ptr" },
    readdir: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    memset: { args: ["ptr", "i32", "u64"], returns: "ptr" }
  } as const;
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      ...commonSymbols,
      __error: { args: [], returns: "ptr" }
    } as const);
    directorySyscalls = {
      openAt: library.symbols.openat,
      duplicate: library.symbols.dup,
      closeDescriptor: library.symbols.close,
      openDirectoryStream: library.symbols.fdopendir,
      readDirectoryEntry: library.symbols.readdir,
      closeDirectoryStream: library.symbols.closedir,
      errnoPointer: () => requiredPointer(library.symbols.__error()),
      clearErrno: (pointer) => {
        library.symbols.memset(pointer, 0, 4);
      }
    };
    return directorySyscalls;
  }
  if (process.platform === "linux") {
    const library = dlopen("libc.so.6", {
      ...commonSymbols,
      __errno_location: { args: [], returns: "ptr" }
    } as const);
    directorySyscalls = {
      openAt: library.symbols.openat,
      duplicate: library.symbols.dup,
      closeDescriptor: library.symbols.close,
      openDirectoryStream: library.symbols.fdopendir,
      readDirectoryEntry: library.symbols.readdir,
      closeDirectoryStream: library.symbols.closedir,
      errnoPointer: () => requiredPointer(library.symbols.__errno_location()),
      clearErrno: (pointer) => {
        library.symbols.memset(pointer, 0, 4);
      }
    };
    return directorySyscalls;
  }
  throw new Error("Descriptor-bound directory traversal requires macOS or Linux.");
}

function requiredPointer(pointer: Pointer | null): Pointer {
  if (pointer === null) throw new Error("Required libc pointer is unavailable.");
  return pointer;
}

function syscallOpenAt(
  syscalls: DirectorySyscalls,
  parentDescriptor: number,
  path: string,
  flags: number,
  evidenceRef: string
): number {
  const descriptor = syscalls.openAt(parentDescriptor, cString(path), flags);
  if (descriptor < 0) {
    throw new WorkspacePathSafetyError(
      "Hash source could not be opened without following path replacements.",
      evidenceRef
    );
  }
  return descriptor;
}

function syscallDuplicate(
  syscalls: DirectorySyscalls,
  descriptor: number,
  evidenceRef: string
): number {
  const duplicate = syscalls.duplicate(descriptor);
  if (duplicate < 0) {
    throw new WorkspacePathSafetyError(
      "Hash source descriptor could not be retained safely.",
      evidenceRef
    );
  }
  return duplicate;
}

function cString(value: string): Buffer {
  if (value.includes("\0")) throw new Error("Filesystem path contains NUL.");
  return Buffer.from(`${value}\0`, "utf8");
}

function platformCurrentWorkingDirectoryDescriptor(): number {
  if (process.platform === "darwin") return -2;
  if (process.platform === "linux") return -100;
  throw new Error("Descriptor-relative traversal is unsupported on this platform.");
}

function absolutePathSegments(path: string): readonly string[] {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  return absolutePath.slice(root.length).split(sep).filter(Boolean);
}

function boundaryRelativeSegments(boundaryRoot: string, path: string): readonly string[] {
  const relativePath = relative(resolve(boundaryRoot), resolve(path));
  if (relativePath === "") return [];
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("Hash path escaped its resolved boundary.");
  }
  return relativePath.split(sep).filter(Boolean);
}

function descriptorStat(descriptor: number, evidenceRef: string): Promise<BigIntStats> {
  return new Promise((resolveStat, rejectStat) => {
    fstat(descriptor, { bigint: true }, (error, stats) => {
      if (error) {
        rejectStat(
          hashingSafetyError(error, evidenceRef, "Hash descriptor could not be inspected safely.")
        );
        return;
      }
      resolveStat(stats);
    });
  });
}

function descriptorRead(
  descriptor: number,
  buffer: Buffer,
  length: number,
  position: bigint,
  evidenceRef: string
): Promise<number> {
  return new Promise((resolveRead, rejectRead) => {
    read(descriptor, buffer, 0, length, position, (error, bytesRead) => {
      if (error) {
        rejectRead(hashingSafetyError(error, evidenceRef, "Hash descriptor read failed safely."));
        return;
      }
      resolveRead(bytesRead);
    });
  });
}

function closeOwnedDescriptor(
  descriptor: number | undefined,
  evidenceRef: string,
  priorFailure: unknown
): unknown {
  if (descriptor === undefined) return priorFailure;
  if (getDirectorySyscalls().closeDescriptor(descriptor) === 0) return priorFailure;
  return (
    priorFailure ??
    new WorkspacePathSafetyError(
      "Hash source descriptor could not be closed safely.",
      evidenceRef
    )
  );
}

function assertSupportedRelativeSegment(segment: string, evidenceRef: string): void {
  if (!segment.includes("\n")) return;
  throw new WorkspacePathSafetyError(
    "Hash directory relative paths cannot contain LF.",
    evidenceRef
  );
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

function hashingSafetyError(
  error: unknown,
  evidenceRef: string,
  fallbackMessage: string
): WorkspacePathSafetyError {
  if (error instanceof WorkspacePathSafetyError) return error;
  return new WorkspacePathSafetyError(fallbackMessage, evidenceRef);
}
