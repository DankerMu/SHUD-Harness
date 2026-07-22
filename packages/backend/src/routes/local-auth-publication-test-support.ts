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
  | "before_recovery_artifact_open";

export type LocalTokenPublicationStageHookForTest = (
  input: Readonly<{ stage: LocalTokenPublicationStageForTest; name?: string }>
) => void;

const localTokenPublicationHookStorage =
  new AsyncLocalStorage<LocalTokenPublicationStageHookForTest>();

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
