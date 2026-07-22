import { dlopen, read as ffiRead, type Pointer } from "bun:ffi";
import { unsafeLocalTokenStorageError } from "./local-token-types";

interface LocalTokenSyscalls {
  openAt(parentDescriptor: number, path: Buffer, flags: number, mode: number): number;
  flock(descriptor: number, operation: number): number;
  mkdirAt(parentDescriptor: number, path: Buffer, mode: number): number;
  renameAtNoReplace(
    oldParentDescriptor: number,
    oldPath: Buffer,
    newParentDescriptor: number,
    newPath: Buffer
  ): number;
  unlinkAt(parentDescriptor: number, path: Buffer, flags: number): number;
  openDirectoryStream(descriptor: number): Pointer | null;
  readDirectoryEntry(stream: Pointer): Pointer | null;
  closeDirectoryStream(stream: Pointer): number;
  errnoPointer(): Pointer;
  clearErrno(pointer: Pointer): void;
}

let cachedSyscalls: LocalTokenSyscalls | undefined;

function syscalls(): LocalTokenSyscalls {
  if (cachedSyscalls) return cachedSyscalls;
  const baseSymbols = {
    openat: { args: ["i32", "cstring", "i32", "i32"], returns: "i32" },
    flock: { args: ["i32", "i32"], returns: "i32" },
    mkdirat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    fdopendir: { args: ["i32"], returns: "ptr" },
    readdir: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    memset: { args: ["ptr", "i32", "u64"], returns: "ptr" }
  } as const;

  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      ...baseSymbols,
      renameatx_np: {
        args: ["i32", "cstring", "i32", "cstring", "u32"],
        returns: "i32"
      },
      __error: { args: [], returns: "ptr" }
    } as const);
    cachedSyscalls = {
      openAt: library.symbols.openat,
      flock: library.symbols.flock,
      mkdirAt: library.symbols.mkdirat,
      unlinkAt: library.symbols.unlinkat,
      openDirectoryStream: library.symbols.fdopendir,
      readDirectoryEntry: library.symbols.readdir,
      closeDirectoryStream: library.symbols.closedir,
      errnoPointer: () => requiredPointer(library.symbols.__error()),
      clearErrno: (pointer) => {
        library.symbols.memset(pointer, 0, 4);
      },
      renameAtNoReplace: (oldParent, oldPath, newParent, newPath) =>
        library.symbols.renameatx_np(oldParent, oldPath, newParent, newPath, 0x00000004)
    };
    return cachedSyscalls;
  }

  if (process.platform === "linux") {
    const library = dlopen("libc.so.6", {
      ...baseSymbols,
      renameat2: {
        args: ["i32", "cstring", "i32", "cstring", "u32"],
        returns: "i32"
      },
      __errno_location: { args: [], returns: "ptr" }
    } as const);
    cachedSyscalls = {
      openAt: library.symbols.openat,
      flock: library.symbols.flock,
      mkdirAt: library.symbols.mkdirat,
      unlinkAt: library.symbols.unlinkat,
      openDirectoryStream: library.symbols.fdopendir,
      readDirectoryEntry: library.symbols.readdir,
      closeDirectoryStream: library.symbols.closedir,
      errnoPointer: () => requiredPointer(library.symbols.__errno_location()),
      clearErrno: (pointer) => {
        library.symbols.memset(pointer, 0, 4);
      },
      renameAtNoReplace: (oldParent, oldPath, newParent, newPath) =>
        library.symbols.renameat2(oldParent, oldPath, newParent, newPath, 0x00000001)
    };
    return cachedSyscalls;
  }
  throw unsafeLocalTokenStorageError();
}

function requiredPointer(pointer: Pointer | null): Pointer {
  if (pointer === null) throw unsafeLocalTokenStorageError();
  return pointer;
}

function cString(value: string): Buffer {
  if (value.includes("\u0000")) throw unsafeLocalTokenStorageError();
  return Buffer.from(`${value}\u0000`, "utf8");
}

export function openAt(
  parentDescriptor: number,
  path: string,
  flags: number,
  mode = 0
): number {
  return syscalls().openAt(parentDescriptor, cString(path), flags, mode);
}

export function mkdirAt(parentDescriptor: number, path: string, mode: number): number {
  return syscalls().mkdirAt(parentDescriptor, cString(path), mode);
}

export function renameAtNoReplace(
  oldParentDescriptor: number,
  oldPath: string,
  newParentDescriptor: number,
  newPath: string
): number {
  return syscalls().renameAtNoReplace(
    oldParentDescriptor,
    cString(oldPath),
    newParentDescriptor,
    cString(newPath)
  );
}

export function unlinkAt(parentDescriptor: number, path: string): number {
  return syscalls().unlinkAt(parentDescriptor, cString(path), 0);
}

export function removeDirectoryAt(parentDescriptor: number, path: string): number {
  const flags = process.platform === "darwin" ? 0x00000080 : 0x00000200;
  return syscalls().unlinkAt(parentDescriptor, cString(path), flags);
}

export function flockNonblocking(descriptor: number, operation: number): number {
  return syscalls().flock(descriptor, operation);
}

export function readErrno(): number {
  return ffiRead.i32(syscalls().errnoPointer());
}

export function clearErrno(): void {
  const pointer = syscalls().errnoPointer();
  syscalls().clearErrno(pointer);
}

export interface DirectoryStreamSyscalls {
  readonly open: (descriptor: number) => Pointer | null;
  readonly read: (stream: Pointer) => Pointer | null;
  readonly close: (stream: Pointer) => number;
}

export function directoryStreamSyscalls(): DirectoryStreamSyscalls {
  const loaded = syscalls();
  return Object.freeze({
    open: loaded.openDirectoryStream,
    read: loaded.readDirectoryEntry,
    close: loaded.closeDirectoryStream
  });
}
