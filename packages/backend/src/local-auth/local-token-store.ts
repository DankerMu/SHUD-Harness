import {
  assertCurrentTokenAuthority,
  assertWorkspaceAndSecretsBinding,
  closeOwnedDescriptor,
  openOrCreateWorkspaceTokenDescriptors,
  readCanonicalToken
} from "./local-token-filesystem";
import { readLocalTokenDirectoryInventory } from "./local-token-inventory";
import { flockNonblocking } from "./local-token-syscalls";
import { invokeLocalTokenTestHook } from "./local-token-test-support";
import {
  FLOCK_EXCLUSIVE,
  FLOCK_NONBLOCKING,
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

export function openWorkspaceLocalTokenAuthority(
  input: OpenWorkspaceLocalTokenAuthorityInput
): WorkspaceLocalTokenAuthority {
  const descriptors = openOrCreateWorkspaceTokenDescriptors(input.workspaceRoot);
  try {
    if (
      flockNonblocking(
        descriptors.secrets,
        FLOCK_EXCLUSIVE | FLOCK_NONBLOCKING
      ) !== 0
    ) {
      throw unsafeLocalTokenStorageError();
    }

    assertWorkspaceAndSecretsBinding(descriptors);
    const inventory = readLocalTokenDirectoryInventory(descriptors.secrets);
    recoverInterruptedLocalTokenStore(descriptors, inventory);
    const existing = readCanonicalToken(descriptors.secrets, true);
    const token = existing ?? publishLocalToken(descriptors);
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
    closeOwnedDescriptor(descriptors.secrets);
    closeOwnedDescriptor(descriptors.workspace);
  }
}
