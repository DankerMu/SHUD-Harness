import { AsyncLocalStorage } from "node:async_hooks";

export type LocalTokenPublicationStageForTest =
  | "after_write"
  | "after_file_fsync"
  | "after_publish"
  | "before_temp_cleanup"
  | "before_directory_fsync"
  | "before_post_publish_binding";

export type LocalTokenPublicationStageHookForTest = (
  input: Readonly<{ stage: LocalTokenPublicationStageForTest }>
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
