export type FailurePhase =
  | "body"
  | "initial_release"
  | "settlement"
  | "final_release"
  | "observation";

export const FAILURE_GRAPH_MAX_NODES = 4096;
export const FAILURE_GRAPH_MAX_EDGES = 8192;
export const FAILURE_GRAPH_MAX_NUMERIC_KEYS = 8192;
export const FAILURE_GRAPH_MAX_CONTROLLED_OPERATIONS = 65_536;
export const FAILURE_GRAPH_MAX_OBSERVATION_FAILURES = 256;

const FAILURE_OCCURRENCE = Symbol("failure_occurrence");
const FAILURE_CARRIER_ADOPTION = Symbol("failure_carrier_adoption");

export interface FailureOccurrence {
  readonly [FAILURE_OCCURRENCE]: true;
  readonly occurrenceId: symbol;
  readonly phase: FailurePhase;
  readonly order: number;
  readonly value: unknown;
}

export interface FailureCarrierAdoption {
  readonly [FAILURE_CARRIER_ADOPTION]: true;
  readonly order: number;
}

export type FailureFoldEntry = FailureOccurrence | FailureCarrierAdoption;

export type FailureOccurrenceProtocolErrorCode =
  | "untrusted_entry"
  | "duplicate_entry"
  | "stale_entry"
  | "reordered_entry"
  | "invalid_phase"
  | "invalid_adoption"
  | "invalid_cardinality";

export class FailureOccurrenceProtocolError extends Error {
  readonly code: FailureOccurrenceProtocolErrorCode;

  constructor(code: FailureOccurrenceProtocolErrorCode) {
    super(`Failure occurrence protocol rejected the fold: ${code}.`);
    this.name = "FailureOccurrenceProtocolError";
    this.code = code;
  }
}

export interface TrustedFailureTransportFamily<T> {
  readonly create: (projection: T) => Error;
  readonly has: (value: unknown) => boolean;
  readonly project: (value: unknown) => T | undefined;
}

export function createTrustedFailureTransportFamily<T>(input: {
  readonly name: string;
  readonly message: string;
}): TrustedFailureTransportFamily<T> {
  const projections = new WeakMap<object, T>();
  class TrustedFailureTransport extends Error {
    constructor(projection: T) {
      super(input.message);
      this.name = input.name;
      projections.set(this, projection);
      Object.freeze(this);
    }
  }
  return Object.freeze({
    create: (projection: T): Error => new TrustedFailureTransport(projection),
    has: (value: unknown): boolean => isObjectLike(value) && projections.has(value),
    project: (value: unknown): T | undefined =>
      isObjectLike(value) ? projections.get(value) : undefined
  });
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
  | "edge_budget_exceeded"
  | "numeric_key_budget_exceeded"
  | "controlled_operation_budget_exceeded"
  | "observation_failure_budget_exceeded";

export class FailureGraphObservationIssue extends Error {
  readonly code: FailureGraphObservationIssueCode;
  readonly limit: number;

  constructor(code: FailureGraphObservationIssueCode, limit: number) {
    const labels: Record<FailureGraphObservationIssueCode, string> = {
      node_budget_exceeded: "node",
      edge_budget_exceeded: "edge",
      numeric_key_budget_exceeded: "numeric-key",
      controlled_operation_budget_exceeded: "controlled-operation",
      observation_failure_budget_exceeded: "observation-failure"
    };
    super(`Failure graph observation stopped at the ${limit}-${labels[code]} budget.`);
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

export type FailureAsyncOutcome<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "not_attempted" }
  | {
      readonly status: "rejected";
      readonly reason: unknown;
      readonly occurrence: FailureFoldEntry;
    };

interface ObservationState {
  readonly nodes: FailureGraphNode[];
  readonly observationFailures: FailureOccurrence[];
  readonly observed: WeakSet<object>;
  readonly queue: unknown[];
  readonly occurrenceById: Map<symbol, FailureOccurrence>;
  readonly visitedLedgers: Set<PreservedFailureLedger>;
  readonly errorsContainerOutcomes: WeakMap<object, ErrorsContainerOutcome>;
  readonly semanticPrimaryValue: unknown;
  classifiedPrimaryBrand?: FailureGraphNode["errorBrand"];
  queueHead: number;
  edgeCount: number;
  controlledOperationCount: number;
  ordinaryObservationFailureCount: number;
  nodeBudgetRecorded: boolean;
  edgeBudgetRecorded: boolean;
  numericKeyBudgetRecorded: boolean;
  controlledOperationBudgetRecorded: boolean;
  observationFailureBudgetRecorded: boolean;
}

interface ErrorsContainerElementSnapshot {
  readonly index: number;
  readonly value: unknown;
}

interface ErrorsContainerSnapshot {
  readonly elements: readonly ErrorsContainerElementSnapshot[];
  readonly overflowWitnessPresent: boolean;
}

type ErrorsContainerOutcome =
  | { readonly status: "array"; readonly snapshot: ErrorsContainerSnapshot }
  | { readonly status: "non_array" }
  | { readonly status: "failed" };

let nextFailureOccurrenceOrder = 1;
const trustedFailureOccurrences = new WeakSet<object>();
const claimedFailureOccurrences = new WeakSet<object>();
interface FailureCarrierAdoptionState {
  readonly ledger: PreservedFailureLedger;
  readonly occurrence: FailureOccurrence;
}
const trustedFailureCarrierAdoptions = new WeakMap<object, FailureCarrierAdoptionState>();
const claimedFailureCarrierAdoptions = new WeakSet<object>();
const preservedFailureLedgers = new WeakMap<object, PreservedFailureLedger>();
const preservedSemanticPrimaryErrors = new WeakMap<object, Error>();

class PreservedFailureCarrier extends Error {
  readonly semanticPrimary: unknown;
  readonly errors: readonly unknown[];

  constructor(
    message: string,
    semanticPrimary: unknown,
    compensations: readonly unknown[]
  ) {
    super(message);
    this.name = "PreservedFailureCarrier";
    this.semanticPrimary = semanticPrimary;
    this.errors = Object.freeze([...compensations]);
  }
}

export async function runWithPreservedRelease<T>(
  body: () => Promise<T>,
  release: () => Promise<void>,
  aggregateMessage: string,
  settleFulfilledValueAfterReleaseFailure?: (
    fulfilledValue: T,
    releaseReason: unknown
  ) => Promise<void>,
  preserveCombinedFailure: (
    primary: FailureFoldEntry,
    compensations: readonly FailureFoldEntry[],
    aggregateMessage: string
  ) => unknown = preserveFailureOccurrencesWithCompatibility
): Promise<T> {
  let bodyOutcome: FailureAsyncOutcome<T>;
  try {
    bodyOutcome = { status: "fulfilled", value: await body() };
  } catch (reason) {
    bodyOutcome = {
      status: "rejected",
      reason,
      occurrence: captureFailureFoldEntry("body", reason)
    };
  }

  let releaseOutcome: FailureAsyncOutcome<void>;
  try {
    releaseOutcome = { status: "fulfilled", value: await release() };
  } catch (reason) {
    const phase = bodyOutcome.status === "rejected" ? "final_release" : "initial_release";
    releaseOutcome = {
      status: "rejected",
      reason,
      occurrence: captureFailureFoldEntry(phase, reason)
    };
  }

  if (bodyOutcome.status === "rejected") {
    if (releaseOutcome.status === "rejected") {
      throw preserveCombinedFailure(
        bodyOutcome.occurrence,
        [releaseOutcome.occurrence],
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
        const settlementOccurrence = captureFailureFoldEntry(
          "settlement",
          settlementReason
        );
        throw preserveCombinedFailure(
          releaseOutcome.occurrence,
          [settlementOccurrence],
          aggregateMessage
        );
      }
    }
    throw preserveCombinedFailure(
      releaseOutcome.occurrence,
      [],
      aggregateMessage
    );
  }
  return bodyOutcome.value;
}

export function captureFailureOccurrence(
  phase: FailurePhase,
  value: unknown
): FailureOccurrence {
  if (!isFailurePhase(phase)) {
    throw new FailureOccurrenceProtocolError("invalid_phase");
  }
  return mintFailureOccurrence(phase, value);
}

function mintFailureOccurrence(
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

export function captureFailureFoldEntry(
  phase: FailurePhase,
  value: unknown
): FailureFoldEntry {
  return failureLedger(value)
    ? adoptFailureCarrier(phase, value)
    : captureFailureOccurrence(phase, value);
}

export function adoptFailureCarrier(
  phase: FailurePhase,
  carrier: unknown
): FailureCarrierAdoption {
  if (!isFailurePhase(phase)) {
    throw new FailureOccurrenceProtocolError("invalid_phase");
  }
  if (!isObjectLike(carrier)) {
    throw new FailureOccurrenceProtocolError("invalid_adoption");
  }
  const ledger = preservedFailureLedgers.get(carrier);
  if (!ledger) throw new FailureOccurrenceProtocolError("invalid_adoption");
  const occurrence = mintFailureOccurrence(phase, carrier);
  const adoption = Object.freeze({
    [FAILURE_CARRIER_ADOPTION]: true as const,
    order: occurrence.order
  });
  trustedFailureCarrierAdoptions.set(adoption, { ledger, occurrence });
  return adoption;
}

export function isTrustedFailureOccurrence(
  value: unknown
): value is FailureOccurrence {
  return isObjectLike(value) && trustedFailureOccurrences.has(value);
}

export function failureFoldEntryValue(entry: FailureFoldEntry): unknown {
  if (!isObjectLike(entry)) {
    throw new FailureOccurrenceProtocolError("untrusted_entry");
  }
  const adoption = trustedFailureCarrierAdoptions.get(entry);
  if (adoption) return adoption.occurrence.value;
  if (trustedFailureOccurrences.has(entry)) {
    return (entry as FailureOccurrence).value;
  }
  throw new FailureOccurrenceProtocolError("untrusted_entry");
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
    return isObjectLike(value) ? preservedSemanticPrimaryErrors.get(value) : undefined;
  }
  return boundedErrorBrand(value) === "error" ? value as Error : undefined;
}

export function failureGraphNodes(value: unknown): readonly FailureGraphNode[] {
  return failureLedger(value)?.observedGraph.nodes ?? [];
}

export function failureEvents(value: unknown): readonly FailureOccurrence[] {
  return failureLedger(value)?.events ?? [];
}

export function failureTerminalPhysicalPhase(
  value: unknown
): Exclude<FailurePhase, "observation"> | undefined {
  const ledger = failureLedger(value);
  return ledger ? terminalPhysicalPhase(ledger) : undefined;
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
    .filter(
      (occurrence) =>
        occurrence !== ledger.primary &&
        !(
          isObjectLike(ledger.primary.value) &&
          Object.is(occurrence.value, ledger.primary.value)
        )
    )
    .map((occurrence) => occurrence.value);
}

export function mergeTrustedFailureOccurrences(
  primary: FailureFoldEntry,
  later: readonly FailureFoldEntry[],
  _aggregateMessage: string,
  primaryClassification?: FailurePrimaryClassification
): unknown {
  return mergeTrustedFailureOccurrenceVector(
    primary,
    [primary, ...later],
    _aggregateMessage,
    primaryClassification
  );
}

export function mergeTrustedFailureOccurrenceVector(
  primary: FailureFoldEntry,
  entries: readonly FailureFoldEntry[],
  _aggregateMessage: string,
  primaryClassification?: FailurePrimaryClassification
): unknown {
  const entrySnapshot = Object.freeze(Array.from(entries));
  if (!entrySnapshot.includes(primary)) {
    throw new FailureOccurrenceProtocolError("invalid_cardinality");
  }
  const primaryAdoption = trustedFailureCarrierAdoptions.get(primary as object);
  const directPrimary = trustedFailureOccurrences.has(primary as object)
    ? primary as FailureOccurrence
    : undefined;
  if (!primaryAdoption && !directPrimary) {
    preflightFailureFoldEntries(entrySnapshot);
    throw new FailureOccurrenceProtocolError("untrusted_entry");
  }
  const semanticPrimary = primaryAdoption?.ledger.primary ?? directPrimary!;
  // Validate the frozen token vector before invoking the optional classifier,
  // then repeat the same validation after it returns so reentrant claims or
  // state changes cannot cross the final claim boundary unnoticed.
  preflightFailureFoldEntries(entrySnapshot);
  const classifyPrimary = primaryClassification?.classify;
  let classifiedPrimaryBrand: FailureGraphNode["errorBrand"] | undefined;
  if (classifyPrimary !== undefined) {
    if (typeof classifyPrimary !== "function") {
      throw new FailureOccurrenceProtocolError("untrusted_entry");
    }
    if (isObjectLike(semanticPrimary.value)) {
      classifiedPrimaryBrand = classifyPrimary(semanticPrimary.value);
      if (
        classifiedPrimaryBrand !== "error" &&
        classifiedPrimaryBrand !== "non_error" &&
        classifiedPrimaryBrand !== "indeterminate"
      ) {
        throw new FailureOccurrenceProtocolError("untrusted_entry");
      }
    }
  }
  // No caller-controlled reads or calls occur between this final validation
  // and claim. Preflight, claim, and fold all consume the same frozen snapshot.
  preflightFailureFoldEntries(entrySnapshot);
  claimFailureFoldEntries(entrySnapshot);

  const state: ObservationState = {
    nodes: [],
    observationFailures: [],
    observed: new WeakSet<object>(),
    queue: [],
    occurrenceById: new Map<symbol, FailureOccurrence>(),
    visitedLedgers: new Set<PreservedFailureLedger>(),
    errorsContainerOutcomes: new WeakMap<object, ErrorsContainerOutcome>(),
    semanticPrimaryValue: semanticPrimary.value,
    classifiedPrimaryBrand,
    queueHead: 0,
    edgeCount: 0,
    controlledOperationCount: classifiedPrimaryBrand === undefined ? 0 : 1,
    ordinaryObservationFailureCount: 0,
    nodeBudgetRecorded: false,
    edgeBudgetRecorded: false,
    numericKeyBudgetRecorded: false,
    controlledOperationBudgetRecorded: false,
    observationFailureBudgetRecorded: false
  };

  if (isObjectLike(semanticPrimary.value) && state.classifiedPrimaryBrand === undefined) {
    state.classifiedPrimaryBrand = observeErrorBrand(semanticPrimary.value, state);
  }

  for (const entry of entrySnapshot) adoptOrRetainEntry(entry, state);

  while (state.queueHead < state.queue.length) {
    const value = state.queue[state.queueHead++];
    if (!isObjectLike(value) || state.observed.has(value)) continue;

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
  const events = Object.freeze(chronological);
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

  const carrier = new PreservedFailureCarrier(
    _aggregateMessage,
    semanticPrimary.value,
    ledger.compensations.map((occurrence) => occurrence.value)
  );
  preservedFailureLedgers.set(carrier, ledger);
  if (
    isObjectLike(semanticPrimary.value) &&
    (state.classifiedPrimaryBrand === "error" ||
      state.classifiedPrimaryBrand === "indeterminate")
  ) {
    preservedSemanticPrimaryErrors.set(carrier, semanticPrimary.value as Error);
  }
  return Object.freeze(carrier);
}

export function adoptTrustedFailureRef(
  ref: FailureFoldEntry,
  later: readonly FailureFoldEntry[],
  aggregateMessage = "A trusted failure and compensating actions failed."
): unknown {
  return mergeTrustedFailureOccurrences(ref, later, aggregateMessage);
}

export function preserveThrownValueAndCompensationErrors(
  primary: FailureFoldEntry,
  compensations: readonly FailureFoldEntry[],
  aggregateMessage: string
): Error {
  return preserveFailureOccurrencesWithCompatibility(
    primary,
    compensations,
    aggregateMessage
  );
}

export function preserveFailureOccurrencesWithCompatibility(
  primary: FailureFoldEntry,
  later: readonly FailureFoldEntry[],
  aggregateMessage: string
): Error {
  const merged = mergeTrustedFailureOccurrences(primary, later, aggregateMessage);
  return merged as Error;
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

function adoptOrRetainEntry(
  entry: FailureFoldEntry,
  state: ObservationState
): void {
  const adopted = trustedFailureCarrierAdoptions.get(entry as object);
  if (!adopted) {
    retainOccurrence(entry as FailureOccurrence, state, true);
    return;
  }
  adoptLedger(adopted.ledger, state);
  retainOccurrence(adopted.occurrence, state, true);
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
  const errorBrand = value === state.semanticPrimaryValue && state.classifiedPrimaryBrand
    ? state.classifiedPrimaryBrand
    : observeErrorBrand(value, state);

  const edges: FailureGraphEdge[] = [];
  for (const kind of ["semanticPrimary", "errors", "cause"] as const) {
    const field = observeOwnGraphField(value, kind, state);
    for (const failure of field.failures) recordObservationFailure(failure, state);
    if (!field.present) continue;

    if (kind === "errors") {
      const container = observeErrorsContainer(field.value, state);
      if (container.status === "failed") continue;
      if (container.status === "array") {
        replayErrorsContainerSnapshot(container.snapshot, edges, state);
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

function observeErrorsContainer(
  value: unknown,
  state: ObservationState
): ErrorsContainerOutcome {
  if (isObjectLike(value)) {
    const cached = state.errorsContainerOutcomes.get(value);
    if (cached) return cached;
  }

  const arrayBrand = safelyObserveArray(value, state);
  for (const failure of arrayBrand.failures) {
    recordObservationFailure(failure, state);
  }
  const outcome: ErrorsContainerOutcome = arrayBrand.status === "array"
    ? Object.freeze({
      status: "array",
      snapshot: inspectSparseErrorsArray(arrayBrand.value, state)
    })
    : Object.freeze({ status: arrayBrand.status });
  if (isObjectLike(value)) state.errorsContainerOutcomes.set(value, outcome);
  return outcome;
}

function replayErrorsContainerSnapshot(
  snapshot: ErrorsContainerSnapshot,
  edges: FailureGraphEdge[],
  state: ObservationState
): void {
  for (const element of snapshot.elements) {
    if (!addEdge({
      kind: "errors",
      target: element.value,
      index: element.index
    }, edges, state)) return;
  }
  if (
    snapshot.overflowWitnessPresent &&
    state.edgeCount >= FAILURE_GRAPH_MAX_EDGES
  ) {
    recordBudgetIssue("edge_budget_exceeded", FAILURE_GRAPH_MAX_EDGES, state);
  }
}

function inspectSparseErrorsArray(
  values: object,
  state: ObservationState
): ErrorsContainerSnapshot {
  let keys: (string | symbol)[];
  if (!chargeControlledOperation(state)) return emptyErrorsContainerSnapshot();
  try {
    keys = Reflect.ownKeys(values);
  } catch (error) {
    recordObservationFailure(error, state);
    return emptyErrorsContainerSnapshot();
  }

  type NumericKey = { readonly key: string; readonly index: number };
  const numericKeys: NumericKey[] = [];
  let numericOverflow: NumericKey | undefined;
  for (const key of keys) {
    if (!chargeControlledOperation(state)) break;
    if (typeof key === "string" && isCanonicalArrayIndex(key)) {
      const candidate = { key, index: Number(key) };
      if (numericKeys.length < FAILURE_GRAPH_MAX_NUMERIC_KEYS) {
        numericKeys.push(candidate);
      } else {
        numericOverflow = candidate;
        recordBudgetIssue(
          "numeric_key_budget_exceeded",
          FAILURE_GRAPH_MAX_NUMERIC_KEYS,
          state
        );
        break;
      }
    }
  }
  numericKeys.sort((left, right) => left.index - right.index);

  const elements: ErrorsContainerElementSnapshot[] = [];
  for (const { key, index } of numericKeys) {
    const element = observeOwnArrayElement(values, key, state);
    for (const failure of element.failures) recordObservationFailure(failure, state);
    if (element.present) {
      elements.push(Object.freeze({ index, value: element.value }));
    }
  }
  let overflowWitnessPresent = false;
  if (numericOverflow) {
    const overflowElement = observeOwnArrayElement(
      values,
      numericOverflow.key,
      state
    );
    for (const failure of overflowElement.failures) {
      recordObservationFailure(failure, state);
    }
    overflowWitnessPresent = overflowElement.present;
  }
  return Object.freeze({
    elements: Object.freeze(elements),
    overflowWitnessPresent
  });
}

function emptyErrorsContainerSnapshot(): ErrorsContainerSnapshot {
  return Object.freeze({
    elements: Object.freeze([]),
    overflowWitnessPresent: false
  });
}

function preflightFailureFoldEntries(entries: readonly FailureFoldEntry[]): void {
  if (entries.length === 0) {
    throw new FailureOccurrenceProtocolError("invalid_cardinality");
  }
  const seen = new Set<object>();
  let previousEntryOrder = -1;
  let finalReleaseSeen = false;
  for (const [index, entry] of entries.entries()) {
    if (!isObjectLike(entry)) {
      throw new FailureOccurrenceProtocolError("untrusted_entry");
    }
    if (seen.has(entry)) throw new FailureOccurrenceProtocolError("duplicate_entry");
    seen.add(entry);
    if (trustedFailureOccurrences.has(entry)) {
      const occurrence = entry as FailureOccurrence;
      if (!isFailurePhase(occurrence.phase)) {
        throw new FailureOccurrenceProtocolError("invalid_phase");
      }
      if (claimedFailureOccurrences.has(entry)) {
        throw new FailureOccurrenceProtocolError("stale_entry");
      }
      if (occurrence.order <= previousEntryOrder) {
        throw new FailureOccurrenceProtocolError("reordered_entry");
      }
      assertFailurePhaseRole(occurrence.phase, index, finalReleaseSeen);
      if (occurrence.phase === "final_release") finalReleaseSeen = true;
      previousEntryOrder = occurrence.order;
      continue;
    }
    if (trustedFailureCarrierAdoptions.has(entry)) {
      if (claimedFailureCarrierAdoptions.has(entry)) {
        throw new FailureOccurrenceProtocolError("stale_entry");
      }
      const adoption = trustedFailureCarrierAdoptions.get(entry)!;
      if (claimedFailureOccurrences.has(adoption.occurrence)) {
        throw new FailureOccurrenceProtocolError("stale_entry");
      }
      if (adoption.occurrence.order <= previousEntryOrder) {
        throw new FailureOccurrenceProtocolError("reordered_entry");
      }
      assertFailurePhaseRole(adoption.occurrence.phase, index, finalReleaseSeen);
      if (adoption.occurrence.phase === "final_release") finalReleaseSeen = true;
      previousEntryOrder = adoption.occurrence.order;
      continue;
    }
    throw new FailureOccurrenceProtocolError("untrusted_entry");
  }
  assertCombinedTerminalPhaseGrammar(entries);
}

function assertCombinedTerminalPhaseGrammar(
  entries: readonly FailureFoldEntry[]
): void {
  for (const entry of entries) {
    const adoption = trustedFailureCarrierAdoptions.get(entry as object);
    if (
      adoption &&
      terminalPhysicalPhase(adoption.ledger) === "final_release" &&
      adoption.occurrence.phase === "settlement"
    ) {
      throw new FailureOccurrenceProtocolError("invalid_phase");
    }
  }
}

function terminalPhysicalPhase(
  ledger: PreservedFailureLedger
): Exclude<FailurePhase, "observation"> | undefined {
  for (let index = ledger.events.length - 1; index >= 0; index -= 1) {
    const phase = ledger.events[index]!.phase;
    if (phase !== "observation") return phase;
  }
  return undefined;
}

function claimFailureFoldEntries(entries: readonly FailureFoldEntry[]): void {
  for (const entry of entries) {
    if (trustedFailureOccurrences.has(entry as object)) {
      claimedFailureOccurrences.add(entry as object);
    } else {
      claimedFailureCarrierAdoptions.add(entry as object);
      claimedFailureOccurrences.add(
        trustedFailureCarrierAdoptions.get(entry as object)!.occurrence
      );
    }
  }
}

function assertFailurePhaseRole(
  phase: FailurePhase,
  index: number,
  finalReleaseSeen: boolean
): void {
  if (
    phase === "observation" ||
    (index > 0 && (phase === "body" || phase === "initial_release")) ||
    (finalReleaseSeen && phase !== "final_release")
  ) {
    throw new FailureOccurrenceProtocolError("invalid_phase");
  }
}

function isFailurePhase(value: unknown): value is FailurePhase {
  return value === "body" ||
    value === "initial_release" ||
    value === "settlement" ||
    value === "final_release" ||
    value === "observation";
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
  property: FailureGraphEdge["kind"],
  state: ObservationState
): { readonly present: boolean; readonly value?: unknown; readonly failures: readonly unknown[] } {
  if (!chargeControlledOperation(state)) return { present: false, failures: [] };
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
  if (!chargeControlledOperation(state)) return { present: false, failures: [] };
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
  key: string,
  state: ObservationState
): { readonly present: boolean; readonly value?: unknown; readonly failures: readonly unknown[] } {
  if (!chargeControlledOperation(state)) return { present: false, failures: [] };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(values, key);
    if (!descriptor) return { present: false, failures: [] };
    if ("value" in descriptor) return { present: true, value: descriptor.value, failures: [] };
    if (!descriptor.get) return { present: false, failures: [] };
    if (!chargeControlledOperation(state)) return { present: false, failures: [] };
    return { present: true, value: descriptor.get.call(values), failures: [] };
  } catch (error) {
    return { present: false, failures: [error] };
  }
}

function safelyObserveArray(
  value: unknown,
  state: ObservationState
):
  | { readonly status: "array"; readonly value: object; readonly failures: readonly unknown[] }
  | { readonly status: "non_array"; readonly failures: readonly unknown[] }
  | { readonly status: "failed"; readonly failures: readonly unknown[] } {
  if (!chargeControlledOperation(state)) return { status: "failed", failures: [] };
  try {
    return Array.isArray(value)
      ? { status: "array", value, failures: [] }
      : { status: "non_array", failures: [] };
  } catch (error) {
    return { status: "failed", failures: [error] };
  }
}

function recordObservationFailure(value: unknown, state: ObservationState): void {
  if (state.ordinaryObservationFailureCount >= FAILURE_GRAPH_MAX_OBSERVATION_FAILURES) {
    recordBudgetIssue(
      "observation_failure_budget_exceeded",
      FAILURE_GRAPH_MAX_OBSERVATION_FAILURES,
      state
    );
    return;
  }
  state.ordinaryObservationFailureCount += 1;
  const occurrence = mintFailureOccurrence("observation", value);
  claimedFailureOccurrences.add(occurrence);
  state.observationFailures.push(occurrence);
  retainOccurrence(occurrence, state, false);
}

function recordBudgetIssue(
  code: FailureGraphObservationIssueCode,
  limit: number,
  state: ObservationState
): void {
  switch (code) {
    case "node_budget_exceeded":
      if (state.nodeBudgetRecorded) return;
      state.nodeBudgetRecorded = true;
      break;
    case "edge_budget_exceeded":
      if (state.edgeBudgetRecorded) return;
      state.edgeBudgetRecorded = true;
      break;
    case "numeric_key_budget_exceeded":
      if (state.numericKeyBudgetRecorded) return;
      state.numericKeyBudgetRecorded = true;
      break;
    case "controlled_operation_budget_exceeded":
      if (state.controlledOperationBudgetRecorded) return;
      state.controlledOperationBudgetRecorded = true;
      break;
    case "observation_failure_budget_exceeded":
      if (state.observationFailureBudgetRecorded) return;
      state.observationFailureBudgetRecorded = true;
      break;
  }
  const occurrence = mintFailureOccurrence(
    "observation",
    Object.freeze(new FailureGraphObservationIssue(code, limit))
  );
  claimedFailureOccurrences.add(occurrence);
  state.observationFailures.push(occurrence);
  retainOccurrence(occurrence, state, false);
}

function chargeControlledOperation(state: ObservationState): boolean {
  if (state.controlledOperationCount >= FAILURE_GRAPH_MAX_CONTROLLED_OPERATIONS) {
    recordBudgetIssue(
      "controlled_operation_budget_exceeded",
      FAILURE_GRAPH_MAX_CONTROLLED_OPERATIONS,
      state
    );
    return false;
  }
  state.controlledOperationCount += 1;
  return true;
}

function observeErrorBrand(
  value: object,
  state: ObservationState
): FailureGraphNode["errorBrand"] {
  const seen = new WeakSet<object>();
  let cursor: object | null = value;
  while (cursor !== null) {
    if (seen.has(cursor)) return "indeterminate";
    seen.add(cursor);
    if (cursor === Error.prototype) return "error";
    if (!chargeControlledOperation(state)) return "indeterminate";
    try {
      cursor = Object.getPrototypeOf(cursor) as object | null;
    } catch (error) {
      recordObservationFailure(error, state);
      return "indeterminate";
    }
  }
  return "non_error";
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

function boundedErrorBrand(value: unknown): FailureGraphNode["errorBrand"] {
  if (!isObjectLike(value)) return "non_error";
  const seen = new WeakSet<object>();
  let cursor: object | null = value;
  for (let count = 0; cursor !== null && count < 256; count += 1) {
    if (seen.has(cursor)) return "indeterminate";
    seen.add(cursor);
    if (cursor === Error.prototype) return "error";
    try {
      cursor = Object.getPrototypeOf(cursor) as object | null;
    } catch {
      return "indeterminate";
    }
  }
  return cursor === null ? "non_error" : "indeterminate";
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
