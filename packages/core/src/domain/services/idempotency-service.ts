import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  IdempotencyRecordSchema,
  IdempotencyScopeSchema,
  type IdempotencyRecord,
  type IdempotencyScope
} from "../schemas/idempotency";
import { TaskServiceError, isSafeTaskId } from "./task-card-service";
import { runWithPreservedRelease } from "./compensation-error-preservation";
import {
  WorkspaceRecordConditionalDeleteError,
  cancelWorkspaceRecordCleanupPermit,
  conditionalDeleteJsonRecordWithCleanupPermit,
  createJsonRecordIfAbsent,
  createJsonRecordIfAbsentWithCleanupPermit,
  observeJsonRecordForCleanup,
  readJsonRecord,
  workspaceRecordPath,
  writeJsonRecord,
  type WorkspaceJsonRecordCleanupObservation,
  type WorkspaceRecordCleanupPermit
} from "./workspace-record-store";

const IDEMPOTENCY_TRANSITION_GUARD_STALE_MS = 30_000;
const IDEMPOTENCY_TRANSITION_GUARD_WAIT_MS = 250;
const IDEMPOTENCY_TRANSITION_GUARD_POLL_MS = 5;
const IDEMPOTENCY_RELEASE_COMPENSATION_MESSAGE =
  "An idempotency operation failed and its owned artifact release also failed.";

async function runWithIdempotencyRelease<T>(
  body: () => Promise<T>,
  release: () => Promise<void>,
  settleFulfilledValueAfterReleaseFailure?: (
    fulfilledValue: T,
    releaseReason: unknown
  ) => Promise<void>
): Promise<T> {
  return await runWithPreservedRelease(
    body,
    release,
    IDEMPOTENCY_RELEASE_COMPENSATION_MESSAGE,
    settleFulfilledValueAfterReleaseFailure
  );
}

const IdempotencyTransitionGuardSchema = z.object({
  guard_id: z.string().min(1),
  owner_pid: z.number().int().nonnegative(),
  acquired_at_ms: z.number().int().nonnegative(),
  acquired_at: z.string().min(1)
});

type IdempotencyTransitionGuard = z.infer<typeof IdempotencyTransitionGuardSchema>;

type IdempotencyTransitionGuardAcquire =
  | { status: "acquired"; release: () => Promise<void> }
  | { status: "busy" };

export interface IdempotencyRecordServiceOptions {
  workspaceRoot: string;
  now?: () => Date;
  transitionGuardHooks?: IdempotencyTransitionGuardHooks;
}

export interface IdempotencyTransitionGuardCleanupHookInput {
  guardPath: string;
  evidenceRef: string;
  observedGuard: IdempotencyTransitionGuard;
}

export interface IdempotencyTransitionGuardHooks {
  beforeStaleGuardCleanup?: (
    input: IdempotencyTransitionGuardCleanupHookInput
  ) => Promise<void> | void;
}

export interface IdempotencyRecordLookupInput {
  scope: IdempotencyScope;
  key: string;
  requestDigest: string;
}

export type InvalidCompletedIdempotencyRecordReason =
  | "missing_result_ref"
  | "unsafe_result_ref";

export interface InvalidCompletedIdempotencyRecordLookup {
  status: "invalid_completed";
  reason: InvalidCompletedIdempotencyRecordReason;
  record: IdempotencyRecord;
  observedResultRef: string | undefined;
}

export type IdempotencyReplayLookup =
  | { status: "missing" }
  | { status: "mismatch"; record: IdempotencyRecord }
  | { status: "incomplete"; record: IdempotencyRecord }
  | { status: "completed"; record: IdempotencyRecord & { result_ref: string } }
  | InvalidCompletedIdempotencyRecordLookup;

export type BeginIdempotencyRecordResult =
  | { status: "acquired"; record: IdempotencyRecord }
  | { status: "mismatch"; record: IdempotencyRecord }
  | { status: "incomplete"; record: IdempotencyRecord }
  | { status: "completed"; record: IdempotencyRecord & { result_ref: string } }
  | InvalidCompletedIdempotencyRecordLookup;

export interface CompleteIdempotencyRecordInput extends IdempotencyRecordLookupInput {
  resultRef: string;
}

export interface InvalidateCompletedIdempotencyRecordInput
  extends IdempotencyRecordLookupInput {
  resultRef: string | undefined;
}

export type FailIdempotencyRecordInput = IdempotencyRecordLookupInput;

export interface IdempotencyRecordService {
  storeRecord: (record: IdempotencyRecord) => Promise<IdempotencyRecord>;
  getRecord: (scope: IdempotencyScope, key: string) => Promise<IdempotencyRecord | undefined>;
  beginRecord: (input: IdempotencyRecordLookupInput) => Promise<BeginIdempotencyRecordResult>;
  lookupReplay: (input: IdempotencyRecordLookupInput) => Promise<IdempotencyReplayLookup>;
  completeRecord: (input: CompleteIdempotencyRecordInput) => Promise<IdempotencyRecord>;
  invalidateCompletedRecord: (
    input: InvalidateCompletedIdempotencyRecordInput
  ) => Promise<IdempotencyRecord>;
  failRecord: (input: FailIdempotencyRecordInput) => Promise<IdempotencyRecord>;
  recoverFailedRecordAfterRollback: (
    input: FailIdempotencyRecordInput
  ) => Promise<IdempotencyRecord>;
  recoverCompletedRecordAfterRollbackFailure: (
    input: CompleteIdempotencyRecordInput
  ) => Promise<IdempotencyRecord>;
  quarantineRecordAfterUnsafeRollback: (
    input: FailIdempotencyRecordInput
  ) => Promise<IdempotencyRecord>;
}

export function createIdempotencyRecordService(
  options: IdempotencyRecordServiceOptions
): IdempotencyRecordService {
  const workspaceRoot = resolve(options.workspaceRoot);
  const now = options.now ?? (() => new Date());
  const transitionGuardHooks = options.transitionGuardHooks;

  async function storeRecordInternal(
    record: IdempotencyRecord,
    options: { allowCompletedWrite: boolean; allowExistingMutation: boolean }
  ): Promise<IdempotencyRecord> {
    const parsedRecord = IdempotencyRecordSchema.safeParse(record);
    if (!parsedRecord.success) {
      return await writeJsonRecord(
        workspaceRoot,
        idempotencyRecordDirectorySegments("task"),
        "invalid.json",
        record,
        "workspace/tasks/_idempotency",
        IdempotencyRecordSchema
      );
    }
    const evidenceRef = idempotencyRecordEvidenceRef(
      parsedRecord.data.scope,
      parsedRecord.data.key
    );
    assertPersistableIdempotencyRecord(parsedRecord.data, evidenceRef);
    assertTaskScopeResultRef(parsedRecord.data, evidenceRef);
    const existing = await service.getRecord(parsedRecord.data.scope, parsedRecord.data.key);
    if (existing && existing.request_digest !== parsedRecord.data.request_digest) {
      throw createIdempotencyMismatchError();
    }
    if (parsedRecord.data.status === "completed" && !options.allowCompletedWrite) {
      throw completedRecordStoreBypassError(evidenceRef);
    }
    if (existing?.status === "completed") {
      return assertCompletedRecordStoreAllowed(existing, parsedRecord.data, evidenceRef);
    }
    if (existing && !options.allowExistingMutation) {
      throw idempotencyRecordStoreExistingError(evidenceRef);
    }

    if (!options.allowExistingMutation) {
      const created = await createJsonRecordIfAbsent(
        workspaceRoot,
        idempotencyRecordDirectorySegments(parsedRecord.data.scope),
        idempotencyRecordFileName(parsedRecord.data.key),
        parsedRecord.data,
        evidenceRef,
        IdempotencyRecordSchema
      );
      if (created.status === "created") {
        return created.record;
      }

      throw idempotencyRecordStoreExistingError(evidenceRef);
    }

    return await writeJsonRecord(
      workspaceRoot,
      idempotencyRecordDirectorySegments(parsedRecord.data.scope),
      idempotencyRecordFileName(parsedRecord.data.key),
      parsedRecord.data,
      evidenceRef,
      IdempotencyRecordSchema
    );
  }

  async function recoverRecordAfterRollback(
    input: IdempotencyRecordLookupInput,
    transition: () => Promise<IdempotencyRecord>
  ): Promise<IdempotencyRecord> {
    try {
      return await transition();
    } catch (error) {
      if (!(error instanceof TaskServiceError) || error.code !== "record_malformed") {
        throw error;
      }
    }

    const parsedScope = assertIdempotencyScope(input.scope);
    assertNonblankIdempotencyKey(input.key);
    const evidenceRef = idempotencyRecordEvidenceRef(parsedScope, input.key);
    const current = await lookupExistingRecordForBegin(
      service,
      { ...input, scope: parsedScope },
      evidenceRef
    );
    if (current.status === "mismatch") {
      throw createIdempotencyMismatchError();
    }
    if (current.status === "completed") {
      return current.record;
    }
    if (current.status === "invalid_completed") {
      throw invalidCompletedRecordAuthorityError(current.reason, evidenceRef);
    }
    if (current.record.status === "failed") {
      return current.record;
    }
    if (current.record.request_digest !== input.requestDigest) {
      throw createIdempotencyMismatchError();
    }

    await removeRecoverableIdempotencyTransitionGuardForRollbackRecovery(
      workspaceRoot,
      parsedScope,
      input.key,
      evidenceRef,
      "fail"
    );
    return await transition();
  }

  const service: IdempotencyRecordService = {
    async storeRecord(record: IdempotencyRecord): Promise<IdempotencyRecord> {
      return await storeRecordInternal(record, {
        allowCompletedWrite: false,
        allowExistingMutation: false
      });
    },

    async getRecord(
      scope: IdempotencyScope,
      key: string
    ): Promise<IdempotencyRecord | undefined> {
      const parsedScope = assertIdempotencyScope(scope);
      assertNonblankIdempotencyKey(key);
      const recordPath = workspaceRecordPath(
        workspaceRoot,
        [...idempotencyRecordDirectorySegments(parsedScope), idempotencyRecordFileName(key)],
        idempotencyRecordEvidenceRef(parsedScope, key)
      );

      const record = await readJsonRecord(
        recordPath,
        idempotencyRecordEvidenceRef(parsedScope, key),
        IdempotencyRecordSchema
      );
      if (!record) {
        return undefined;
      }

      assertIdempotencyRecordLookupIdentity(
        record,
        parsedScope,
        key,
        idempotencyRecordEvidenceRef(parsedScope, key)
      );
      return record;
    },

    async beginRecord(
      input: IdempotencyRecordLookupInput
    ): Promise<BeginIdempotencyRecordResult> {
      const parsedScope = assertIdempotencyScope(input.scope);
      assertNonblankIdempotencyKey(input.key);
      const timestamp = now().toISOString();
      const record: IdempotencyRecord = {
        key: input.key,
        scope: parsedScope,
        request_digest: input.requestDigest,
        status: "started",
        created_at: timestamp,
        updated_at: timestamp
      };
      const evidenceRef = idempotencyRecordEvidenceRef(parsedScope, input.key);
      const created = await createJsonRecordIfAbsent(
        workspaceRoot,
        idempotencyRecordDirectorySegments(parsedScope),
        idempotencyRecordFileName(input.key),
        record,
        evidenceRef,
        IdempotencyRecordSchema
      );

      if (created.status === "created") {
        return { status: "acquired", record: created.record };
      }

      const existing = await service.lookupReplay({ ...input, scope: parsedScope });
      if (existing.status === "missing") {
        throw new TaskServiceError({
          code: "record_malformed",
          status: 500,
          category: "workspace_error",
          message: "Idempotency record claim was not readable after an existing-record race.",
          userMessage: "The idempotency record could not be read safely.",
          evidenceRefs: [evidenceRef],
          recommendedNextActions: ["Inspect the idempotency record state before retrying."]
        });
      }
      if (existing.status === "incomplete" && existing.record.status === "failed") {
        const guard = await acquireIdempotencyTransitionGuard(
          workspaceRoot,
          parsedScope,
          input.key,
          evidenceRef,
          transitionGuardHooks
        );
        if (guard.status === "busy") {
          return beginResultFromReplayLookup(
            await lookupExistingRecordForBegin(service, { ...input, scope: parsedScope }, evidenceRef)
          );
        }
        return await runWithIdempotencyRelease(async () => {
          const retryExisting = await service.lookupReplay({ ...input, scope: parsedScope });
          if (retryExisting.status === "missing") {
            throw new TaskServiceError({
              code: "record_malformed",
              status: 500,
              category: "workspace_error",
              message: "Idempotency record was not readable during failed retry acquisition.",
              userMessage: "The idempotency record could not be updated safely.",
              evidenceRefs: [evidenceRef],
              recommendedNextActions: ["Inspect the idempotency record state before retrying."]
            });
          }
          if (retryExisting.status !== "incomplete" || retryExisting.record.status !== "failed") {
            return beginResultFromReplayLookup(retryExisting);
          }

          const stored = await storeRecordInternal(record, {
            allowCompletedWrite: false,
            allowExistingMutation: true
          });
          return beginResultFromStoredRecord(stored, input.requestDigest, parsedScope);
        }, guard.release);
      }

      return existing;
    },

    async lookupReplay(input: IdempotencyRecordLookupInput): Promise<IdempotencyReplayLookup> {
      const parsedScope = assertIdempotencyScope(input.scope);
      assertNonblankIdempotencyKey(input.key);
      const record = await service.getRecord(parsedScope, input.key);
      if (!record) {
        return { status: "missing" };
      }
      if (record.request_digest !== input.requestDigest) {
        return { status: "mismatch", record };
      }
      if (record.status === "completed") {
        if (!record.result_ref) {
          return {
            status: "invalid_completed",
            reason: "missing_result_ref",
            record,
            observedResultRef: undefined
          };
        }
        if (parsedScope === "task" && !isSafeTaskId(record.result_ref)) {
          return {
            status: "invalid_completed",
            reason: "unsafe_result_ref",
            record,
            observedResultRef: record.result_ref
          };
        }

        return { status: "completed", record: record as IdempotencyRecord & { result_ref: string } };
      }

      return { status: "incomplete", record };
    },

    async completeRecord(input: CompleteIdempotencyRecordInput): Promise<IdempotencyRecord> {
      const parsedScope = assertIdempotencyScope(input.scope);
      assertNonblankIdempotencyKey(input.key);
      assertTaskScopeInputResultRef(parsedScope, input.key, input.resultRef);
      const evidenceRef = idempotencyRecordEvidenceRef(parsedScope, input.key);
      const observed = await service.lookupReplay({ ...input, scope: parsedScope });
      if (observed.status === "mismatch") {
        throw createIdempotencyMismatchError();
      }
      if (observed.status === "missing") {
        throw missingTransitionRecordError(
          parsedScope,
          input.key,
          "Idempotency record was missing when completing the claim."
        );
      }
      if (observed.status === "completed") {
        return observed.record;
      }
      if (observed.status === "invalid_completed") {
        throw invalidCompletedRecordAuthorityError(observed.reason, evidenceRef);
      }

      const guard = await acquireIdempotencyTransitionGuard(
        workspaceRoot,
        parsedScope,
        input.key,
        evidenceRef,
        transitionGuardHooks
      );
      if (guard.status === "busy") {
        const current = await service.lookupReplay({ ...input, scope: parsedScope });
        if (current.status === "completed") {
          return current.record;
        }
        if (current.status === "invalid_completed") {
          throw invalidCompletedRecordAuthorityError(current.reason, evidenceRef);
        }
        throw transitionGuardBusyError(parsedScope, input.key, "complete");
      }

      return await runWithIdempotencyRelease(async () => {
        const existing = await service.lookupReplay({ ...input, scope: parsedScope });
        if (existing.status === "mismatch") {
          throw createIdempotencyMismatchError();
        }
        if (existing.status === "missing") {
          throw missingTransitionRecordError(
            parsedScope,
            input.key,
            "Idempotency record was missing when completing the claim."
          );
        }
        if (existing.status === "completed") {
          return existing.record;
        }
        if (existing.status === "invalid_completed") {
          throw invalidCompletedRecordAuthorityError(existing.reason, evidenceRef);
        }
        if (existing.record.status !== "started") {
          throw invalidTransitionStateError(
            parsedScope,
            input.key,
            "completed",
            "Only a started idempotency record can be completed.",
            "The idempotency record is not in a completable state."
          );
        }

        const timestamp = now().toISOString();
        return await storeRecordInternal({
          key: input.key,
          scope: parsedScope,
          request_digest: input.requestDigest,
          status: "completed",
          result_ref: input.resultRef,
          created_at: existing.record.created_at,
          updated_at: timestamp
        }, { allowCompletedWrite: true, allowExistingMutation: true });
      }, guard.release);
    },

    async invalidateCompletedRecord(
      input: InvalidateCompletedIdempotencyRecordInput
    ): Promise<IdempotencyRecord> {
      const parsedScope = assertIdempotencyScope(input.scope);
      assertNonblankIdempotencyKey(input.key);
      const evidenceRef = idempotencyRecordEvidenceRef(parsedScope, input.key);
      const guard = await acquireIdempotencyTransitionGuard(
        workspaceRoot,
        parsedScope,
        input.key,
        evidenceRef,
        transitionGuardHooks
      );
      if (guard.status === "busy") {
        throw transitionGuardBusyError(parsedScope, input.key, "fail");
      }

      return await runWithIdempotencyRelease(async () => {
        const existing = await service.getRecord(parsedScope, input.key);
        if (!existing) {
          throw missingTransitionRecordError(
            parsedScope,
            input.key,
            "Idempotency record was missing when invalidating the completed result."
          );
        }
        if (existing.request_digest !== input.requestDigest) {
          throw createIdempotencyMismatchError();
        }
        if (existing.status !== "completed") {
          throw completedRecordInvalidationStateError(evidenceRef);
        }
        if (existing.result_ref !== input.resultRef) {
          throw completedRecordInvalidationIdentityError(evidenceRef);
        }

        const failedRecord: IdempotencyRecord = { ...existing };
        delete failedRecord.result_ref;
        return await writeJsonRecord(
          workspaceRoot,
          idempotencyRecordDirectorySegments(parsedScope),
          idempotencyRecordFileName(input.key),
          {
            ...failedRecord,
            status: "failed",
            updated_at: now().toISOString()
          },
          evidenceRef,
          IdempotencyRecordSchema
        );
      }, guard.release);
    },

    async failRecord(input: FailIdempotencyRecordInput): Promise<IdempotencyRecord> {
      const parsedScope = assertIdempotencyScope(input.scope);
      assertNonblankIdempotencyKey(input.key);
      const evidenceRef = idempotencyRecordEvidenceRef(parsedScope, input.key);
      const observed = await service.lookupReplay({ ...input, scope: parsedScope });
      if (observed.status === "mismatch") {
        throw createIdempotencyMismatchError();
      }
      if (observed.status === "missing") {
        throw missingTransitionRecordError(
          parsedScope,
          input.key,
          "Idempotency record was missing when marking the claim failed."
        );
      }
      if (observed.status === "invalid_completed") {
        throw invalidCompletedRecordAuthorityError(observed.reason, evidenceRef);
      }
      if (observed.status === "completed" || observed.record.status === "failed") {
        return observed.record;
      }

      const guard = await acquireIdempotencyTransitionGuard(
        workspaceRoot,
        parsedScope,
        input.key,
        evidenceRef,
        transitionGuardHooks
      );
      if (guard.status === "busy") {
        const current = await service.lookupReplay({ ...input, scope: parsedScope });
        if (
          current.status === "completed" ||
          (current.status === "incomplete" && current.record.status === "failed")
        ) {
          return current.record;
        }
        if (current.status === "invalid_completed") {
          throw invalidCompletedRecordAuthorityError(current.reason, evidenceRef);
        }
        throw transitionGuardBusyError(parsedScope, input.key, "fail");
      }

      return await runWithIdempotencyRelease(async () => {
        const existing = await service.lookupReplay({ ...input, scope: parsedScope });
        if (existing.status === "mismatch") {
          throw createIdempotencyMismatchError();
        }
        if (existing.status === "missing") {
          throw missingTransitionRecordError(
            parsedScope,
            input.key,
            "Idempotency record was missing when marking the claim failed."
          );
        }
        if (existing.status === "invalid_completed") {
          throw invalidCompletedRecordAuthorityError(existing.reason, evidenceRef);
        }
        if (existing.status === "completed" || existing.record.status === "failed") {
          return existing.record;
        }
        if (existing.record.status !== "started") {
          throw invalidTransitionStateError(
            parsedScope,
            input.key,
            "failed",
            "Only a started idempotency record can be marked failed.",
            "The idempotency record is not in a failable state."
          );
        }

        const recordWithoutResultRef = { ...existing.record };
        delete recordWithoutResultRef.result_ref;
        return await storeRecordInternal({
          ...recordWithoutResultRef,
          status: "failed",
          updated_at: now().toISOString()
        }, { allowCompletedWrite: false, allowExistingMutation: true });
      }, guard.release);
    },

    async recoverFailedRecordAfterRollback(
      input: FailIdempotencyRecordInput
    ): Promise<IdempotencyRecord> {
      return await recoverRecordAfterRollback(input, async () => service.failRecord(input));
    },

    async recoverCompletedRecordAfterRollbackFailure(
      input: CompleteIdempotencyRecordInput
    ): Promise<IdempotencyRecord> {
      const parsedScope = assertIdempotencyScope(input.scope);
      assertNonblankIdempotencyKey(input.key);
      assertTaskScopeInputResultRef(parsedScope, input.key, input.resultRef);
      const evidenceRef = idempotencyRecordEvidenceRef(parsedScope, input.key);
      const current = await lookupExistingRecordForBegin(
        service,
        { ...input, scope: parsedScope },
        evidenceRef
      );
      if (current.status === "mismatch") {
        throw createIdempotencyMismatchError();
      }
      if (current.status === "completed") {
        return current.record;
      }
      if (current.status === "invalid_completed") {
        throw invalidCompletedRecordAuthorityError(current.reason, evidenceRef);
      }
      if (current.record.request_digest !== input.requestDigest) {
        throw createIdempotencyMismatchError();
      }

      await removeRecoverableIdempotencyTransitionGuardForRollbackRecovery(
        workspaceRoot,
        parsedScope,
        input.key,
        evidenceRef,
        "complete"
      );
      return await storeRecordInternal({
        ...current.record,
        status: "completed",
        result_ref: input.resultRef,
        updated_at: now().toISOString()
      }, { allowCompletedWrite: true, allowExistingMutation: true });
    },

    async quarantineRecordAfterUnsafeRollback(
      input: FailIdempotencyRecordInput
    ): Promise<IdempotencyRecord> {
      return await recoverRecordAfterRollback(input, async () => service.failRecord(input));
    }
  };

  return service;
}

export function idempotencyRecordFileName(key: string): string {
  assertNonblankIdempotencyKey(key);
  return `${sha256Hex(key)}.json`;
}

function idempotencyTransitionGuardFileName(key: string): string {
  assertNonblankIdempotencyKey(key);
  return `${sha256Hex(`transition:${key}`)}.guard.json`;
}

export function idempotencyRecordEvidenceRef(scope: IdempotencyScope, key: string): string {
  const parsedScope = assertIdempotencyScope(scope);
  assertNonblankIdempotencyKey(key);
  return join("workspace", "tasks", "_idempotency", parsedScope, idempotencyRecordFileName(key));
}

export function idempotencyRecordDirectorySegments(
  scope: IdempotencyScope
): readonly string[] {
  return ["tasks", "_idempotency", assertIdempotencyScope(scope)];
}

async function acquireIdempotencyTransitionGuard(
  workspaceRoot: string,
  scope: IdempotencyScope,
  key: string,
  evidenceRef: string,
  transitionGuardHooks?: IdempotencyTransitionGuardHooks
): Promise<IdempotencyTransitionGuardAcquire> {
  const directorySegments = idempotencyRecordDirectorySegments(scope);
  const guardFileName = idempotencyTransitionGuardFileName(key);
  const guardPath = workspaceRecordPath(
    workspaceRoot,
    [...directorySegments, guardFileName],
    evidenceRef
  );
  const deadline = Date.now() + IDEMPOTENCY_TRANSITION_GUARD_WAIT_MS;

  for (;;) {
    const guard: IdempotencyTransitionGuard = {
      guard_id: randomUUID(),
      owner_pid: process.pid,
      acquired_at_ms: Date.now(),
      acquired_at: new Date().toISOString()
    };
    const publishLock = await acquireIdempotencyTransitionCleanupLock(
      workspaceRoot,
      scope,
      key,
      evidenceRef
    );
    if (publishLock.status === "busy") {
      if (Date.now() >= deadline) {
        return { status: "busy" };
      }
      await sleep(IDEMPOTENCY_TRANSITION_GUARD_POLL_MS);
      continue;
    }

    const created = await runWithIdempotencyRelease(
      async () =>
        await createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          directorySegments,
          guardFileName,
          guard,
          evidenceRef,
          IdempotencyTransitionGuardSchema
        ),
      publishLock.release,
      async (fulfilledGuard) => {
        if (fulfilledGuard.status !== "created") return;
        await releaseOwnedIdempotencyTransitionArtifact(
          fulfilledGuard.cleanupPermit,
          guardPath,
          evidenceRef,
          fulfilledGuard.record
        );
      }
    );
    if (created.status === "created") {
      const cleanupPermit = created.cleanupPermit;
      return {
        status: "acquired",
        release: async () =>
          await releaseOwnedIdempotencyTransitionArtifact(
            cleanupPermit,
            guardPath,
            evidenceRef,
            created.record
          )
      };
    }

    const staleCleanup = await removeStaleIdempotencyTransitionGuard(
      workspaceRoot,
      scope,
      key,
      guardPath,
      evidenceRef,
      transitionGuardHooks
    );
    if (staleCleanup === "removed") {
      continue;
    }
    if (staleCleanup === "authority_changed") return { status: "busy" };
    if (Date.now() >= deadline) {
      return { status: "busy" };
    }

    await sleep(IDEMPOTENCY_TRANSITION_GUARD_POLL_MS);
  }
}

async function removeStaleIdempotencyTransitionGuard(
  workspaceRoot: string,
  scope: IdempotencyScope,
  key: string,
  guardPath: string,
  evidenceRef: string,
  transitionGuardHooks?: IdempotencyTransitionGuardHooks
): Promise<"removed" | "blocked" | "authority_changed"> {
  let observation: WorkspaceJsonRecordCleanupObservation<IdempotencyTransitionGuard>;
  try {
    observation = await observeJsonRecordForCleanup(
      guardPath,
      evidenceRef,
      IdempotencyTransitionGuardSchema
    );
  } catch (error) {
    if (isRetryableWorkspaceRecordAuthorityContention(error)) return "blocked";
    throw error;
  }
  if (observation.status === "missing") return "removed";

  try {
    const removed = await withOwnedIdempotencyTransitionObservation(
      observation,
      guardPath,
      evidenceRef,
      async (consume) => {
        if (observation.status === "schema_threw") throw observation.error;
        if (observation.status === "malformed") throw observation.error;
        if (!isIdempotencyTransitionGuardStale(observation.record)) return false;

        const cleanupLock = await acquireIdempotencyTransitionCleanupLock(
          workspaceRoot,
          scope,
          key,
          evidenceRef
        );
        if (cleanupLock.status === "busy") return false;

        return await runWithIdempotencyRelease(async () => {
          await transitionGuardHooks?.beforeStaleGuardCleanup?.({
            guardPath,
            evidenceRef,
            observedGuard: observation.record
          });
          return await consume();
        }, cleanupLock.release);
      }
    );
    return removed ? "removed" : "blocked";
  } catch (error) {
    if (isPreMutationIdempotencyArtifactAuthorityChange(error)) {
      return "authority_changed";
    }
    throw error;
  }
}

async function removeRecoverableIdempotencyTransitionGuardForRollbackRecovery(
  workspaceRoot: string,
  scope: IdempotencyScope,
  key: string,
  evidenceRef: string,
  transition: "complete" | "fail"
): Promise<void> {
  const guardPath = workspaceRecordPath(
    workspaceRoot,
    [...idempotencyRecordDirectorySegments(scope), idempotencyTransitionGuardFileName(key)],
    evidenceRef
  );

  let observation: WorkspaceJsonRecordCleanupObservation<IdempotencyTransitionGuard>;
  try {
    observation = await observeJsonRecordForCleanup(
      guardPath,
      evidenceRef,
      IdempotencyTransitionGuardSchema
    );
  } catch (error) {
    if (isRetryableWorkspaceRecordAuthorityContention(error)) {
      throw transitionGuardBusyError(scope, key, transition);
    }
    throw error;
  }
  if (observation.status === "missing") return;

  await withOwnedIdempotencyTransitionObservation(
    observation,
    guardPath,
    evidenceRef,
    async (consume) => {
      if (observation.status === "schema_threw") throw observation.error;
      if (
        observation.status === "record" &&
        !isIdempotencyTransitionGuardStale(observation.record)
      ) {
        throw transitionGuardBusyError(scope, key, transition);
      }

      await deleteObservedIdempotencyTransitionGuardForRollbackRecovery(
        workspaceRoot,
        scope,
        key,
        evidenceRef,
        transition,
        consume
      );
    }
  );
}

async function deleteObservedIdempotencyTransitionGuardForRollbackRecovery(
  workspaceRoot: string,
  scope: IdempotencyScope,
  key: string,
  evidenceRef: string,
  transition: "complete" | "fail",
  consume: () => Promise<boolean>
): Promise<void> {
  const cleanupLock = await acquireIdempotencyTransitionCleanupLock(
    workspaceRoot,
    scope,
    key,
    evidenceRef
  );
  if (cleanupLock.status === "busy") {
    throw transitionGuardBusyError(scope, key, transition);
  }

  await runWithIdempotencyRelease(async () => {
    if (await consume()) return;
    throw new TaskServiceError({
      code: "record_malformed",
      status: 500,
      category: "workspace_error",
      message: "Idempotency transition guard changed during rollback recovery.",
      userMessage: "The idempotency record could not be recovered safely.",
      evidenceRefs: [evidenceRef],
      retryable: true,
      recommendedNextActions: ["Retry after the in-progress idempotency transition finishes."]
    });
  }, cleanupLock.release);
}

type ExistingIdempotencyTransitionObservation = Exclude<
  WorkspaceJsonRecordCleanupObservation<IdempotencyTransitionGuard>,
  { readonly status: "missing" }
>;

async function withOwnedIdempotencyTransitionObservation<T>(
  observation: ExistingIdempotencyTransitionObservation,
  path: string,
  evidenceRef: string,
  body: (consume: () => Promise<boolean>) => Promise<T>
): Promise<T> {
  let ownership: "owned" | "transferred" | "settled" = "owned";
  return await runWithIdempotencyRelease(
    async () =>
      await body(async () => {
        if (ownership !== "owned") {
          throw idempotencyTransitionArtifactSettlementError(
            evidenceRef,
            new Error("Idempotency transition cleanup capability was reused.")
          );
        }
        ownership = "transferred";
        return await consumeObservedIdempotencyTransitionArtifact(
          observation,
          path,
          evidenceRef
        );
      }),
    async () => {
      if (ownership !== "owned") return;
      ownership = "settled";
      await cancelWorkspaceRecordCleanupPermit(observation.cleanupPermit);
    }
  );
}

async function consumeObservedIdempotencyTransitionArtifact(
  observation: ExistingIdempotencyTransitionObservation,
  path: string,
  evidenceRef: string
): Promise<boolean> {
  if (observation.status === "schema_threw") throw observation.error;
  try {
    const result = await conditionalDeleteJsonRecordWithCleanupPermit(
      observation.cleanupPermit,
      path,
      evidenceRef,
      IdempotencyTransitionGuardSchema,
      observation.status === "record"
        ? {
            kind: "record",
            expected: observation.record,
            matches: () => true
          }
        : { kind: "malformed" }
    );
    return result.status !== "condition_not_met";
  } catch (error) {
    if (error instanceof WorkspaceRecordConditionalDeleteError) {
      throw idempotencyTransitionArtifactSettlementError(evidenceRef, error);
    }
    throw error;
  }
}

async function acquireIdempotencyTransitionCleanupLock(
  workspaceRoot: string,
  scope: IdempotencyScope,
  key: string,
  evidenceRef: string
): Promise<IdempotencyTransitionGuardAcquire> {
  const directorySegments = idempotencyRecordDirectorySegments(scope);
  const cleanupLockFileName = idempotencyTransitionCleanupLockFileName(key);
  const cleanupLockPath = workspaceRecordPath(
    workspaceRoot,
    [...directorySegments, cleanupLockFileName],
    evidenceRef
  );

  const deadline = Date.now() + IDEMPOTENCY_TRANSITION_GUARD_WAIT_MS;
  for (;;) {
    const cleanupLock: IdempotencyTransitionGuard = {
      guard_id: randomUUID(),
      owner_pid: process.pid,
      acquired_at_ms: Date.now(),
      acquired_at: new Date().toISOString()
    };
    const created = await createJsonRecordIfAbsentWithCleanupPermit(
      workspaceRoot,
      directorySegments,
      cleanupLockFileName,
      cleanupLock,
      evidenceRef,
      IdempotencyTransitionGuardSchema
    );
    if (created.status === "created") {
      const cleanupPermit = created.cleanupPermit;
      return {
        status: "acquired",
        release: async () =>
          await releaseOwnedIdempotencyTransitionArtifact(
            cleanupPermit,
            cleanupLockPath,
            evidenceRef,
            cleanupLock
          )
      };
    }

    if (await removeStaleIdempotencyTransitionCleanupLock(cleanupLockPath, evidenceRef)) {
      continue;
    }

    if (Date.now() >= deadline) {
      return { status: "busy" };
    }

    await sleep(IDEMPOTENCY_TRANSITION_GUARD_POLL_MS);
  }
}

async function removeStaleIdempotencyTransitionCleanupLock(
  cleanupLockPath: string,
  evidenceRef: string
): Promise<boolean> {
  let observation: WorkspaceJsonRecordCleanupObservation<IdempotencyTransitionGuard>;
  try {
    observation = await observeJsonRecordForCleanup(
      cleanupLockPath,
      evidenceRef,
      IdempotencyTransitionGuardSchema
    );
  } catch (error) {
    if (isRetryableWorkspaceRecordAuthorityContention(error)) return false;
    throw error;
  }
  if (observation.status === "missing") return true;

  return await withOwnedIdempotencyTransitionObservation(
    observation,
    cleanupLockPath,
    evidenceRef,
    async (consume) => {
      if (observation.status === "schema_threw") throw observation.error;
      if (observation.status === "malformed") throw observation.error;
      if (!isIdempotencyTransitionGuardStale(observation.record)) return false;
      return await consume();
    }
  );
}

async function releaseOwnedIdempotencyTransitionArtifact(
  cleanupPermit: WorkspaceRecordCleanupPermit,
  path: string,
  evidenceRef: string,
  expected: IdempotencyTransitionGuard
): Promise<void> {
  try {
    await conditionalDeleteJsonRecordWithCleanupPermit(
      cleanupPermit,
      path,
      evidenceRef,
      IdempotencyTransitionGuardSchema,
      {
        kind: "record",
        expected,
        matches: isSameIdempotencyTransitionGuard
      }
    );
  } catch (error) {
    if (
      error instanceof WorkspaceRecordConditionalDeleteError &&
      error.mutationPhase === "pre_mutation"
    ) {
      return;
    }

    throw idempotencyTransitionArtifactSettlementError(evidenceRef, error);
  }
}

function idempotencyTransitionArtifactSettlementError(
  evidenceRef: string,
  cause: unknown
): TaskServiceError {
  const error = new TaskServiceError({
    code: "workspace_path_not_safe",
    status: 500,
    category: "workspace_error",
    message: "Idempotency transition artifact release did not settle safely.",
    userMessage: "The idempotency transition could not be finalized safely.",
    evidenceRefs: [evidenceRef],
    retryable: false,
    recommendedNextActions: ["Inspect the idempotency transition artifacts before retrying."]
  });
  error.cause = cause;
  return error;
}

function isPreMutationIdempotencyArtifactAuthorityChange(error: unknown): boolean {
  return (
    error instanceof TaskServiceError &&
    error.cause instanceof WorkspaceRecordConditionalDeleteError &&
    error.cause.mutationPhase === "pre_mutation"
  );
}

function isRetryableWorkspaceRecordAuthorityContention(error: unknown): boolean {
  return (
    error instanceof TaskServiceError &&
    error.status === 409 &&
    error.category === "workspace_error" &&
    error.retryable
  );
}

function idempotencyTransitionCleanupLockFileName(key: string): string {
  return `${sha256Hex(`transition-cleanup:${key}`)}.guard-cleanup`;
}

function isSameIdempotencyTransitionGuard(
  left: IdempotencyTransitionGuard,
  right: IdempotencyTransitionGuard
): boolean {
  return (
    left.guard_id === right.guard_id &&
    left.owner_pid === right.owner_pid &&
    left.acquired_at_ms === right.acquired_at_ms &&
    left.acquired_at === right.acquired_at
  );
}

function isIdempotencyTransitionGuardStale(guard: IdempotencyTransitionGuard): boolean {
  const ageMs = Date.now() - guard.acquired_at_ms;
  const ownerIsGone = guard.owner_pid !== process.pid && !isProcessLikelyAlive(guard.owner_pid);
  return ageMs >= IDEMPOTENCY_TRANSITION_GUARD_STALE_MS || ownerIsGone;
}

function isProcessLikelyAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

export function createIdempotencyMismatchError(): TaskServiceError {
  return new TaskServiceError({
    code: "idempotency_mismatch",
    status: 422,
    category: "idempotency_mismatch",
    message: "Idempotency key mismatch for task create request.",
    userMessage: "This idempotency key was already used with different request content.",
    evidenceRefs: [
      "request.headers.Idempotency-Key",
      "idempotency.scope:task",
      "idempotency.request_digest"
    ],
    retryable: false,
    recommendedNextActions: ["Use the original request body or choose a new idempotency key."]
  });
}

function assertPersistableIdempotencyRecord(
  record: IdempotencyRecord,
  evidenceRef: string
): void {
  if (record.status !== "completed" || typeof record.result_ref === "string") {
    return;
  }

  throw new TaskServiceError({
    code: "record_schema_error",
    status: 400,
    category: "schema_error",
    message: "Completed idempotency record is missing result_ref.",
    userMessage: "A completed idempotency record must include its result reference.",
    evidenceRefs: [evidenceRef, "idempotency.result_ref"],
    recommendedNextActions: ["Set result_ref before storing a completed idempotency record."]
  });
}

function assertTaskScopeResultRef(record: IdempotencyRecord, evidenceRef: string): void {
  if (
    record.scope !== "task" ||
    record.status !== "completed" ||
    typeof record.result_ref !== "string" ||
    isSafeTaskId(record.result_ref)
  ) {
    return;
  }

  throw unsafeTaskResultRefError(evidenceRef);
}

function assertTaskScopeInputResultRef(
  scope: IdempotencyScope,
  key: string,
  resultRef: string
): void {
  if (scope !== "task" || isSafeTaskId(resultRef)) {
    return;
  }

  throw unsafeTaskResultRefError(idempotencyRecordEvidenceRef(scope, key));
}

function unsafeTaskResultRefError(evidenceRef: string): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 500,
    category: "workspace_error",
    message: "Completed task idempotency result_ref is not a safe TaskCard id.",
    userMessage: "The idempotency result reference cannot be used safely.",
    evidenceRefs: [evidenceRef, "idempotency.result_ref"],
    retryable: false,
    recommendedNextActions: ["Inspect and repair the idempotency result reference before retrying."]
  });
}

function invalidCompletedRecordAuthorityError(
  reason: InvalidCompletedIdempotencyRecordReason,
  evidenceRef: string
): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 500,
    category: "workspace_error",
    message:
      reason === "missing_result_ref"
        ? "Completed idempotency record is missing result_ref."
        : "Completed task idempotency result_ref is not a safe TaskCard id.",
    userMessage: "The completed idempotency result cannot be used safely.",
    evidenceRefs: [evidenceRef, "idempotency.result_ref"],
    retryable: false,
    recommendedNextActions: ["Retry after the invalid completed authority is quarantined."]
  });
}

function completedRecordStoreBypassError(evidenceRef: string): TaskServiceError {
  return new TaskServiceError({
    code: "record_schema_error",
    status: 400,
    category: "schema_error",
    message: "Completed idempotency records must be written through completeRecord.",
    userMessage: "A completed idempotency record cannot be stored directly.",
    evidenceRefs: [evidenceRef, "idempotency.status"],
    retryable: false,
    recommendedNextActions: ["Use beginRecord and completeRecord to finish an idempotency claim."]
  });
}

function idempotencyRecordStoreExistingError(evidenceRef: string): TaskServiceError {
  return new TaskServiceError({
    code: "record_schema_error",
    status: 400,
    category: "schema_error",
    message: "Existing idempotency records cannot be mutated through storeRecord.",
    userMessage: "An existing idempotency record cannot be overwritten directly.",
    evidenceRefs: [evidenceRef, "idempotency.status"],
    retryable: false,
    recommendedNextActions: ["Use beginRecord, completeRecord, or failRecord for state transitions."]
  });
}

function completedRecordInvalidationStateError(evidenceRef: string): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 409,
    category: "workspace_error",
    message: "Only the exact observed completed idempotency record can be invalidated.",
    userMessage: "The idempotency result changed before it could be invalidated safely.",
    evidenceRefs: [evidenceRef, "idempotency.status"],
    retryable: true,
    recommendedNextActions: ["Retry after inspecting the current idempotency record state."]
  });
}

function completedRecordInvalidationIdentityError(evidenceRef: string): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 409,
    category: "workspace_error",
    message: "Completed idempotency result changed before exact invalidation.",
    userMessage: "The idempotency result changed before it could be invalidated safely.",
    evidenceRefs: [evidenceRef, "idempotency.result_ref"],
    retryable: true,
    recommendedNextActions: ["Retry after inspecting the current idempotency result."]
  });
}

function assertCompletedRecordStoreAllowed(
  existing: IdempotencyRecord,
  incoming: IdempotencyRecord,
  evidenceRef: string
): IdempotencyRecord {
  if (!existing.result_ref) {
    throw completedRecordMissingResultRefError(existing.scope, existing.key);
  }
  if (
    incoming.status === "completed" &&
    incoming.request_digest === existing.request_digest &&
    incoming.result_ref === existing.result_ref
  ) {
    return existing;
  }
  if (incoming.request_digest !== existing.request_digest) {
    throw createIdempotencyMismatchError();
  }

  throw new TaskServiceError({
    code: "record_schema_error",
    status: 400,
    category: "schema_error",
    message: "Completed idempotency record is immutable.",
    userMessage: "A completed idempotency record cannot be overwritten.",
    evidenceRefs: [evidenceRef, "idempotency.result_ref"],
    recommendedNextActions: ["Use the existing idempotency result or choose a new key."]
  });
}

function completedRecordMissingResultRefError(
  scope: IdempotencyScope,
  key: string
): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 500,
    category: "workspace_error",
    message: "Completed idempotency record is missing result_ref.",
    userMessage: "A completed idempotency record is missing its result reference.",
    evidenceRefs: [idempotencyRecordEvidenceRef(scope, key), "idempotency.result_ref"],
    recommendedNextActions: ["Inspect and repair the idempotency record before retrying."]
  });
}

function assertIdempotencyRecordLookupIdentity(
  record: IdempotencyRecord,
  scope: IdempotencyScope,
  key: string,
  evidenceRef: string
): void {
  if (record.scope === scope && record.key === key) {
    return;
  }

  throw new TaskServiceError({
    code: "record_malformed",
    status: 500,
    category: "workspace_error",
    message: "Idempotency record identity does not match its lookup path.",
    userMessage: "The idempotency record cannot be used safely.",
    evidenceRefs: [evidenceRef, "idempotency.key", "idempotency.scope"],
    retryable: false,
    recommendedNextActions: ["Inspect and repair the idempotency record before retrying."]
  });
}

function missingTransitionRecordError(
  scope: IdempotencyScope,
  key: string,
  message: string
): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 500,
    category: "workspace_error",
    message,
    userMessage: "The idempotency record could not be updated safely.",
    evidenceRefs: [idempotencyRecordEvidenceRef(scope, key)],
    recommendedNextActions: ["Inspect the idempotency record state before retrying."]
  });
}

function invalidTransitionStateError(
  scope: IdempotencyScope,
  key: string,
  targetStatus: "completed" | "failed",
  message: string,
  userMessage: string
): TaskServiceError {
  return new TaskServiceError({
    code: "record_schema_error",
    status: 400,
    category: "schema_error",
    message,
    userMessage,
    evidenceRefs: [idempotencyRecordEvidenceRef(scope, key), "idempotency.status"],
    recommendedNextActions: [
      `Repair the idempotency record before marking it ${targetStatus}.`
    ]
  });
}

function transitionGuardBusyError(
  scope: IdempotencyScope,
  key: string,
  transition: "complete" | "fail"
): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 409,
    category: "workspace_error",
    message: `Idempotency record ${transition} transition is already in progress.`,
    userMessage: "The idempotency record is being updated by another request.",
    evidenceRefs: [idempotencyRecordEvidenceRef(scope, key)],
    retryable: true,
    recommendedNextActions: ["Retry after the in-progress idempotency transition finishes."]
  });
}

async function lookupExistingRecordForBegin(
  service: IdempotencyRecordService,
  input: IdempotencyRecordLookupInput,
  evidenceRef: string
): Promise<Exclude<IdempotencyReplayLookup, { status: "missing" }>> {
  const existing = await service.lookupReplay(input);
  if (existing.status === "missing") {
    throw new TaskServiceError({
      code: "record_malformed",
      status: 500,
      category: "workspace_error",
      message: "Idempotency record was not readable during transition acquisition.",
      userMessage: "The idempotency record could not be updated safely.",
      evidenceRefs: [evidenceRef],
      recommendedNextActions: ["Inspect the idempotency record state before retrying."]
    });
  }

  return existing;
}

function beginResultFromReplayLookup(
  lookup: Exclude<IdempotencyReplayLookup, { status: "missing" }>
): BeginIdempotencyRecordResult {
  if (lookup.status === "mismatch") {
    return { status: "mismatch", record: lookup.record };
  }
  if (lookup.status === "completed") {
    return { status: "completed", record: lookup.record };
  }
  if (lookup.status === "invalid_completed") {
    return lookup;
  }

  return { status: "incomplete", record: lookup.record };
}

function beginResultFromStoredRecord(
  record: IdempotencyRecord,
  requestDigest: string,
  scope: IdempotencyScope
): BeginIdempotencyRecordResult {
  if (record.request_digest !== requestDigest) {
    return { status: "mismatch", record };
  }
  if (record.status === "completed") {
    if (!record.result_ref) {
      return {
        status: "invalid_completed",
        reason: "missing_result_ref",
        record,
        observedResultRef: undefined
      };
    }
    if (scope === "task" && !isSafeTaskId(record.result_ref)) {
      return {
        status: "invalid_completed",
        reason: "unsafe_result_ref",
        record,
        observedResultRef: record.result_ref
      };
    }

    return {
      status: "completed",
      record: record as IdempotencyRecord & { result_ref: string }
    };
  }
  if (record.status === "started") {
    return { status: "acquired", record };
  }

  return { status: "incomplete", record };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertNonblankIdempotencyKey(key: string): void {
  if (typeof key === "string" && key.trim().length > 0) {
    return;
  }

  throw new TaskServiceError({
    code: "record_id_not_safe",
    status: 400,
    category: "schema_error",
    message: "Idempotency key must be nonblank.",
    userMessage: "The idempotency key must be nonblank when provided.",
    evidenceRefs: ["request.headers.Idempotency-Key"],
    recommendedNextActions: ["Provide a nonblank idempotency key or omit the header."]
  });
}

function assertIdempotencyScope(scope: IdempotencyScope): IdempotencyScope {
  const parsedScope = IdempotencyScopeSchema.safeParse(scope);
  if (parsedScope.success) {
    return parsedScope.data;
  }

  throw new TaskServiceError({
    code: "record_id_not_safe",
    status: 400,
    category: "schema_error",
    message: "Idempotency scope is not supported.",
    userMessage: "The idempotency scope is not supported.",
    evidenceRefs: ["idempotency.scope"],
    recommendedNextActions: ["Use a supported idempotency scope."]
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
