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
import {
  runWithPreservedRelease
} from "./compensation-error-preservation";
import { preserveTaskServiceErrorCompensationCompatibility } from "./task-service-error-compensation";
import {
  WorkspaceRecordConditionalDeleteError,
  cancelWorkspaceRecordCleanupPermit,
  classifyWorkspaceRecordCleanupPermitAfterSiblingMutation,
  conditionalDeleteJsonRecordWithCleanupPermit,
  createJsonRecordIfAbsent,
  createJsonRecordIfAbsentWithCleanupPermit,
  observeJsonRecordForCleanup,
  readJsonRecord,
  refreshWorkspaceRecordCleanupPermitAfterSiblingMutation,
  replaceJsonRecordAfterExactObservation,
  workspaceRecordPath,
  writeJsonRecord,
  type ExactWorkspaceJsonRecordReplacementResult,
  type WorkspaceJsonRecordCleanupObservation,
  type WorkspaceRecordCleanupPermit
} from "./workspace-record-store";

const IDEMPOTENCY_TRANSITION_GUARD_STALE_MS = 30_000;
const IDEMPOTENCY_TRANSITION_GUARD_WAIT_MS = 250;
const IDEMPOTENCY_TRANSITION_GUARD_POLL_MS = 5;
const IDEMPOTENCY_RELEASE_COMPENSATION_MESSAGE =
  "An idempotency operation failed and its owned artifact release also failed.";
const IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE =
  "Completed idempotency invalidation and its durable quarantine recovery both failed.";

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
    settleFulfilledValueAfterReleaseFailure,
    preserveAuthorityTransportAwareCombinedFailure
  );
}

/**
 * Root C (V33-03): a caller-thrown authority-transport wrapper (an Error
 * exposing the inner failure via `authorityError`, e.g. the backend's
 * CompletedTaskSnapshotAuthorityUnknownError) must keep its INNER typed
 * primary reachable through the caller's one-level unwrap. The fold
 * preserves the inner error with the release failure as an ordered
 * compensation and re-wraps with the same constructor.
 */
function preserveAuthorityTransportAwareCombinedFailure(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): unknown {
  // Root C (V33-13): never count one occurrence twice — a compensation
  // candidate that IS the primary is already represented by the primary
  // itself, so a memoized rejection folded into itself yields primary-only.
  const distinctCompensations = compensations.filter(
    (candidate) => !Object.is(primary, candidate)
  );
  if (distinctCompensations.length === 0) return primary;
  if (
    primary instanceof Error &&
    primary.name === "CompletedTaskSnapshotAuthorityUnknownError" &&
    "authorityError" in primary
  ) {
    const authorityError =
      (primary as Error & { authorityError: unknown }).authorityError;
    const innerDistinctCompensations = distinctCompensations.filter(
      (candidate) => !Object.is(authorityError, candidate)
    );
    if (innerDistinctCompensations.length === 0) return primary;
    try {
      const folded = preserveTaskServiceErrorCompensationCompatibility(
        authorityError,
        innerDistinctCompensations,
        aggregateMessage
      );
      return Reflect.construct(
        primary.constructor as new (inner: unknown) => Error,
        [folded]
      );
    } catch {
      // Fall through to the wrapper-blind fold when reconstruction fails.
    }
  }
  return preserveTaskServiceErrorCompensationCompatibility(
    primary,
    distinctCompensations,
    aggregateMessage
  );
}

const IdempotencyTransitionGuardIdentitySchema = z.object({
  guard_id: z.string().min(1),
  owner_pid: z.number().int().nonnegative(),
  acquired_at_ms: z.number().int().nonnegative(),
  acquired_at: z.string().min(1)
});

const IdempotencyTransitionGuardSchema = IdempotencyTransitionGuardIdentitySchema.extend({
  intent: z.enum(["complete", "fail"]).optional(),
  request_digest: z.string().min(1).optional(),
  result_ref: z.string().min(1).optional()
});

type IdempotencyTransitionGuardIdentity = z.infer<
  typeof IdempotencyTransitionGuardIdentitySchema
>;
type IdempotencyTransitionGuard = z.infer<typeof IdempotencyTransitionGuardSchema>;
type IdempotencyTransitionGuardIntent =
  | Record<never, never>
  | { readonly intent: "complete"; readonly request_digest: string; readonly result_ref?: string }
  | { readonly intent: "fail"; readonly request_digest: string; readonly result_ref?: string };

const activeIdempotencyTransitionGuards = new Map<string, IdempotencyTransitionGuard>();
const malformedIdempotencyTransitionGuardErrors = new WeakSet<TaskServiceError>();

type IdempotencyExactReplacementOperationalFailure = Extract<
  ExactWorkspaceJsonRecordReplacementResult<IdempotencyRecord>,
  { status: "writer_failed" | "operation_failed" }
>;

class RetainedIdempotencyExactReplacementFailure {
  readonly failure: IdempotencyExactReplacementOperationalFailure;
  readonly error: unknown;

  constructor(
    failure: IdempotencyExactReplacementOperationalFailure,
    error: unknown
  ) {
    this.failure = failure;
    this.error = error;
  }
}

type InternalIdempotencyReplayLookup =
  | { readonly status: "lookup"; readonly lookup: IdempotencyReplayLookup }
  | {
      readonly status: "exact_replacement_failed";
      readonly failure: IdempotencyExactReplacementOperationalFailure;
      readonly error: unknown;
    };

type IdempotencyTransitionGuardAcquire =
  | {
      status: "acquired";
      guard: IdempotencyTransitionGuard;
      release: () => Promise<void>;
      retain: () => Promise<void>;
      recoverTerminalRelease: (assertDurablyFailed: () => Promise<void>) => Promise<void>;
    }
  | { status: "busy" };

type IdempotencyTransitionCleanupLockAcquire =
  | { status: "acquired"; release: () => Promise<void> }
  | { status: "busy" };

type RecoveryGenerationClassification =
  | { readonly status: "missing" }
  | { readonly status: "mismatch"; readonly record: IdempotencyRecord }
  | {
      readonly status: "completed";
      readonly record: IdempotencyRecord;
      readonly invalidReason?: InvalidCompletedIdempotencyRecordReason;
    }
  | { readonly status: "failed"; readonly record: IdempotencyRecord }
  | { readonly status: "nonterminal"; readonly record: IdempotencyRecord };

type FailedRecoveryWriteOutcome =
  | { readonly status: "replaced"; readonly record: IdempotencyRecord }
  | {
      readonly status: "exact_existing_terminal";
      readonly classification: Extract<
        RecoveryGenerationClassification,
        { status: "completed" | "failed" }
      >;
    }
  | {
      readonly status: "generation_lost";
      readonly classification: RecoveryGenerationClassification;
    }
  | {
      readonly status: "operational_failure";
      readonly failure: IdempotencyExactReplacementOperationalFailure;
      readonly classification: RecoveryGenerationClassification;
    }
  | {
      readonly status: "operational_failure";
      readonly failure: IdempotencyExactReplacementOperationalFailure;
      readonly classificationError: unknown;
    };

export interface IdempotencyRecordServiceOptions {
  workspaceRoot: string;
  now?: () => Date;
  transitionGuardHooks?: IdempotencyTransitionGuardHooks;
}

export interface IdempotencyTransitionGuardCleanupHookInput {
  guardPath: string;
  evidenceRef: string;
  observedGuard: IdempotencyTransitionGuardIdentity;
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
  mutationAuthority?: CompletedIdempotencyRecordMutationAuthority;
}

export type IdempotencyReplayLookup =
  | { status: "missing" }
  | { status: "mismatch"; record: IdempotencyRecord }
  | { status: "incomplete"; record: IdempotencyRecord }
  | { status: "completed"; record: IdempotencyRecord & { result_ref: string } }
  | InvalidCompletedIdempotencyRecordLookup;

export type CompletedIdempotencyRecordConsumptionDecision<Accepted, Rejected> =
  | { readonly status: "accepted"; readonly value: Accepted }
  | {
      readonly status: "rejected";
      readonly reason: Rejected;
      /**
       * Root A (V33-01): a rejected decision may transport caller-owned
       * counted resources inside `reason` (an observation owning a cleanup
       * permit, a pinned fd, and a cache claim). `consumeCompletedRecord`
       * invokes this hook on its own throw-after-fulfilled windows so every
       * transported resource is settled before the error propagates; it is
       * never invoked when the rejected decision is returned to the caller.
       */
      readonly settleReasonAfterConsumptionFailure?: () => Promise<void>;
    };

/** Runtime ownership is validated by the creating service's private WeakMap. */
export interface CompletedIdempotencyRecordMutationAuthority {}

export type CompletedIdempotencyRecordConsumptionResult<Accepted, Rejected> =
  | Exclude<
      IdempotencyReplayLookup,
      { status: "completed" } | InvalidCompletedIdempotencyRecordLookup
    >
  /**
   * Root A (V32-01): an invalid-completed consumption always transports the
   * exact generation authority captured under the transition guard so callers
   * never invalidate a record they did not physically observe.
   */
  | (InvalidCompletedIdempotencyRecordLookup & {
      readonly mutationAuthority: CompletedIdempotencyRecordMutationAuthority;
    })
  | {
      readonly status: "accepted";
      readonly record: IdempotencyRecord & { result_ref: string };
      readonly value: Accepted;
      readonly mutationAuthority: CompletedIdempotencyRecordMutationAuthority;
    }
  | {
      readonly status: "rejected";
      readonly record: IdempotencyRecord & { result_ref: string };
      readonly reason: Rejected;
      readonly mutationAuthority: CompletedIdempotencyRecordMutationAuthority;
    };

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
  mutationAuthority?: CompletedIdempotencyRecordMutationAuthority;
}

export type FailIdempotencyRecordInput = IdempotencyRecordLookupInput;

export interface QuarantineIdempotencyRecordInput
  extends IdempotencyRecordLookupInput {
  readonly expectedCompletedAuthority?: {
    readonly resultRef: string | undefined;
    readonly mutationAuthority?: CompletedIdempotencyRecordMutationAuthority;
  };
}

export interface IdempotencyRecordService {
  storeRecord: (record: IdempotencyRecord) => Promise<IdempotencyRecord>;
  getRecord: (scope: IdempotencyScope, key: string) => Promise<IdempotencyRecord | undefined>;
  beginRecord: (input: IdempotencyRecordLookupInput) => Promise<BeginIdempotencyRecordResult>;
  lookupReplay: (input: IdempotencyRecordLookupInput) => Promise<IdempotencyReplayLookup>;
  consumeCompletedRecord: <Accepted, Rejected>(
    input: IdempotencyRecordLookupInput,
    consume: (
      record: IdempotencyRecord & { result_ref: string }
    ) => Promise<CompletedIdempotencyRecordConsumptionDecision<Accepted, Rejected>>
  ) => Promise<CompletedIdempotencyRecordConsumptionResult<Accepted, Rejected>>;
  cancelCompletedRecordMutationAuthority: (
    authority: CompletedIdempotencyRecordMutationAuthority
  ) => Promise<void>;
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
    input: QuarantineIdempotencyRecordInput
  ) => Promise<IdempotencyRecord>;
}

function isExactReplacementOperationalFailure<T>(
  result: ExactWorkspaceJsonRecordReplacementResult<T>
): result is Extract<
  ExactWorkspaceJsonRecordReplacementResult<T>,
  { status: "writer_failed" | "operation_failed" }
> {
  return result.status === "writer_failed" || result.status === "operation_failed";
}

export function createIdempotencyRecordService(
  options: IdempotencyRecordServiceOptions
): IdempotencyRecordService {
  const workspaceRoot = resolve(options.workspaceRoot);
  const now = options.now ?? (() => new Date());
  const transitionGuardHooks = options.transitionGuardHooks;
  const completedMutationAuthorities = new WeakMap<
    CompletedIdempotencyRecordMutationAuthority,
    {
      readonly scope: IdempotencyScope;
      readonly key: string;
      readonly requestDigest: string;
      readonly resultRef: string | undefined;
      readonly record: IdempotencyRecord;
      readonly cleanupPermit: WorkspaceRecordCleanupPermit;
      status: "outstanding" | "consumed" | "cancelled";
    }
  >();

  function registerCompletedMutationAuthority(
    scope: IdempotencyScope,
    input: IdempotencyRecordLookupInput,
    record: IdempotencyRecord,
    cleanupPermit: WorkspaceRecordCleanupPermit
  ): CompletedIdempotencyRecordMutationAuthority {
    const authority = Object.freeze({});
    completedMutationAuthorities.set(authority, {
      scope,
      key: input.key,
      requestDigest: input.requestDigest,
      resultRef: record.result_ref,
      record,
      cleanupPermit,
      status: "outstanding"
    });
    return authority;
  }

  async function cancelCompletedMutationAuthority(
    authority: CompletedIdempotencyRecordMutationAuthority
  ): Promise<void> {
    const state = completedMutationAuthorities.get(authority);
    if (!state || state.status !== "outstanding") {
      throw new TypeError(
        "Completed idempotency mutation authority is not owned by this service or is already settled."
      );
    }
    state.status = "cancelled";
    await cancelWorkspaceRecordCleanupPermit(state.cleanupPermit);
  }

  function consumeCompletedMutationAuthority(
    authority: CompletedIdempotencyRecordMutationAuthority,
    input: IdempotencyRecordLookupInput,
    resultRef: string | undefined
  ) {
    const state = completedMutationAuthorities.get(authority);
    if (
      !state ||
      state.status !== "outstanding" ||
      state.scope !== input.scope ||
      state.key !== input.key ||
      state.requestDigest !== input.requestDigest ||
      state.resultRef !== resultRef
    ) {
      throw completedRecordInvalidationIdentityError(
        idempotencyRecordEvidenceRef(input.scope, input.key)
      );
    }
    state.status = "consumed";
    return state;
  }

  async function replaceCompletedRecordWithMutationAuthority(
    authority: CompletedIdempotencyRecordMutationAuthority,
    input: IdempotencyRecordLookupInput,
    scope: IdempotencyScope,
    resultRef: string | undefined,
    evidenceRef: string
  ): Promise<IdempotencyRecord> {
    let exact: ReturnType<typeof consumeCompletedMutationAuthority>;
    try {
      exact = consumeCompletedMutationAuthority(
        authority,
        { ...input, scope },
        resultRef
      );
    } catch (identityError) {
      const state = completedMutationAuthorities.get(authority);
      if (state?.status === "outstanding") {
        try {
          await cancelCompletedMutationAuthority(authority);
        } catch (cancellationError) {
          throw preserveTaskServiceErrorCompensationCompatibility(
            identityError,
            [cancellationError],
            IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
          );
        }
      }
      throw identityError;
    }
    const failedRecord: IdempotencyRecord = {
      ...exact.record,
      status: "failed",
      updated_at: now().toISOString()
    };
    delete failedRecord.result_ref;
    const replacement = await replaceJsonRecordAfterExactObservation(
      exact.cleanupPermit,
      workspaceRoot,
      idempotencyRecordDirectorySegments(scope),
      idempotencyRecordFileName(input.key),
      failedRecord,
      evidenceRef,
      IdempotencyRecordSchema
    );
    if (isExactReplacementOperationalFailure(replacement)) {
      throw exactReplacementOperationalFailureForDomain(
        replacement,
        input,
        scope,
        evidenceRef
      );
    }
    if (replacement.status !== "replaced") {
      throw completedRecordInvalidationIdentityError(evidenceRef);
    }
    return replacement.record;
  }

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

  async function writeFailedRecord(
    input: IdempotencyRecordLookupInput,
    scope: IdempotencyScope,
    key: string,
    evidenceRef: string,
    guard: IdempotencyTransitionGuard & { intent: "fail" }
  ): Promise<FailedRecoveryWriteOutcome> {
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      [...idempotencyRecordDirectorySegments(scope), idempotencyRecordFileName(key)],
      evidenceRef
    );
    const observation = await observeJsonRecordForCleanup(
      recordPath,
      evidenceRef,
      IdempotencyRecordSchema
    );
    if (observation.status === "missing") {
      return { status: "generation_lost", classification: { status: "missing" } };
    }

    let cleanupPermitOutstanding = true;
    try {
      if (observation.status === "malformed" || observation.status === "schema_threw") {
        throw observation.error;
      }
      const existing = observation.record;
      assertIdempotencyRecordLookupIdentity(existing, scope, key, evidenceRef);
      if (existing.request_digest !== input.requestDigest) {
        return {
          status: "generation_lost",
          classification: { status: "mismatch", record: existing }
        };
      }
      if (existing.status === "completed") {
        const classification = classifyRecoveryRecord(existing, input, scope);
        if (classification.status !== "completed") {
          throw new TypeError("Completed recovery classification changed unexpectedly.");
        }
        return {
          status: "exact_existing_terminal",
          classification
        };
      }
      if (existing.status === "failed") {
        return {
          status: "exact_existing_terminal",
          classification: { status: "failed", record: existing }
        };
      }
      assertFailIntentGuardMatchesRecoverableRecord(guard, existing, scope, key);

      const failedRecord: IdempotencyRecord = {
        ...existing,
        status: "failed",
        updated_at: now().toISOString()
      };
      delete failedRecord.result_ref;
      cleanupPermitOutstanding = false;
      const replacement = await replaceJsonRecordAfterExactObservation(
        observation.cleanupPermit,
        workspaceRoot,
        idempotencyRecordDirectorySegments(scope),
        idempotencyRecordFileName(key),
        failedRecord,
        evidenceRef,
        IdempotencyRecordSchema
      );
      if (replacement.status === "replaced") {
        return { status: "replaced", record: replacement.record };
      }
      if (isExactReplacementOperationalFailure(replacement)) {
        return classifyFailedRecoveryOperationalFailure(
          replacement,
          () =>
            replacement.successor.status === "missing"
              ? { status: "missing" }
              : replacement.successor.status === "unavailable"
                ? (() => {
                    throw replacement.successor.proofError;
                  })()
                : classifyRecoveryRecordBytes(
                    replacement.successor.bytes,
                    input,
                    scope,
                    evidenceRef
                  )
        );
      }
      return {
        status: "generation_lost",
        classification:
          replacement.status === "missing"
            ? { status: "missing" }
            : classifyRecoveryRecordBytes(
                replacement.bytes,
                input,
                scope,
                evidenceRef
              )
      };
    } finally {
      if (cleanupPermitOutstanding) {
        await cancelWorkspaceRecordCleanupPermit(observation.cleanupPermit);
      }
    }
  }

  async function writeCompletedRecordAfterRollbackFailure(
    input: CompleteIdempotencyRecordInput,
    scope: IdempotencyScope,
    evidenceRef: string,
    beforeReplacement: () => Promise<void>
  ): Promise<IdempotencyRecord> {
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      [...idempotencyRecordDirectorySegments(scope), idempotencyRecordFileName(input.key)],
      evidenceRef
    );
    const observation = await observeJsonRecordForCleanup(
      recordPath,
      evidenceRef,
      IdempotencyRecordSchema
    );
    if (observation.status === "missing") {
      throw missingTransitionRecordError(
        scope,
        input.key,
        "Idempotency record was missing during completed rollback recovery."
      );
    }

    let cleanupPermitOutstanding = true;
    try {
      if (observation.status === "malformed" || observation.status === "schema_threw") {
        throw observation.error;
      }
      const existing = observation.record;
      assertIdempotencyRecordLookupIdentity(existing, scope, input.key, evidenceRef);
      if (existing.request_digest !== input.requestDigest) {
        throw createIdempotencyMismatchError();
      }

      let parsedReplacement: IdempotencyRecord | undefined;
      if (existing.status !== "completed") {
        const replacementRecord: IdempotencyRecord = {
          ...existing,
          status: "completed",
          result_ref: input.resultRef,
          updated_at: now().toISOString()
        };
        parsedReplacement = IdempotencyRecordSchema.parse(replacementRecord);
        assertPersistableIdempotencyRecord(parsedReplacement, evidenceRef);
        assertTaskScopeResultRef(parsedReplacement, evidenceRef);
      }

      let guardCleanupFailure: { readonly value: unknown } | undefined;
      try {
        await beforeReplacement();
      } catch (error) {
        guardCleanupFailure = { value: error };
      }
      let refresh: Awaited<
        ReturnType<typeof classifyWorkspaceRecordCleanupPermitAfterSiblingMutation>
      >;
      try {
        refresh = await classifyWorkspaceRecordCleanupPermitAfterSiblingMutation(
          observation.cleanupPermit,
          recordPath,
          evidenceRef
        );
      } catch (refreshError) {
        if (!guardCleanupFailure) throw refreshError;
        throw preserveTaskServiceErrorCompensationCompatibility(
          refreshError,
          [guardCleanupFailure.value],
          IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
        );
      }
      if (refresh.status !== "current") {
        let classified: IdempotencyRecord;
        try {
          classified = resolveRecoveryGenerationClassification(
            refresh.status === "missing"
              ? { status: "missing" }
              : classifyRecoveryRecordBytes(
                  refresh.bytes,
                  input,
                  scope,
                  evidenceRef
                ),
            input,
            scope,
            evidenceRef,
            "Idempotency record was missing after completed rollback recovery lost its observed generation."
          );
        } catch (classificationError) {
          if (!guardCleanupFailure) throw classificationError;
          throw preserveTaskServiceErrorCompensationCompatibility(
            classificationError,
            [guardCleanupFailure.value],
            IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
          );
        }
        if (guardCleanupFailure) throw guardCleanupFailure.value;
        return classified;
      }
      if (guardCleanupFailure) throw guardCleanupFailure.value;
      if (existing.status === "completed") {
        assertValidCompletedRecoveryRecord(existing, scope, evidenceRef);
        return existing;
      }
      if (!parsedReplacement) {
        throw new TypeError("Completed recovery replacement was not prepared.");
      }
      cleanupPermitOutstanding = false;
      const replacement = await replaceJsonRecordAfterExactObservation(
        observation.cleanupPermit,
        workspaceRoot,
        idempotencyRecordDirectorySegments(scope),
        idempotencyRecordFileName(input.key),
        parsedReplacement,
        evidenceRef,
        IdempotencyRecordSchema
      );
      if (replacement.status === "replaced") return replacement.record;
      if (isExactReplacementOperationalFailure(replacement)) {
        throw exactReplacementOperationalFailureForDomain(
          replacement,
          input,
          scope,
          evidenceRef
        );
      }
      return resolveRecoveryGenerationClassification(
        replacement.status === "missing"
          ? { status: "missing" }
          : classifyRecoveryRecordBytes(
              replacement.bytes,
              input,
              scope,
              evidenceRef
            ),
        input,
        scope,
        evidenceRef,
        "Idempotency record was missing after completed rollback recovery lost its observed generation."
      );
    } finally {
      if (cleanupPermitOutstanding) {
        await cancelWorkspaceRecordCleanupPermit(observation.cleanupPermit);
      }
    }
  }

  function classifyRecoveryRecordBytes(
    bytes: Buffer,
    input: IdempotencyRecordLookupInput,
    scope: IdempotencyScope,
    evidenceRef: string
  ): RecoveryGenerationClassification {
    let rawRecord: unknown;
    try {
      rawRecord = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      const malformed = new TaskServiceError({
        code: "record_malformed",
        status: 500,
        category: "workspace_error",
        message: "Record is not valid JSON.",
        userMessage: "A workspace record is malformed.",
        evidenceRefs: [evidenceRef]
      });
      if (error instanceof Error) malformed.cause = error;
      throw malformed;
    }

    const parsed = IdempotencyRecordSchema.safeParse(rawRecord);
    if (!parsed.success) {
      throw new TaskServiceError({
        code: "record_schema_error",
        status: 400,
        category: "schema_error",
        message: "Workspace record failed schema validation.",
        userMessage: "A workspace record has invalid fields.",
        evidenceRefs: Array.from(
          new Set(
            parsed.error.issues.map((issue) =>
              issue.path.length > 0
                ? `${evidenceRef}.${issue.path.join(".")}`
                : evidenceRef
            )
          )
        ),
        recommendedNextActions: [
          "Inspect and repair the workspace record before retrying."
        ]
      });
    }

    assertIdempotencyRecordLookupIdentity(
      parsed.data,
      scope,
      input.key,
      evidenceRef
    );
    return classifyRecoveryRecord(parsed.data, input, scope);
  }

  function classifyRecoveryRecord(
    record: IdempotencyRecord,
    input: IdempotencyRecordLookupInput,
    scope: IdempotencyScope
  ): RecoveryGenerationClassification {
    if (record.request_digest !== input.requestDigest) {
      return { status: "mismatch", record };
    }
    if (record.status === "completed") {
      const invalidReason = !record.result_ref
        ? "missing_result_ref"
        : scope === "task" && !isSafeTaskId(record.result_ref)
          ? "unsafe_result_ref"
          : undefined;
      return {
        status: "completed",
        record,
        ...(invalidReason ? { invalidReason } : {})
      };
    }
    return record.status === "failed"
      ? { status: "failed", record }
      : { status: "nonterminal", record };
  }

  function exactReplacementOperationalFailureForDomain(
    failure: IdempotencyExactReplacementOperationalFailure,
    input: IdempotencyRecordLookupInput,
    scope: IdempotencyScope,
    evidenceRef: string
  ): unknown {
    if (failure.successor.status === "unavailable") return failure.error;
    let classification: RecoveryGenerationClassification;
    try {
      classification = failure.successor.status === "missing"
        ? { status: "missing" }
        : classifyRecoveryRecordBytes(
            failure.successor.bytes,
            input,
            scope,
            evidenceRef
          );
    } catch (classificationError) {
      return preserveTaskServiceErrorCompensationCompatibility(
        failure.error,
        [classificationError],
        IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
      );
    }

    let classificationError: unknown;
    if (classification.status === "completed") {
      classificationError = completedRecoveryClassificationError(
        classification,
        evidenceRef
      );
      if (
        failure.origin === "precondition" ||
        (failure.origin === "physical_proof" && classification.invalidReason)
      ) {
        return preserveTaskServiceErrorCompensationCompatibility(
          classificationError,
          [failure.error],
          IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
        );
      }
    } else if (classification.status === "mismatch") {
      classificationError = createIdempotencyMismatchError();
    } else if (classification.status === "missing") {
      classificationError = missingTransitionRecordError(
        scope,
        input.key,
        "Idempotency record was missing after exact replacement failed."
      );
    }
    return classificationError === undefined
      ? failure.error
      : preserveTaskServiceErrorCompensationCompatibility(
          failure.error,
          [classificationError],
          IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
        );
  }

  function resolveRecoveryGenerationClassification(
    classification: RecoveryGenerationClassification,
    input: IdempotencyRecordLookupInput,
    scope: IdempotencyScope,
    evidenceRef: string,
    missingMessage: string
  ): IdempotencyRecord {
    if (classification.status === "missing") {
      throw missingTransitionRecordError(scope, input.key, missingMessage);
    }
    if (classification.status === "mismatch") {
      throw createIdempotencyMismatchError();
    }
    if (classification.status === "completed") {
      if (classification.invalidReason) {
        throw invalidCompletedRecordAuthorityError(
          classification.invalidReason,
          evidenceRef
        );
      }
      return classification.record;
    }
    if (classification.status === "failed") return classification.record;
    throw completedRecordInvalidationStateError(evidenceRef);
  }

  function classifyFailedRecoveryOperationalFailure(
    failure: IdempotencyExactReplacementOperationalFailure,
    classifySuccessor: () => RecoveryGenerationClassification
  ): Extract<FailedRecoveryWriteOutcome, { status: "operational_failure" }> {
    try {
      return {
        status: "operational_failure",
        failure,
        classification: classifySuccessor()
      };
    } catch (classificationError) {
      return {
        status: "operational_failure",
        failure,
        classificationError
      };
    }
  }

  function failedRecoveryOperationalFailureForDomain(
    outcome: Extract<FailedRecoveryWriteOutcome, { status: "operational_failure" }>,
    input: IdempotencyRecordLookupInput,
    scope: IdempotencyScope,
    evidenceRef: string
  ): unknown {
    if ("classificationError" in outcome) {
      if (
        outcome.failure.successor.status === "unavailable" &&
        Object.is(
          outcome.classificationError,
          outcome.failure.successor.proofError
        )
      ) {
        return outcome.failure.error;
      }
      return preserveTaskServiceErrorCompensationCompatibility(
        outcome.failure.error,
        [outcome.classificationError],
        IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
      );
    }
    if (outcome.classification.status === "completed") {
      const classificationError = completedRecoveryClassificationError(
        outcome.classification,
        evidenceRef
      );
      if (
        outcome.failure.origin === "precondition" ||
        (outcome.failure.origin === "physical_proof" &&
          outcome.classification.invalidReason)
      ) {
        return preserveTaskServiceErrorCompensationCompatibility(
          classificationError,
          [outcome.failure.error],
          IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
        );
      }
      return preserveTaskServiceErrorCompensationCompatibility(
        outcome.failure.error,
        [classificationError],
        IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
      );
    }
    if (
      outcome.classification.status === "failed" ||
      outcome.classification.status === "nonterminal"
    ) {
      return outcome.failure.error;
    }
    let classificationError: unknown;
    try {
      resolveRecoveryGenerationClassification(
        outcome.classification,
        input,
        scope,
        evidenceRef,
        "Idempotency record was missing after failed rollback writer failure."
      );
    } catch (error) {
      classificationError = error;
    }
    return preserveTaskServiceErrorCompensationCompatibility(
      outcome.failure.error,
      [classificationError],
      IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
    );
  }

  function completedRecoveryClassificationError(
    classification: Extract<
      RecoveryGenerationClassification,
      { status: "completed" }
    >,
    evidenceRef: string
  ): TaskServiceError {
    return classification.invalidReason
      ? invalidCompletedRecordAuthorityError(
          classification.invalidReason,
          evidenceRef
        )
      : completedRecordInvalidationIdentityError(evidenceRef);
  }

  function assertValidCompletedRecoveryRecord(
    record: IdempotencyRecord,
    scope: IdempotencyScope,
    evidenceRef: string
  ): void {
    if (record.status !== "completed") return;
    if (!record.result_ref) {
      throw invalidCompletedRecordAuthorityError("missing_result_ref", evidenceRef);
    }
    if (scope === "task" && !isSafeTaskId(record.result_ref)) {
      throw invalidCompletedRecordAuthorityError("unsafe_result_ref", evidenceRef);
    }
  }

  async function quarantineRecordAfterUnsafeRollbackInternal(
    input: QuarantineIdempotencyRecordInput
  ): Promise<IdempotencyRecord> {
    try {
      return await quarantineRecordAfterUnsafeRollbackTransition(input);
    } catch (error) {
      if (error instanceof RetainedIdempotencyExactReplacementFailure) {
        throw error.error;
      }
      if (input.expectedCompletedAuthority?.mutationAuthority) {
        throw error;
      }
      if (
        error instanceof TaskServiceError &&
        malformedIdempotencyTransitionGuardErrors.has(error)
      ) {
        throw error;
      }
      if (!(error instanceof TaskServiceError) || error.code !== "record_malformed") {
        throw error;
      }
    }

    const parsedScope = assertIdempotencyScope(input.scope);
    assertNonblankIdempotencyKey(input.key);
    const evidenceRef = idempotencyRecordEvidenceRef(parsedScope, input.key);
    const current = await service.getRecord(parsedScope, input.key);
    if (!current) {
      throw missingTransitionRecordError(
        parsedScope,
        input.key,
        "Idempotency record was missing during unsafe rollback quarantine recovery."
      );
    }
    if (current.request_digest !== input.requestDigest) {
      throw createIdempotencyMismatchError();
    }
    if (current.status === "failed") return current;

    await removeRecoverableIdempotencyTransitionGuardForRollbackRecovery(
      workspaceRoot,
      parsedScope,
      input.key,
      evidenceRef,
      "fail"
    );
    return await quarantineRecordAfterUnsafeRollbackTransition({
      ...input,
      scope: parsedScope
    });
  }

  async function quarantineRecordAfterUnsafeRollbackTransition(
    input: QuarantineIdempotencyRecordInput
  ): Promise<IdempotencyRecord> {
    const parsedScope = assertIdempotencyScope(input.scope);
    assertNonblankIdempotencyKey(input.key);
    const evidenceRef = idempotencyRecordEvidenceRef(parsedScope, input.key);
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      [...idempotencyRecordDirectorySegments(parsedScope), idempotencyRecordFileName(input.key)],
      evidenceRef
    );
    const exactCompletedAuthority =
      input.expectedCompletedAuthority?.mutationAuthority;
    if (exactCompletedAuthority) {
      return await replaceCompletedRecordWithMutationAuthority(
        exactCompletedAuthority,
        input,
        parsedScope,
        input.expectedCompletedAuthority?.resultRef,
        evidenceRef
      );
    }
    const internalReplay = await lookupReplayInternal({
      ...input,
      scope: parsedScope
    });
    if (internalReplay.status === "exact_replacement_failed") {
      throw new RetainedIdempotencyExactReplacementFailure(
        internalReplay.failure,
        internalReplay.error
      );
    }
    const replay = internalReplay.lookup;
    if (replay.status === "missing") {
      throw missingTransitionRecordError(
        parsedScope,
        input.key,
        "Idempotency record was missing when quarantining unsafe rollback authority."
      );
    }
    if (replay.status === "mismatch") throw createIdempotencyMismatchError();
    const semanticRecord = replay.record;
    if (semanticRecord.status === "failed") return semanticRecord;
    assertUnsafeRollbackQuarantineAuthority(semanticRecord, evidenceRef);

    const guard = await acquireIdempotencyTransitionGuard(
      workspaceRoot,
      parsedScope,
      input.key,
      evidenceRef,
      {
        intent: "fail",
        request_digest: input.requestDigest,
        ...(semanticRecord.result_ref === undefined
          ? {}
          : { result_ref: semanticRecord.result_ref })
      },
      transitionGuardHooks
    );
    if (guard.status === "busy") {
      throw transitionGuardBusyError(parsedScope, input.key, "fail");
    }

    let replacementOperationalFailure:
      | IdempotencyExactReplacementOperationalFailure
      | undefined;
    try {
      return await runExactFailedRecordTransitionWithGuardRecovery(
        input,
        parsedScope,
        guard,
        async () => {
      const observation = await observeJsonRecordForCleanup(
        recordPath,
        evidenceRef,
        IdempotencyRecordSchema
      );
      if (observation.status === "missing") {
        throw missingTransitionRecordError(
          parsedScope,
          input.key,
          "Idempotency record was missing when quarantining unsafe rollback authority."
        );
      }
      const cleanupPermit = observation.cleanupPermit;
      let cleanupPermitOutstanding = true;
      try {
        if (observation.status === "malformed") throw observation.error;
        if (observation.status === "schema_threw") throw observation.error;
        const observed = observation.record;
        if (observed.request_digest !== input.requestDigest) {
          throw createIdempotencyMismatchError();
        }
        if (observed.status === "failed") return observed;
        assertUnsafeRollbackQuarantineAuthority(observed, evidenceRef);
        const failedRecord: IdempotencyRecord = {
          ...observed,
          status: "failed",
          updated_at: now().toISOString()
        };
        delete failedRecord.result_ref;
        cleanupPermitOutstanding = false;
        const replacement = await replaceJsonRecordAfterExactObservation(
          cleanupPermit,
          workspaceRoot,
          idempotencyRecordDirectorySegments(parsedScope),
          idempotencyRecordFileName(input.key),
          failedRecord,
          evidenceRef,
          IdempotencyRecordSchema
        );
        if (isExactReplacementOperationalFailure(replacement)) {
          replacementOperationalFailure = replacement;
          throw exactReplacementOperationalFailureForDomain(
            replacement,
            input,
            parsedScope,
            evidenceRef
          );
        }
        if (replacement.status !== "replaced") {
          throw completedRecordInvalidationIdentityError(evidenceRef);
        }
        return replacement.record;
      } finally {
        if (cleanupPermitOutstanding) {
          await cancelWorkspaceRecordCleanupPermit(cleanupPermit);
        }
      }
        }
      );
    } catch (error) {
      if (replacementOperationalFailure) {
        throw new RetainedIdempotencyExactReplacementFailure(
          replacementOperationalFailure,
          error
        );
      }
      throw error;
    }
  }

  async function recoverRetainedFailIntentGuardForReplay(
    scope: IdempotencyScope,
    key: string,
    record: IdempotencyRecord | undefined,
    evidenceRef: string
  ): Promise<IdempotencyRecord | undefined> {
    const guardPath = workspaceRecordPath(
      workspaceRoot,
      [...idempotencyRecordDirectorySegments(scope), idempotencyTransitionGuardFileName(key)],
      evidenceRef
    );
    const observationDeadline = Date.now() + IDEMPOTENCY_TRANSITION_GUARD_WAIT_MS;
    let observation: WorkspaceJsonRecordCleanupObservation<IdempotencyTransitionGuard>;
    for (;;) {
      const activeGuard = activeIdempotencyTransitionGuards.get(guardPath);
      if (activeGuard?.intent === "complete") return record;
      if (activeGuard && activeGuard.intent === undefined) return record;
      if (activeGuard?.intent === "fail") {
        throw transitionGuardBusyError(scope, key, "fail");
      }
      try {
        observation = await observeJsonRecordForCleanup(
          guardPath,
          evidenceRef,
          IdempotencyTransitionGuardSchema
        );
        break;
      } catch (error) {
        if (!isRetryableWorkspaceRecordAuthorityContention(error)) throw error;
        if (Date.now() >= observationDeadline) {
          throw transitionGuardBusyError(scope, key, "fail");
        }
        await sleep(IDEMPOTENCY_TRANSITION_GUARD_POLL_MS);
      }
    }
    if (observation.status === "missing") return record;

    return await withOwnedIdempotencyTransitionObservation(
      observation,
      guardPath,
      evidenceRef,
      async (consume) => {
        if (observation.status === "schema_threw") throw observation.error;
        if (observation.status === "malformed") {
          throw malformedIdempotencyTransitionGuardError(evidenceRef, observation.error);
        }
        assertValidIdempotencyTransitionGuardShape(observation.record, evidenceRef);
        if (observation.record.intent !== "fail") {
          return record;
        }

        const guard = observation.record as IdempotencyTransitionGuard & {
          intent: "fail";
        };
        if (
          isSameIdempotencyTransitionGuard(
            activeIdempotencyTransitionGuards.get(guardPath),
            guard
          ) ||
          (guard.owner_pid !== process.pid && !isIdempotencyTransitionGuardStale(guard))
        ) {
          throw transitionGuardBusyError(scope, key, "fail");
        }
        const guardRequestDigest = guard.request_digest;
        if (!record || !guardRequestDigest || guardRequestDigest !== record.request_digest) {
          throw transitionGuardBusyError(scope, key, "fail");
        }
        assertFailIntentGuardMatchesRecoverableRecord(guard, record, scope, key);

        const cleanupLock = await acquireIdempotencyTransitionCleanupLock(
          workspaceRoot,
          scope,
          key,
          evidenceRef
        );
        if (cleanupLock.status === "busy") {
          throw transitionGuardBusyError(scope, key, "fail");
        }

        const recoveryInput = { scope, key, requestDigest: guardRequestDigest };
        let result: IdempotencyRecord | undefined;
        let resultResolved = false;
        let bodyFailure: { value: unknown } | undefined;
        let retainedOperationalFailure:
          | IdempotencyExactReplacementOperationalFailure
          | undefined;
        let retainedDomainFailure: unknown;
        const settlementFailures: unknown[] = [];
        try {
          const outcome = await writeFailedRecord(
            recoveryInput,
            scope,
            key,
            evidenceRef,
            guard
          );
          const retainGuardForRetry =
            outcome.status === "operational_failure" &&
            ("classificationError" in outcome
              ? outcome.failure.successor.status === "unavailable"
              : outcome.classification.status === "nonterminal");

          if (outcome.status === "operational_failure") {
            // Fix both provenance channels before settling the observed guard:
            // consume/release failures are compensations of this domain error,
            // never replacements for the exact store writer/proof outcome.
            retainedOperationalFailure = outcome.failure;
            retainedDomainFailure = failedRecoveryOperationalFailureForDomain(
              outcome,
              recoveryInput,
              scope,
              evidenceRef
            );
          }

          if (!retainGuardForRetry) {
            try {
              if (!(await consume())) {
                throw idempotencyTransitionArtifactSettlementError(
                  evidenceRef,
                  new Error(
                    "Idempotency fail-intent guard changed while settling generation-bound recovery."
                  )
                );
              }
            } catch (error) {
              if (retainedOperationalFailure) {
                settlementFailures.push(error);
              } else {
                throw error;
              }
            }
          }

          if (outcome.status === "operational_failure") {
            // The error is transported after the cleanup lock is released so
            // every settlement occurrence can be folded exactly once.
          } else if (outcome.status === "replaced") {
            result = outcome.record;
            resultResolved = true;
          } else if (outcome.status === "exact_existing_terminal") {
            // lookupReplay owns completed validity classification. Returning
            // the exact terminal record here also lets a stale guard settle
            // before invalid-completed replay is reported.
            result = outcome.classification.record;
            resultResolved = true;
          } else {
            result = resolveRecoveryGenerationClassification(
              outcome.classification,
              recoveryInput,
              scope,
              evidenceRef,
              "Idempotency record was missing after failed rollback recovery lost its observed generation."
            );
            resultResolved = true;
          }
        } catch (error) {
          bodyFailure = { value: error };
        }

        if (retainedOperationalFailure) {
          try {
            await cleanupLock.release();
          } catch (error) {
            settlementFailures.push(error);
          }
          const finalDomainFailure = settlementFailures.length === 0
            ? retainedDomainFailure
            : preserveAuthorityTransportAwareCombinedFailure(
                retainedDomainFailure,
                settlementFailures,
                IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
              );
          throw new RetainedIdempotencyExactReplacementFailure(
            retainedOperationalFailure,
            finalDomainFailure
          );
        }
        return await runWithIdempotencyRelease(
          async () => {
            if (bodyFailure) throw bodyFailure.value;
            if (!resultResolved) {
              throw new TypeError("Retained failed recovery completed without a result.");
            }
            return result!;
          },
          cleanupLock.release
        );
      }
    );
  }

  function assertFailIntentGuardMatchesRecoverableRecord(
    guard: IdempotencyTransitionGuard & { intent: "fail" },
    record: IdempotencyRecord,
    scope: IdempotencyScope,
    key: string
  ): void {
    if (!guard.request_digest || guard.request_digest !== record.request_digest) {
      throw transitionGuardBusyError(scope, key, "fail");
    }
    if (record.status === "failed") return;
    if (record.status === "completed") {
      if (guard.result_ref === record.result_ref) return;
      throw completedRecordInvalidationIdentityError(
        idempotencyRecordEvidenceRef(scope, key)
      );
    }
    if (record.status === "started" && guard.result_ref === undefined) return;
    throw completedRecordInvalidationStateError(idempotencyRecordEvidenceRef(scope, key));
  }

  async function runFailedRecordTransitionWithGuardRecovery<T>(
    input: IdempotencyRecordLookupInput,
    scope: IdempotencyScope,
    guard: Extract<IdempotencyTransitionGuardAcquire, { status: "acquired" }>,
    body: () => Promise<T>
  ): Promise<T> {
    let bodyCompleted = false;
    let bodyResult: T | undefined;
    let transitionError: unknown;
    try {
      bodyResult = await body();
      bodyCompleted = true;
    } catch (error) {
      transitionError = error;
    }

    let durableFailedRecord: IdempotencyRecord | undefined;
    let classificationError: unknown;
    try {
      durableFailedRecord = await requireDurablyFailedRecord(input, scope);
    } catch (error) {
      classificationError = error;
    }

    if (durableFailedRecord) {
      const releaseErrors: unknown[] = [];
      try {
        await guard.release();
      } catch (releaseError) {
        releaseErrors.push(releaseError);
        try {
          await guard.recoverTerminalRelease(async () => {
            await requireDurablyFailedRecord(input, scope);
          });
        } catch (recoveryError) {
          releaseErrors.push(recoveryError);
        }
      }

      if (transitionError !== undefined) {
        throw preserveTaskServiceErrorCompensationCompatibility(
          transitionError,
          releaseErrors,
          IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
        );
      }
      if (releaseErrors.length > 0) {
        throw preserveTaskServiceErrorCompensationCompatibility(
          releaseErrors[0],
          releaseErrors.slice(1),
          IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
        );
      }
      if (!bodyCompleted) {
        throw new TypeError("Failed idempotency transition settled without a body result.");
      }
      return bodyResult as T;
    }

    const retentionErrors: unknown[] = [];
    let retainExactFailIntent = true;
    try {
      retainExactFailIntent = await exactFailIntentStillProtectsCurrentRecord(
        input,
        scope,
        guard.guard
      );
    } catch (retentionClassificationError) {
      retentionErrors.push(retentionClassificationError);
    }
    try {
      if (retainExactFailIntent) await guard.retain();
      else await guard.release();
    } catch (retentionError) {
      retentionErrors.push(retentionError);
    }
    const primary = transitionError ?? classificationError ?? new TaskServiceError({
      code: "record_malformed",
      status: 500,
      category: "workspace_error",
      message: "Failed idempotency transition did not reach a durable failed state.",
      userMessage: "The idempotency record could not be failed safely.",
      evidenceRefs: [idempotencyRecordEvidenceRef(scope, input.key)],
      retryable: true,
      recommendedNextActions: ["Retry after inspecting the idempotency transition state."]
    });
    const compensations = [
      ...(transitionError !== undefined && classificationError !== undefined
        ? [classificationError]
        : []),
      ...retentionErrors
    ];
    throw preserveTaskServiceErrorCompensationCompatibility(
      primary,
      compensations,
      IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
    );
  }

  async function runExactFailedRecordTransitionWithGuardRecovery<T>(
    input: IdempotencyRecordLookupInput,
    scope: IdempotencyScope,
    guard: Extract<IdempotencyTransitionGuardAcquire, { status: "acquired" }>,
    body: () => Promise<T>
  ): Promise<T> {
    let bodyResult: T | undefined;
    let bodyCompleted = false;
    let bodyError: unknown;
    try {
      bodyResult = await body();
      bodyCompleted = true;
    } catch (error) {
      bodyError = error;
    }

    let durableFailure: IdempotencyRecord | undefined;
    let classificationError: unknown;
    try {
      durableFailure = await requireDurablyFailedRecord(input, scope);
    } catch (error) {
      classificationError = error;
    }

    const releaseErrors: unknown[] = [];
    try {
      await guard.release();
    } catch (releaseError) {
      releaseErrors.push(releaseError);
      if (durableFailure) {
        try {
          await guard.recoverTerminalRelease(async () => {
            await requireDurablyFailedRecord(input, scope);
          });
        } catch (recoveryError) {
          releaseErrors.push(recoveryError);
        }
      }
    }

    if (bodyError !== undefined) {
      throw preserveTaskServiceErrorCompensationCompatibility(
        bodyError,
        [
          ...(classificationError === undefined ? [] : [classificationError]),
          ...releaseErrors
        ],
        IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
      );
    }
    if (!durableFailure) {
      throw preserveTaskServiceErrorCompensationCompatibility(
        classificationError ?? completedRecordInvalidationStateError(
          idempotencyRecordEvidenceRef(scope, input.key)
        ),
        releaseErrors,
        IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
      );
    }
    if (releaseErrors.length > 0) {
      throw preserveTaskServiceErrorCompensationCompatibility(
        releaseErrors[0],
        releaseErrors.slice(1),
        IDEMPOTENCY_INVALIDATION_RECOVERY_COMPENSATION_MESSAGE
      );
    }
    if (!bodyCompleted) {
      throw new TypeError("Exact failed transition completed without a body result.");
    }
    return bodyResult as T;
  }

  async function requireDurablyFailedRecord(
    input: IdempotencyRecordLookupInput,
    scope: IdempotencyScope
  ): Promise<IdempotencyRecord> {
    const current = await service.getRecord(scope, input.key);
    if (!current) {
      throw missingTransitionRecordError(
        scope,
        input.key,
        "Idempotency record was missing while proving durable failed recovery."
      );
    }
    if (current.request_digest !== input.requestDigest) {
      throw createIdempotencyMismatchError();
    }
    if (current.status !== "failed" || current.result_ref !== undefined) {
      throw completedRecordInvalidationStateError(
        idempotencyRecordEvidenceRef(scope, input.key)
      );
    }
    return current;
  }

  async function exactFailIntentStillProtectsCurrentRecord(
    input: IdempotencyRecordLookupInput,
    scope: IdempotencyScope,
    guard: IdempotencyTransitionGuard
  ): Promise<boolean> {
    const current = await service.getRecord(scope, input.key);
    if (!current || current.request_digest !== guard.request_digest) return false;
    if (current.status === "failed") return false;
    if (guard.result_ref !== undefined) {
      return current.status === "completed" && current.result_ref === guard.result_ref;
    }
    return current.status === "started" && current.result_ref === undefined;
  }

  async function beginFromExistingReplay(
    input: IdempotencyRecordLookupInput,
    scope: IdempotencyScope,
    replacement: IdempotencyRecord,
    evidenceRef: string,
    existing: Exclude<IdempotencyReplayLookup, { status: "missing" }>
  ): Promise<BeginIdempotencyRecordResult> {
    if (existing.status === "incomplete" && existing.record.status === "failed") {
      const guard = await acquireIdempotencyTransitionGuard(
        workspaceRoot,
        scope,
        input.key,
        evidenceRef,
        {},
        transitionGuardHooks
      );
      if (guard.status === "busy") {
        return beginResultFromReplayLookup(
          await lookupExistingRecordForBegin(
            service,
            { ...input, scope },
            evidenceRef
          )
        );
      }
      return await runWithIdempotencyRelease(async () => {
        const retryExisting = await service.lookupReplay({ ...input, scope });
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

        const stored = await storeRecordInternal(replacement, {
          allowCompletedWrite: false,
          allowExistingMutation: true
        });
        return beginResultFromStoredRecord(stored, input.requestDigest, scope);
      }, guard.release);
    }

    return beginResultFromReplayLookup(existing);
  }

  async function lookupReplayInternal(
    input: IdempotencyRecordLookupInput
  ): Promise<InternalIdempotencyReplayLookup> {
    const parsedScope = assertIdempotencyScope(input.scope);
    assertNonblankIdempotencyKey(input.key);
    let record = await service.getRecord(parsedScope, input.key);
    if (record && record.request_digest !== input.requestDigest) {
      return { status: "lookup", lookup: { status: "mismatch", record } };
    }
    try {
      record = await recoverRetainedFailIntentGuardForReplay(
        parsedScope,
        input.key,
        record,
        idempotencyRecordEvidenceRef(parsedScope, input.key)
      );
    } catch (error) {
      if (error instanceof RetainedIdempotencyExactReplacementFailure) {
        return {
          status: "exact_replacement_failed",
          failure: error.failure,
          error: error.error
        };
      }
      throw error;
    }
    if (!record) {
      return { status: "lookup", lookup: { status: "missing" } };
    }
    if (record.request_digest !== input.requestDigest) {
      return { status: "lookup", lookup: { status: "mismatch", record } };
    }
    if (record.status === "completed") {
      if (!record.result_ref) {
        return {
          status: "lookup",
          lookup: {
            status: "invalid_completed",
            reason: "missing_result_ref",
            record,
            observedResultRef: undefined
          }
        };
      }
      if (parsedScope === "task" && !isSafeTaskId(record.result_ref)) {
        return {
          status: "lookup",
          lookup: {
            status: "invalid_completed",
            reason: "unsafe_result_ref",
            record,
            observedResultRef: record.result_ref
          }
        };
      }

      return {
        status: "lookup",
        lookup: {
          status: "completed",
          record: record as IdempotencyRecord & { result_ref: string }
        }
      };
    }

    return { status: "lookup", lookup: { status: "incomplete", record } };
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
      const beforeCreate = await service.lookupReplay({ ...input, scope: parsedScope });
      if (beforeCreate.status !== "missing") {
        return await beginFromExistingReplay(
          input,
          parsedScope,
          record,
          evidenceRef,
          beforeCreate
        );
      }
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
      return await beginFromExistingReplay(
        input,
        parsedScope,
        record,
        evidenceRef,
        existing
      );
    },

    async lookupReplay(input: IdempotencyRecordLookupInput): Promise<IdempotencyReplayLookup> {
      const internal = await lookupReplayInternal(input);
      if (internal.status === "exact_replacement_failed") throw internal.error;
      return internal.lookup;
    },

    /**
     * Root E (V33-15, documented disposition): composed permit envelope. An
     * in-window completed replay holds a peak of TWO counted cleanup permits
     * from the shared 1,024 pool — the record permit held across
     * classification, plus the observation permit transported inside the
     * rejected reason until the route settles it. Roughly 512 concurrent
     * completed replays therefore saturate the shared pool; excess replays
     * receive the typed, retryable authority-capacity rejection and
     * self-heal. Capacity re-scoping is out of scope for #74 (deferred to a
     * Phase 8 follow-up issue).
     */
    async consumeCompletedRecord<Accepted, Rejected>(
      input: IdempotencyRecordLookupInput,
      consume: (
        record: IdempotencyRecord & { result_ref: string }
      ) => Promise<CompletedIdempotencyRecordConsumptionDecision<Accepted, Rejected>>
    ): Promise<CompletedIdempotencyRecordConsumptionResult<Accepted, Rejected>> {
      const parsedScope = assertIdempotencyScope(input.scope);
      assertNonblankIdempotencyKey(input.key);
      const evidenceRef = idempotencyRecordEvidenceRef(parsedScope, input.key);
      const deadline = Date.now() + IDEMPOTENCY_TRANSITION_GUARD_WAIT_MS;

      for (;;) {
        const observed = await service.lookupReplay({ ...input, scope: parsedScope });
        if (
          observed.status !== "completed" &&
          observed.status !== "invalid_completed"
        ) return observed;

        const guard = await acquireIdempotencyTransitionGuard(
          workspaceRoot,
          parsedScope,
          input.key,
          evidenceRef,
          {
            intent: "complete",
            request_digest: input.requestDigest,
            ...(observed.record.result_ref === undefined
              ? {}
              : { result_ref: observed.record.result_ref })
          },
          transitionGuardHooks
        );
        if (guard.status === "busy") {
          throw transitionGuardBusyError(parsedScope, input.key, "complete");
        }

        let retryWithCurrentAuthority = false;
        // Root A (V33-01): the rejected decision's settlement hook is carried
        // beside (never inside) the returned result so all three
        // throw-after-fulfilled windows settle transported resources without
        // changing the result shape: transition-artifact release failure,
        // post-release mutation-authority state validation, and
        // cleanup-permit refresh failure.
        let settleRejectedReasonAfterFailure: (() => Promise<void>) | undefined;
        const settleFulfilledDecisionResources = async (
          fulfilled: unknown
        ): Promise<void> => {
          if (
            !fulfilled ||
            typeof fulfilled !== "object" ||
            !("mutationAuthority" in fulfilled)
          ) {
            return;
          }
          const settlementErrors: unknown[] = [];
          try {
            await cancelCompletedMutationAuthority(
              fulfilled.mutationAuthority as CompletedIdempotencyRecordMutationAuthority
            );
          } catch (cancellationError) {
            settlementErrors.push(cancellationError);
          }
          const settleRejectedReason = settleRejectedReasonAfterFailure;
          settleRejectedReasonAfterFailure = undefined;
          if (settleRejectedReason) {
            try {
              await settleRejectedReason();
            } catch (reasonSettlementError) {
              settlementErrors.push(reasonSettlementError);
            }
          }
          if (settlementErrors.length === 1) throw settlementErrors[0];
          if (settlementErrors.length > 1) {
            throw preserveTaskServiceErrorCompensationCompatibility(
              settlementErrors[0],
              settlementErrors.slice(1),
              IDEMPOTENCY_RELEASE_COMPENSATION_MESSAGE
            );
          }
        };
        const recordPath = workspaceRecordPath(
          workspaceRoot,
          [
            ...idempotencyRecordDirectorySegments(parsedScope),
            idempotencyRecordFileName(input.key)
          ],
          evidenceRef
        );
        const result = await runWithIdempotencyRelease(
          async () => {
            const exact = await observeJsonRecordForCleanup(
              recordPath,
              evidenceRef,
              IdempotencyRecordSchema
            );
            if (exact.status === "missing") {
              retryWithCurrentAuthority = true;
              return undefined;
            }
            let permitOutstanding = true;
            try {
              if (exact.status === "malformed" || exact.status === "schema_threw") {
                throw exact.error;
              }
              const current = exact.record;
              const sameObservedCompletedGeneration =
                current.request_digest === input.requestDigest &&
                current.status === "completed" &&
                current.result_ref === observed.record.result_ref;
              if (!sameObservedCompletedGeneration) {
                retryWithCurrentAuthority = true;
                return undefined;
              }
              if (observed.status === "invalid_completed") {
                const mutationAuthority = registerCompletedMutationAuthority(
                  parsedScope,
                  input,
                  current,
                  exact.cleanupPermit
                );
                permitOutstanding = false;
                return {
                  ...observed,
                  record: current,
                  mutationAuthority
                };
              }
              const decision = await consume(
                current as IdempotencyRecord & { result_ref: string }
              );
              const mutationAuthority = registerCompletedMutationAuthority(
                parsedScope,
                input,
                current,
                exact.cleanupPermit
              );
              permitOutstanding = false;
              if (decision.status === "accepted") {
                return {
                  status: "accepted" as const,
                  record: current as IdempotencyRecord & { result_ref: string },
                  value: decision.value,
                  mutationAuthority
                };
              }
              settleRejectedReasonAfterFailure =
                decision.settleReasonAfterConsumptionFailure;
              return {
                status: "rejected" as const,
                record: current as IdempotencyRecord & { result_ref: string },
                reason: decision.reason,
                mutationAuthority
              };
            } finally {
              if (permitOutstanding) {
                await cancelWorkspaceRecordCleanupPermit(exact.cleanupPermit);
              }
            }
          },
          guard.release,
          settleFulfilledDecisionResources
        );

        if (!retryWithCurrentAuthority) {
          if (
            result &&
            typeof result === "object" &&
            "mutationAuthority" in result
          ) {
            const mutationAuthority = result.mutationAuthority as
              CompletedIdempotencyRecordMutationAuthority;
            const authorityState = completedMutationAuthorities.get(mutationAuthority);
            let authorityStateError: unknown;
            if (!authorityState || authorityState.status !== "outstanding") {
              authorityStateError = completedRecordInvalidationIdentityError(evidenceRef);
            } else {
              try {
                // Reuse the transported cleanup permit for the defensive
                // post-release proof. The classification is intentionally
                // non-consuming here: semantic generation drift remains the
                // cleanup-permit refresh exit below, and no ordinary record
                // authority reservation is added after fulfillment.
                await classifyWorkspaceRecordCleanupPermitAfterSiblingMutation(
                  authorityState.cleanupPermit,
                  recordPath,
                  evidenceRef
                );
              } catch (error) {
                authorityStateError = error;
              }
            }
            if (authorityStateError !== undefined) {
              // Root A (V33-01): the post-release authority-state validation
              // is the second throw-after-fulfilled exit and therefore uses
              // the same owner as release and refresh failures.
              try {
                await settleFulfilledDecisionResources(result);
              } catch (settlementError) {
                throw preserveTaskServiceErrorCompensationCompatibility(
                  authorityStateError,
                  [settlementError],
                  IDEMPOTENCY_RELEASE_COMPENSATION_MESSAGE
                );
              }
              throw authorityStateError;
            }
            try {
              await refreshWorkspaceRecordCleanupPermitAfterSiblingMutation(
                authorityState!.cleanupPermit,
                recordPath,
                evidenceRef
              );
            } catch (refreshError) {
              // Root A (V33-01): cleanup-permit refresh is the third
              // throw-after-fulfilled exit; settle the mutation authority AND
              // the rejected reason's transported resources before the
              // refresh failure propagates.
              try {
                await settleFulfilledDecisionResources(result);
              } catch (settlementError) {
                throw preserveTaskServiceErrorCompensationCompatibility(
                  refreshError,
                  [settlementError],
                  IDEMPOTENCY_RELEASE_COMPENSATION_MESSAGE
                );
              }
              throw refreshError;
            }
          }
          return result as CompletedIdempotencyRecordConsumptionResult<Accepted, Rejected>;
        }
        if (Date.now() >= deadline) {
          throw transitionGuardBusyError(parsedScope, input.key, "complete");
        }
      }
    },

    async cancelCompletedRecordMutationAuthority(
      authority: CompletedIdempotencyRecordMutationAuthority
    ): Promise<void> {
      await cancelCompletedMutationAuthority(authority);
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
        {
          intent: "complete",
          request_digest: input.requestDigest,
          result_ref: input.resultRef
        },
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
      if (!input.mutationAuthority) {
        const beforeInvalidation = await service.lookupReplay({
          ...input,
          scope: parsedScope
        });
        if (beforeInvalidation.status === "mismatch") {
          throw createIdempotencyMismatchError();
        }
        if (beforeInvalidation.status === "missing") {
          throw missingTransitionRecordError(
            parsedScope,
            input.key,
            "Idempotency record was missing when invalidating the completed result."
          );
        }
        if (
          beforeInvalidation.status === "incomplete" &&
          beforeInvalidation.record.status === "failed"
        ) {
          return beforeInvalidation.record;
        }
      }
      if (input.mutationAuthority) {
        return await replaceCompletedRecordWithMutationAuthority(
          input.mutationAuthority,
          input,
          parsedScope,
          input.resultRef,
          evidenceRef
        );
      }
      const guard = await acquireIdempotencyTransitionGuard(
        workspaceRoot,
        parsedScope,
        input.key,
        evidenceRef,
        {
          intent: "fail",
          request_digest: input.requestDigest,
          ...(input.resultRef === undefined ? {} : { result_ref: input.resultRef })
        },
        transitionGuardHooks
      );
      if (guard.status === "busy") {
        throw transitionGuardBusyError(parsedScope, input.key, "fail");
      }

      return await runExactFailedRecordTransitionWithGuardRecovery(
        input,
        parsedScope,
        guard,
        async () => {
          const recordPath = workspaceRecordPath(
            workspaceRoot,
            [
              ...idempotencyRecordDirectorySegments(parsedScope),
              idempotencyRecordFileName(input.key)
            ],
            evidenceRef
          );
          const exact = await observeJsonRecordForCleanup(
            recordPath,
            evidenceRef,
            IdempotencyRecordSchema
          );
          if (exact.status === "missing") {
            throw missingTransitionRecordError(
              parsedScope,
              input.key,
              "Idempotency record was missing when invalidating the completed result."
            );
          }
          let permitOutstanding = true;
          try {
            if (exact.status === "malformed" || exact.status === "schema_threw") {
              throw exact.error;
            }
            const existing = exact.record;
            if (existing.request_digest !== input.requestDigest) {
              throw createIdempotencyMismatchError();
            }
            if (existing.status !== "completed") {
              throw completedRecordInvalidationStateError(evidenceRef);
            }
            if (existing.result_ref !== input.resultRef) {
              throw completedRecordInvalidationIdentityError(evidenceRef);
            }
            const failedRecord: IdempotencyRecord = {
              ...existing,
              status: "failed",
              updated_at: now().toISOString()
            };
            delete failedRecord.result_ref;
            permitOutstanding = false;
            const replacement = await replaceJsonRecordAfterExactObservation(
              exact.cleanupPermit,
              workspaceRoot,
              idempotencyRecordDirectorySegments(parsedScope),
              idempotencyRecordFileName(input.key),
              failedRecord,
              evidenceRef,
              IdempotencyRecordSchema
            );
            if (isExactReplacementOperationalFailure(replacement)) {
              throw exactReplacementOperationalFailureForDomain(
                replacement,
                input,
                parsedScope,
                evidenceRef
              );
            }
            if (replacement.status !== "replaced") {
              throw completedRecordInvalidationIdentityError(evidenceRef);
            }
            return replacement.record;
          } finally {
            if (permitOutstanding) {
              await cancelWorkspaceRecordCleanupPermit(exact.cleanupPermit);
            }
          }
        }
      );
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
        {
          intent: "fail",
          request_digest: input.requestDigest
        },
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

      return await runFailedRecordTransitionWithGuardRecovery(
        input,
        parsedScope,
        guard,
        async () => {
          const existing = await service.getRecord(parsedScope, input.key);
          if (!existing) {
            throw missingTransitionRecordError(
              parsedScope,
              input.key,
              "Idempotency record was missing when marking the claim failed."
            );
          }
          if (existing.request_digest !== input.requestDigest) {
            throw createIdempotencyMismatchError();
          }
          if (existing.status === "failed") {
            return existing;
          }
          if (existing.status !== "started") {
            throw invalidTransitionStateError(
              parsedScope,
              input.key,
              "failed",
              "Only a started idempotency record can be marked failed.",
              "The idempotency record is not in a failable state."
            );
          }

          const recordWithoutResultRef = { ...existing };
          delete recordWithoutResultRef.result_ref;
          return await storeRecordInternal(
            {
              ...recordWithoutResultRef,
              status: "failed",
              updated_at: now().toISOString()
            },
            { allowCompletedWrite: false, allowExistingMutation: true }
          );
        }
      );
    },

    async recoverFailedRecordAfterRollback(
      input: FailIdempotencyRecordInput
    ): Promise<IdempotencyRecord> {
      const parsedScope = assertIdempotencyScope(input.scope);
      assertNonblankIdempotencyKey(input.key);
      const recoveryInput = { ...input, scope: parsedScope };
      const evidenceRef = idempotencyRecordEvidenceRef(parsedScope, input.key);
      const observed = await service.lookupReplay(recoveryInput);
      if (observed.status === "mismatch") throw createIdempotencyMismatchError();
      if (observed.status === "missing") {
        throw missingTransitionRecordError(
          parsedScope,
          input.key,
          "Idempotency record was missing during failed rollback recovery."
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
        { intent: "fail", request_digest: input.requestDigest },
        transitionGuardHooks
      );
      if (guard.status === "busy") {
        const current = await service.lookupReplay(recoveryInput);
        if (current.status === "mismatch") throw createIdempotencyMismatchError();
        if (current.status === "completed") return current.record;
        if (current.status === "invalid_completed") {
          throw invalidCompletedRecordAuthorityError(current.reason, evidenceRef);
        }
        if (current.status === "incomplete" && current.record.status === "failed") {
          return current.record;
        }
        throw transitionGuardBusyError(parsedScope, input.key, "fail");
      }

      return await runWithIdempotencyRelease(async () => {
        const outcome = await writeFailedRecord(
          recoveryInput,
          parsedScope,
          input.key,
          evidenceRef,
          guard.guard as IdempotencyTransitionGuard & { intent: "fail" }
        );
        if (outcome.status === "replaced") return outcome.record;
        if (
          outcome.status === "exact_existing_terminal" ||
          outcome.status === "generation_lost"
        ) {
          return resolveRecoveryGenerationClassification(
            outcome.classification,
            recoveryInput,
            parsedScope,
            evidenceRef,
            "Idempotency record was missing after failed rollback recovery lost its observed generation."
          );
        }
        throw failedRecoveryOperationalFailureForDomain(
          outcome,
          recoveryInput,
          parsedScope,
          evidenceRef
        );
      }, guard.release);
    },

    async recoverCompletedRecordAfterRollbackFailure(
      input: CompleteIdempotencyRecordInput
    ): Promise<IdempotencyRecord> {
      const parsedScope = assertIdempotencyScope(input.scope);
      assertNonblankIdempotencyKey(input.key);
      assertTaskScopeInputResultRef(parsedScope, input.key, input.resultRef);
      const evidenceRef = idempotencyRecordEvidenceRef(parsedScope, input.key);
      return await writeCompletedRecordAfterRollbackFailure(
        { ...input, scope: parsedScope },
        parsedScope,
        evidenceRef,
        async () =>
          await removeRecoverableIdempotencyTransitionGuardForRollbackRecovery(
            workspaceRoot,
            parsedScope,
            input.key,
            evidenceRef,
            "complete"
          )
      );
    },

    async quarantineRecordAfterUnsafeRollback(
      input: QuarantineIdempotencyRecordInput
    ): Promise<IdempotencyRecord> {
      return await quarantineRecordAfterUnsafeRollbackInternal(input);
    }
  };

  return service;
}

/**
 * Root A (V32-01): a completed record may only be mutated through the exact
 * transported mutation authority captured at classification. The tokenless
 * quarantine fallback fails closed on every completed observation instead of
 * re-authorizing semantically from a fresh read.
 */
function assertUnsafeRollbackQuarantineAuthority(
  record: IdempotencyRecord,
  evidenceRef: string
): void {
  if (record.status !== "completed") return;
  throw completedRecordInvalidationIdentityError(evidenceRef);
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
  intent: IdempotencyTransitionGuardIntent,
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
      acquired_at: new Date().toISOString(),
      ...intent
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
      activeIdempotencyTransitionGuards.set(guardPath, created.record);
      const markTerminal = (): void => {
        if (
          isSameIdempotencyTransitionGuard(
            activeIdempotencyTransitionGuards.get(guardPath),
            created.record
          )
        ) {
          activeIdempotencyTransitionGuards.delete(guardPath);
        }
      };
      return {
        status: "acquired",
        guard: created.record,
        release: async () => {
          try {
            await releaseOwnedIdempotencyTransitionArtifact(
              cleanupPermit,
              guardPath,
              evidenceRef,
              created.record
            );
          } finally {
            markTerminal();
          }
        },
        retain: async () => {
          try {
            await cancelWorkspaceRecordCleanupPermit(cleanupPermit);
          } finally {
            markTerminal();
          }
        },
        recoverTerminalRelease: async (assertDurablyFailed) =>
          await recoverOwnedIdempotencyTransitionGuardAfterTerminalReleaseFailure(
            workspaceRoot,
            scope,
            key,
            guardPath,
            evidenceRef,
            created.record,
            assertDurablyFailed
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
        assertValidIdempotencyTransitionGuardShape(observation.record, evidenceRef);
        if (observation.record.intent === "fail") return false;
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
            observedGuard: idempotencyTransitionGuardIdentity(observation.record)
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
      if (observation.status === "malformed") {
        throw malformedIdempotencyTransitionGuardError(evidenceRef, observation.error);
      }
      assertValidIdempotencyTransitionGuardShape(observation.record, evidenceRef);
      if (
        observation.status === "record" &&
        (observation.record.intent === "fail" ||
          !isIdempotencyTransitionGuardStale(observation.record))
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

async function recoverOwnedIdempotencyTransitionGuardAfterTerminalReleaseFailure(
  workspaceRoot: string,
  scope: IdempotencyScope,
  key: string,
  guardPath: string,
  evidenceRef: string,
  expected: IdempotencyTransitionGuard,
  assertDurablyFailed: () => Promise<void>
): Promise<void> {
  let observation: WorkspaceJsonRecordCleanupObservation<IdempotencyTransitionGuard>;
  try {
    observation = await observeJsonRecordForCleanup(
      guardPath,
      evidenceRef,
      IdempotencyTransitionGuardSchema
    );
  } catch (error) {
    if (isRetryableWorkspaceRecordAuthorityContention(error)) {
      throw transitionGuardBusyError(scope, key, "fail");
    }
    throw error;
  }
  if (observation.status === "missing") return;

  await withOwnedIdempotencyTransitionObservation(
    observation,
    guardPath,
    evidenceRef,
    async (consume) => {
      if (
        observation.status !== "record" ||
        !isSameIdempotencyTransitionGuard(observation.record, expected)
      ) {
        return;
      }

      const cleanupLock = await acquireIdempotencyTransitionCleanupLock(
        workspaceRoot,
        scope,
        key,
        evidenceRef
      );
      if (cleanupLock.status === "busy") {
        throw transitionGuardBusyError(scope, key, "fail");
      }

      await runWithIdempotencyRelease(async () => {
        await assertDurablyFailed();
        await consume();
      }, cleanupLock.release);
    }
  );
}

function assertValidIdempotencyTransitionGuardShape(
  guard: IdempotencyTransitionGuard,
  evidenceRef: string
): void {
  const hasIntent = guard.intent !== undefined;
  const hasRequestDigest = guard.request_digest !== undefined;
  const hasResultRef = guard.result_ref !== undefined;
  if (!hasIntent && !hasRequestDigest && !hasResultRef) return;
  if (guard.intent === "complete" && hasRequestDigest && hasResultRef) return;
  if (guard.intent === "fail" && hasRequestDigest) return;
  throw malformedIdempotencyTransitionGuardError(
    evidenceRef,
    new TypeError(
      "Idempotency transition guard private fields do not form a complete or fail marker."
    )
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
): Promise<IdempotencyTransitionCleanupLockAcquire> {
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

function malformedIdempotencyTransitionGuardError(
  evidenceRef: string,
  cause: unknown
): TaskServiceError {
  const error = new TaskServiceError({
    code: "record_malformed",
    status: 500,
    category: "workspace_error",
    message: "Idempotency transition guard is malformed.",
    userMessage: "The idempotency transition state cannot be read safely.",
    evidenceRefs: [evidenceRef],
    retryable: false,
    recommendedNextActions: ["Inspect and repair the private transition marker before retrying."]
  });
  if (cause instanceof Error) error.cause = cause;
  malformedIdempotencyTransitionGuardErrors.add(error);
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
  left: IdempotencyTransitionGuard | undefined,
  right: IdempotencyTransitionGuard
): boolean {
  return (
    left !== undefined &&
    left.guard_id === right.guard_id &&
    left.owner_pid === right.owner_pid &&
    left.acquired_at_ms === right.acquired_at_ms &&
    left.acquired_at === right.acquired_at &&
    left.intent === right.intent &&
    left.request_digest === right.request_digest &&
    left.result_ref === right.result_ref
  );
}

function idempotencyTransitionGuardIdentity(
  guard: IdempotencyTransitionGuard
): IdempotencyTransitionGuardIdentity {
  return {
    guard_id: guard.guard_id,
    owner_pid: guard.owner_pid,
    acquired_at_ms: guard.acquired_at_ms,
    acquired_at: guard.acquired_at
  };
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
