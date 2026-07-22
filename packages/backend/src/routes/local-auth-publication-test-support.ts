import { AsyncLocalStorage } from "node:async_hooks";

export type LocalTokenPublicationStageForTest =
  | "after_write"
  | "after_file_fsync"
  | "after_publish"
  | "before_temp_cleanup"
  | "before_directory_fsync"
  | "before_post_publish_binding"
  | "after_rollback_armed"
  | "after_rollback_move"
  | "before_rollback_candidate_cleanup"
  | "before_rollback_restore"
  | "after_rollback_restore"
  | "before_recovery_directory_read"
  | "after_recovery_directory_read"
  | "before_recovery_artifact_open"
  | "before_publishing_marker_cleanup"
  | "before_rollback_marker_cleanup"
  | "before_lease_cleanup"
  | "recovery_directory_boundary_rejected";

export type LocalTokenDirectoryBoundaryForTest =
  | "entry_limit"
  | "name_bytes"
  | "duplicate_decoded_name"
  | "decode";

export type LocalTokenPublicationStageHookForTest = (
  input: Readonly<{
    stage: LocalTokenPublicationStageForTest;
    name?: string;
    entryCount?: number;
    maxNameBytes?: number;
    boundary?: LocalTokenDirectoryBoundaryForTest;
  }>
) => void;

export interface LocalTokenDirectoryEntryReplayForTest {
  readonly layout: "darwin" | "linux";
  readonly records: readonly Buffer[];
}

const localTokenPublicationHookStorage =
  new AsyncLocalStorage<LocalTokenPublicationStageHookForTest>();
const localTokenDirectoryEntryReplayStorage =
  new AsyncLocalStorage<LocalTokenDirectoryEntryReplayForTest>();

export function runWithLocalTokenPublicationStageHookForTest<T>(
  hook: LocalTokenPublicationStageHookForTest,
  action: () => T
): T {
  return localTokenPublicationHookStorage.run(hook, action);
}

export function currentLocalTokenPublicationStageHookForTest():
  | LocalTokenPublicationStageHookForTest
  | undefined {
  return localTokenPublicationHookStorage.getStore();
}

export function runWithLocalTokenDirectoryEntryReplayForTest<T>(
  replay: LocalTokenDirectoryEntryReplayForTest,
  action: () => T
): T {
  return localTokenDirectoryEntryReplayStorage.run(replay, action);
}

export function currentLocalTokenDirectoryEntryReplayForTest():
  | LocalTokenDirectoryEntryReplayForTest
  | undefined {
  return localTokenDirectoryEntryReplayStorage.getStore();
}

export function localTokenDirectoryEntryRecordForTest(
  layout: LocalTokenDirectoryEntryReplayForTest["layout"],
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
