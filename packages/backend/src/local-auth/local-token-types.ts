import { constants, type BigIntStats } from "node:fs";

export const LOCAL_TOKEN_DIRECTORY = "secrets";
export const LOCAL_TOKEN_FILE = "local-token";
export const LOCAL_TOKEN_MAX_BYTES = 4096;
export const LOCAL_TOKEN_NAME_MAX_BYTES = 255;
export const LOCAL_TOKEN_MAX_EXTERNAL_ENTRIES = 1024;
export const LOCAL_TOKEN_MAX_OWNED_ENTRIES = 8;
export const LOCAL_TOKEN_MAX_DECODED_ENTRIES =
  LOCAL_TOKEN_MAX_EXTERNAL_ENTRIES + LOCAL_TOKEN_MAX_OWNED_ENTRIES;

export const PRIVATE_MODE_MASK = 0o7777n;
export const PRIVATE_TOKEN_MODE = 0o600n;
export const PRIVATE_DIRECTORY_MODE = 0o700n;

export const DIRECTORY_OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
export const READ_OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
export const CREATE_OPEN_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
export const LEASE_CREATE_FLAGS =
  constants.O_RDWR |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

export const FLOCK_EXCLUSIVE = 0x02;
export const FLOCK_NONBLOCKING = 0x04;

export const LEGACY_STAGED_PATTERN =
  /^\.local-token-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;
export const TRANSACTION_ARTIFACT_PATTERN =
  /^\.local-token-transaction-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(lease|staged|candidate)$/u;
export const TRANSACTION_PHASE_PATTERN =
  /^\.local-token-transaction-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{64})-([0-9a-f]+)-([0-9a-f]+)\.(publishing|rolling-back)$/u;
export const RETIRED_ARTIFACT_PATTERN =
  /^\.local-token-retired-([0-9a-f]+)-([0-9a-f]+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.retired$/u;

export interface LocalTokenPhysicalIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface OwnedLocalTokenArtifact {
  readonly name: string;
  readonly identity: LocalTokenPhysicalIdentity;
}

export interface ValidatedLocalToken {
  readonly token: string;
  readonly bytes: Buffer;
  readonly observation: BigIntStats;
  readonly identity: LocalTokenPhysicalIdentity;
}

export interface WorkspaceLocalTokenAuthority {
  readonly token: string;
  readonly source: "workspace";
  assertCurrent(): void;
}

export class LocalTokenStorageError extends Error {
  readonly code = "local_token_storage_unsafe" as const;

  constructor() {
    super("Local API token storage is unsafe.");
    this.name = "LocalTokenStorageError";
  }
}

export function unsafeLocalTokenStorageError(): LocalTokenStorageError {
  return new LocalTokenStorageError();
}

export function physicalIdentity(entry: BigIntStats): LocalTokenPhysicalIdentity {
  return Object.freeze({ dev: entry.dev, ino: entry.ino });
}

export function sameIdentity(
  left: LocalTokenPhysicalIdentity,
  right: LocalTokenPhysicalIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameStatIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function identityName(identity: LocalTokenPhysicalIdentity): string {
  return `${identity.dev.toString(16)}-${identity.ino.toString(16)}`;
}
