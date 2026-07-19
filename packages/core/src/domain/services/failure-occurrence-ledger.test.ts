import { describe, expect, test } from "bun:test";
import {
  FAILURE_GRAPH_MAX_EDGES,
  FAILURE_GRAPH_MAX_NODES,
  FailureGraphObservationIssue,
  captureFailureOccurrence,
  createTrustedTaskServiceErrorProxy,
  failureEvents,
  failureGraphNodes,
  failureLedger,
  mergeTrustedFailureOccurrences,
  orderedDistinctFailures,
  preserveTaskServiceErrorCompensationCompatibility,
  semanticPrimaryValue,
  taskServiceErrorAtBoundary
} from "./index";
import { runWithPreservedRelease } from "./compensation-error-preservation";
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

    expect(objectLedger).not.toBe(shared);
    expect(objectLedger).toBeInstanceOf(Error);
    expect(failureLedger(shared)).toBeUndefined();
    expect(semanticPrimaryValue(objectLedger)).toBe(shared);
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

  test("isolates sequential, concurrent, and getter-reentrant reuse of one raw Error", async () => {
    const shared = new Error("one raw failure");
    const first = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", shared),
      [captureFailureOccurrence("final_release", "first release")],
      "first operation"
    );
    const second = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", shared),
      [captureFailureOccurrence("settlement", "second settlement")],
      "second operation"
    );
    const concurrent = await Promise.all(["left", "right"].map(async (label) =>
      mergeTrustedFailureOccurrences(
        captureFailureOccurrence("body", shared),
        [captureFailureOccurrence("settlement", label)],
        label
      )
    ));
    let reentrant: unknown;
    const getterPrimary = new Error("getter primary");
    Object.defineProperty(getterPrimary, "cause", {
      get() {
        reentrant = mergeTrustedFailureOccurrences(
          captureFailureOccurrence("body", shared),
          [captureFailureOccurrence("settlement", "inner")],
          "inner operation"
        );
        return shared;
      }
    });
    const outer = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", getterPrimary),
      [],
      "outer operation"
    );

    const carriers = [first, second, ...concurrent, reentrant, outer];
    expect(new Set(carriers).size).toBe(carriers.length);
    expect(failureLedger(shared)).toBeUndefined();
    expect(failureEvents(first).map((event) => event.value)).toEqual([shared, "first release"]);
    expect(failureEvents(second).map((event) => event.value)).toEqual([shared, "second settlement"]);
    expect(concurrent.map((value) => failureEvents(value).at(-1)?.value)).toEqual(["left", "right"]);
    expect(failureEvents(reentrant).map((event) => event.value)).toEqual([shared, "inner"]);
    for (const carrier of carriers) {
      expect(Object.isFrozen(failureLedger(carrier))).toBe(true);
      expect(Object.isFrozen(failureEvents(carrier))).toBe(true);
      expect(failureEvents(carrier).every(Object.isFrozen)).toBe(true);
      expect(Object.isFrozen(failureLedger(carrier)!.observedGraph)).toBe(true);
      expect(Object.isFrozen(failureGraphNodes(carrier))).toBe(true);
      expect(failureGraphNodes(carrier).every((node) =>
        Object.isFrozen(node) && Object.isFrozen(node.edges) && node.edges.every(Object.isFrozen)
      )).toBe(true);
      expect(semanticPrimaryValue(carrier)).toBe(carrier === outer ? getterPrimary : shared);
    }
  });

  test("round-trips exact nullish and custom-branded semantic primaries", () => {
    const privateBrand = new WeakSet<object>();
    class PrivateError extends Error {
      #value = 7;
      constructor() {
        super("private");
        privateBrand.add(this);
      }
      value() { return this.#value; }
    }
    const branded = new PrivateError();
    for (const raw of [null, undefined, false, 0, "", branded] as const) {
      const carrier = mergeTrustedFailureOccurrences(
        captureFailureOccurrence("body", raw),
        [captureFailureOccurrence("settlement", "later")],
        "exact primary"
      );
      expect(semanticPrimaryValue(carrier)).toBe(raw);
      expect(failureLedger(raw)).toBeUndefined();
    }
    expect(branded.value()).toBe(7);
    expect(privateBrand.has(branded)).toBe(true);
  });

  test("keeps adopted history chronological and imports every occurrence once", () => {
    const primary = new Error("chronological primary");
    const first = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", primary),
      [captureFailureOccurrence("settlement", "first later")],
      "first"
    );
    const adopted = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("final_release", first),
      [captureFailureOccurrence("observation", "new later")],
      "adopt"
    );
    const events = failureEvents(adopted);
    expect(events.map((event) => event.order)).toEqual(
      [...events].map((event) => event.order).sort((left, right) => left - right)
    );
    expect(new Set(events.map((event) => event.order)).size).toBe(events.length);
    expect(new Set(events.map((event) => event.occurrenceId)).size).toBe(events.length);
    expect(failureLedger(adopted)).toBe(failureLedger(adopted));
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
      expect(observationIssueCodes(result).filter(
        (code) => code === "node_budget_exceeded"
      )).toHaveLength(truncated ? 1 : 0);
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
      expect(observationIssueCodes(result).filter(
        (code) => code === "edge_budget_exceeded"
      )).toHaveLength(truncated ? 1 : 0);
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

  test("bounds deceptive numeric keys and terminates a failed array-brand path", () => {
    let descriptorReads = 0;
    const keys = Array.from({ length: 16_384 }, (_, index) => String(index));
    const deceptive = new Proxy([], {
      ownKeys() { return [...keys, "length"]; },
      getOwnPropertyDescriptor(_target, property) {
        if (property === "length") return { configurable: false, enumerable: false, value: 16_384, writable: true };
        descriptorReads += 1;
        throw new Error(`descriptor ${String(property)}`);
      }
    });
    const primary = new AggregateError([], "deceptive keys");
    Object.defineProperty(primary, "errors", { value: deceptive });
    const result = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", primary),
      [],
      "deceptive keys"
    );
    expect(descriptorReads).toBeLessThanOrEqual(8192);
    expect(failureLedger(result)!.observedGraph.observationFailures.filter(
      (event) => !(event.value instanceof FailureGraphObservationIssue)
    ).length).toBeLessThanOrEqual(256);

    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const revokedPrimary = new AggregateError([], "revoked errors");
    Object.defineProperty(revokedPrimary, "errors", { value: revoked.proxy });
    const revokedResult = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", revokedPrimary),
      [],
      "revoked errors"
    );
    const revokedLedger = failureLedger(revokedResult)!;
    expect(revokedLedger.observedGraph.observationFailures).toHaveLength(1);
    expect(revokedLedger.observedGraph.nodes.some((node) => node.value === revoked.proxy)).toBe(false);
    expect(revokedLedger.observedGraph.nodes
      .flatMap((node) => node.edges)
      .some((edge) => edge.target === revoked.proxy)).toBe(false);
  });

  test("bounds cyclic and fresh-per-hop prototype work and observes aliases once", () => {
    let cyclicReads = 0;
    let cyclicProxy: object;
    cyclicProxy = new Proxy({}, {
      getPrototypeOf() {
        cyclicReads += 1;
        return cyclicProxy;
      }
    });
    const cyclicResult = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", cyclicProxy),
      [],
      "cyclic prototype"
    );
    expect(cyclicReads).toBe(1);
    expect(semanticPrimaryValue(cyclicResult)).toBe(cyclicProxy);

    let freshReads = 0;
    const fresh = (): object => new Proxy({}, {
      getPrototypeOf() {
        freshReads += 1;
        return fresh();
      }
    });
    const freshPrimary = fresh();
    const freshResult = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", freshPrimary),
      [],
      "fresh prototype"
    );
    expect(freshReads).toBeLessThanOrEqual(65_536);
    expect(observationIssueCodes(freshResult)).toContain("controlled_operation_budget_exceeded");

    const alias = new Error("one aliased node");
    const aliasedPrimary = new AggregateError([alias, alias], "aliases");
    aliasedPrimary.cause = alias;
    const aliased = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", aliasedPrimary),
      [],
      "aliases"
    );
    expect(failureGraphNodes(aliased).filter((node) => node.value === alias)).toHaveLength(1);
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

    expect(result).not.toBe(primary);
    expect(semanticPrimaryValue(result)).toBe(primary);
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
    const proxy = createTrustedTaskServiceErrorProxy(proxyTarget, {
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
    expect(proxyResult).not.toBe(proxy);
    expect(semanticPrimaryValue(proxyResult)).toBe(proxy);
    expect(taskServiceErrorAtBoundary(proxyResult)).toBe(proxyTarget);
    expect(brandReads).toBe(0);

    const forged = Object.create(TaskServiceError.prototype);
    const spoof = new Proxy({}, { getPrototypeOf: () => TaskServiceError.prototype });
    const aggregate = new AggregateError([primary], "untrusted aggregate");
    const ledgerLike = { primary: { value: primary }, events: [primary] };
    for (const untrusted of [forged, spoof, aggregate, ledgerLike]) {
      expect(taskServiceErrorAtBoundary(untrusted)).toBeUndefined();
    }
  });

  test("captures physical body, release, and settlement phases at the shared helper", async () => {
    const bodyFailure = new Error("body failed");
    const releaseFailure = new Error("release failed");
    const bodyAndRelease = await runWithPreservedRelease(
      async () => { throw bodyFailure; },
      async () => { throw releaseFailure; },
      "body and release",
      undefined,
      preserveTaskServiceErrorCompensationCompatibility
    ).catch((error) => error);
    expect(failureEvents(bodyAndRelease).map((event) => event.phase)).toEqual([
      "body", "final_release"
    ]);

    const settlementFailure = new Error("settlement failed");
    const releaseAndSettlement = await runWithPreservedRelease(
      async () => "value",
      async () => { throw releaseFailure; },
      "release and settlement",
      async () => { throw settlementFailure; },
      preserveTaskServiceErrorCompensationCompatibility
    ).catch((error) => error);
    expect(failureEvents(releaseAndSettlement).map((event) => event.phase)).toEqual([
      "initial_release", "settlement"
    ]);
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
