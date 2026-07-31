import { dlopen } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";

export type { BigIntStats };

export type CapabilityPhase = "admission" | "post_admission";
export type CloseOwner = "unretained" | "retained" | "verification";
export type CloseAttempt = Readonly<{ owner: CloseOwner; ordinal: number }>;
export type ContractAuthorityFault =
  | "ambient_absolute_open"
  | "replacement_object_read"
  | "file_write"
  | "child_spawn";
export type DescriptorCapabilityState = "pending_retained" | "retained" | "verification" | "closed";
export type DescriptorOperation =
  | "open_root"
  | "openat"
  | "mark_retained"
  | "fstat_sync"
  | "read_sync"
  | "close_sync";

type DescriptorAuthorityDenialReason =
  | "unproven_descriptor"
  | "unproven_parent"
  | "foreign_descriptor"
  | "stale_descriptor"
  | "closed_descriptor"
  | "state_invalid"
  | "flags_invalid"
  | "kind_mismatch"
  | "owner_mismatch"
  | "phase_invalid"
  | "range_invalid"
  | "root_invalid"
  | "child_invalid";
type DescriptorKind = "file" | "directory";

declare const capabilityDescriptorBrand: unique symbol;

/**
 * A descriptor is an opaque, frozen capability token. The live OS descriptor
 * is held only in ContractCapabilities instance-private records.
 */
export type CapabilityDescriptor = Readonly<{
  readonly [capabilityDescriptorBrand]: "shud.contract.capability-descriptor.v1";
}>;

export type DescriptorAuthorityDenial = Readonly<{
  schema_version: "shud.contract.descriptor-denial.v1";
  operation: DescriptorOperation;
  reason: DescriptorAuthorityDenialReason;
  descriptor: number | null;
  generation: number | null;
  phase: CapabilityPhase | null;
}>;

export type CapabilityHooks = Readonly<{
  closeFault?: (attempt: CloseAttempt) => boolean;
  onCloseAttempt?: (attempt: CloseAttempt) => void;
  onAuthorityViolation?: (fault: ContractAuthorityFault) => void;
  onDescriptorAuthorityDenial?: (denial: DescriptorAuthorityDenial) => void;
}>;

export const FILE_OPEN_FLAGS = constants.O_RDONLY | (constants.O_CLOEXEC ?? 0) |
  (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
export const DIRECTORY_OPEN_FLAGS = FILE_OPEN_FLAGS | (constants.O_DIRECTORY ?? 0);

const OPEN_FLAGS_BY_KIND = Object.freeze({
  directory: DIRECTORY_OPEN_FLAGS,
  file: FILE_OPEN_FLAGS
});
const LIVE_DESCRIPTOR_STATES = Object.freeze([
  "pending_retained", "retained", "verification"
] as const);
const CLOSE_OWNERS_BY_STATE = Object.freeze({
  pending_retained: "unretained",
  retained: "retained",
  verification: "verification"
} as const);

/**
 * Frozen lifecycle vocabulary for every raw descriptor primitive. This is data,
 * not a fallback dispatch path: every method below enforces this exact policy.
 */
export const DESCRIPTOR_OPERATION_POLICY = Object.freeze({
  open_root: Object.freeze({
    phase: "admission",
    root: "/",
    flags: DIRECTORY_OPEN_FLAGS,
    next_state: "pending_retained"
  }),
  openat: Object.freeze({
    parent: "retained_directory",
    flags: OPEN_FLAGS_BY_KIND,
    admission: Object.freeze({ next_state: "pending_retained" }),
    post_admission: Object.freeze({ next_state: "verification" })
  }),
  mark_retained: Object.freeze({
    required_state: "pending_retained",
    required_stat: true,
    next_state: "retained"
  }),
  fstat_sync: Object.freeze({ states: LIVE_DESCRIPTOR_STATES }),
  read_sync: Object.freeze({
    state: "retained",
    kind: "file",
    flags: FILE_OPEN_FLAGS,
    phase: "post_admission"
  }),
  close_sync: Object.freeze({ owners: CLOSE_OWNERS_BY_STATE })
});

type OpenAt = (parentDescriptor: number, path: Buffer, flags: number) => number;
type DescriptorRecord = {
  readonly fd: number;
  readonly generation: number;
  readonly parentGeneration: number | null;
  readonly flags: number;
  readonly kind: DescriptorKind;
  readonly phase: CapabilityPhase;
  state: DescriptorCapabilityState;
  statValidated: boolean;
  statKind: DescriptorKind | undefined;
};
type IssuedDescriptorMetadata = Readonly<{
  descriptor: number;
  generation: number;
  phase: CapabilityPhase;
}>;

let cachedOpenAt: OpenAt | undefined;
const issuedDescriptorMetadata = new WeakMap<CapabilityDescriptor, IssuedDescriptorMetadata>();

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
  return Buffer.from(`${value}\0`, "utf8");
}

function isCapabilityPhase(value: unknown): value is CapabilityPhase {
  return value === "admission" || value === "post_admission";
}

function isValidChildName(value: unknown): value is string {
  return typeof value === "string" && Boolean(value) && !value.includes("\0") && !value.includes("/") &&
    value !== "." && value !== "..";
}

function isBoundedRead(
  buffer: unknown,
  offset: unknown,
  length: unknown,
  position: unknown
): buffer is Buffer {
  return Buffer.isBuffer(buffer) &&
    typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0 && offset <= buffer.length &&
    typeof length === "number" && Number.isSafeInteger(length) && length >= 0 && length <= buffer.length - offset &&
    typeof position === "number" && Number.isSafeInteger(position) && position >= 0;
}

/**
 * The only module allowed to import OS filesystem authority for direct contracts.
 * It exposes a closed read-only vocabulary; forbidden controls fail before an OS call.
 */
export class ContractCapabilities {
  readonly #registry = new WeakMap<CapabilityDescriptor, DescriptorRecord>();
  readonly #currentGenerationByDescriptor = new Map<number, number>();
  #nextGeneration = 0;
  #closeOrdinal = 0;
  #admissionSealed = false;

  constructor(private readonly hooks: CapabilityHooks = {}) {}

  sealAdmission(): void {
    this.#admissionSealed = true;
  }

  openRoot(root: string, phase: CapabilityPhase): CapabilityDescriptor {
    if (!isCapabilityPhase(phase) || phase !== "admission" || this.#admissionSealed) {
      return this.#deny("open_root", "phase_invalid", null, null, null);
    }
    if (root !== "/") return this.#deny("open_root", "root_invalid", null, null, phase);
    return this.#issue(openSync(root, DIRECTORY_OPEN_FLAGS), null, DIRECTORY_OPEN_FLAGS, "directory", phase, "pending_retained");
  }

  openRelative(
    parent: CapabilityDescriptor,
    childName: string,
    flags: number,
    phase: CapabilityPhase
  ): CapabilityDescriptor {
    const requestedPhase = isCapabilityPhase(phase) ? phase : null;
    const parentRecord = this.#resolve(parent, "openat", requestedPhase, "unproven_parent");
    if (!requestedPhase) return this.#denyRecord("openat", "phase_invalid", parentRecord);
    if (
      this.#admissionSealed
        ? requestedPhase !== "post_admission"
        : requestedPhase !== "admission"
    ) {
      return this.#denyRecord("openat", "phase_invalid", parentRecord);
    }
    if (parentRecord.state !== "retained") return this.#denyRecord("openat", "state_invalid", parentRecord);
    if (parentRecord.kind !== "directory") return this.#denyRecord("openat", "kind_mismatch", parentRecord);
    if (parentRecord.flags !== DIRECTORY_OPEN_FLAGS) return this.#denyRecord("openat", "flags_invalid", parentRecord);
    const kind = flags === DIRECTORY_OPEN_FLAGS ? "directory" : flags === FILE_OPEN_FLAGS ? "file" : undefined;
    if (!kind) return this.#denyRecord("openat", "flags_invalid", parentRecord);
    if (!isValidChildName(childName)) return this.#denyRecord("openat", "child_invalid", parentRecord);

    const descriptor = openAt()(parentRecord.fd, childCString(childName), flags);
    if (descriptor < 0) throw new Error("CONTRACT_CAPABILITY_OPEN_FAILED");
    return this.#issue(
      descriptor,
      parentRecord.generation,
      flags,
      kind,
      requestedPhase,
      requestedPhase === "admission" ? "pending_retained" : "verification"
    );
  }

  markRetained(descriptor: CapabilityDescriptor, kind: DescriptorKind): void {
    const record = this.#resolve(descriptor, "mark_retained", null);
    if (this.#admissionSealed && record.state === "pending_retained") {
      return this.#denyRecord("mark_retained", "phase_invalid", record);
    }
    if (record.state !== "pending_retained" || !record.statValidated) {
      return this.#denyRecord("mark_retained", "state_invalid", record);
    }
    if (kind !== record.kind || record.statKind !== record.kind) {
      return this.#denyRecord("mark_retained", "kind_mismatch", record);
    }
    record.state = "retained";
  }

  stat(descriptor: CapabilityDescriptor): BigIntStats {
    const record = this.#resolve(descriptor, "fstat_sync", null);
    const stats = fstatSync(record.fd, { bigint: true });
    record.statValidated = true;
    record.statKind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : undefined;
    return stats;
  }

  readRetained(
    descriptor: CapabilityDescriptor,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    phase: CapabilityPhase
  ): number {
    const requestedPhase = isCapabilityPhase(phase) ? phase : null;
    const record = this.#resolve(descriptor, "read_sync", requestedPhase);
    if (requestedPhase !== "post_admission" || !this.#admissionSealed) {
      return this.#denyRecord("read_sync", "phase_invalid", record);
    }
    if (record.state !== "retained") return this.#denyRecord("read_sync", "state_invalid", record);
    if (record.kind !== "file") return this.#denyRecord("read_sync", "kind_mismatch", record);
    if (record.flags !== FILE_OPEN_FLAGS) return this.#denyRecord("read_sync", "flags_invalid", record);
    if (!isBoundedRead(buffer, offset, length, position)) {
      return this.#denyRecord("read_sync", "range_invalid", record);
    }
    return readSync(record.fd, buffer, offset, length, position);
  }

  close(descriptor: CapabilityDescriptor, owner: CloseOwner): void {
    const record = this.#resolve(descriptor, "close_sync", null);
    const expectedOwner = CLOSE_OWNERS_BY_STATE[record.state as keyof typeof CLOSE_OWNERS_BY_STATE];
    if (owner !== expectedOwner) return this.#denyRecord("close_sync", "owner_mismatch", record);

    record.state = "closed";
    const attempt = Object.freeze({ owner, ordinal: ++this.#closeOrdinal });
    let hookError: unknown;
    try {
      this.hooks.onCloseAttempt?.(attempt);
    } catch (error) {
      hookError = error;
    }
    let closeError: unknown;
    try {
      closeSync(record.fd);
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

  #issue(
    raw: number,
    parentGeneration: number | null,
    flags: number,
    kind: DescriptorKind,
    phase: CapabilityPhase,
    state: "pending_retained" | "verification"
  ): CapabilityDescriptor {
    const descriptor = Object.freeze(Object.create(null)) as CapabilityDescriptor;
    const generation = ++this.#nextGeneration;
    const record: DescriptorRecord = {
      fd: raw,
      generation,
      parentGeneration,
      flags,
      kind,
      phase,
      state,
      statValidated: false,
      statKind: undefined
    };
    this.#registry.set(descriptor, record);
    this.#currentGenerationByDescriptor.set(raw, generation);
    issuedDescriptorMetadata.set(descriptor, Object.freeze({ descriptor: raw, generation, phase }));
    return descriptor;
  }

  #resolve(
    descriptor: unknown,
    operation: DescriptorOperation,
    phase: CapabilityPhase | null,
    unprovenReason: "unproven_descriptor" | "unproven_parent" = "unproven_descriptor"
  ): DescriptorRecord {
    if (typeof descriptor !== "object" || descriptor === null) {
      return this.#deny(
        operation,
        unprovenReason,
        typeof descriptor === "number" && Number.isFinite(descriptor) ? descriptor : null,
        null,
        phase
      );
    }
    const capability = descriptor as CapabilityDescriptor;
    const record = this.#registry.get(capability);
    if (!record) {
      const metadata = issuedDescriptorMetadata.get(capability);
      if (metadata) {
        return this.#deny(
          operation,
          "foreign_descriptor",
          metadata.descriptor,
          metadata.generation,
          metadata.phase
        );
      }
      return this.#deny(operation, unprovenReason, null, null, phase);
    }
    const currentGeneration = this.#currentGenerationByDescriptor.get(record.fd);
    if (record.state === "closed") {
      return this.#denyRecord(
        operation,
        currentGeneration === record.generation ? "closed_descriptor" : "stale_descriptor",
        record
      );
    }
    if (currentGeneration !== record.generation) return this.#denyRecord(operation, "stale_descriptor", record);
    return record;
  }

  #denyRecord(
    operation: DescriptorOperation,
    reason: DescriptorAuthorityDenialReason,
    record: DescriptorRecord
  ): never {
    return this.#deny(operation, reason, record.fd, record.generation, record.phase);
  }

  #deny(
    operation: DescriptorOperation,
    reason: DescriptorAuthorityDenialReason,
    descriptor: number | null,
    generation: number | null,
    phase: CapabilityPhase | null
  ): never {
    const denial = Object.freeze({
      schema_version: "shud.contract.descriptor-denial.v1" as const,
      operation,
      reason,
      descriptor,
      generation,
      phase
    });
    try {
      this.hooks.onDescriptorAuthorityDenial?.(denial);
    } catch {
      // The denial is authoritative even if an observation hook misbehaves.
    }
    throw new Error("CONTRACT_CAPABILITY_DESCRIPTOR_DENIED");
  }
}
