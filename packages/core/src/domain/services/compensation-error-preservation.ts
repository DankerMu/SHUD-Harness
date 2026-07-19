export type FailurePhase =
  | "body"
  | "initial_release"
  | "settlement"
  | "final_release"
  | "observation";

export const FAILURE_GRAPH_MAX_NODES = 4096;
export const FAILURE_GRAPH_MAX_EDGES = 8192;

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

export interface FailurePrimaryClassification {
  readonly classify: (value: object) => FailureGraphNode["errorBrand"];
}

export type FailureGraphObservationIssueCode =
  | "node_budget_exceeded"
  | "edge_budget_exceeded";

export class FailureGraphObservationIssue extends Error {
  readonly code: FailureGraphObservationIssueCode;
  readonly limit: number;

  constructor(code: FailureGraphObservationIssueCode, limit: number) {
    super(
      code === "node_budget_exceeded"
        ? `Failure graph observation stopped at the ${limit}-node budget.`
        : `Failure graph observation stopped at the ${limit}-edge budget.`
    );
    this.name = "FailureGraphObservationIssue";
    this.code = code;
    this.limit = limit;
  }
}

export class PreservedNonErrorThrownValue extends Error {
  readonly thrownValue: unknown;

  constructor(thrownValue: unknown) {
    super("A non-Error value was thrown.");
    this.name = "PreservedNonErrorThrownValue";
    this.thrownValue = thrownValue;
  }
}

/**
 * Compatibility carrier for existing generic compensation consumers.
 * The trusted occurrence ledger, not this public graph shape, is authoritative.
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

interface ObservationState {
  readonly nodes: FailureGraphNode[];
  readonly observationFailures: FailureOccurrence[];
  readonly observed: WeakSet<object>;
  readonly queue: unknown[];
  readonly occurrenceById: Map<symbol, FailureOccurrence>;
  readonly visitedLedgers: Set<PreservedFailureLedger>;
  readonly semanticPrimaryValue: unknown;
  readonly classifyPrimary?: (value: object) => FailureGraphNode["errorBrand"];
  queueHead: number;
  edgeCount: number;
  nodeBudgetRecorded: boolean;
  edgeBudgetRecorded: boolean;
}

let nextFailureOccurrenceOrder = 1;
const trustedFailureOccurrences = new WeakSet<object>();
const preservedFailureLedgers = new WeakMap<object, PreservedFailureLedger>();
const preservedFailureSemanticErrors = new WeakMap<object, Error>();

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
  return failureLedger(value)?.primary.value ?? value;
}

export function semanticPrimaryError(value: unknown): Error | undefined {
  if (isObjectLike(value)) {
    const represented = preservedFailureSemanticErrors.get(value);
    if (represented) return represented;
  }
  const ledger = failureLedger(value);
  if (ledger) {
    const primary = ledger.primary.value;
    const node = ledger.observedGraph.nodes.find((candidate) => candidate.value === primary);
    if (node?.errorBrand === "error" || node?.errorBrand === "indeterminate") {
      return primary as Error;
    }
    return value instanceof Error ? value : undefined;
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

export function registerPreservedErrorCompatibility(
  compatibleError: Error,
  preservedError: Error
): void {
  const ledger = failureLedger(preservedError);
  if (ledger) {
    preservedFailureLedgers.set(compatibleError, ledger);
    const semantic = semanticPrimaryError(preservedError);
    if (semantic) preservedFailureSemanticErrors.set(compatibleError, semantic);
  }
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
  const state: ObservationState = {
    nodes: [],
    observationFailures: [],
    observed: new WeakSet<object>(),
    queue: [],
    occurrenceById: new Map<symbol, FailureOccurrence>(),
    visitedLedgers: new Set<PreservedFailureLedger>(),
    semanticPrimaryValue: semanticPrimary.value,
    classifyPrimary: primaryClassification?.classify,
    queueHead: 0,
    edgeCount: 0,
    nodeBudgetRecorded: false,
    edgeBudgetRecorded: false
  };

  adoptLedger(inherited, state);
  retainOccurrence(primary, state, true);
  for (const occurrence of later) retainOccurrence(occurrence, state, true);

  while (state.queueHead < state.queue.length) {
    const value = state.queue[state.queueHead++];
    if (!isObjectLike(value) || state.observed.has(value)) continue;

    adoptLedger(failureLedger(value), state);
    if (state.observed.has(value)) continue;
    if (state.nodes.length >= FAILURE_GRAPH_MAX_NODES) {
      recordBudgetIssue("node_budget_exceeded", FAILURE_GRAPH_MAX_NODES, state);
      continue;
    }

    state.observed.add(value);
    observeNode(value, state);
  }

  const chronological = [...state.occurrenceById.values()].sort(
    (left, right) => left.order - right.order
  );
  const events = Object.freeze([
    semanticPrimary,
    ...chronological.filter((occurrence) => occurrence !== semanticPrimary)
  ]);
  const ledger: PreservedFailureLedger = Object.freeze({
    primary: semanticPrimary,
    events,
    compensations: Object.freeze(events.filter((occurrence) => occurrence !== semanticPrimary)),
    orderedDistinct: Object.freeze(distinctFailureOccurrences(events)),
    observedGraph: Object.freeze({
      nodes: Object.freeze(state.nodes),
      observationFailures: Object.freeze(state.observationFailures)
    })
  });

  const primaryNode = state.nodes.find((node) => node.value === semanticPrimary.value);
  const representedPrimary = !isObjectLike(semanticPrimary.value) ||
    primaryNode?.errorBrand === "non_error";
  const carrier: object = representedPrimary
    ? new PreservedNonErrorThrownValue(semanticPrimary.value)
    : semanticPrimary.value as object;
  preservedFailureLedgers.set(carrier, ledger);
  if (representedPrimary) preservedFailureSemanticErrors.set(carrier, carrier as Error);
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
  return preserveFailureOccurrencesWithCompatibility(
    captureFailureOccurrence("body", primary),
    [...additionalObservationFailures, ...compensations].map((value) =>
      captureFailureOccurrence("settlement", value)
    ),
    aggregateMessage
  );
}

export function preserveFailureOccurrencesWithCompatibility(
  primary: FailureOccurrence,
  later: readonly FailureOccurrence[],
  aggregateMessage: string
): Error {
  const merged = mergeTrustedFailureOccurrences(primary, later, aggregateMessage);
  return merged as Error;
}

export function preservePrimaryAndCompensationErrors(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): unknown {
  if (compensations.length === 0 || !safelyHasErrorBrand(primary)) return primary;
  return preserveThrownValueAndCompensationErrors(primary, compensations, aggregateMessage);
}

function retainOccurrence(
  occurrence: FailureOccurrence,
  state: ObservationState,
  queueValue: boolean
): void {
  if (state.occurrenceById.has(occurrence.occurrenceId)) return;
  state.occurrenceById.set(occurrence.occurrenceId, occurrence);
  if (queueValue) state.queue.push(occurrence.value);
}

function adoptLedger(
  ledger: PreservedFailureLedger | undefined,
  state: ObservationState
): void {
  if (!ledger || state.visitedLedgers.has(ledger)) return;
  state.visitedLedgers.add(ledger);
  for (const occurrence of ledger.events) retainOccurrence(occurrence, state, true);
}

function observeNode(value: object, state: ObservationState): void {
  let errorBrand: FailureGraphNode["errorBrand"];
  try {
    errorBrand = value === state.semanticPrimaryValue && state.classifyPrimary
      ? state.classifyPrimary(value)
      : value instanceof Error
        ? "error"
        : "non_error";
  } catch (error) {
    errorBrand = "indeterminate";
    recordObservationFailure(error, state);
  }

  const edges: FailureGraphEdge[] = [];
  for (const kind of ["semanticPrimary", "errors", "cause"] as const) {
    const field = observeOwnGraphField(value, kind);
    for (const failure of field.failures) recordObservationFailure(failure, state);
    if (!field.present) continue;

    if (kind === "errors") {
      const arrayBrand = safelyObserveArray(field.value);
      for (const failure of arrayBrand.failures) recordObservationFailure(failure, state);
      if (arrayBrand.isArray) {
        observeSparseErrorsArray(arrayBrand.value, edges, state);
        continue;
      }
    }

    addEdge({ kind, target: field.value }, edges, state);
  }

  state.nodes.push(Object.freeze({
    value,
    errorBrand,
    edges: Object.freeze(edges)
  }));
}

function observeSparseErrorsArray(
  values: object,
  edges: FailureGraphEdge[],
  state: ObservationState
): void {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(values);
  } catch (error) {
    recordObservationFailure(error, state);
    return;
  }

  const numericKeys = keys.flatMap((key) => {
    if (typeof key !== "string" || !isCanonicalArrayIndex(key)) return [];
    return [{ key, index: Number(key) }];
  }).sort((left, right) => left.index - right.index);

  for (const { key, index } of numericKeys) {
    const element = observeOwnArrayElement(values, key);
    for (const failure of element.failures) recordObservationFailure(failure, state);
    if (!element.present) continue;
    if (!addEdge({ kind: "errors", target: element.value, index }, edges, state)) return;
  }
}

function addEdge(
  edge: FailureGraphEdge,
  nodeEdges: FailureGraphEdge[],
  state: ObservationState
): boolean {
  if (state.edgeCount >= FAILURE_GRAPH_MAX_EDGES) {
    recordBudgetIssue("edge_budget_exceeded", FAILURE_GRAPH_MAX_EDGES, state);
    return false;
  }
  const frozen = Object.freeze(edge);
  nodeEdges.push(frozen);
  state.edgeCount += 1;
  state.queue.push(edge.target);
  return true;
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

function observeOwnArrayElement(
  values: object,
  key: string
): { readonly present: boolean; readonly value?: unknown; readonly failures: readonly unknown[] } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(values, key);
    if (!descriptor) return { present: false, failures: [] };
    if ("value" in descriptor) return { present: true, value: descriptor.value, failures: [] };
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

function recordObservationFailure(value: unknown, state: ObservationState): void {
  const occurrence = captureFailureOccurrence("observation", value);
  state.observationFailures.push(occurrence);
  retainOccurrence(occurrence, state, false);
}

function recordBudgetIssue(
  code: FailureGraphObservationIssueCode,
  limit: number,
  state: ObservationState
): void {
  if (code === "node_budget_exceeded") {
    if (state.nodeBudgetRecorded) return;
    state.nodeBudgetRecorded = true;
  } else {
    if (state.edgeBudgetRecorded) return;
    state.edgeBudgetRecorded = true;
  }
  recordObservationFailure(Object.freeze(new FailureGraphObservationIssue(code, limit)), state);
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

function isCanonicalArrayIndex(value: string): boolean {
  if (value.length === 0) return false;
  const numeric = Number(value);
  return Number.isInteger(numeric) &&
    numeric >= 0 &&
    numeric < 0xffff_ffff &&
    String(numeric) === value;
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
