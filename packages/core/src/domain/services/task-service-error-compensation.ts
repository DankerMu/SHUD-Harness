import {
  createTrustedFailureTransportFamily,
  failureLedger,
  isTrustedFailureOccurrence,
  mergeTrustedFailureOccurrenceVector,
  mergeTrustedFailureOccurrences,
  semanticPrimaryValue,
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
  const directPrimary = isTrustedFailureOccurrence(primary) ? primary.value : undefined;
  const directProjection = taskServiceErrorAuthorityTransportFamily.project(directPrimary);
  const trustedDirectPrimary = trustedTaskServiceErrorFromFailureLedger(directPrimary) ??
    trustedTaskServiceErrorTarget(directPrimary) ??
    trustedTaskServiceErrorFromFailureLedger(directProjection) ??
    trustedTaskServiceErrorTarget(directProjection);
  const preserved = mergeTrustedFailureOccurrences(
    primary,
    compensations,
    aggregateMessage,
    trustedDirectPrimary ? { classify: () => "error" } : undefined
  );
  const exactPrimary = semanticPrimaryValue(preserved);
  const transportProjection = taskServiceErrorAuthorityTransportFamily.project(exactPrimary);
  const trustedPrimary = trustedTaskServiceErrorFromFailureLedger(exactPrimary) ??
    trustedTaskServiceErrorTarget(exactPrimary) ??
    trustedTaskServiceErrorFromFailureLedger(transportProjection) ??
    trustedTaskServiceErrorTarget(transportProjection);
  if (trustedPrimary && isObjectLike(preserved)) {
    trustedTaskServiceErrorLedgerViews.set(preserved, trustedPrimary);
    return preserved;
  }
  return preserved;
}

export function preserveTaskServiceErrorFailureVector(
  primary: FailureFoldEntry,
  entries: readonly FailureFoldEntry[],
  aggregateMessage: string
): unknown {
  const directPrimary = isTrustedFailureOccurrence(primary) ? primary.value : undefined;
  const directProjection = taskServiceErrorAuthorityTransportFamily.project(directPrimary);
  const trustedDirectPrimary = trustedTaskServiceErrorFromFailureLedger(directPrimary) ??
    trustedTaskServiceErrorTarget(directPrimary) ??
    trustedTaskServiceErrorFromFailureLedger(directProjection) ??
    trustedTaskServiceErrorTarget(directProjection);
  const preserved = mergeTrustedFailureOccurrenceVector(
    primary,
    entries,
    aggregateMessage,
    trustedDirectPrimary ? { classify: () => "error" } : undefined
  );
  const exactPrimary = semanticPrimaryValue(preserved);
  const transportProjection = taskServiceErrorAuthorityTransportFamily.project(exactPrimary);
  const trustedPrimary = trustedTaskServiceErrorFromFailureLedger(exactPrimary) ??
    trustedTaskServiceErrorTarget(exactPrimary) ??
    trustedTaskServiceErrorFromFailureLedger(transportProjection) ??
    trustedTaskServiceErrorTarget(transportProjection);
  if (trustedPrimary && isObjectLike(preserved)) {
    trustedTaskServiceErrorLedgerViews.set(preserved, trustedPrimary);
  }
  return preserved;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
