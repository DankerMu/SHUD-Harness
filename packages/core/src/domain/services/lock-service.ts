import { join, resolve } from "node:path";
import {
  LockRecordSchema,
  LockScopeSchema,
  type LockRecord,
  type LockScope
} from "../schemas/lock";
import { TaskServiceError } from "./task-card-service";
import {
  assertSafeRecordSegment,
  readJsonRecord,
  workspaceRecordPath,
  writeJsonRecord
} from "./workspace-record-store";

export interface LockRecordServiceOptions {
  workspaceRoot: string;
}

export interface LockRecordService {
  storeLock: (record: LockRecord) => Promise<LockRecord>;
  getLock: (scope: LockScope, lockId: string) => Promise<LockRecord | undefined>;
}

export function createLockRecordService(options: LockRecordServiceOptions): LockRecordService {
  const workspaceRoot = resolve(options.workspaceRoot);

  return {
    async storeLock(record: LockRecord): Promise<LockRecord> {
      const parsedRecord = LockRecordSchema.safeParse(record);
      if (parsedRecord.success) {
        assertSafeRecordSegment(parsedRecord.data.lock_id, "lock.lock_id");
      }

      return await writeJsonRecord(
        workspaceRoot,
        lockRecordDirectorySegments(parsedRecord.success ? parsedRecord.data.scope : "task"),
        parsedRecord.success ? lockRecordFileName(parsedRecord.data.lock_id) : "invalid.json",
        record,
        parsedRecord.success
          ? lockRecordEvidenceRef(parsedRecord.data.scope, parsedRecord.data.lock_id)
          : "workspace/locks",
        LockRecordSchema
      );
    },

    async getLock(scope: LockScope, lockId: string): Promise<LockRecord | undefined> {
      const parsedScope = assertLockScope(scope);
      assertSafeRecordSegment(lockId, "lock.lock_id");
      const recordPath = workspaceRecordPath(
        workspaceRoot,
        [...lockRecordDirectorySegments(parsedScope), lockRecordFileName(lockId)],
        lockRecordEvidenceRef(parsedScope, lockId)
      );

      return await readJsonRecord(
        recordPath,
        lockRecordEvidenceRef(parsedScope, lockId),
        LockRecordSchema
      );
    }
  };
}

export function lockRecordDirectorySegments(scope: LockScope): readonly string[] {
  return ["locks", assertLockScope(scope)];
}

export function lockRecordFileName(lockId: string): string {
  assertSafeRecordSegment(lockId, "lock.lock_id");
  return `${lockId}.json`;
}

export function lockRecordEvidenceRef(scope: LockScope, lockId: string): string {
  return join("workspace", "locks", assertLockScope(scope), lockRecordFileName(lockId));
}

function assertLockScope(scope: LockScope): LockScope {
  const parsedScope = LockScopeSchema.safeParse(scope);
  if (parsedScope.success) {
    return parsedScope.data;
  }

  throw new TaskServiceError({
    code: "record_id_not_safe",
    status: 400,
    category: "schema_error",
    message: "Lock scope is not supported.",
    userMessage: "The lock scope is not supported.",
    evidenceRefs: ["lock.scope"],
    recommendedNextActions: ["Use a supported lock scope."]
  });
}
