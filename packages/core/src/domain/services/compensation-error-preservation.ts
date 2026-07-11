import { TaskServiceError } from "./task-card-service";

export function preservePrimaryAndCompensationErrors(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): unknown {
  const failures = compensations.filter((error) => error !== undefined);
  if (!(primary instanceof Error) || failures.length === 0) return primary;

  const priorCause = primary.cause;
  const aggregateCause = new AggregateError(
    priorCause === undefined ? failures : [priorCause, ...failures],
    aggregateMessage
  );
  return primary instanceof TaskServiceError
    ? cloneTaskServiceErrorWithCause(primary, aggregateCause)
    : cloneErrorWithCause(primary, aggregateCause);
}

function cloneTaskServiceErrorWithCause(
  primary: TaskServiceError,
  cause: unknown
): TaskServiceError {
  const clone = new TaskServiceError({
    code: primary.code,
    status: primary.status,
    category: primary.category,
    message: primary.message,
    userMessage: primary.userMessage,
    evidenceRefs: [...primary.evidenceRefs],
    retryable: primary.retryable,
    recommendedNextActions: [...primary.recommendedNextActions]
  });
  clone.stack = primary.stack;
  Object.defineProperty(clone, "cause", standardCauseDescriptor(cause));
  return clone;
}

function cloneErrorWithCause(primary: Error, cause: unknown): Error {
  const descriptors = Object.getOwnPropertyDescriptors(primary);
  const priorCauseDescriptor = descriptors.cause;
  descriptors.cause =
    priorCauseDescriptor && "value" in priorCauseDescriptor
      ? { ...priorCauseDescriptor, value: cause }
      : standardCauseDescriptor(cause, priorCauseDescriptor);

  const clone = Object.create(Object.getPrototypeOf(primary)) as Error;
  Object.defineProperties(clone, descriptors);
  return clone;
}

function standardCauseDescriptor(cause: unknown, prior?: PropertyDescriptor): PropertyDescriptor {
  return {
    configurable: prior?.configurable ?? true,
    enumerable: prior?.enumerable ?? false,
    writable: true,
    value: cause
  };
}
