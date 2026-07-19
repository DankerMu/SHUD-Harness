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

type AsyncOutcome<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | {
      readonly status: "rejected";
      readonly reason: unknown;
      readonly occurrence: FailureOccurrence;
    };

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
  controlledOperationCount: number;
  ordinaryObservationFailureCount: number;
  nodeBudgetRecorded: boolean;
  edgeBudgetRecorded: boolean;
  numericKeyBudgetRecorded: boolean;
  controlledOperationBudgetRecorded: boolean;
  observationFailureBudgetRecorded: boolean;
}

let nextFailureOccurrenceOrder = 1;
const trustedFailureOccurrences = new WeakSet<object>();
const preservedFailureLedgers = new WeakMap<object, PreservedFailureLedger>();

class PreservedFailureCarrier extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreservedFailureCarrier";
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
    primary: unknown,
    compensations: readonly unknown[],
    aggregateMessage: string,
    primaryPhase?: FailurePhase,
    compensationPhases?: readonly FailurePhase[],
    primaryOccurrence?: FailureOccurrence,
    compensationOccurrences?: readonly FailureOccurrence[]
  ) => unknown = (
    primary,
    compensations,
    message,
    primaryPhase,
    compensationPhases,
    primaryOccurrence,
    compensationOccurrences
  ) =>
    preserveThrownValueAndCompensationErrors(
      primary,
      compensations,
      message,
      [],
      primaryPhase,
      compensationPhases,
      primaryOccurrence,
      compensationOccurrences
    )
): Promise<T> {
  let bodyOutcome: AsyncOutcome<T>;
  try {
    bodyOutcome = { status: "fulfilled", value: await body() };
  } catch (reason) {
    bodyOutcome = {
      status: "rejected",
      reason,
      occurrence: captureFailureOccurrence("body", reason)
    };
  }

  let releaseOutcome: AsyncOutcome<void>;
  try {
    releaseOutcome = { status: "fulfilled", value: await release() };
  } catch (reason) {
    const phase = bodyOutcome.status === "rejected" ? "final_release" : "initial_release";
    releaseOutcome = {
      status: "rejected",
      reason,
      occurrence: captureFailureOccurrence(phase, reason)
    };
  }

  if (bodyOutcome.status === "rejected") {
    if (releaseOutcome.status === "rejected") {
      throw preserveCombinedFailure(
        bodyOutcome.reason,
        [releaseOutcome.reason],
        aggregateMessage,
        "body",
        ["final_release"],
        bodyOutcome.occurrence,
        [releaseOutcome.occurrence]
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
        const settlementOccurrence = captureFailureOccurrence(
          "settlement",
          settlementReason
        );
        throw preserveCombinedFailure(
          releaseOutcome.reason,
          [settlementReason],
          aggregateMessage,
          "initial_release",
          ["settlement"],
          releaseOutcome.occurrence,
          [settlementOccurrence]
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
    const node = ledger.observedGraph.nodes.find((candidate) => candidate.value === primary);
    if (node?.errorBrand === "error" || node?.errorBrand === "indeterminate") {
      return primary as Error;
    }
    return undefined;
  }
  return boundedErrorBrand(value) === "error" ? value as Error : undefined;
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
    controlledOperationCount: 0,
    ordinaryObservationFailureCount: 0,
    nodeBudgetRecorded: false,
    edgeBudgetRecorded: false,
    numericKeyBudgetRecorded: false,
    controlledOperationBudgetRecorded: false,
    observationFailureBudgetRecorded: false
  };

  if (inherited) {
    adoptLedger(inherited, state);
    state.queue.push(primary.value);
  } else {
    retainOccurrence(primary, state, true);
  }
  for (const occurrence of later) adoptOrRetainOccurrence(occurrence, state);

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

  const carrier = new PreservedFailureCarrier(_aggregateMessage);
  preservedFailureLedgers.set(carrier, ledger);
  return Object.freeze(carrier);
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
  additionalObservationFailures: readonly unknown[] = [],
  primaryPhase: FailurePhase = "body",
  compensationPhases: readonly FailurePhase[] = compensations.map(() => "settlement"),
  primaryOccurrence?: FailureOccurrence,
  compensationOccurrences?: readonly FailureOccurrence[]
): Error {
  return preserveFailureOccurrencesWithCompatibility(
    primaryOccurrence ?? captureFailureOccurrence(primaryPhase, primary),
    [
      ...additionalObservationFailures.map((value) =>
        captureFailureOccurrence("observation", value)
      ),
      ...compensations.map((value, index) =>
        compensationOccurrences?.[index] ??
          captureFailureOccurrence(compensationPhases[index] ?? "settlement", value)
      )
    ],
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
  if (compensations.length === 0 || boundedErrorBrand(primary) !== "error") return primary;
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

function adoptOrRetainOccurrence(
  occurrence: FailureOccurrence,
  state: ObservationState
): void {
  const inherited = failureLedger(occurrence.value);
  if (!inherited) {
    retainOccurrence(occurrence, state, true);
    return;
  }
  adoptLedger(inherited, state);
  state.queue.push(occurrence.value);
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
  const errorBrand = value === state.semanticPrimaryValue && state.classifyPrimary
    ? observePrimaryClassification(value, state)
    : observeErrorBrand(value, state);

  const edges: FailureGraphEdge[] = [];
  for (const kind of ["semanticPrimary", "errors", "cause"] as const) {
    const field = observeOwnGraphField(value, kind, state);
    for (const failure of field.failures) recordObservationFailure(failure, state);
    if (!field.present) continue;

    if (kind === "errors") {
      const arrayBrand = safelyObserveArray(field.value, state);
      for (const failure of arrayBrand.failures) recordObservationFailure(failure, state);
      if (arrayBrand.status === "failed") continue;
      if (arrayBrand.status === "array") {
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
  if (!chargeControlledOperation(state)) return;
  try {
    keys = Reflect.ownKeys(values);
  } catch (error) {
    recordObservationFailure(error, state);
    return;
  }

  const numericKeys: Array<{ readonly key: string; readonly index: number }> = [];
  const inspected = Math.min(keys.length, FAILURE_GRAPH_MAX_NUMERIC_KEYS);
  for (let position = 0; position < inspected; position += 1) {
    if (!chargeControlledOperation(state)) return;
    const key = keys[position];
    if (typeof key === "string" && isCanonicalArrayIndex(key)) {
      numericKeys.push({ key, index: Number(key) });
    }
  }
  numericKeys.sort((left, right) => left.index - right.index);

  for (const { key, index } of numericKeys) {
    const element = observeOwnArrayElement(values, key, state);
    for (const failure of element.failures) recordObservationFailure(failure, state);
    if (!element.present) continue;
    if (!addEdge({ kind: "errors", target: element.value, index }, edges, state)) return;
  }
  if (keys.length > FAILURE_GRAPH_MAX_NUMERIC_KEYS + 1) {
    if (state.edgeCount >= FAILURE_GRAPH_MAX_EDGES) {
      recordBudgetIssue("edge_budget_exceeded", FAILURE_GRAPH_MAX_EDGES, state);
    } else {
      recordBudgetIssue(
        "numeric_key_budget_exceeded",
        FAILURE_GRAPH_MAX_NUMERIC_KEYS,
        state
      );
    }
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
  const occurrence = captureFailureOccurrence("observation", value);
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
  const occurrence = captureFailureOccurrence(
    "observation",
    Object.freeze(new FailureGraphObservationIssue(code, limit))
  );
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

function observePrimaryClassification(
  value: object,
  state: ObservationState
): FailureGraphNode["errorBrand"] {
  if (!chargeControlledOperation(state)) return "indeterminate";
  try {
    return state.classifyPrimary!(value);
  } catch (error) {
    recordObservationFailure(error, state);
    return "indeterminate";
  }
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
