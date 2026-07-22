import { ptr, read as ffiRead, toBuffer, type Pointer } from "bun:ffi";
import { closeSync, fstatSync } from "node:fs";
import {
  clearErrno,
  directoryStreamSyscalls,
  openAt,
  readErrno
} from "./local-token-syscalls";
import {
  currentLocalTokenRawDirectoryReplay,
  invokeLocalTokenTestHook,
  type LocalTokenInventoryBoundary
} from "./local-token-test-support";
import {
  DIRECTORY_OPEN_FLAGS,
  LEGACY_STAGED_PATTERN,
  LOCAL_TOKEN_FILE,
  LOCAL_TOKEN_MAX_DECODED_ENTRIES,
  LOCAL_TOKEN_MAX_EXTERNAL_ENTRIES,
  LOCAL_TOKEN_MAX_OWNED_ENTRIES,
  LOCAL_TOKEN_NAME_MAX_BYTES,
  RETIRED_ARTIFACT_PATTERN,
  TRANSACTION_ARTIFACT_PATTERN,
  TRANSACTION_PHASE_PATTERN,
  unsafeLocalTokenStorageError
} from "./local-token-types";

const DIRECTORY_ENTRY_BUFFER_BYTES = 4 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface LocalTokenDirectoryInventory {
  readonly names: readonly string[];
  readonly ownedNames: ReadonlySet<string>;
  readonly externalNames: ReadonlySet<string>;
  readonly totalEntries: number;
  readonly ownedEntries: number;
  readonly externalEntries: number;
  readonly maxNameBytes: number;
}

function isRecognizedOwnedName(name: string): boolean {
  return (
    name === LOCAL_TOKEN_FILE ||
    TRANSACTION_ARTIFACT_PATTERN.test(name) ||
    TRANSACTION_PHASE_PATTERN.test(name) ||
    RETIRED_ARTIFACT_PATTERN.test(name) ||
    LEGACY_STAGED_PATTERN.test(name)
  );
}

function rejectInventory(
  boundary: LocalTokenInventoryBoundary,
  totalEntries: number,
  externalEntries: number,
  ownedEntries: number,
  maxNameBytes: number
): never {
  invokeLocalTokenTestHook({
    stage: "inventory_rejected",
    boundary,
    totalEntries,
    externalEntries,
    ownedEntries,
    maxNameBytes
  });
  throw unsafeLocalTokenStorageError();
}

export function readLocalTokenDirectoryInventory(
  secretsDescriptor: number
): LocalTokenDirectoryInventory {
  const streamDescriptor = openAt(secretsDescriptor, ".", DIRECTORY_OPEN_FLAGS);
  if (streamDescriptor < 0) throw unsafeLocalTokenStorageError();
  try {
    const observed = fstatSync(streamDescriptor, { bigint: true });
    if (!observed.isDirectory() || observed.isSymbolicLink()) {
      throw unsafeLocalTokenStorageError();
    }
  } catch (error) {
    closeSync(streamDescriptor);
    throw error;
  }

  const directorySyscalls = directoryStreamSyscalls();
  const stream = directorySyscalls.open(streamDescriptor);
  if (stream === null) {
    closeSync(streamDescriptor);
    throw unsafeLocalTokenStorageError();
  }

  const names: string[] = [];
  const decodedNames = new Set<string>();
  const ownedNames = new Set<string>();
  const externalNames = new Set<string>();
  let maxNameBytes = 0;
  let failure: unknown;

  const accept = (entry: Pointer, layout: "darwin" | "linux"): void => {
    if (names.length >= LOCAL_TOKEN_MAX_DECODED_ENTRIES) {
      rejectInventory(
        "total_limit",
        names.length,
        externalNames.size,
        ownedNames.size,
        maxNameBytes
      );
    }
    let name: string;
    try {
      name = decodeLocalTokenDirectoryEntry(entry, layout);
    } catch {
      rejectInventory(
        "decode",
        names.length,
        externalNames.size,
        ownedNames.size,
        maxNameBytes
      );
    }
    if (name === "." || name === "..") return;
    const nameBytes = Buffer.byteLength(name, "utf8");
    if (nameBytes > LOCAL_TOKEN_NAME_MAX_BYTES) {
      rejectInventory(
        "name_bytes",
        names.length,
        externalNames.size,
        ownedNames.size,
        Math.max(maxNameBytes, nameBytes)
      );
    }
    if (decodedNames.has(name)) {
      rejectInventory(
        "duplicate_decoded_name",
        names.length,
        externalNames.size,
        ownedNames.size,
        Math.max(maxNameBytes, nameBytes)
      );
    }
    const owned = isRecognizedOwnedName(name);
    if (owned && ownedNames.size >= LOCAL_TOKEN_MAX_OWNED_ENTRIES) {
      rejectInventory(
        "owned_limit",
        names.length,
        externalNames.size,
        ownedNames.size,
        Math.max(maxNameBytes, nameBytes)
      );
    }
    if (!owned && externalNames.size >= LOCAL_TOKEN_MAX_EXTERNAL_ENTRIES) {
      rejectInventory(
        "external_limit",
        names.length,
        externalNames.size,
        ownedNames.size,
        Math.max(maxNameBytes, nameBytes)
      );
    }

    decodedNames.add(name);
    names.push(name);
    (owned ? ownedNames : externalNames).add(name);
    maxNameBytes = Math.max(maxNameBytes, nameBytes);
  };

  try {
    const replay = currentLocalTokenRawDirectoryReplay();
    if (replay) {
      for (const record of replay.records) accept(ptr(record), replay.layout);
    } else {
      for (;;) {
        clearErrno();
        const entry = directorySyscalls.read(stream);
        if (entry === null) {
          if (readErrno() !== 0) throw unsafeLocalTokenStorageError();
          break;
        }
        accept(entry, process.platform === "darwin" ? "darwin" : "linux");
      }
    }
  } catch (error) {
    failure = error;
  }
  if (directorySyscalls.close(stream) !== 0) {
    failure ??= unsafeLocalTokenStorageError();
  }
  if (failure !== undefined) throw failure;

  const inventory = Object.freeze({
    names: Object.freeze(names),
    ownedNames,
    externalNames,
    totalEntries: names.length,
    ownedEntries: ownedNames.size,
    externalEntries: externalNames.size,
    maxNameBytes
  });
  invokeLocalTokenTestHook({
    stage: "after_inventory",
    totalEntries: inventory.totalEntries,
    externalEntries: inventory.externalEntries,
    ownedEntries: inventory.ownedEntries,
    maxNameBytes
  });
  return inventory;
}

export function decodeLocalTokenDirectoryEntry(
  entry: Pointer,
  layout: "darwin" | "linux"
): string {
  try {
    if (layout === "darwin") {
      const nameLength = ffiRead.u16(entry, 18);
      if (
        nameLength === 0 ||
        nameLength > LOCAL_TOKEN_NAME_MAX_BYTES ||
        nameLength > DIRECTORY_ENTRY_BUFFER_BYTES - 21
      ) {
        throw unsafeLocalTokenStorageError();
      }
      return UTF8_DECODER.decode(toBuffer(entry, 21, nameLength));
    }
    if (layout === "linux") {
      const recordLength = ffiRead.u16(entry, 16);
      if (recordLength <= 19 || recordLength > DIRECTORY_ENTRY_BUFFER_BYTES) {
        throw unsafeLocalTokenStorageError();
      }
      const bytes = toBuffer(entry, 19, recordLength - 19);
      const terminator = bytes.indexOf(0);
      if (terminator <= 0 || terminator > LOCAL_TOKEN_NAME_MAX_BYTES) {
        throw unsafeLocalTokenStorageError();
      }
      return UTF8_DECODER.decode(bytes.subarray(0, terminator));
    }
  } catch {
    throw unsafeLocalTokenStorageError();
  }
  throw unsafeLocalTokenStorageError();
}
