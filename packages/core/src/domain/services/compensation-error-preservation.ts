interface PreservedErrorProvenance {
  readonly primary: Error;
  readonly observedCauses: readonly unknown[];
  readonly rawCompensations: readonly unknown[];
}

const preservedErrorProvenance = new WeakMap<Error, PreservedErrorProvenance>();

export class PreservedNonErrorThrownValue extends Error {
  readonly thrownValue: unknown;

  constructor(thrownValue: unknown) {
    super("A non-Error value was thrown.");
    this.name = "PreservedNonErrorThrownValue";
    this.thrownValue = thrownValue;
  }
}

export class PreservedErrorCompensationEnvelope extends Error {
  readonly semanticPrimary: Error;

  constructor(semanticPrimary: Error, cause: AggregateError) {
    super("An error occurred and one or more compensating actions also failed.", { cause });
    this.name = "PreservedErrorCompensationEnvelope";
    this.semanticPrimary = semanticPrimary;
  }
}

export function semanticPrimaryError(value: unknown): Error | undefined {
  if (!(value instanceof Error)) return undefined;
  return preservedErrorProvenance.get(value)?.primary ?? value;
}

export function registerPreservedErrorCompatibility(
  compatibleError: Error,
  preservedError: Error
): void {
  const provenance = preservedErrorProvenance.get(preservedError);
  if (provenance) preservedErrorProvenance.set(compatibleError, provenance);
}

export function preserveThrownValueAndCompensationErrors(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): Error {
  if (primary instanceof Error) {
    return preservePrimaryAndCompensationErrors(
      primary,
      compensations,
      aggregateMessage
    ) as Error;
  }

  const representedPrimary = new PreservedNonErrorThrownValue(primary);
  preservedErrorProvenance.set(representedPrimary, {
    primary: representedPrimary,
    observedCauses: [primary],
    rawCompensations: []
  });
  return preservePrimaryAndCompensationErrors(
    representedPrimary,
    compensations,
    aggregateMessage
  ) as Error;
}

export function preservePrimaryAndCompensationErrors(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): unknown {
  if (!(primary instanceof Error) || compensations.length === 0) return primary;

  const priorProvenance = preservedErrorProvenance.get(primary);
  const semanticPrimary = priorProvenance?.primary ?? primary;
  const observedCauses = priorProvenance?.observedCauses ??
    safelyObservePriorCause(semanticPrimary);
  const rawCompensations = [
    ...(priorProvenance?.rawCompensations ?? []),
    ...canonicalizeCompensations(compensations)
  ];
  const aggregateCause = new AggregateError(
    [...observedCauses, ...rawCompensations],
    aggregateMessage
  );
  const envelope = new PreservedErrorCompensationEnvelope(
    semanticPrimary,
    aggregateCause
  );
  preservedErrorProvenance.set(envelope, {
    primary: semanticPrimary,
    observedCauses,
    rawCompensations
  });
  return envelope;
}

function canonicalizeCompensations(compensations: readonly unknown[]): unknown[] {
  const canonical: unknown[] = [];
  for (const compensation of compensations) {
    if (!(compensation instanceof Error)) {
      canonical.push(compensation);
      continue;
    }

    const provenance = preservedErrorProvenance.get(compensation);
    if (!provenance) {
      canonical.push(compensation);
      continue;
    }

    canonical.push(
      provenance.primary,
      ...canonicalizeCompensations(provenance.rawCompensations)
    );
  }
  return canonical;
}

function safelyObservePriorCause(primary: Error): unknown[] {
  const descriptor = Object.getOwnPropertyDescriptor(primary, "cause");
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
