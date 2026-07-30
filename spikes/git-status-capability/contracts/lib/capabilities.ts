import { dlopen } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";

export type { BigIntStats };

export type CapabilityPhase = "admission" | "post_admission";
export type CloseOwner = "unretained" | "retained" | "verification";
export type CloseAttempt = Readonly<{ descriptor: number; owner: CloseOwner; ordinal: number }>;
export type ContractAuthorityFault =
  | "ambient_absolute_open"
  | "replacement_object_read"
  | "file_write"
  | "child_spawn";

export type CapabilityHooks = Readonly<{
  closeFault?: (attempt: CloseAttempt) => boolean;
  onCloseAttempt?: (attempt: CloseAttempt) => void;
  onAuthorityViolation?: (fault: ContractAuthorityFault) => void;
}>;

export const FILE_OPEN_FLAGS = constants.O_RDONLY | (constants.O_CLOEXEC ?? 0) |
  (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
export const DIRECTORY_OPEN_FLAGS = FILE_OPEN_FLAGS | (constants.O_DIRECTORY ?? 0);

type OpenAt = (parentDescriptor: number, path: Buffer, flags: number) => number;
let cachedOpenAt: OpenAt | undefined;

function openAt(): OpenAt {
  if (cachedOpenAt) return cachedOpenAt;
  const symbols = { openat: { args: ["i32", "cstring", "i32"], returns: "i32" } } as const;
  if (process.platform === "darwin") {
    cachedOpenAt = dlopen("/usr/lib/libSystem.B.dylib", symbols).symbols.openat;
  } else if (process.platform === "linux") {
    cachedOpenAt = dlopen("libc.so.6", symbols).symbols.openat;
  } else {
    throw new Error("CONTRACT_CAPABILITY_PLATFORM_UNSUPPORTED");
  }
  return cachedOpenAt;
}

function childCString(value: string): Buffer {
  if (!value || value.includes("\0") || value.includes("/") || value === "." || value === "..") {
    throw new Error("CONTRACT_CAPABILITY_CHILD_INVALID");
  }
  return Buffer.from(`${value}\0`, "utf8");
}

/**
 * The only module allowed to import OS filesystem authority for direct contracts.
 * It exposes a closed read-only vocabulary; forbidden controls fail before an OS call.
 */
export class ContractCapabilities {
  private closeOrdinal = 0;

  constructor(private readonly hooks: CapabilityHooks = {}) {}

  openRoot(root: string, phase: CapabilityPhase): number {
    if (phase !== "admission" || root !== "/") throw new Error("CONTRACT_CAPABILITY_ROOT_FORBIDDEN");
    return openSync(root, DIRECTORY_OPEN_FLAGS);
  }

  openRelative(parentDescriptor: number, childName: string, flags: number): number {
    return openAt()(parentDescriptor, childCString(childName), flags);
  }

  stat(descriptor: number): BigIntStats {
    return fstatSync(descriptor, { bigint: true });
  }

  readRetained(
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    phase: CapabilityPhase
  ): number {
    if (phase !== "post_admission") throw new Error("CONTRACT_CAPABILITY_READ_PHASE_INVALID");
    return readSync(descriptor, buffer, offset, length, position);
  }

  close(descriptor: number, owner: CloseOwner): void {
    const attempt = Object.freeze({ descriptor, owner, ordinal: ++this.closeOrdinal });
    let hookError: unknown;
    try {
      this.hooks.onCloseAttempt?.(attempt);
    } catch (error) {
      hookError = error;
    }
    let closeError: unknown;
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
    let injectedFault = false;
    try {
      injectedFault = this.hooks.closeFault?.(attempt) ?? false;
    } catch (error) {
      hookError = hookError ?? error;
    }
    if (injectedFault || closeError || hookError) throw new Error("CONTRACT_CAPABILITY_CLOSE_FAILED");
  }

  rejectForbidden(fault: ContractAuthorityFault, phase: CapabilityPhase): never {
    if (phase !== "post_admission") throw new Error("CONTRACT_CAPABILITY_FAULT_PHASE_INVALID");
    this.hooks.onAuthorityViolation?.(fault);
    throw new Error(`CONTRACT_CAPABILITY_FORBIDDEN_${fault}`);
  }
}
