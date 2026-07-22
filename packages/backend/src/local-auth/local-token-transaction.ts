import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  fchmodSync,
  fstatSync,
  fsyncSync
} from "node:fs";
import {
  assertControlStat,
  assertWorkspaceAndSecretsBinding,
  closeOwnedDescriptor,
  createdArtifactIdentity,
  moveObservedArtifactUnderLease,
  observeRegularArtifact,
  openCreatedArtifactUnderLease,
  readObservedTokenArtifact,
  retireObservedArtifactUnderLease,
  secretsDescriptorUnderLease,
  settleOwnedDescriptors,
  validateControlArtifact,
  writeAll,
  type HeldSecretsMutationLease,
  type WorkspaceTokenDescriptors
} from "./local-token-filesystem";
import type { LocalTokenDirectoryInventory } from "./local-token-inventory";
import { openAt } from "./local-token-syscalls";
import {
  invokeLocalTokenTestHook,
  shouldFailLocalTokenTestOperation
} from "./local-token-test-support";
import {
  LEASE_CREATE_FLAGS,
  LEGACY_STAGED_PATTERN,
  LOCAL_TOKEN_FILE,
  LOCAL_TOKEN_MAX_BYTES,
  PRIVATE_MODE_MASK,
  PRIVATE_TOKEN_MODE,
  READ_OPEN_FLAGS,
  RETIRED_ARTIFACT_PATTERN,
  TRANSACTION_ARTIFACT_PATTERN,
  TRANSACTION_PHASE_PATTERN,
  identityName,
  physicalIdentity,
  sameIdentity,
  unsafeLocalTokenStorageError,
  type LocalTokenPhysicalIdentity,
  type OwnedLocalTokenArtifact,
  type ValidatedLocalToken
} from "./local-token-types";

interface LocalTokenTransactionArtifacts {
  readonly id: string;
  leaseName?: string;
  stagedName?: string;
  candidateName?: string;
  publishingMarkerName?: string;
  rollbackMarkerName?: string;
  digest?: string;
  generationIdentity?: LocalTokenPhysicalIdentity;
}

interface CreatedLease {
  readonly descriptor: number;
  readonly control: OwnedLocalTokenArtifact;
}

function settleOperations(...operations: ReadonlyArray<() => void>): void {
  let failure: unknown;
  for (const operation of operations) {
    try {
      operation();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw unsafeLocalTokenStorageError();
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function transactionLeaseName(id: string): string {
  return `.local-token-transaction-${id}.lease`;
}

function transactionStagedName(id: string): string {
  return `.local-token-transaction-${id}.staged`;
}

function transactionCandidateName(id: string): string {
  return `.local-token-transaction-${id}.candidate`;
}

function publishingMarkerName(
  id: string,
  contentDigest: string,
  identity: LocalTokenPhysicalIdentity
): string {
  return `.local-token-transaction-${id}-${contentDigest}-${identityName(identity)}.publishing`;
}

function rollbackMarkerName(
  id: string,
  contentDigest: string,
  identity: LocalTokenPhysicalIdentity
): string {
  return `.local-token-transaction-${id}-${contentDigest}-${identityName(identity)}.rolling-back`;
}

function collectTransactions(
  names: readonly string[]
): Map<string, LocalTokenTransactionArtifacts> {
  const transactions = new Map<string, LocalTokenTransactionArtifacts>();
  for (const name of names) {
    const artifact = TRANSACTION_ARTIFACT_PATTERN.exec(name);
    if (artifact) {
      const id = artifact[1] as string;
      const transaction = transactions.get(id) ?? { id };
      const kind = artifact[2];
      if (kind === "lease") {
        if (transaction.leaseName) throw unsafeLocalTokenStorageError();
        transaction.leaseName = name;
      }
      if (kind === "staged") {
        if (transaction.stagedName) throw unsafeLocalTokenStorageError();
        transaction.stagedName = name;
      }
      if (kind === "candidate") {
        if (transaction.candidateName) throw unsafeLocalTokenStorageError();
        transaction.candidateName = name;
      }
      transactions.set(id, transaction);
      continue;
    }

    const phase = TRANSACTION_PHASE_PATTERN.exec(name);
    if (!phase) continue;
    const id = phase[1] as string;
    const contentDigest = phase[2] as string;
    const generationIdentity = Object.freeze({
      dev: BigInt(`0x${phase[3]}`),
      ino: BigInt(`0x${phase[4]}`)
    });
    const transaction = transactions.get(id) ?? { id };
    if (transaction.digest && transaction.digest !== contentDigest) {
      throw unsafeLocalTokenStorageError();
    }
    if (
      transaction.generationIdentity &&
      !sameIdentity(transaction.generationIdentity, generationIdentity)
    ) {
      throw unsafeLocalTokenStorageError();
    }
    transaction.digest = contentDigest;
    transaction.generationIdentity = generationIdentity;
    if (phase[5] === "publishing") {
      if (transaction.publishingMarkerName) throw unsafeLocalTokenStorageError();
      transaction.publishingMarkerName = name;
    } else {
      if (transaction.rollbackMarkerName) throw unsafeLocalTokenStorageError();
      transaction.rollbackMarkerName = name;
    }
    transactions.set(id, transaction);
  }
  return transactions;
}

function controlKind(name: string): "publishing" | "rolling-back" | "lease" {
  if (name.endsWith(".publishing")) return "publishing";
  if (name.endsWith(".rolling-back")) return "rolling-back";
  if (name.endsWith(".lease")) return "lease";
  throw unsafeLocalTokenStorageError();
}

function cleanupControl(
  mutationLease: HeldSecretsMutationLease,
  control: OwnedLocalTokenArtifact
): void {
  const artifact = controlKind(control.name);
  invokeLocalTokenTestHook({
    stage: artifact === "publishing"
      ? "before_publishing_cleanup"
      : artifact === "rolling-back"
        ? "before_rolling_back_cleanup"
        : "before_lease_cleanup",
    name: control.name,
    artifact
  });
  retireObservedArtifactUnderLease(mutationLease, control);
}

function cleanupControls(
  mutationLease: HeldSecretsMutationLease,
  marker: OwnedLocalTokenArtifact | undefined,
  lease: OwnedLocalTokenArtifact | undefined
): void {
  settleOperations(
    () => {
      if (marker) cleanupControl(mutationLease, marker);
    },
    () => {
      if (lease) cleanupControl(mutationLease, lease);
    },
    () => fsyncSync(secretsDescriptorUnderLease(mutationLease))
  );
}

function validateRecoverablePartialArtifact(
  secretsDescriptor: number,
  name: string
): OwnedLocalTokenArtifact {
  const artifact = observeRegularArtifact(secretsDescriptor, name);
  if (!artifact) throw unsafeLocalTokenStorageError();
  const descriptor = openAt(secretsDescriptor, name, READ_OPEN_FLAGS);
  if (descriptor < 0) throw unsafeLocalTokenStorageError();
  try {
    const observed = fstatSync(descriptor, { bigint: true });
    if (
      !observed.isFile() ||
      observed.isSymbolicLink() ||
      observed.nlink < 1n ||
      observed.nlink > 2n ||
      observed.size < 0n ||
      observed.size > BigInt(LOCAL_TOKEN_MAX_BYTES) ||
      (observed.mode & PRIVATE_MODE_MASK) !== PRIVATE_TOKEN_MODE ||
      !sameIdentity(physicalIdentity(observed), artifact.identity)
    ) {
      throw unsafeLocalTokenStorageError();
    }
    if (observed.nlink === 2n) {
      const canonical = observeRegularArtifact(secretsDescriptor, LOCAL_TOKEN_FILE);
      if (!canonical || !sameIdentity(canonical.identity, artifact.identity)) {
        throw unsafeLocalTokenStorageError();
      }
    }
    return artifact;
  } finally {
    closeOwnedDescriptor(descriptor);
  }
}

function recoverPublishing(
  mutationLease: HeldSecretsMutationLease,
  transaction: LocalTokenTransactionArtifacts,
  lease: OwnedLocalTokenArtifact | undefined
): void {
  const secretsDescriptor = secretsDescriptorUnderLease(mutationLease);
  if (
    !transaction.publishingMarkerName ||
    !transaction.digest ||
    !transaction.generationIdentity ||
    transaction.candidateName
  ) {
    throw unsafeLocalTokenStorageError();
  }
  const marker = validateControlArtifact(secretsDescriptor, transaction.publishingMarkerName);
  const canonical = readObservedTokenArtifact(secretsDescriptor, LOCAL_TOKEN_FILE);
  const foreignCanonical = canonical !== undefined &&
    !sameIdentity(canonical.identity, transaction.generationIdentity);
  if (canonical && sameIdentity(canonical.identity, transaction.generationIdentity)) {
    if (canonical.digest !== transaction.digest || transaction.stagedName) {
      throw unsafeLocalTokenStorageError();
    }
  } else if (transaction.stagedName) {
    const staged = readObservedTokenArtifact(secretsDescriptor, transaction.stagedName);
    if (
      !staged ||
      staged.digest !== transaction.digest ||
      !sameIdentity(staged.identity, transaction.generationIdentity)
    ) {
      throw unsafeLocalTokenStorageError();
    }
    invokeLocalTokenTestHook({
      stage: "before_staged_cleanup",
      name: transaction.stagedName,
      artifact: "staged"
    });
    retireObservedArtifactUnderLease(mutationLease, {
      name: transaction.stagedName,
      identity: staged.identity
    });
  }
  cleanupControls(mutationLease, marker, lease);
  if (foreignCanonical) throw unsafeLocalTokenStorageError();
}

function recoverRollingBack(
  mutationLease: HeldSecretsMutationLease,
  transaction: LocalTokenTransactionArtifacts,
  lease: OwnedLocalTokenArtifact | undefined
): void {
  const secretsDescriptor = secretsDescriptorUnderLease(mutationLease);
  if (
    !transaction.rollbackMarkerName ||
    !transaction.digest ||
    !transaction.generationIdentity ||
    transaction.stagedName
  ) {
    throw unsafeLocalTokenStorageError();
  }
  const marker = validateControlArtifact(secretsDescriptor, transaction.rollbackMarkerName);
  let foreignGenerationObserved = false;

  if (transaction.candidateName) {
    const candidate = readObservedTokenArtifact(secretsDescriptor, transaction.candidateName);
    if (!candidate) throw unsafeLocalTokenStorageError();
    if (sameIdentity(candidate.identity, transaction.generationIdentity)) {
      if (candidate.digest !== transaction.digest) throw unsafeLocalTokenStorageError();
      invokeLocalTokenTestHook({
        stage: "before_candidate_cleanup",
        name: transaction.candidateName,
        artifact: "candidate"
      });
      retireObservedArtifactUnderLease(mutationLease, {
        name: transaction.candidateName,
        identity: candidate.identity
      });
    } else {
      foreignGenerationObserved = true;
      if (readObservedTokenArtifact(secretsDescriptor, LOCAL_TOKEN_FILE)) {
        // Two external canonical writers cannot be ordered without deleting one.
        cleanupControls(mutationLease, marker, lease);
        throw unsafeLocalTokenStorageError();
      }
      if (!moveObservedArtifactUnderLease(mutationLease, {
        name: transaction.candidateName,
        identity: candidate.identity
      }, LOCAL_TOKEN_FILE)) {
        throw unsafeLocalTokenStorageError();
      }
      const restored = readObservedTokenArtifact(secretsDescriptor, LOCAL_TOKEN_FILE);
      if (!restored || !sameIdentity(restored.identity, candidate.identity)) {
        throw unsafeLocalTokenStorageError();
      }
    }
  }

  const canonical = readObservedTokenArtifact(secretsDescriptor, LOCAL_TOKEN_FILE);
  if (canonical && sameIdentity(canonical.identity, transaction.generationIdentity)) {
    if (canonical.digest !== transaction.digest) throw unsafeLocalTokenStorageError();
    const candidateName = transactionCandidateName(transaction.id);
    if (!moveObservedArtifactUnderLease(mutationLease, {
      name: LOCAL_TOKEN_FILE,
      identity: canonical.identity
    }, candidateName)) {
      throw unsafeLocalTokenStorageError();
    }
    invokeLocalTokenTestHook({
      stage: "before_candidate_cleanup",
      name: candidateName,
      artifact: "candidate"
    });
    retireObservedArtifactUnderLease(mutationLease, {
      name: candidateName,
      identity: transaction.generationIdentity
    });
  } else if (canonical) {
    foreignGenerationObserved = true;
  }
  cleanupControls(mutationLease, marker, lease);
  if (foreignGenerationObserved) throw unsafeLocalTokenStorageError();
}

function recoverTransaction(
  mutationLease: HeldSecretsMutationLease,
  transaction: LocalTokenTransactionArtifacts
): void {
  const secretsDescriptor = secretsDescriptorUnderLease(mutationLease);
  const lease = transaction.leaseName
    ? validateControlArtifact(secretsDescriptor, transaction.leaseName)
    : undefined;
  if (transaction.publishingMarkerName && transaction.rollbackMarkerName) {
    throw unsafeLocalTokenStorageError();
  }
  if (!transaction.digest) {
    if (transaction.candidateName || transaction.publishingMarkerName || transaction.rollbackMarkerName) {
      throw unsafeLocalTokenStorageError();
    }
    if (transaction.stagedName) {
      invokeLocalTokenTestHook({
        stage: "before_recovery_artifact_open",
        name: transaction.stagedName,
        artifact: "staged"
      });
      const staged = validateRecoverablePartialArtifact(
        secretsDescriptor,
        transaction.stagedName
      );
      invokeLocalTokenTestHook({
        stage: "before_staged_cleanup",
        name: transaction.stagedName,
        artifact: "staged"
      });
      retireObservedArtifactUnderLease(mutationLease, staged);
    }
    cleanupControls(mutationLease, undefined, lease);
    return;
  }
  if (transaction.publishingMarkerName) {
    recoverPublishing(mutationLease, transaction, lease);
    return;
  }
  if (transaction.rollbackMarkerName) {
    recoverRollingBack(mutationLease, transaction, lease);
    return;
  }
  throw unsafeLocalTokenStorageError();
}

function recoverLegacyArtifact(
  mutationLease: HeldSecretsMutationLease,
  name: string
): void {
  const secretsDescriptor = secretsDescriptorUnderLease(mutationLease);
  invokeLocalTokenTestHook({
    stage: "before_recovery_artifact_open",
    name,
    artifact: "legacy"
  });
  const artifact = validateRecoverablePartialArtifact(secretsDescriptor, name);
  invokeLocalTokenTestHook({ stage: "before_legacy_cleanup", name, artifact: "legacy" });
  retireObservedArtifactUnderLease(mutationLease, artifact);
}

export function recoverInterruptedLocalTokenStore(
  descriptors: WorkspaceTokenDescriptors,
  inventory: LocalTokenDirectoryInventory,
  mutationLease: HeldSecretsMutationLease
): void {
  if (secretsDescriptorUnderLease(mutationLease) !== descriptors.secrets) {
    throw unsafeLocalTokenStorageError();
  }
  assertWorkspaceAndSecretsBinding(descriptors);
  for (const name of inventory.names) {
    const retired = RETIRED_ARTIFACT_PATTERN.exec(name);
    if (!retired) continue;
    invokeLocalTokenTestHook({ stage: "before_retired_cleanup", name, artifact: "retired" });
    retireObservedArtifactUnderLease(mutationLease, {
      name,
      identity: Object.freeze({
        dev: BigInt(`0x${retired[1]}`),
        ino: BigInt(`0x${retired[2]}`)
      })
    });
  }
  for (const transaction of collectTransactions(inventory.names).values()) {
    recoverTransaction(mutationLease, transaction);
  }
  for (const name of inventory.names) {
    if (LEGACY_STAGED_PATTERN.test(name)) recoverLegacyArtifact(mutationLease, name);
  }
  assertWorkspaceAndSecretsBinding(descriptors);
}

function createControlArtifact(
  mutationLease: HeldSecretsMutationLease,
  name: string
): OwnedLocalTokenArtifact {
  const descriptor = openCreatedArtifactUnderLease(mutationLease, name);
  if (descriptor < 0) throw unsafeLocalTokenStorageError();
  let control: OwnedLocalTokenArtifact | undefined;
  let valid = false;
  try {
    control = createdArtifactIdentity(descriptor, name);
    fchmodSync(descriptor, 0o600);
    assertControlStat(fstatSync(descriptor, { bigint: true }));
    if (shouldFailLocalTokenTestOperation("marker_setup")) {
      throw unsafeLocalTokenStorageError();
    }
    fsyncSync(descriptor);
    valid = true;
    return control;
  } finally {
    settleOperations(
      () => closeOwnedDescriptor(descriptor),
      () => {
        if (!valid && control) cleanupControl(mutationLease, control);
      }
    );
  }
}

function createLease(
  mutationLease: HeldSecretsMutationLease,
  name: string
): CreatedLease {
  const descriptor = openCreatedArtifactUnderLease(mutationLease, name, LEASE_CREATE_FLAGS);
  if (descriptor < 0) throw unsafeLocalTokenStorageError();
  let control: OwnedLocalTokenArtifact | undefined;
  let valid = false;
  try {
    control = createdArtifactIdentity(descriptor, name);
    fchmodSync(descriptor, 0o600);
    assertControlStat(fstatSync(descriptor, { bigint: true }));
    if (shouldFailLocalTokenTestOperation("lease_setup")) {
      throw unsafeLocalTokenStorageError();
    }
    valid = true;
    return Object.freeze({ descriptor, control });
  } finally {
    if (!valid) {
      settleOperations(
        () => closeOwnedDescriptor(descriptor),
        () => {
          if (control) cleanupControl(mutationLease, control);
        }
      );
    }
  }
}

function rollbackPublished(input: {
  readonly descriptors: WorkspaceTokenDescriptors;
  readonly mutationLease: HeldSecretsMutationLease;
  readonly transactionId: string;
  readonly contentDigest: string;
  readonly generationIdentity: LocalTokenPhysicalIdentity;
  readonly publishingMarker: OwnedLocalTokenArtifact;
  readonly rollbackName: string;
  readonly lease: OwnedLocalTokenArtifact;
}): void {
  const {
    descriptors,
    mutationLease,
    transactionId,
    contentDigest,
    generationIdentity,
    publishingMarker,
    rollbackName,
    lease
  } = input;
  const currentMarker = validateControlArtifact(
    descriptors.secrets,
    publishingMarker.name
  );
  if (!sameIdentity(currentMarker.identity, publishingMarker.identity)) {
    throw unsafeLocalTokenStorageError();
  }
  if (!moveObservedArtifactUnderLease(mutationLease, currentMarker, rollbackName)) {
    throw unsafeLocalTokenStorageError();
  }
  const rollbackMarker = validateControlArtifact(descriptors.secrets, rollbackName);
  if (!sameIdentity(rollbackMarker.identity, publishingMarker.identity)) {
    throw unsafeLocalTokenStorageError();
  }
  invokeLocalTokenTestHook({ stage: "after_rollback_marker_fsync" });

  const candidateName = transactionCandidateName(transactionId);
  const canonicalBeforeMove = readObservedTokenArtifact(
    descriptors.secrets,
    LOCAL_TOKEN_FILE
  );
  if (
    !canonicalBeforeMove ||
    !moveObservedArtifactUnderLease(mutationLease, {
      name: LOCAL_TOKEN_FILE,
      identity: canonicalBeforeMove.identity
    }, candidateName)
  ) {
    const canonical = readObservedTokenArtifact(descriptors.secrets, LOCAL_TOKEN_FILE);
    if (!canonical || sameIdentity(canonical.identity, generationIdentity)) {
      throw unsafeLocalTokenStorageError();
    }
    cleanupControls(mutationLease, rollbackMarker, lease);
    return;
  }
  invokeLocalTokenTestHook({ stage: "after_rollback_move" });
  const candidate = readObservedTokenArtifact(descriptors.secrets, candidateName);
  if (!candidate) throw unsafeLocalTokenStorageError();
  if (sameIdentity(candidate.identity, generationIdentity)) {
    if (candidate.digest !== contentDigest) throw unsafeLocalTokenStorageError();
    invokeLocalTokenTestHook({
      stage: "before_candidate_cleanup",
      name: candidateName,
      artifact: "candidate"
    });
    retireObservedArtifactUnderLease(mutationLease, {
      name: candidateName,
      identity: candidate.identity
    });
  } else {
    if (!moveObservedArtifactUnderLease(mutationLease, {
      name: candidateName,
      identity: candidate.identity
    }, LOCAL_TOKEN_FILE)) {
      throw unsafeLocalTokenStorageError();
    }
    const restored = readObservedTokenArtifact(descriptors.secrets, LOCAL_TOKEN_FILE);
    if (!restored || !sameIdentity(restored.identity, candidate.identity)) {
      throw unsafeLocalTokenStorageError();
    }
  }
  cleanupControls(mutationLease, rollbackMarker, lease);
}

export function publishLocalToken(
  descriptors: WorkspaceTokenDescriptors,
  mutationLease: HeldSecretsMutationLease
): ValidatedLocalToken {
  if (secretsDescriptorUnderLease(mutationLease) !== descriptors.secrets) {
    throw unsafeLocalTokenStorageError();
  }
  const tokenBytes = Buffer.from(randomBytes(32).toString("base64url"), "utf8");
  const transactionId = randomUUID();
  const contentDigest = digest(tokenBytes);
  const leaseName = transactionLeaseName(transactionId);
  const stagedName = transactionStagedName(transactionId);
  const lease = createLease(mutationLease, leaseName);
  let leaseDescriptorOpen = true;
  let stagedDescriptor: number | undefined;
  let staged: OwnedLocalTokenArtifact | undefined;
  let marker: OwnedLocalTokenArtifact | undefined;
  let stagedExists = false;
  let leaseExists = true;
  let published = false;
  try {
    invokeLocalTokenTestHook({ stage: "before_staged_open", name: stagedName, artifact: "staged" });
    stagedDescriptor = shouldFailLocalTokenTestOperation("staged_open")
      ? -1
      : openCreatedArtifactUnderLease(mutationLease, stagedName);
    if (stagedDescriptor < 0) {
      stagedDescriptor = undefined;
      leaseExists = false;
      leaseDescriptorOpen = false;
      settleOperations(
        () => closeOwnedDescriptor(lease.descriptor),
        () => cleanupControl(mutationLease, lease.control)
      );
      throw unsafeLocalTokenStorageError();
    }
    stagedExists = true;
    if (shouldFailLocalTokenTestOperation("staged_fstat")) {
      throw unsafeLocalTokenStorageError();
    }
    staged = createdArtifactIdentity(stagedDescriptor, stagedName);
    invokeLocalTokenTestHook({
      stage: "staged_descriptor_guard",
      name: stagedName,
      artifact: "staged"
    });
    fchmodSync(stagedDescriptor, 0o600);
    writeAll(stagedDescriptor, tokenBytes);
    fsyncSync(stagedDescriptor);
    invokeLocalTokenTestHook({ stage: "after_staged_fsync" });
    const stagedObservation = fstatSync(stagedDescriptor, { bigint: true });
    if (
      !sameIdentity(physicalIdentity(stagedObservation), staged.identity) ||
      stagedObservation.size !== BigInt(tokenBytes.byteLength) ||
      stagedObservation.nlink !== 1n ||
      (stagedObservation.mode & PRIVATE_MODE_MASK) !== PRIVATE_TOKEN_MODE
    ) {
      throw unsafeLocalTokenStorageError();
    }

    const publishingName = publishingMarkerName(
      transactionId,
      contentDigest,
      staged.identity
    );
    const rollingName = rollbackMarkerName(
      transactionId,
      contentDigest,
      staged.identity
    );
    marker = createControlArtifact(mutationLease, publishingName);
    fsyncSync(descriptors.secrets);
    invokeLocalTokenTestHook({ stage: "after_publishing_marker_fsync" });

    published = moveObservedArtifactUnderLease(
      mutationLease,
      staged,
      LOCAL_TOKEN_FILE
    );
    if (published) {
      stagedExists = false;
      invokeLocalTokenTestHook({ stage: "after_publish" });
    } else {
      invokeLocalTokenTestHook({ stage: "before_staged_cleanup", name: stagedName, artifact: "staged" });
      retireObservedArtifactUnderLease(mutationLease, staged);
      stagedExists = false;
    }
    fsyncSync(descriptors.secrets);

    if (!published) {
      cleanupControls(mutationLease, marker, lease.control);
      marker = undefined;
      leaseExists = false;
      throw unsafeLocalTokenStorageError();
    }

    invokeLocalTokenTestHook({ stage: "before_post_publish_binding" });
    assertWorkspaceAndSecretsBinding(descriptors);
    const canonical = readObservedTokenArtifact(descriptors.secrets, LOCAL_TOKEN_FILE);
    if (
      !canonical ||
      canonical.digest !== contentDigest ||
      !sameIdentity(canonical.identity, staged.identity)
    ) {
      throw unsafeLocalTokenStorageError();
    }
    cleanupControls(mutationLease, marker, lease.control);
    marker = undefined;
    leaseExists = false;
    return canonical;
  } catch {
    if (published && marker && staged) {
      rollbackPublished({
        descriptors,
        mutationLease,
        transactionId,
        contentDigest,
        generationIdentity: staged.identity,
        publishingMarker: marker,
        rollbackName: rollbackMarkerName(transactionId, contentDigest, staged.identity),
        lease: lease.control
      });
      marker = undefined;
      leaseExists = false;
    }
    if (stagedExists && staged) {
      invokeLocalTokenTestHook({ stage: "before_staged_cleanup", name: staged.name, artifact: "staged" });
      retireObservedArtifactUnderLease(mutationLease, staged);
      stagedExists = false;
    }
    if (marker) cleanupControl(mutationLease, marker);
    if (leaseExists) cleanupControl(mutationLease, lease.control);
    throw unsafeLocalTokenStorageError();
  } finally {
    settleOwnedDescriptors(
      stagedDescriptor,
      leaseDescriptorOpen ? lease.descriptor : undefined
    );
  }
}
