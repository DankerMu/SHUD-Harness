interface PreservedErrorProvenance {
  readonly primary: Error;
  readonly observedCauses: readonly unknown[];
  readonly observationFailures: readonly unknown[];
  readonly rawCompensations: readonly unknown[];
  readonly retainedCompensationIdentities: readonly unknown[];
}

type ErrorObservation =
  | {
      readonly kind: "error";
      readonly error: Error;
      readonly failures: readonly unknown[];
    }
  | {
      readonly kind: "non_error" | "indeterminate";
      readonly error?: undefined;
      readonly failures: readonly unknown[];
    };

interface CauseObservation {
  readonly causes: readonly unknown[];
  readonly failures: readonly unknown[];
}

interface CanonicalCompensations {
  readonly values: readonly unknown[];
  readonly observationFailures: readonly unknown[];
}

const preservedErrorProvenance = new WeakMap<Error, PreservedErrorProvenance>();
const errorObservationCache = new WeakMap<object, ErrorObservation>();

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

class PreservedCompensationCycle extends Error {
  constructor() {
    super("A cycle was detected while flattening preserved compensation errors.");
    this.name = "PreservedCompensationCycle";
  }
}

const preservedCompensationCycles = new WeakMap<
  PreservedErrorProvenance,
  PreservedCompensationCycle
>();

function preservedCompensationCycleFor(
  provenance: PreservedErrorProvenance
): PreservedCompensationCycle {
  const existing = preservedCompensationCycles.get(provenance);
  if (existing) return existing;
  const marker = Object.freeze(new PreservedCompensationCycle());
  preservedCompensationCycles.set(provenance, marker);
  return marker;
}

type AsyncOutcome<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

export async function runWithPreservedRelease<T>(
  body: () => Promise<T>,
  release: () => Promise<void>,
  aggregateMessage: string,
  settleFulfilledValueAfterReleaseFailure?: (
    fulfilledValue: T,
    releaseReason: unknown
  ) => Promise<void>,
  preserveCombinedFailure: (
    primary: unknown,
    compensations: readonly unknown[],
    aggregateMessage: string
  ) => unknown = preserveThrownValueAndCompensationErrors
): Promise<T> {
  let bodyOutcome: AsyncOutcome<T>;
  try {
    bodyOutcome = { status: "fulfilled", value: await body() };
  } catch (reason) {
    bodyOutcome = { status: "rejected", reason };
  }

  let releaseOutcome: AsyncOutcome<void>;
  try {
    releaseOutcome = { status: "fulfilled", value: await release() };
  } catch (reason) {
    releaseOutcome = { status: "rejected", reason };
  }

  if (bodyOutcome.status === "rejected") {
    if (releaseOutcome.status === "rejected") {
      throw preserveCombinedFailure(
        bodyOutcome.reason,
        [releaseOutcome.reason],
        aggregateMessage
      );
    }
    throw bodyOutcome.reason;
  }
  if (releaseOutcome.status === "rejected") {
    if (settleFulfilledValueAfterReleaseFailure !== undefined) {
      try {
        await settleFulfilledValueAfterReleaseFailure(
          bodyOutcome.value,
          releaseOutcome.reason
        );
      } catch (settlementReason) {
        throw preserveCombinedFailure(
          releaseOutcome.reason,
          [settlementReason],
          aggregateMessage
        );
      }
    }
    throw releaseOutcome.reason;
  }
  return bodyOutcome.value;
}

export function semanticPrimaryError(value: unknown): Error | undefined {
  const provenance = readPreservedErrorProvenance(value);
  if (provenance) return provenance.primary;
  const observation = observeError(value);
  return observation.kind === "error" ? observation.error : undefined;
}

export function registerPreservedErrorCompatibility(
  compatibleError: Error,
  preservedError: Error
): void {
  const provenance = readPreservedErrorProvenance(preservedError);
  if (provenance) preservedErrorProvenance.set(compatibleError, provenance);
}

export function preserveThrownValueAndCompensationErrors(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string,
  additionalObservationFailures: readonly unknown[] = []
): Error {
  const primaryObservation = observeError(primary);
  if (primaryObservation.kind === "error") {
    return preserveObservedPrimaryAndCompensationErrors(
      primaryObservation.error,
      [...primaryObservation.failures, ...additionalObservationFailures],
      compensations,
      aggregateMessage
    );
  }

  const representedPrimary = new PreservedNonErrorThrownValue(primary);
  const observationFailures = [
    ...primaryObservation.failures,
    ...additionalObservationFailures
  ];
  preservedErrorProvenance.set(representedPrimary, {
    primary: representedPrimary,
    observedCauses: [primary],
    observationFailures,
    rawCompensations: [],
    retainedCompensationIdentities: []
  });
  return preserveObservedPrimaryAndCompensationErrors(
    representedPrimary,
    [],
    compensations,
    aggregateMessage
  );
}

export function preservePrimaryAndCompensationErrors(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): unknown {
  const primaryObservation = observeError(primary);
  if (primaryObservation.kind !== "error" || compensations.length === 0) return primary;
  return preserveObservedPrimaryAndCompensationErrors(
    primaryObservation.error,
    primaryObservation.failures,
    compensations,
    aggregateMessage
  );
}

function preserveObservedPrimaryAndCompensationErrors(
  primary: Error,
  primaryObservationFailures: readonly unknown[],
  compensations: readonly unknown[],
  aggregateMessage: string
): Error {
  if (compensations.length === 0) return primary;

  const priorProvenance = readPreservedErrorProvenance(primary);
  const semanticPrimary = priorProvenance?.primary ?? primary;
  const causeObservation = priorProvenance
    ? undefined
    : safelyObservePriorCause(semanticPrimary);
  const observedCauses = priorProvenance?.observedCauses ?? causeObservation!.causes;
  const priorRetainedProvenance = priorProvenance
    ? priorProvenance.retainedCompensationIdentities
    : [];
  const newCompensationInputs = compensations.filter(
    (candidate) => !priorRetainedProvenance.some((prior) => Object.is(prior, candidate))
  );
  const canonicalCompensations = canonicalizeCompensations(newCompensationInputs);
  const observationFailures = [
    ...(priorProvenance?.observationFailures ?? []),
    ...primaryObservationFailures,
    ...(causeObservation?.failures ?? []),
    ...canonicalCompensations.observationFailures
  ].filter((failure, index, allFailures) => allFailures.indexOf(failure) === index);
  const priorRawCompensations = priorProvenance?.rawCompensations ?? [];
  const newRawCompensations = canonicalCompensations.values.filter(
    (candidate) => !priorRetainedProvenance.some((prior) => Object.is(prior, candidate))
  );
  const rawCompensations = [
    ...priorRawCompensations,
    ...newRawCompensations
  ];
  const retainedCompensationIdentities = [
    ...priorRetainedProvenance,
    ...[...newCompensationInputs, ...canonicalCompensations.values].filter(
      (candidate, index, values) =>
        !priorRetainedProvenance.some((prior) => Object.is(prior, candidate)) &&
        values.findIndex((value) => Object.is(value, candidate)) === index
    )
  ];
  const aggregateCause = new AggregateError(
    [...observedCauses, ...observationFailures, ...rawCompensations],
    aggregateMessage
  );
  const envelope = new PreservedErrorCompensationEnvelope(
    semanticPrimary,
    aggregateCause
  );
  preservedErrorProvenance.set(envelope, {
    primary: semanticPrimary,
    observedCauses,
    observationFailures,
    rawCompensations,
    retainedCompensationIdentities
  });
  return envelope;
}

function canonicalizeCompensations(
  compensations: readonly unknown[],
  activeProvenance = new Set<PreservedErrorProvenance>()
): CanonicalCompensations {
  const values: unknown[] = [];
  const observationFailures: unknown[] = [];
  for (const compensation of compensations) {
    const provenance = readPreservedErrorProvenance(compensation);
    if (provenance) {
      if (activeProvenance.has(provenance)) {
        values.push(preservedCompensationCycleFor(provenance));
        continue;
      }

      activeProvenance.add(provenance);
      try {
        observationFailures.push(...provenance.observationFailures);
        values.push(provenance.primary);
        const nested = canonicalizeCompensations(
          provenance.rawCompensations,
          activeProvenance
        );
        observationFailures.push(...nested.observationFailures);
        values.push(...nested.values);
      } finally {
        activeProvenance.delete(provenance);
      }
      continue;
    }

    const observation = observeError(compensation);
    observationFailures.push(...observation.failures);
    values.push(compensation);
  }
  return { values, observationFailures };
}

function safelyObservePriorCause(primary: Error): CauseObservation {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(primary, "cause");
  } catch (error) {
    return { causes: [], failures: [error] };
  }

  if (descriptor && "value" in descriptor) {
    return descriptor.value === undefined
      ? { causes: [], failures: [] }
      : { causes: [descriptor.value], failures: [] };
  }

  try {
    const priorCause = descriptor?.get ? descriptor.get.call(primary) : primary.cause;
    return priorCause === undefined
      ? { causes: [], failures: [] }
      : { causes: [priorCause], failures: [] };
  } catch (error) {
    return { causes: [], failures: [error] };
  }
}

function observeError(value: unknown): ErrorObservation {
  const provenance = readPreservedErrorProvenance(value);
  if (provenance) return { kind: "error", error: value as Error, failures: [] };
  if (!isObjectLike(value)) return { kind: "non_error", failures: [] };

  const cached = errorObservationCache.get(value);
  if (cached) return cached;

  try {
    const observation = value instanceof Error
      ? { kind: "error" as const, error: value, failures: [] }
      : { kind: "non_error" as const, failures: [] };
    errorObservationCache.set(value, observation);
    return observation;
  } catch (error) {
    // A trapping prototype/brand observation cannot distinguish Proxy(Error)
    // from Proxy(plain object). Preserve the raw identity through the existing
    // represented non-error channel, but never promote it to semantic Error.
    const observation = {
      kind: "indeterminate" as const,
      failures: [error]
    };
    errorObservationCache.set(value, observation);
    return observation;
  }
}

function readPreservedErrorProvenance(
  value: unknown
): PreservedErrorProvenance | undefined {
  if (!isObjectLike(value)) return undefined;
  return preservedErrorProvenance.get(value as Error);
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
