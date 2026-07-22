import { AsyncLocalStorage } from "node:async_hooks";

export type LocalTokenTestStage =
  | "before_staged_open"
  | "staged_descriptor_guard"
  | "after_staged_fsync"
  | "after_publishing_marker_fsync"
  | "after_publish"
  | "before_post_publish_binding"
  | "after_rollback_marker_fsync"
  | "after_rollback_move"
  | "before_publishing_cleanup"
  | "before_rolling_back_cleanup"
  | "before_lease_cleanup"
  | "before_staged_cleanup"
  | "before_candidate_cleanup"
  | "before_legacy_cleanup"
  | "before_retired_cleanup"
  | "before_recovery_artifact_open"
  | "after_inventory"
  | "inventory_rejected"
  | "before_authority_return"
  | "before_assert_current";

export type LocalTokenInventoryBoundary =
  | "total_limit"
  | "external_limit"
  | "owned_limit"
  | "name_bytes"
  | "duplicate_decoded_name"
  | "decode";

export interface LocalTokenTestHookInput {
  readonly stage: LocalTokenTestStage;
  readonly name?: string;
  readonly artifact?: "publishing" | "rolling-back" | "lease" | "staged" | "candidate" | "legacy" | "retired";
  readonly totalEntries?: number;
  readonly externalEntries?: number;
  readonly ownedEntries?: number;
  readonly maxNameBytes?: number;
  readonly boundary?: LocalTokenInventoryBoundary;
}

export type LocalTokenTestHook = (input: Readonly<LocalTokenTestHookInput>) => void;

export interface LocalTokenRawDirectoryReplay {
  readonly layout: "darwin" | "linux";
  readonly records: readonly Buffer[];
}

interface LocalTokenTestContext {
  readonly hook?: LocalTokenTestHook;
  readonly rawDirectoryReplay?: LocalTokenRawDirectoryReplay;
  readonly failures?: ReadonlySet<
    "staged_open" | "staged_fstat" | "lease_setup" | "marker_setup"
  >;
}

const storage = new AsyncLocalStorage<LocalTokenTestContext>();

export function runWithLocalTokenStoreTestContext<T>(
  context: LocalTokenTestContext,
  action: () => T
): T {
  return storage.run(Object.freeze(context), action);
}

export function invokeLocalTokenTestHook(input: LocalTokenTestHookInput): void {
  storage.getStore()?.hook?.(Object.freeze(input));
}

export function currentLocalTokenRawDirectoryReplay():
  | LocalTokenRawDirectoryReplay
  | undefined {
  return storage.getStore()?.rawDirectoryReplay;
}

export function shouldFailLocalTokenTestOperation(
  operation: "staged_open" | "staged_fstat" | "lease_setup" | "marker_setup"
): boolean {
  return storage.getStore()?.failures?.has(operation) ?? false;
}

export function localTokenRawDirectoryEntryForTest(
  layout: LocalTokenRawDirectoryReplay["layout"],
  nameBytes: Uint8Array
): Buffer {
  if (nameBytes.byteLength === 0 || nameBytes.byteLength > 255) {
    throw new Error("Test dirent name must contain 1..255 bytes.");
  }
  if (layout === "darwin") {
    const record = Buffer.alloc(21 + nameBytes.byteLength + 1);
    record.writeUInt16LE(record.byteLength, 16);
    record.writeUInt16LE(nameBytes.byteLength, 18);
    record.set(nameBytes, 21);
    return record;
  }
  const record = Buffer.alloc(19 + nameBytes.byteLength + 1);
  record.writeUInt16LE(record.byteLength, 16);
  record.set(nameBytes, 19);
  return record;
}
