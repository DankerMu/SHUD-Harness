import { createHash } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeSync,
  type BigIntStats
} from "node:fs";
import { parse, resolve, sep } from "node:path";
import { openAt, mkdirAt, readErrno, renameAtNoReplace, unlinkAt } from "./local-token-syscalls";
import {
  CREATE_OPEN_FLAGS,
  DIRECTORY_OPEN_FLAGS,
  LOCAL_TOKEN_DIRECTORY,
  LOCAL_TOKEN_FILE,
  LOCAL_TOKEN_MAX_BYTES,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_MODE_MASK,
  PRIVATE_TOKEN_MODE,
  READ_OPEN_FLAGS,
  identityName,
  physicalIdentity,
  sameIdentity,
  sameStatIdentity,
  unsafeLocalTokenStorageError,
  type LocalTokenPhysicalIdentity,
  type OwnedLocalTokenArtifact,
  type ValidatedLocalToken
} from "./local-token-types";

const ENOENT = 2;

export interface WorkspaceTokenDescriptors {
  readonly workspaceRoot: string;
  readonly workspace: number;
  readonly secrets: number;
  readonly workspaceIdentity: LocalTokenPhysicalIdentity;
  readonly secretsIdentity: LocalTokenPhysicalIdentity;
}

export interface ObservedTokenArtifact extends ValidatedLocalToken {
  readonly digest: string;
}

export function closeOwnedDescriptor(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // A descriptor with lost close status cannot confer namespace authority.
  }
}

function guardDirectoryType(descriptor: number): BigIntStats {
  const observed = fstatSync(descriptor, { bigint: true });
  if (!observed.isDirectory() || observed.isSymbolicLink()) {
    throw unsafeLocalTokenStorageError();
  }
  return observed;
}

export function assertPrivateDirectory(descriptor: number): BigIntStats {
  const observed = guardDirectoryType(descriptor);
  if ((observed.mode & PRIVATE_MODE_MASK) !== PRIVATE_DIRECTORY_MODE) {
    throw unsafeLocalTokenStorageError();
  }
  return observed;
}

function guardedDirectoryOpenAt(parent: number, name: string): number {
  const descriptor = openAt(parent, name, DIRECTORY_OPEN_FLAGS);
  if (descriptor < 0) return descriptor;
  try {
    guardDirectoryType(descriptor);
    return descriptor;
  } catch (error) {
    closeOwnedDescriptor(descriptor);
    throw error;
  }
}

export function openWorkspaceRootDescriptor(
  workspaceRootInput: string,
  createLeaf = true
): { readonly root: string; readonly descriptor: number } {
  const workspaceRoot = resolve(workspaceRootInput);
  const parsed = parse(workspaceRoot);
  if (workspaceRoot === parsed.root) throw unsafeLocalTokenStorageError();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(parsed.root, DIRECTORY_OPEN_FLAGS);
    guardDirectoryType(descriptor);
    const segments = workspaceRoot.slice(parsed.root.length).split(sep).filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string;
      let next = guardedDirectoryOpenAt(descriptor, segment);
      if (next < 0 && createLeaf && index === segments.length - 1) {
        const created = mkdirAt(descriptor, segment, 0o700) === 0;
        next = guardedDirectoryOpenAt(descriptor, segment);
        if (next >= 0 && created) {
          fchmodSync(next, 0o700);
          fsyncSync(descriptor);
          guardDirectoryType(next);
        }
      }
      if (next < 0) throw unsafeLocalTokenStorageError();
      closeSync(descriptor);
      descriptor = next;
    }
    return Object.freeze({ root: workspaceRoot, descriptor });
  } catch {
    closeOwnedDescriptor(descriptor);
    throw unsafeLocalTokenStorageError();
  }
}

export function openOrCreateWorkspaceTokenDescriptors(
  workspaceRootInput: string
): WorkspaceTokenDescriptors {
  let workspace: number | undefined;
  let secrets: number | undefined;
  try {
    const opened = openWorkspaceRootDescriptor(workspaceRootInput, true);
    workspace = opened.descriptor;
    const workspaceObservation = guardDirectoryType(workspace);
    secrets = guardedDirectoryOpenAt(workspace, LOCAL_TOKEN_DIRECTORY);
    if (secrets < 0) {
      const created = mkdirAt(workspace, LOCAL_TOKEN_DIRECTORY, 0o700) === 0;
      secrets = guardedDirectoryOpenAt(workspace, LOCAL_TOKEN_DIRECTORY);
      if (secrets < 0) throw unsafeLocalTokenStorageError();
      if (created) {
        fchmodSync(secrets, 0o700);
        fsyncSync(workspace);
      }
    }
    const secretsObservation = assertPrivateDirectory(secrets);
    return Object.freeze({
      workspaceRoot: opened.root,
      workspace,
      secrets,
      workspaceIdentity: physicalIdentity(workspaceObservation),
      secretsIdentity: physicalIdentity(secretsObservation)
    });
  } catch {
    closeOwnedDescriptor(secrets);
    closeOwnedDescriptor(workspace);
    throw unsafeLocalTokenStorageError();
  }
}

export function assertWorkspaceAndSecretsBinding(input: WorkspaceTokenDescriptors): void {
  let reboundWorkspace: number | undefined;
  let reboundSecrets: number | undefined;
  try {
    reboundWorkspace = openWorkspaceRootDescriptor(input.workspaceRoot, false).descriptor;
    const workspaceObservation = guardDirectoryType(reboundWorkspace);
    if (!sameIdentity(physicalIdentity(workspaceObservation), input.workspaceIdentity)) {
      throw unsafeLocalTokenStorageError();
    }
    reboundSecrets = guardedDirectoryOpenAt(reboundWorkspace, LOCAL_TOKEN_DIRECTORY);
    if (reboundSecrets < 0) throw unsafeLocalTokenStorageError();
    const secretsObservation = assertPrivateDirectory(reboundSecrets);
    if (!sameIdentity(physicalIdentity(secretsObservation), input.secretsIdentity)) {
      throw unsafeLocalTokenStorageError();
    }
    const heldWorkspace = guardDirectoryType(input.workspace);
    const heldSecrets = assertPrivateDirectory(input.secrets);
    if (
      !sameIdentity(physicalIdentity(heldWorkspace), input.workspaceIdentity) ||
      !sameIdentity(physicalIdentity(heldSecrets), input.secretsIdentity)
    ) {
      throw unsafeLocalTokenStorageError();
    }
  } finally {
    closeOwnedDescriptor(reboundSecrets);
    closeOwnedDescriptor(reboundWorkspace);
  }
}

function assertTokenStat(entry: BigIntStats): void {
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1n ||
    (entry.mode & PRIVATE_MODE_MASK) !== PRIVATE_TOKEN_MODE ||
    entry.size <= 0n ||
    entry.size > BigInt(LOCAL_TOKEN_MAX_BYTES)
  ) {
    throw unsafeLocalTokenStorageError();
  }
}

function sameTokenObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameStatIdentity(left, right) &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

export function readValidatedTokenDescriptor(
  descriptor: number,
  secretsDescriptor: number,
  boundName: string
): ValidatedLocalToken {
  const before = fstatSync(descriptor, { bigint: true });
  assertTokenStat(before);
  const expectedBytes = Number(before.size);
  const bytes = Buffer.alloc(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const count = readSync(descriptor, bytes, offset, expectedBytes - offset, offset);
    if (count <= 0) break;
    offset += count;
  }
  const overflow = Buffer.alloc(1);
  const overflowCount = readSync(descriptor, overflow, 0, 1, offset);
  const after = fstatSync(descriptor, { bigint: true });
  if (
    offset !== expectedBytes ||
    overflowCount !== 0 ||
    !sameTokenObservation(before, after)
  ) {
    throw unsafeLocalTokenStorageError();
  }

  const rebound = openAt(secretsDescriptor, boundName, READ_OPEN_FLAGS);
  if (rebound < 0) throw unsafeLocalTokenStorageError();
  try {
    const reboundObservation = fstatSync(rebound, { bigint: true });
    assertTokenStat(reboundObservation);
    if (!sameTokenObservation(after, reboundObservation)) {
      throw unsafeLocalTokenStorageError();
    }
  } finally {
    closeOwnedDescriptor(rebound);
  }

  let token: string;
  try {
    token = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw unsafeLocalTokenStorageError();
  }
  if (token.length === 0 || !Buffer.from(token, "utf8").equals(bytes)) {
    throw unsafeLocalTokenStorageError();
  }
  return Object.freeze({
    token,
    bytes,
    observation: after,
    identity: physicalIdentity(after)
  });
}

export function readCanonicalToken(
  secretsDescriptor: number,
  allowMissing: boolean
): ValidatedLocalToken | undefined {
  const descriptor = openAt(secretsDescriptor, LOCAL_TOKEN_FILE, READ_OPEN_FLAGS);
  if (descriptor < 0) {
    if (allowMissing && readErrno() === ENOENT) return undefined;
    throw unsafeLocalTokenStorageError();
  }
  try {
    return readValidatedTokenDescriptor(descriptor, secretsDescriptor, LOCAL_TOKEN_FILE);
  } finally {
    closeOwnedDescriptor(descriptor);
  }
}

export function observeRegularArtifact(
  secretsDescriptor: number,
  name: string
): OwnedLocalTokenArtifact | undefined {
  const descriptor = openAt(secretsDescriptor, name, READ_OPEN_FLAGS);
  if (descriptor < 0) {
    if (readErrno() === ENOENT) return undefined;
    throw unsafeLocalTokenStorageError();
  }
  try {
    const observed = fstatSync(descriptor, { bigint: true });
    if (!observed.isFile() || observed.isSymbolicLink()) {
      throw unsafeLocalTokenStorageError();
    }
    const rebound = openAt(secretsDescriptor, name, READ_OPEN_FLAGS);
    if (rebound < 0) throw unsafeLocalTokenStorageError();
    try {
      const reboundObservation = fstatSync(rebound, { bigint: true });
      if (!sameStatIdentity(observed, reboundObservation)) {
        throw unsafeLocalTokenStorageError();
      }
    } finally {
      closeOwnedDescriptor(rebound);
    }
    return Object.freeze({ name, identity: physicalIdentity(observed) });
  } finally {
    closeOwnedDescriptor(descriptor);
  }
}

export function validateControlArtifact(
  secretsDescriptor: number,
  name: string
): OwnedLocalTokenArtifact {
  const descriptor = openAt(secretsDescriptor, name, READ_OPEN_FLAGS);
  if (descriptor < 0) throw unsafeLocalTokenStorageError();
  try {
    const observed = fstatSync(descriptor, { bigint: true });
    assertControlStat(observed);
    const rebound = openAt(secretsDescriptor, name, READ_OPEN_FLAGS);
    if (rebound < 0) throw unsafeLocalTokenStorageError();
    try {
      const reboundObservation = fstatSync(rebound, { bigint: true });
      assertControlStat(reboundObservation);
      if (!sameStatIdentity(observed, reboundObservation)) {
        throw unsafeLocalTokenStorageError();
      }
    } finally {
      closeOwnedDescriptor(rebound);
    }
    return Object.freeze({ name, identity: physicalIdentity(observed) });
  } finally {
    closeOwnedDescriptor(descriptor);
  }
}

export function assertControlStat(entry: BigIntStats): void {
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1n ||
    entry.size !== 0n ||
    (entry.mode & PRIVATE_MODE_MASK) !== PRIVATE_TOKEN_MODE
  ) {
    throw unsafeLocalTokenStorageError();
  }
}

export function retireExactArtifact(
  secretsDescriptor: number,
  artifact: OwnedLocalTokenArtifact
): void {
  const before = observeRegularArtifact(secretsDescriptor, artifact.name);
  if (before === undefined || !sameIdentity(before.identity, artifact.identity)) {
    throw unsafeLocalTokenStorageError();
  }
  const retirementName = `.local-token-retired-${identityName(artifact.identity)}-${crypto.randomUUID()}.retired`;
  if (renameAtNoReplace(
    secretsDescriptor,
    artifact.name,
    secretsDescriptor,
    retirementName
  ) !== 0) {
    throw unsafeLocalTokenStorageError();
  }
  fsyncSync(secretsDescriptor);
  const retired = observeRegularArtifact(secretsDescriptor, retirementName);
  if (retired === undefined || !sameIdentity(retired.identity, artifact.identity)) {
    throw unsafeLocalTokenStorageError();
  }
  const reproof = observeRegularArtifact(secretsDescriptor, retirementName);
  if (reproof === undefined || !sameIdentity(reproof.identity, artifact.identity)) {
    throw unsafeLocalTokenStorageError();
  }
  if (unlinkAt(secretsDescriptor, retirementName) !== 0) {
    throw unsafeLocalTokenStorageError();
  }
  fsyncSync(secretsDescriptor);
}

export function readObservedTokenArtifact(
  secretsDescriptor: number,
  name: string
): ObservedTokenArtifact | undefined {
  const descriptor = openAt(secretsDescriptor, name, READ_OPEN_FLAGS);
  if (descriptor < 0) {
    if (readErrno() === ENOENT) return undefined;
    throw unsafeLocalTokenStorageError();
  }
  try {
    const token = readValidatedTokenDescriptor(descriptor, secretsDescriptor, name);
    return Object.freeze({
      ...token,
      digest: createHash("sha256").update(token.bytes).digest("hex")
    });
  } finally {
    closeOwnedDescriptor(descriptor);
  }
}

export function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (count <= 0) throw unsafeLocalTokenStorageError();
    offset += count;
  }
}

export function openCreatedArtifact(
  secretsDescriptor: number,
  name: string,
  flags = CREATE_OPEN_FLAGS
): number {
  return openAt(secretsDescriptor, name, flags, 0o600);
}

export function createdArtifactIdentity(
  descriptor: number,
  name: string
): OwnedLocalTokenArtifact {
  const observed = fstatSync(descriptor, { bigint: true });
  if (!observed.isFile() || observed.isSymbolicLink()) {
    throw unsafeLocalTokenStorageError();
  }
  return Object.freeze({ name, identity: physicalIdentity(observed) });
}

export function assertCurrentTokenAuthority(input: {
  readonly workspaceRoot: string;
  readonly workspaceIdentity: LocalTokenPhysicalIdentity;
  readonly secretsIdentity: LocalTokenPhysicalIdentity;
  readonly tokenIdentity: LocalTokenPhysicalIdentity;
  readonly tokenBytes: Buffer;
}): void {
  let workspace: number | undefined;
  let secrets: number | undefined;
  try {
    const opened = openWorkspaceRootDescriptor(input.workspaceRoot, false);
    workspace = opened.descriptor;
    const workspaceObservation = guardDirectoryType(workspace);
    if (!sameIdentity(physicalIdentity(workspaceObservation), input.workspaceIdentity)) {
      throw unsafeLocalTokenStorageError();
    }
    secrets = guardedDirectoryOpenAt(workspace, LOCAL_TOKEN_DIRECTORY);
    if (secrets < 0) throw unsafeLocalTokenStorageError();
    const secretsObservation = assertPrivateDirectory(secrets);
    if (!sameIdentity(physicalIdentity(secretsObservation), input.secretsIdentity)) {
      throw unsafeLocalTokenStorageError();
    }
    const token = readCanonicalToken(secrets, false);
    if (
      token === undefined ||
      !sameIdentity(token.identity, input.tokenIdentity) ||
      !token.bytes.equals(input.tokenBytes)
    ) {
      throw unsafeLocalTokenStorageError();
    }
  } catch {
    throw unsafeLocalTokenStorageError();
  } finally {
    closeOwnedDescriptor(secrets);
    closeOwnedDescriptor(workspace);
  }
}
