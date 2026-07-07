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

      const record = await readJsonRecord(
        recordPath,
        lockRecordEvidenceRef(parsedScope, lockId),
        LockRecordSchema
      );
      if (!record) {
        return undefined;
      }
      assertLockLookupIdentity(record, parsedScope, lockId);
      return record;
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

function assertLockLookupIdentity(
  record: LockRecord,
  scope: LockScope,
  lockId: string
): void {
  if (record.scope === scope && record.lock_id === lockId) {
    return;
  }

  throw new TaskServiceError({
    code: "record_malformed",
    status: 500,
    category: "workspace_error",
    message: "Lock record identity does not match its lookup path.",
    userMessage: "The lock record cannot be used safely.",
    evidenceRefs: [lockRecordEvidenceRef(scope, lockId), "lock.scope", "lock.lock_id"],
    retryable: false,
    recommendedNextActions: ["Inspect and repair the lock record before retrying."]
  });
}
