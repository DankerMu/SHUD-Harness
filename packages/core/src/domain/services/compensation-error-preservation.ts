export function preservePrimaryAndCompensationErrors(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): unknown {
  const failures = compensations.filter((error) => error !== undefined);
  if (!(primary instanceof Error) || failures.length === 0) return primary;

  const descriptors = Object.getOwnPropertyDescriptors(primary);
  const priorCause = primary.cause;
  const aggregateCause = new AggregateError(
    priorCause === undefined ? failures : [priorCause, ...failures],
    aggregateMessage
  );
  const priorCauseDescriptor = descriptors.cause;
  descriptors.cause =
    priorCauseDescriptor && "value" in priorCauseDescriptor
      ? { ...priorCauseDescriptor, value: aggregateCause }
      : standardCauseDescriptor(aggregateCause, priorCauseDescriptor);

  const clone = Object.create(Object.getPrototypeOf(primary)) as Error;
  Object.defineProperties(clone, descriptors);
  return clone;
}

function standardCauseDescriptor(cause: unknown, prior?: PropertyDescriptor): PropertyDescriptor {
  return {
    configurable: prior?.configurable ?? true,
    enumerable: prior?.enumerable ?? false,
    writable: prior && "writable" in prior ? prior.writable : true,
    value: cause
  };
}
