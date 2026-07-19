import {
  captureFailureOccurrence,
  failureLedger,
  mergeTrustedFailureOccurrences,
  type FailurePhase
} from "./compensation-error-preservation";
import {
  TaskServiceError,
  trustedTaskServiceErrorTarget
} from "./task-card-service";

const trustedTaskServiceErrorLedgerViews = new WeakMap<object, TaskServiceError>();

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
  return trustedTaskServiceErrorTarget(value);
}

export function preserveTaskServiceErrorCompensationCompatibility(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string,
  primaryPhase: FailurePhase = "body",
  compensationPhases: readonly FailurePhase[] = compensations.map(() => "settlement"),
  primaryOccurrence?: import("./compensation-error-preservation").FailureOccurrence,
  compensationOccurrences?: readonly import("./compensation-error-preservation").FailureOccurrence[]
): unknown {
  const trustedPrimary = trustedTaskServiceErrorFromFailureLedger(primary) ??
    trustedTaskServiceErrorTarget(primary);
  const capturedPrimary = primaryOccurrence ?? captureFailureOccurrence(primaryPhase, primary);
  const capturedCompensations = compensations.map((value, index) =>
    compensationOccurrences?.[index] ??
      captureFailureOccurrence(compensationPhases[index] ?? "settlement", value)
  );
  const preserved = mergeTrustedFailureOccurrences(
    capturedPrimary,
    capturedCompensations,
    aggregateMessage,
    trustedPrimary ? { classify: () => "error" } : undefined
  );
  if (trustedPrimary && isObjectLike(preserved)) {
    trustedTaskServiceErrorLedgerViews.set(preserved, trustedPrimary);
    return preserved;
  }
  return preserved;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
