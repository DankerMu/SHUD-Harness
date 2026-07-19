export type FailurePhase =
  | "body"
  | "initial_release"
  | "settlement"
  | "final_release"
  | "observation";

const FAILURE_OCCURRENCE = Symbol("failure_occurrence");

export interface FailureOccurrence {
  readonly [FAILURE_OCCURRENCE]: true;
  readonly occurrenceId: symbol;
  readonly phase: FailurePhase;
  readonly order: number;
  readonly value: unknown;
}

export interface FailureGraphEdge {
  readonly kind: "semanticPrimary" | "errors" | "cause";
  readonly target: unknown;
  readonly index?: number;
}

export interface FailureGraphNode {
  readonly value: object;
  readonly errorBrand: "error" | "non_error" | "indeterminate";
  readonly edges: readonly FailureGraphEdge[];
}

export interface FailureGraphObservation {
  readonly nodes: readonly FailureGraphNode[];
  readonly observationFailures: readonly FailureOccurrence[];
}

export interface PreservedFailureLedger {
  readonly primary: FailureOccurrence;
  readonly events: readonly FailureOccurrence[];
  readonly compensations: readonly FailureOccurrence[];
  readonly orderedDistinct: readonly FailureOccurrence[];
  readonly observedGraph: FailureGraphObservation;
}

interface FailureObservationSession {
  readonly nodes: FailureGraphNode[];
  readonly observationFailures: FailureOccurrence[];
  readonly observed: WeakSet<object>;
  readonly refreshLedgerCarriers: WeakSet<object>;
  readonly classifiedPrimary?: object;
  readonly classifyPrimary?: (value: object) => FailureGraphNode["errorBrand"];
  adoptNestedLedger?: (value: object) => boolean;
}

export interface FailurePrimaryClassification {
  readonly classify: (value: object) => FailureGraphNode["errorBrand"];
}

let nextFailureOccurrenceOrder = 1;
const trustedFailureOccurrences = new WeakSet<object>();
const preservedFailureLedgers = new WeakMap<object, PreservedFailureLedger>();

export class PreservedNonErrorThrownValue extends Error {
  readonly thrownValue: unknown;

  constructor(thrownValue: unknown) {
    super("A non-Error value was thrown.");
    this.name = "PreservedNonErrorThrownValue";
    this.thrownValue = thrownValue;
  }
}

/**
 * Retained only as a JavaScript compatibility type for caller-created values.
 * The preservation fold never constructs or adopts one by shape.
 */
export class PreservedErrorCompensationEnvelope extends Error {
  readonly semanticPrimary: Error;

  constructor(semanticPrimary: Error, cause: AggregateError) {
    super("An error occurred and one or more compensating actions also failed.", { cause });
    this.name = "PreservedErrorCompensationEnvelope";
    this.semanticPrimary = semanticPrimary;
  }
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

export function captureFailureOccurrence(
  phase: FailurePhase,
  value: unknown
): FailureOccurrence {
  const occurrence = Object.freeze({
    [FAILURE_OCCURRENCE]: true as const,
    occurrenceId: Symbol(phase),
    phase,
    order: nextFailureOccurrenceOrder++,
    value
  });
  trustedFailureOccurrences.add(occurrence);
  return occurrence;
}

export function isTrustedFailureOccurrence(
  value: unknown
): value is FailureOccurrence {
  return isObjectLike(value) && trustedFailureOccurrences.has(value);
}

export function failureLedger(value: unknown): PreservedFailureLedger | undefined {
  return isObjectLike(value) ? preservedFailureLedgers.get(value) : undefined;
}

export function semanticPrimaryValue(value: unknown): unknown {
  const ledger = failureLedger(value);
  return ledger ? ledger.primary.value : value;
}

export function semanticPrimaryError(value: unknown): Error | undefined {
  const ledger = failureLedger(value);
  if (ledger) {
    const primary = ledger.primary.value;
    const observedPrimary = ledger.observedGraph.nodes.find(
      (node) => node.value === primary
    );
    if (
      observedPrimary?.errorBrand === "error" ||
      observedPrimary?.errorBrand === "indeterminate"
    ) return primary as Error;
    return isObjectLike(value) && !Object.is(value, primary)
      ? value as Error
      : undefined;
  }
  return safelyHasErrorBrand(value) ? value : undefined;
}

export function failureGraphNodes(value: unknown): readonly FailureGraphNode[] {
  return failureLedger(value)?.observedGraph.nodes ?? [];
}

export function failureEvents(value: unknown): readonly FailureOccurrence[] {
  return failureLedger(value)?.events ?? [];
}

export function orderedDistinctFailures(value: unknown): readonly unknown[] {
  return failureLedger(value)?.orderedDistinct.map((occurrence) => occurrence.value) ?? [value];
}

export function orderedDistinctCompensationFailures(
  value: unknown
): readonly unknown[] {
  const ledger = failureLedger(value);
  if (!ledger) return [];
  return ledger.orderedDistinct
    .filter((occurrence) => occurrence !== ledger.primary)
    .map((occurrence) => occurrence.value);
}

export function mergeTrustedFailureOccurrences(
  primary: FailureOccurrence,
  later: readonly FailureOccurrence[],
  _aggregateMessage: string,
  primaryClassification?: FailurePrimaryClassification
): unknown {
  if (!isTrustedFailureOccurrence(primary) || later.some((item) => !isTrustedFailureOccurrence(item))) {
    throw new TypeError("Failure occurrences must be created by the preservation boundary.");
  }

  const inherited = failureLedger(primary.value);
  const semanticPrimary = inherited?.primary ?? primary;
  const occurrenceById = new Map<symbol, FailureOccurrence>();
  const visitedLedgers = new Set<PreservedFailureLedger>();
  const reusedObservationLedgers = new Set<PreservedFailureLedger>();
  const retainedObservationFailureIds = new Set<symbol>();
  const session: FailureObservationSession = {
    nodes: [],
    observationFailures: [],
    observed: new WeakSet<object>(),
    refreshLedgerCarriers: new WeakSet<object>(),
    classifiedPrimary: isObjectLike(semanticPrimary.value)
      ? semanticPrimary.value
      : undefined,
    classifyPrimary: primaryClassification?.classify
  };
  const retainOccurrence = (occurrence: FailureOccurrence): void => {
    occurrenceById.set(occurrence.occurrenceId, occurrence);
  };
  const retainObservationFailure = (occurrence: FailureOccurrence): void => {
    if (retainedObservationFailureIds.has(occurrence.occurrenceId)) return;
    retainedObservationFailureIds.add(occurrence.occurrenceId);
    session.observationFailures.push(occurrence);
  };
  const retainLedger = (
    ledger: PreservedFailureLedger | undefined,
    carrier: object | undefined,
    observationMode: "refresh" | "reuse"
  ): boolean => {
    if (!ledger) return false;
    const firstVisit = !visitedLedgers.has(ledger);
    if (firstVisit) {
      visitedLedgers.add(ledger);
      for (const occurrence of ledger.events) retainOccurrence(occurrence);
    }
    if (observationMode === "refresh") {
      if (carrier) session.refreshLedgerCarriers.add(carrier);
    } else if (!reusedObservationLedgers.has(ledger)) {
      reusedObservationLedgers.add(ledger);
      if (carrier) session.observed.add(carrier);
      for (const node of ledger.observedGraph.nodes) {
        if (session.observed.has(node.value)) continue;
        session.observed.add(node.value);
        session.nodes.push(node);
      }
      for (const occurrence of ledger.observedGraph.observationFailures) {
        retainObservationFailure(occurrence);
      }
    } else if (carrier) {
      session.observed.add(carrier);
    }
    if (!firstVisit) return true;
    for (const occurrence of ledger.events) {
      if (!isObjectLike(occurrence.value)) continue;
      const nested = failureLedger(occurrence.value);
      if (nested && nested !== ledger) retainLedger(nested, occurrence.value, "reuse");
    }
    for (const node of ledger.observedGraph.nodes) {
      const nested = failureLedger(node.value);
      if (nested && nested !== ledger) retainLedger(nested, node.value, "reuse");
    }
    return true;
  };
  session.adoptNestedLedger = (value) => {
    const ledger = failureLedger(value);
    return ledger ? retainLedger(ledger, value, "reuse") : false;
  };

  retainLedger(
    inherited,
    isObjectLike(primary.value) ? primary.value : undefined,
    "refresh"
  );
  retainOccurrence(primary);
  for (const occurrence of later) {
    retainLedger(
      failureLedger(occurrence.value),
      isObjectLike(occurrence.value) ? occurrence.value : undefined,
      "reuse"
    );
    retainOccurrence(occurrence);
  }

  for (const occurrence of occurrenceById.values()) {
    observeFailureGraphValue(occurrence.value, session);
  }
  for (const occurrence of session.observationFailures) retainOccurrence(occurrence);
  const chronologicalEvents = [...occurrenceById.values()].sort(
    (left, right) => left.order - right.order
  );
  const events = [
    semanticPrimary,
    ...chronologicalEvents.filter((occurrence) => occurrence !== semanticPrimary)
  ];
  const orderedDistinct = distinctFailureOccurrences(events);
  const ledger = Object.freeze({
    primary: semanticPrimary,
    events: Object.freeze(events),
    compensations: Object.freeze(events.filter((item) => item !== semanticPrimary)),
    orderedDistinct: Object.freeze(orderedDistinct),
    observedGraph: Object.freeze({
      nodes: Object.freeze(session.nodes),
      observationFailures: Object.freeze(session.observationFailures)
    })
  });

  const primaryObservation = session.nodes.find((node) => node.value === semanticPrimary.value);
  const carrier: object = isObjectLike(semanticPrimary.value) &&
    primaryObservation?.errorBrand !== "non_error"
    ? semanticPrimary.value as object
    : new PreservedNonErrorThrownValue(semanticPrimary.value);
  preservedFailureLedgers.set(carrier, ledger);
  return carrier;
}

export function adoptTrustedFailureRef(
  ref: FailureOccurrence,
  later: readonly FailureOccurrence[],
  aggregateMessage = "A trusted failure and compensating actions failed."
): unknown {
  return mergeTrustedFailureOccurrences(ref, later, aggregateMessage);
}

export function preserveThrownValueAndCompensationErrors(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string,
  additionalObservationFailures: readonly unknown[] = []
): Error {
  const primaryOccurrence = captureFailureOccurrence("body", primary);
  const later = [...additionalObservationFailures, ...compensations].map((value) =>
    captureFailureOccurrence("settlement", value)
  );
  return mergeTrustedFailureOccurrences(primaryOccurrence, later, aggregateMessage) as Error;
}

export function preservePrimaryAndCompensationErrors(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): unknown {
  if (compensations.length === 0) return primary;
  return preserveThrownValueAndCompensationErrors(
    primary,
    compensations,
    aggregateMessage
  );
}

function distinctFailureOccurrences(
  occurrences: readonly FailureOccurrence[]
): FailureOccurrence[] {
  const objects = new WeakSet<object>();
  const distinct: FailureOccurrence[] = [];
  for (const occurrence of occurrences) {
    if (isObjectLike(occurrence.value)) {
      if (objects.has(occurrence.value)) continue;
      objects.add(occurrence.value);
    }
    distinct.push(occurrence);
  }
  return distinct;
}

function observeFailureGraphValue(
  value: unknown,
  session: FailureObservationSession
): void {
  if (!isObjectLike(value)) return;
  const refreshLedgerCarrier = session.refreshLedgerCarriers.has(value);
  if (session.observed.has(value) && !refreshLedgerCarrier) return;
  if (refreshLedgerCarrier) {
    session.refreshLedgerCarriers.delete(value);
    session.observed.delete(value);
    const retainedNodeIndex = session.nodes.findIndex(
      (node) => node.value === value
    );
    if (retainedNodeIndex >= 0) session.nodes.splice(retainedNodeIndex, 1);
  }
  if (
    !refreshLedgerCarrier &&
    session.adoptNestedLedger?.(value)
  ) return;
  session.observed.add(value);

  let errorBrand: FailureGraphNode["errorBrand"];
  try {
    errorBrand = value === session.classifiedPrimary && session.classifyPrimary
      ? session.classifyPrimary(value)
      : value instanceof Error
        ? "error"
        : "non_error";
  } catch (error) {
    errorBrand = "indeterminate";
    session.observationFailures.push(
      captureFailureOccurrence("observation", error)
    );
  }

  const edges: FailureGraphEdge[] = [];
  for (const kind of ["semanticPrimary", "errors", "cause"] as const) {
    const observation = observeOwnGraphField(value, kind);
    session.observationFailures.push(
      ...observation.failures.map((failure) =>
        captureFailureOccurrence("observation", failure)
      )
    );
    if (!observation.present) continue;
    if (kind === "errors") {
      const arrayObservation = safelyObserveArray(observation.value);
      session.observationFailures.push(
        ...arrayObservation.failures.map((failure) =>
          captureFailureOccurrence("observation", failure)
        )
      );
      if (!arrayObservation.isArray) {
        edges.push(Object.freeze({ kind, target: observation.value }));
        continue;
      }
      const lengthObservation = safelyObserveArrayLength(arrayObservation.value);
      session.observationFailures.push(
        ...lengthObservation.failures.map((failure) =>
          captureFailureOccurrence("observation", failure)
        )
      );
      if (lengthObservation.length === undefined) continue;
      const length = lengthObservation.length;
      for (let index = 0; index < length; index += 1) {
        const element = observeArrayElement(arrayObservation.value, index);
        session.observationFailures.push(
          ...element.failures.map((failure) =>
            captureFailureOccurrence("observation", failure)
          )
        );
        if (!element.present) continue;
        edges.push(Object.freeze({ kind, target: element.value, index }));
      }
      continue;
    }
    edges.push(Object.freeze({ kind, target: observation.value }));
  }

  const node = Object.freeze({
    value,
    errorBrand,
    edges: Object.freeze(edges)
  });
  session.nodes.push(node);
  for (const edge of edges) observeFailureGraphValue(edge.target, session);
}

function observeOwnGraphField(
  value: object,
  property: FailureGraphEdge["kind"]
): { readonly present: boolean; readonly value?: unknown; readonly failures: readonly unknown[] } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, property);
  } catch (error) {
    return { present: false, failures: [error] };
  }
  if (!descriptor) return { present: false, failures: [] };
  if ("value" in descriptor) {
    return descriptor.value === undefined
      ? { present: false, failures: [] }
      : { present: true, value: descriptor.value, failures: [] };
  }
  if (!descriptor.get) return { present: false, failures: [] };
  try {
    const observed = descriptor.get.call(value);
    return observed === undefined
      ? { present: false, failures: [] }
      : { present: true, value: observed, failures: [] };
  } catch (error) {
    return { present: false, failures: [error] };
  }
}

function observeArrayElement(
  values: object,
  index: number
): { readonly present: boolean; readonly value?: unknown; readonly failures: readonly unknown[] } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (!descriptor) return { present: false, failures: [] };
    if ("value" in descriptor) {
      return { present: true, value: descriptor.value, failures: [] };
    }
    if (!descriptor.get) return { present: false, failures: [] };
    return { present: true, value: descriptor.get.call(values), failures: [] };
  } catch (error) {
    return { present: false, failures: [error] };
  }
}

function safelyObserveArray(
  value: unknown
):
  | { readonly isArray: true; readonly value: object; readonly failures: readonly unknown[] }
  | { readonly isArray: false; readonly failures: readonly unknown[] } {
  try {
    return Array.isArray(value)
      ? { isArray: true, value, failures: [] }
      : { isArray: false, failures: [] };
  } catch (error) {
    return { isArray: false, failures: [error] };
  }
}

function safelyObserveArrayLength(
  value: object
): { readonly length?: number; readonly failures: readonly unknown[] } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!descriptor || !("value" in descriptor)) return { failures: [] };
    const length = descriptor.value;
    return typeof length === "number" && Number.isSafeInteger(length) && length >= 0
      ? { length, failures: [] }
      : { failures: [] };
  } catch (error) {
    return { failures: [error] };
  }
}

function safelyHasErrorBrand(value: unknown): value is Error {
  if (!isObjectLike(value)) return false;
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
