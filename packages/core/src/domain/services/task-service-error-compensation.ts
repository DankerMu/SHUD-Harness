import {
  captureFailureOccurrence,
  failureLedger,
  mergeTrustedFailureOccurrences,
  type FailurePhase
} from "./compensation-error-preservation";
import { TaskServiceError } from "./task-card-service";

const trustedTaskServiceErrorLedgerViews = new WeakMap<object, TaskServiceError>();

export function trustedTaskServiceErrorFromFailureLedger(
  value: unknown
): TaskServiceError | undefined {
  return typeof value === "object" && value !== null
    ? trustedTaskServiceErrorLedgerViews.get(value)
    : undefined;
}

export function taskServiceErrorAtBoundary(
  value: unknown
): TaskServiceError | undefined {
  const trusted = trustedTaskServiceErrorFromFailureLedger(value);
  if (trusted) return trusted;
  if (failureLedger(value)) return undefined;
  return classifyTaskServiceErrorPrimary(value).taskServiceError;
}

export function preserveTaskServiceErrorCompensationCompatibility(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string,
  primaryPhase: FailurePhase = "body",
  compensationPhases: readonly FailurePhase[] = compensations.map(
    () => "settlement"
  )
): unknown {
  let trustedPrimary = trustedTaskServiceErrorFromFailureLedger(primary);
  const primaryOccurrence = captureFailureOccurrence(primaryPhase, primary);
  const compensationOccurrences = compensations.map((value, index) =>
    captureFailureOccurrence(compensationPhases[index] ?? "settlement", value)
  );
  const classification = {
    classify: (value: object) => {
      const result = classifyTaskServiceErrorPrimary(value, true);
      trustedPrimary = result.taskServiceError;
      return result.errorBrand;
    }
  };
  const preserved = mergeTrustedFailureOccurrences(
    primaryOccurrence,
    compensationOccurrences,
    aggregateMessage,
    classification
  );
  if (trustedPrimary && typeof preserved === "object" && preserved !== null) {
    trustedTaskServiceErrorLedgerViews.set(preserved, trustedPrimary);
    return trustedPrimary;
  }
  return preserved;
}

function classifyTaskServiceErrorPrimary(value: unknown, propagateFailure = false): {
  readonly errorBrand: "error" | "non_error" | "indeterminate";
  readonly taskServiceError?: TaskServiceError;
} {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return { errorBrand: "non_error" };
  }
  const seen = new WeakSet<object>();
  let cursor: object | null = value;
  try {
    while (cursor !== null) {
      if (seen.has(cursor)) return { errorBrand: "indeterminate" };
      seen.add(cursor);
      const prototype = Object.getPrototypeOf(cursor) as object | null;
      if (prototype === TaskServiceError.prototype) {
        return {
          errorBrand: "error",
          taskServiceError: value as TaskServiceError
        };
      }
      if (prototype === Error.prototype) return { errorBrand: "error" };
      cursor = prototype;
    }
    return { errorBrand: "non_error" };
  } catch (error) {
    if (propagateFailure) throw error;
    return { errorBrand: "indeterminate" };
  }
}
