import {
  preserveThrownValueAndCompensationErrors,
  registerPreservedErrorCompatibility,
  semanticPrimaryError
} from "./compensation-error-preservation";
import {
  TaskServiceError,
  type TaskServiceErrorCode
} from "./task-card-service";

interface TaskServiceErrorSnapshot {
  readonly code: TaskServiceErrorCode;
  readonly status: 400 | 404 | 409 | 422 | 500;
  readonly category: string;
  readonly message: string;
  readonly userMessage: string;
  readonly evidenceRefs: readonly string[];
  readonly retryable: boolean;
  readonly recommendedNextActions: readonly string[];
  readonly stack: string | undefined;
}

interface TaskServiceErrorObservation {
  readonly snapshot: TaskServiceErrorSnapshot | undefined;
  readonly failures: readonly unknown[];
}

export function preserveTaskServiceErrorCompensationCompatibility(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): unknown {
  const semanticCandidate = semanticPrimaryError(primary);
  const observation = observeTaskServiceError(semanticCandidate);
  const preserved = preserveThrownValueAndCompensationErrors(
    primary,
    compensations,
    aggregateMessage,
    observation.failures
  );
  const semanticPrimary = semanticPrimaryError(preserved);
  if (
    observation.snapshot &&
    semanticPrimary === semanticCandidate &&
    preserved !== semanticPrimary
  ) {
    return taskServiceErrorWithCompensationEnvelope(
      observation.snapshot,
      preserved
    );
  }
  return preserved;
}

function taskServiceErrorWithCompensationEnvelope(
  primary: TaskServiceErrorSnapshot,
  compensationEnvelope: Error
): TaskServiceError {
  const compatibleError = new TaskServiceError({
    code: primary.code,
    status: primary.status,
    category: primary.category,
    message: primary.message,
    userMessage: primary.userMessage,
    evidenceRefs: [...primary.evidenceRefs],
    retryable: primary.retryable,
    recommendedNextActions: [...primary.recommendedNextActions]
  });
  compatibleError.stack = primary.stack;
  compatibleError.cause = compensationEnvelope;
  registerPreservedErrorCompatibility(compatibleError, compensationEnvelope);
  return compatibleError;
}

function observeTaskServiceError(value: unknown): TaskServiceErrorObservation {
  if (value === undefined) return { snapshot: undefined, failures: [] };
  try {
    if (!(value instanceof TaskServiceError)) {
      return { snapshot: undefined, failures: [] };
    }
    return {
      snapshot: {
        code: value.code,
        status: value.status,
        category: value.category,
        message: value.message,
        userMessage: value.userMessage,
        evidenceRefs: [...value.evidenceRefs],
        retryable: value.retryable,
        recommendedNextActions: [...value.recommendedNextActions],
        stack: value.stack
      },
      failures: []
    };
  } catch (error) {
    return { snapshot: undefined, failures: [error] };
  }
}
