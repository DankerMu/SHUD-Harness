export function preservePrimaryAndCompensationErrors(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): unknown {
  const failures = compensations.filter((error) => error !== undefined);
  if (!(primary instanceof Error) || failures.length === 0) return primary;

  const descriptors = Object.getOwnPropertyDescriptors(primary);
  const priorCauseDescriptor = descriptors.cause;
  const observedCauses = safelyObservePriorCause(primary, priorCauseDescriptor);
  const aggregateCause = new AggregateError(
    [...observedCauses, ...failures],
    aggregateMessage
  );
  descriptors.cause = aggregateCauseDescriptor(aggregateCause, priorCauseDescriptor);

  const clone = Object.create(Object.getPrototypeOf(primary)) as Error;
  Object.defineProperties(clone, descriptors);
  return clone;
}

function safelyObservePriorCause(
  primary: Error,
  descriptor: PropertyDescriptor | undefined
): unknown[] {
  if (descriptor && "value" in descriptor) {
    return descriptor.value === undefined ? [] : [descriptor.value];
  }

  try {
    const priorCause = descriptor?.get ? descriptor.get.call(primary) : primary.cause;
    return priorCause === undefined ? [] : [priorCause];
  } catch (error) {
    return [error];
  }
}

function aggregateCauseDescriptor(
  cause: AggregateError,
  prior?: PropertyDescriptor
): PropertyDescriptor {
  if (prior && !("value" in prior)) {
    return {
      configurable: prior.configurable,
      enumerable: prior.enumerable,
      get: () => cause,
      set: prior.set
    };
  }

  return {
    configurable: prior?.configurable ?? true,
    enumerable: prior?.enumerable ?? false,
    writable: prior && "writable" in prior ? prior.writable : true,
    value: cause
  };
}
