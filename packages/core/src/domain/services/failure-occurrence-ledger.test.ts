import { describe, expect, test } from "bun:test";
import {
  FAILURE_GRAPH_MAX_EDGES,
  FAILURE_GRAPH_MAX_NODES,
  FailureGraphObservationIssue,
  captureFailureOccurrence,
  failureEvents,
  failureGraphNodes,
  failureLedger,
  mergeTrustedFailureOccurrences,
  orderedDistinctFailures,
  preserveTaskServiceErrorCompensationCompatibility,
  semanticPrimaryValue,
  taskServiceErrorAtBoundary
} from "./index";
import { TaskServiceError } from "./task-card-service";

describe("failure occurrence ledger", () => {
  test("preserves equal primitives and reused Error identities as physical occurrences", () => {
    const shared = new Error("reused physical failure");
    const sharedDescriptors = Object.getOwnPropertyDescriptors(shared);
    const objectLedger = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", shared),
      [captureFailureOccurrence("final_release", shared)],
      "reused identity"
    );

    expect(objectLedger).toBe(shared);
    expect(failureEvents(objectLedger).map(({ phase, value }) => ({ phase, value }))).toEqual([
      { phase: "body", value: shared },
      { phase: "final_release", value: shared }
    ]);
    expect(new Set(failureEvents(objectLedger).map((event) => event.occurrenceId)).size).toBe(2);
    expect(orderedDistinctFailures(objectLedger)).toEqual([shared]);
    expect(Object.getOwnPropertyDescriptors(shared)).toEqual(sharedDescriptors);

    const primitiveLedger = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("initial_release", "same"),
      [captureFailureOccurrence("settlement", "same")],
      "equal primitive"
    );
    expect(semanticPrimaryValue(primitiveLedger)).toBe("same");
    expect(failureEvents(primitiveLedger).map((event) => event.value)).toEqual(["same", "same"]);
    expect(orderedDistinctFailures(primitiveLedger)).toEqual(["same", "same"]);
  });

  test("freshly observes mutable nested causes and accessors on every independent fold", () => {
    const firstCause = new Error("first cause");
    const secondCause = new Error("second cause");
    let currentCause: Error = firstCause;
    let causeReads = 0;
    const primary = new Error("mutable accessor primary");
    Object.defineProperty(primary, "cause", {
      configurable: true,
      get() {
        causeReads += 1;
        return currentCause;
      }
    });
    const first = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", primary),
      [],
      "first fold"
    );
    const inheritedId = failureEvents(first)[0]!.occurrenceId;
    expect(graphEdgeTargets(first, "cause")).toEqual([firstCause]);

    currentCause = secondCause;
    const second = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("settlement", first),
      [],
      "second fold"
    );
    expect(failureEvents(second).filter((event) => event.occurrenceId === inheritedId)).toHaveLength(1);
    expect(graphEdgeTargets(second, "cause")).toEqual([secondCause]);
    expect(failureGraphNodes(second).some((node) => node.value === firstCause)).toBe(false);
    expect(causeReads).toBe(2);
  });

  test("freshly observes a nested Proxy carrier once per fold and terminates cyclic graphs", () => {
    const firstCause = new Error("proxy first cause");
    const secondCause = new Error("proxy second cause");
    let currentCause: Error = firstCause;
    let causeDescriptorReads = 0;
    const target = new Error("proxy ledger carrier");
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(inner, property) {
        if (property === "cause") {
          causeDescriptorReads += 1;
          return { configurable: true, enumerable: false, value: currentCause, writable: true };
        }
        return Reflect.getOwnPropertyDescriptor(inner, property);
      }
    });
    const first = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", proxy),
      [],
      "proxy first fold"
    );
    currentCause = secondCause;
    const second = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("settlement", first),
      [],
      "proxy second fold"
    );
    expect(graphEdgeTargets(second, "cause")).toEqual([secondCause]);
    expect(causeDescriptorReads).toBe(2);

    const left = new Error("cycle left");
    const right = new Error("cycle right");
    left.cause = right;
    right.cause = left;
    const cyclic = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", left),
      [],
      "cyclic fold"
    );
    const cycleNodes = failureGraphNodes(cyclic).filter(
      (node) => node.value === left || node.value === right
    );
    expect(cycleNodes).toHaveLength(2);
    expect(graphEdgeTargets(cyclic, "cause")).toEqual([right, left]);
  });

  test("enforces the node budget exactly at N-1, N, and N+1", () => {
    for (const [count, truncated] of [
      [FAILURE_GRAPH_MAX_NODES - 1, false],
      [FAILURE_GRAPH_MAX_NODES, false],
      [FAILURE_GRAPH_MAX_NODES + 1, true]
    ] as const) {
      const primary = causeChain(count);
      const result = mergeTrustedFailureOccurrences(
        captureFailureOccurrence("body", primary),
        [],
        `node budget ${count}`
      );
      expect(failureGraphNodes(result)).toHaveLength(Math.min(count, FAILURE_GRAPH_MAX_NODES));
      expect(observationIssueCodes(result).includes("node_budget_exceeded")).toBe(truncated);
      expect(semanticPrimaryValue(result)).toBe(primary);
    }
  });

  test("enforces the edge budget exactly at N-1, N, and N+1", () => {
    for (const [count, truncated] of [
      [FAILURE_GRAPH_MAX_EDGES - 1, false],
      [FAILURE_GRAPH_MAX_EDGES, false],
      [FAILURE_GRAPH_MAX_EDGES + 1, true]
    ] as const) {
      const errors = Array.from({ length: count }, (_, index) => index);
      const primary = new AggregateError(errors, `edge budget ${count}`);
      const result = mergeTrustedFailureOccurrences(
        captureFailureOccurrence("body", primary),
        [],
        `edge budget ${count}`
      );
      const edgeCount = failureGraphNodes(result).reduce(
        (total, node) => total + node.edges.length,
        0
      );
      expect(edgeCount).toBe(Math.min(count, FAILURE_GRAPH_MAX_EDGES));
      expect(observationIssueCodes(result).includes("edge_budget_exceeded")).toBe(truncated);
      expect(semanticPrimaryValue(result)).toBe(primary);
    }
  });

  test("enumerates present numeric keys of a maximum-length sparse errors array", () => {
    const low = new Error("low sparse edge");
    const high = new Error("high sparse edge");
    const sparse: unknown[] = [];
    sparse.length = 0xffff_ffff;
    sparse[1] = low;
    sparse[0xffff_fffe] = high;
    const primary = new AggregateError([], "sparse graph");
    Object.defineProperty(primary, "errors", { configurable: true, value: sparse });

    const result = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", primary),
      [],
      "sparse graph"
    );
    const errorsEdges = failureGraphNodes(result)
      .find((node) => node.value === primary)!
      .edges.filter((edge) => edge.kind === "errors");
    expect(errorsEdges.map((edge) => edge.index)).toEqual([1, 0xffff_fffe]);
    expect(errorsEdges.map((edge) => edge.target)).toEqual([low, high]);
    expect(observationIssueCodes(result)).toEqual([]);
  });

  test("bounds a 25K cause chain and records accessor and Proxy failures without RangeError", () => {
    const deep = causeChain(25_001);
    const deepResult = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", deep),
      [],
      "deep graph"
    );
    expect(failureGraphNodes(deepResult)).toHaveLength(FAILURE_GRAPH_MAX_NODES);
    expect(observationIssueCodes(deepResult)).toContain("node_budget_exceeded");
    expect(failureEvents(deepResult).some((event) => event.value instanceof RangeError)).toBe(false);

    const accessorFailure = new Error("cause accessor failed");
    const accessorPrimary = new Error("accessor primary");
    Object.defineProperty(accessorPrimary, "cause", {
      get() {
        throw accessorFailure;
      }
    });
    const accessorResult = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", accessorPrimary),
      [],
      "accessor graph"
    );
    expect(failureLedger(accessorResult)!.observedGraph.observationFailures.map((event) => event.value))
      .toContain(accessorFailure);

    const ownKeysFailure = new Error("errors ownKeys failed");
    const errorsProxy = new Proxy([], {
      ownKeys() {
        throw ownKeysFailure;
      }
    });
    const proxyPrimary = new AggregateError([], "proxy errors");
    Object.defineProperty(proxyPrimary, "errors", { value: errorsProxy });
    const proxyResult = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", proxyPrimary),
      [],
      "proxy graph"
    );
    expect(failureLedger(proxyResult)!.observedGraph.observationFailures.map((event) => event.value))
      .toContain(ownKeysFailure);
    expect(semanticPrimaryValue(proxyResult)).toBe(proxyPrimary);
  });

  test("projects only an exact trusted TaskServiceError primary", () => {
    const primary = taskServiceError("trusted typed primary");
    const compensation = new Error("typed compensation");
    const descriptors = Object.getOwnPropertyDescriptors(primary);
    const result = preserveTaskServiceErrorCompensationCompatibility(
      primary,
      [compensation],
      "typed fold",
      "body",
      ["final_release"]
    );

    expect(result).toBe(primary);
    expect(taskServiceErrorAtBoundary(result)).toBe(primary);
    expect(failureEvents(result).map((event) => event.value)).toEqual([primary, compensation]);
    expect(Object.getOwnPropertyDescriptors(primary)).toEqual(descriptors);
    expect(taskServiceErrorAtBoundary({
      code: primary.code,
      status: primary.status,
      category: primary.category
    })).toBeUndefined();

    const proxyTarget = taskServiceError("one-shot proxy primary");
    let brandReads = 0;
    const proxy = new Proxy(proxyTarget, {
      getPrototypeOf(target) {
        brandReads += 1;
        if (brandReads > 1) throw new Error("TaskServiceError brand read twice");
        return Reflect.getPrototypeOf(target);
      }
    });
    const proxyResult = preserveTaskServiceErrorCompensationCompatibility(
      proxy,
      [new Error("proxy compensation")],
      "proxy typed fold"
    );
    expect(proxyResult).toBe(proxy);
    expect(taskServiceErrorAtBoundary(proxyResult)).toBe(proxy);
    expect(brandReads).toBe(1);
  });


});

function causeChain(count: number): Error {
  if (count < 1) throw new TypeError("count must be positive");
  const root = new Error("cause-0");
  let cursor = root;
  for (let index = 1; index < count; index += 1) {
    const next = new Error(`cause-${index}`);
    cursor.cause = next;
    cursor = next;
  }
  return root;
}

function graphEdgeTargets(
  value: unknown,
  kind: "semanticPrimary" | "errors" | "cause"
): unknown[] {
  return failureGraphNodes(value).flatMap((node) =>
    node.edges.filter((edge) => edge.kind === kind).map((edge) => edge.target)
  );
}

function observationIssueCodes(value: unknown): string[] {
  return failureLedger(value)!.observedGraph.observationFailures.flatMap((event) =>
    event.value instanceof FailureGraphObservationIssue ? [event.value.code] : []
  );
}

function taskServiceError(message: string): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 409,
    category: "workspace_error",
    message,
    userMessage: "The task failure is preserved.",
    evidenceRefs: ["failure-occurrence-ledger.test"],
    retryable: true,
    recommendedNextActions: ["Inspect the failure occurrence ledger."]
  });
}
