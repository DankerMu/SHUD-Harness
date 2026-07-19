import {
  createTrustedFailureTransportFamily,
  failureFoldEntrySemanticPrimaryValue,
  failureFoldEntryValue,
  failureLedger,
  mergeTrustedFailureOccurrenceVector,
  mergeTrustedFailureOccurrences,
  type FailureFoldEntry
} from "./compensation-error-preservation";
import {
  TaskServiceError,
  trustedTaskServiceErrorTarget
} from "./task-card-service";

const trustedTaskServiceErrorLedgerViews = new WeakMap<object, TaskServiceError>();

export const taskServiceErrorAuthorityTransportFamily =
  createTrustedFailureTransportFamily<unknown>({
    name: "CompletedTaskSnapshotAuthorityUnknownError",
    message: "Completed task snapshot authority is temporarily unknown."
  });

export function trustedTaskServiceErrorFromFailureLedger(
  value: unknown
): TaskServiceError | undefined {
  return isObjectLike(value) ? trustedTaskServiceErrorLedgerViews.get(value) : undefined;
}

export function taskServiceErrorAtBoundary(
  value: unknown
): TaskServiceError | undefined {
  const trusted = trustedTaskServiceErrorFromFailureLedger(value);
  if (trusted) return trusted;
  if (failureLedger(value)) return undefined;
  const transportProjection = taskServiceErrorAuthorityTransportFamily.project(value);
  return trustedTaskServiceErrorTarget(value) ??
    trustedTaskServiceErrorFromFailureLedger(transportProjection) ??
    trustedTaskServiceErrorTarget(transportProjection);
}

export function preserveTaskServiceErrorFailureEntries(
  primary: FailureFoldEntry,
  compensations: readonly FailureFoldEntry[],
  aggregateMessage: string
): unknown {
  const trustedDirectPrimary = trustedTaskServiceErrorForFoldPrimary(primary);
  const preserved = mergeTrustedFailureOccurrences(
    primary,
    compensations,
    aggregateMessage,
    trustedDirectPrimary ? { classify: () => "error" } : undefined
  );
  if (trustedDirectPrimary && isObjectLike(preserved)) {
    trustedTaskServiceErrorLedgerViews.set(preserved, trustedDirectPrimary);
    return preserved;
  }
  return preserved;
}

export function preserveTaskServiceErrorFailureVector(
  primary: FailureFoldEntry,
  entries: readonly FailureFoldEntry[],
  aggregateMessage: string
): unknown {
  const trustedDirectPrimary = trustedTaskServiceErrorForFoldPrimary(primary);
  const preserved = mergeTrustedFailureOccurrenceVector(
    primary,
    entries,
    aggregateMessage,
    trustedDirectPrimary ? { classify: () => "error" } : undefined
  );
  if (trustedDirectPrimary && isObjectLike(preserved)) {
    trustedTaskServiceErrorLedgerViews.set(preserved, trustedDirectPrimary);
  }
  return preserved;
}

function trustedTaskServiceErrorForFoldPrimary(
  primary: FailureFoldEntry
): TaskServiceError | undefined {
  const entryValue = failureFoldEntryValue(primary);
  const semanticPrimary = failureFoldEntrySemanticPrimaryValue(primary);
  return trustedTaskServiceErrorFromPrivateAuthority(entryValue) ??
    trustedTaskServiceErrorFromPrivateAuthority(semanticPrimary);
}

function trustedTaskServiceErrorFromPrivateAuthority(
  value: unknown
): TaskServiceError | undefined {
  const projection = taskServiceErrorAuthorityTransportFamily.project(value);
  return trustedTaskServiceErrorFromFailureLedger(value) ??
    trustedTaskServiceErrorTarget(value) ??
    trustedTaskServiceErrorFromFailureLedger(projection) ??
    trustedTaskServiceErrorTarget(projection);
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
