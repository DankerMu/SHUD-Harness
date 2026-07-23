import {
  acquireHeldSecretsMutationLease,
  assertCurrentTokenAuthority,
  assertWorkspaceAndSecretsBinding,
  closeOwnedDescriptor,
  openOrCreateWorkspaceTokenDescriptors,
  readCanonicalToken,
  releaseHeldSecretsMutationLease,
  settleOwnedDescriptors,
  type HeldSecretsMutationLease
} from "./local-token-filesystem";
import { readLocalTokenDirectoryInventory } from "./local-token-inventory";
import { invokeLocalTokenTestHook } from "./local-token-test-support";
import {
  LocalTokenStorageError,
  unsafeLocalTokenStorageError,
  sameIdentity,
  type WorkspaceLocalTokenAuthority
} from "./local-token-types";
import {
  publishLocalToken,
  recoverInterruptedLocalTokenStore
} from "./local-token-transaction";

export { LocalTokenStorageError } from "./local-token-types";
export type { WorkspaceLocalTokenAuthority } from "./local-token-types";

export interface OpenWorkspaceLocalTokenAuthorityInput {
  readonly workspaceRoot: string;
}

export function ensurePrivateWorkspaceSecretsDirectory(workspaceRoot: string): void {
  let descriptors: ReturnType<typeof openOrCreateWorkspaceTokenDescriptors> | undefined;
  try {
    descriptors = openOrCreateWorkspaceTokenDescriptors(workspaceRoot);
    assertWorkspaceAndSecretsBinding(descriptors);
  } catch (error) {
    if (error instanceof LocalTokenStorageError) throw error;
    throw unsafeLocalTokenStorageError();
  } finally {
    if (descriptors) {
      settleOwnedDescriptors(descriptors.secrets, descriptors.workspace);
    }
  }
}

export function openWorkspaceLocalTokenAuthority(
  input: OpenWorkspaceLocalTokenAuthorityInput
): WorkspaceLocalTokenAuthority {
  const descriptors = openOrCreateWorkspaceTokenDescriptors(input.workspaceRoot);
  let mutationLease: HeldSecretsMutationLease | undefined;
  try {
    mutationLease = acquireHeldSecretsMutationLease(descriptors);
    assertWorkspaceAndSecretsBinding(descriptors);
    const inventory = readLocalTokenDirectoryInventory(descriptors.secrets);
    recoverInterruptedLocalTokenStore(descriptors, inventory, mutationLease);
    const existing = readCanonicalToken(descriptors.secrets, true);
    const token = existing ?? publishLocalToken(descriptors, mutationLease);
    invokeLocalTokenTestHook({ stage: "before_authority_return" });
    assertWorkspaceAndSecretsBinding(descriptors);
    const finalToken = readCanonicalToken(descriptors.secrets, false);
    if (
      finalToken === undefined ||
      !sameIdentity(finalToken.identity, token.identity) ||
      !finalToken.bytes.equals(token.bytes)
    ) {
      throw unsafeLocalTokenStorageError();
    }

    const captured = Object.freeze({
      workspaceRoot: descriptors.workspaceRoot,
      workspaceIdentity: descriptors.workspaceIdentity,
      secretsIdentity: descriptors.secretsIdentity,
      tokenIdentity: finalToken.identity,
      tokenBytes: Buffer.from(finalToken.bytes)
    });
    const authority: WorkspaceLocalTokenAuthority = {
      token: finalToken.token,
      source: "workspace",
      assertCurrent(): void {
        invokeLocalTokenTestHook({ stage: "before_assert_current" });
        assertCurrentTokenAuthority(captured);
      }
    };
    return Object.freeze(authority);
  } catch (error) {
    if (error instanceof LocalTokenStorageError) throw error;
    throw unsafeLocalTokenStorageError();
  } finally {
    let failure: unknown;
    if (mutationLease) {
      try {
        releaseHeldSecretsMutationLease(mutationLease);
      } catch (error) {
        failure = error;
      }
    } else {
      try {
        closeOwnedDescriptor(descriptors.secrets);
      } catch (error) {
        failure = error;
      }
    }
    try {
      settleOwnedDescriptors(descriptors.workspace);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw unsafeLocalTokenStorageError();
  }
}
