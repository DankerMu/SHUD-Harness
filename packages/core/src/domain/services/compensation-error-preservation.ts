export function preservePrimaryAndCompensationErrors(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): unknown {
  if (!(primary instanceof Error) || compensations.length === 0) return primary;

  const descriptors = Object.getOwnPropertyDescriptors(primary);
  const integrityLevel = captureIntegrityLevel(primary, descriptors);
  const priorCauseDescriptor = descriptors.cause;
  const observedCauses = safelyObservePriorCause(primary, priorCauseDescriptor);
  const aggregateCause = new AggregateError(
    [...observedCauses, ...compensations],
    aggregateMessage
  );
  descriptors.cause = aggregateCauseDescriptor(aggregateCause, priorCauseDescriptor);

  const clone = Object.create(Object.getPrototypeOf(primary)) as Error;
  Object.defineProperties(clone, descriptors);
  return restoreIntegrityLevel(clone, integrityLevel);
}

type IntegrityLevel = "frozen" | "sealed" | "non-extensible" | "extensible";

function captureIntegrityLevel(
  primary: Error,
  descriptors: PropertyDescriptorMap
): IntegrityLevel {
  if (Object.isExtensible(primary)) return "extensible";

  const ownDescriptors = Reflect.ownKeys(descriptors).map((key) => descriptors[key]!);
  const sealed = ownDescriptors.every((descriptor) => !descriptor.configurable);
  if (!sealed) return "non-extensible";

  const frozen = ownDescriptors.every(
    (descriptor) => !("value" in descriptor) || !descriptor.writable
  );
  return frozen ? "frozen" : "sealed";
}

function restoreIntegrityLevel(clone: Error, integrityLevel: IntegrityLevel): Error {
  switch (integrityLevel) {
    case "frozen":
      return Object.freeze(clone);
    case "sealed":
      return Object.seal(clone);
    case "non-extensible":
      return Object.preventExtensions(clone);
    case "extensible":
      return clone;
  }
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
