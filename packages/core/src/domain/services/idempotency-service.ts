import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  IdempotencyRecordSchema,
  IdempotencyScopeSchema,
  type IdempotencyRecord,
  type IdempotencyScope
} from "../schemas/idempotency";
import { TaskServiceError } from "./task-card-service";
import {
  createJsonRecordIfAbsent,
  readJsonRecord,
  workspaceRecordPath,
  writeJsonRecord
} from "./workspace-record-store";

const IDEMPOTENCY_TRANSITION_GUARD_STALE_MS = 30_000;
const IDEMPOTENCY_TRANSITION_GUARD_WAIT_MS = 250;
const IDEMPOTENCY_TRANSITION_GUARD_POLL_MS = 5;

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
}

export interface IdempotencyRecordLookupInput {
  scope: IdempotencyScope;
  key: string;
  requestDigest: string;
}

export type IdempotencyReplayLookup =
  | { status: "missing" }
  | { status: "mismatch"; record: IdempotencyRecord }
  | { status: "incomplete"; record: IdempotencyRecord }
  | { status: "completed"; record: IdempotencyRecord & { result_ref: string } };

export type BeginIdempotencyRecordResult =
  | { status: "acquired"; record: IdempotencyRecord }
  | { status: "mismatch"; record: IdempotencyRecord }
  | { status: "incomplete"; record: IdempotencyRecord }
  | { status: "completed"; record: IdempotencyRecord & { result_ref: string } };

export interface CompleteIdempotencyRecordInput extends IdempotencyRecordLookupInput {
  resultRef: string;
}

export type FailIdempotencyRecordInput = IdempotencyRecordLookupInput;

export interface IdempotencyRecordService {
  storeRecord: (record: IdempotencyRecord) => Promise<IdempotencyRecord>;
  getRecord: (scope: IdempotencyScope, key: string) => Promise<IdempotencyRecord | undefined>;
  beginRecord: (input: IdempotencyRecordLookupInput) => Promise<BeginIdempotencyRecordResult>;
  lookupReplay: (input: IdempotencyRecordLookupInput) => Promise<IdempotencyReplayLookup>;
  completeRecord: (input: CompleteIdempotencyRecordInput) => Promise<IdempotencyRecord>;
  failRecord: (input: FailIdempotencyRecordInput) => Promise<IdempotencyRecord>;
}

export function createIdempotencyRecordService(
  options: IdempotencyRecordServiceOptions
): IdempotencyRecordService {
  const workspaceRoot = resolve(options.workspaceRoot);
  const now = options.now ?? (() => new Date());

  const service: IdempotencyRecordService = {
    async storeRecord(record: IdempotencyRecord): Promise<IdempotencyRecord> {
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
      assertPersistableIdempotencyRecord(
        parsedRecord.data,
        idempotencyRecordEvidenceRef(parsedRecord.data.scope, parsedRecord.data.key)
      );
      const existing = await service.getRecord(parsedRecord.data.scope, parsedRecord.data.key);
      if (existing && existing.request_digest !== parsedRecord.data.request_digest) {
        throw createIdempotencyMismatchError();
      }
      if (existing?.status === "completed") {
        return assertCompletedRecordStoreAllowed(
          existing,
          parsedRecord.data,
          idempotencyRecordEvidenceRef(parsedRecord.data.scope, parsedRecord.data.key)
        );
      }

      return await writeJsonRecord(
        workspaceRoot,
        idempotencyRecordDirectorySegments(parsedRecord.data.scope),
        idempotencyRecordFileName(parsedRecord.data.key),
        parsedRecord.data,
        idempotencyRecordEvidenceRef(parsedRecord.data.scope, parsedRecord.data.key),
        IdempotencyRecordSchema
      );
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

      return await readJsonRecord(
        recordPath,
        idempotencyRecordEvidenceRef(parsedScope, key),
        IdempotencyRecordSchema
      );
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
          evidenceRef
        );
        if (guard.status === "busy") {
          return beginResultFromReplayLookup(
            await lookupExistingRecordForBegin(service, { ...input, scope: parsedScope }, evidenceRef)
          );
        }
        try {
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

          const stored = await service.storeRecord(record);
          return beginResultFromStoredRecord(stored, input.requestDigest, parsedScope, input.key);
        } finally {
          await guard.release();
        }
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
          throw completedRecordMissingResultRefError(parsedScope, input.key);
        }

        return { status: "completed", record: record as IdempotencyRecord & { result_ref: string } };
      }

      return { status: "incomplete", record };
    },

    async completeRecord(input: CompleteIdempotencyRecordInput): Promise<IdempotencyRecord> {
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
          "Idempotency record was missing when completing the claim."
        );
      }
      if (observed.status === "completed") {
        return observed.record;
      }

      const guard = await acquireIdempotencyTransitionGuard(
        workspaceRoot,
        parsedScope,
        input.key,
        evidenceRef
      );
      if (guard.status === "busy") {
        const current = await service.lookupReplay({ ...input, scope: parsedScope });
        if (current.status === "completed") {
          return current.record;
        }
        throw transitionGuardBusyError(parsedScope, input.key, "complete");
      }

      try {
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
        return await service.storeRecord({
          key: input.key,
          scope: parsedScope,
          request_digest: input.requestDigest,
          status: "completed",
          result_ref: input.resultRef,
          created_at: existing.record.created_at,
          updated_at: timestamp
        });
      } finally {
        await guard.release();
      }
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
      if (observed.status === "completed" || observed.record.status === "failed") {
        return observed.record;
      }

      const guard = await acquireIdempotencyTransitionGuard(
        workspaceRoot,
        parsedScope,
        input.key,
        evidenceRef
      );
      if (guard.status === "busy") {
        const current = await service.lookupReplay({ ...input, scope: parsedScope });
        if (
          current.status === "completed" ||
          (current.status === "incomplete" && current.record.status === "failed")
        ) {
          return current.record;
        }
        throw transitionGuardBusyError(parsedScope, input.key, "fail");
      }

      try {
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
        return await service.storeRecord({
          ...recordWithoutResultRef,
          status: "failed",
          updated_at: now().toISOString()
        });
      } finally {
        await guard.release();
      }
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
  evidenceRef: string
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
    const created = await createJsonRecordIfAbsent(
      workspaceRoot,
      directorySegments,
      guardFileName,
      guard,
      evidenceRef,
      IdempotencyTransitionGuardSchema
    );
    if (created.status === "created") {
      return {
        status: "acquired",
        release: async () => {
          const current = await readJsonRecord(
            guardPath,
            evidenceRef,
            IdempotencyTransitionGuardSchema
          ).catch(() => undefined);
          if (current?.guard_id === guard.guard_id) {
            await unlink(guardPath).catch(() => undefined);
          }
        }
      };
    }

    if (await removeStaleIdempotencyTransitionGuard(guardPath, evidenceRef)) {
      continue;
    }
    if (Date.now() >= deadline) {
      return { status: "busy" };
    }

    await sleep(IDEMPOTENCY_TRANSITION_GUARD_POLL_MS);
  }
}

async function removeStaleIdempotencyTransitionGuard(
  guardPath: string,
  evidenceRef: string
): Promise<boolean> {
  const existing = await readJsonRecord(
    guardPath,
    evidenceRef,
    IdempotencyTransitionGuardSchema
  );
  if (!existing) {
    return true;
  }

  const ageMs = Date.now() - existing.acquired_at_ms;
  const ownerIsGone = existing.owner_pid !== process.pid && !isProcessLikelyAlive(existing.owner_pid);
  if (ageMs < IDEMPOTENCY_TRANSITION_GUARD_STALE_MS && !ownerIsGone) {
    return false;
  }

  await unlink(guardPath).catch(() => undefined);
  return true;
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
    status: 500,
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

  return { status: "incomplete", record: lookup.record };
}

function beginResultFromStoredRecord(
  record: IdempotencyRecord,
  requestDigest: string,
  scope: IdempotencyScope,
  key: string
): BeginIdempotencyRecordResult {
  if (record.request_digest !== requestDigest) {
    return { status: "mismatch", record };
  }
  if (record.status === "completed") {
    if (!record.result_ref) {
      throw completedRecordMissingResultRefError(scope, key);
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
