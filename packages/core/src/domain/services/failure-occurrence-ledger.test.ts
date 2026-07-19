import { describe, expect, test } from "bun:test";
import {
  FAILURE_GRAPH_MAX_EDGES,
  FAILURE_GRAPH_MAX_CONTROLLED_OPERATIONS,
  FAILURE_GRAPH_MAX_NUMERIC_KEYS,
  FAILURE_GRAPH_MAX_NODES,
  FailureGraphObservationIssue,
  FailureOccurrenceProtocolError,
  adoptFailureCarrier,
  captureFailureFoldEntry,
  captureFailureOccurrence,
  createTrustedTaskServiceErrorProxy,
  failureEvents,
  failureGraphNodes,
  failureLedger,
  mergeTrustedFailureOccurrences,
  orderedDistinctFailures,
  preserveTaskServiceErrorFailureEntries,
  semanticPrimaryValue,
  taskServiceErrorAtBoundary
} from "./index";
import * as failurePreservation from "./compensation-error-preservation";
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
      adoptFailureCarrier("body", first),
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
    const recatch = adoptFailureCarrier("body", first);
    const finalRelease = captureFailureOccurrence("final_release", "new later");
    const adopted = mergeTrustedFailureOccurrences(
      recatch,
      [finalRelease],
      "adopt"
    );
    const events = failureEvents(adopted);
    const inheritedEvents = failureEvents(first);
    expect(events.map((event) => event.order)).toEqual(
      [...events].map((event) => event.order).sort((left, right) => left - right)
    );
    expect(new Set(events.map((event) => event.order)).size).toBe(events.length);
    expect(new Set(events.map((event) => event.occurrenceId)).size).toBe(events.length);
    expect(events.filter((event) => inheritedEvents.some(
      (inherited) => inherited.occurrenceId === event.occurrenceId
    ))).toHaveLength(inheritedEvents.length);
    const recatchOccurrence = events.find((event) => event.value === first);
    expect(recatchOccurrence).toMatchObject({
      phase: "body",
      value: first
    });
    expect(Object.keys(recatch)).toEqual(["order"]);
    expect("occurrence" in recatch).toBe(false);
    expect("carrier" in recatch).toBe(false);
    expectProtocolError(
      () => mergeTrustedFailureOccurrences(
        (recatch as unknown as { occurrence?: never }).occurrence!,
        [],
        "opaque adoption child"
      ),
      "untrusted_entry"
    );
    expect(events.at(-1)).toBe(finalRelease);
    expect(semanticPrimaryValue(adopted)).toBe(primary);
    expect(failureLedger(adopted)).toBe(failureLedger(adopted));
  });

  test("Phase 6.2 observes nested carrier edges without incidental adoption", () => {
    const inheritedPrimary = new Error("inherited primary");
    const inheritedLater = new Error("inherited later");
    const inherited = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", inheritedPrimary),
      [captureFailureOccurrence("settlement", inheritedLater)],
      "inherited operation"
    );
    const inheritedIds = new Set(
      failureEvents(inherited).map((event) => event.occurrenceId)
    );

    for (const kind of ["cause", "errors", "semanticPrimary"] as const) {
      const outer = kind === "errors"
        ? new AggregateError([inherited], `outer ${kind}`)
        : new Error(`outer ${kind}`);
      if (kind !== "errors") {
        Object.defineProperty(outer, kind, {
          configurable: true,
          enumerable: false,
          value: inherited
        });
      }
      const outerOccurrence = captureFailureOccurrence("body", outer);
      const result = mergeTrustedFailureOccurrences(
        outerOccurrence,
        [],
        `outer ${kind} operation`
      );
      const events = failureEvents(result);
      const outerNode = failureGraphNodes(result).find(
        (node) => node.value === outer
      );

      expect(events).toEqual([outerOccurrence]);
      expect(
        events.some((event) => inheritedIds.has(event.occurrenceId))
      ).toBe(false);
      expect(failureGraphNodes(result).some((node) => node.value === inherited)).toBe(
        true
      );
      expect(
        failureGraphNodes(result).some((node) => node.value === inheritedPrimary)
      ).toBe(true);
      expect(
        failureGraphNodes(result).some((node) => node.value === inheritedLater)
      ).toBe(true);
      expect(
        outerNode?.edges.some(
          (edge) => edge.kind === kind && edge.target === inherited
        )
      ).toBe(true);
    }

    const explicitlyAdopted = mergeTrustedFailureOccurrences(
      adoptFailureCarrier("body", inherited),
      [captureFailureOccurrence("final_release", "new later")],
      "explicit adoption"
    );
    expect(
      failureEvents(explicitlyAdopted).filter((event) =>
        inheritedIds.has(event.occurrenceId)
      )
    ).toHaveLength(inheritedIds.size);
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
      adoptFailureCarrier("body", first),
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
      expect(observationIssueCodes(result).filter(
        (code) => code === "numeric_key_budget_exceeded"
      )).toHaveLength(truncated ? 1 : 0);
      expect(semanticPrimaryValue(result)).toBe(primary);
    }
  });

  test("Phase 6.2 records edge and numeric-key budget exhaustion independently", () => {
    const errors = Array.from(
      { length: FAILURE_GRAPH_MAX_NUMERIC_KEYS + 1 },
      (_, index) => index
    );
    const primary = new AggregateError(errors, "combined budget exhaustion");
    const result = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", primary),
      [],
      "combined budget exhaustion"
    );
    const codes = observationIssueCodes(result);

    expect(codes.filter((code) => code === "edge_budget_exceeded")).toHaveLength(1);
    expect(
      codes.filter((code) => code === "numeric_key_budget_exceeded")
    ).toHaveLength(1);
    expect(failureGraphNodes(result)[0]?.edges).toHaveLength(
      FAILURE_GRAPH_MAX_EDGES
    );
    expect(semanticPrimaryValue(result)).toBe(primary);
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
    expect(observationIssueCodes(deepResult)).toEqual(["node_budget_exceeded"]);
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
    let ownKeysCalls = 0;
    const keys = Array.from({ length: 16_384 }, (_, index) => String(index));
    const deceptive = new Proxy([], {
      ownKeys() { ownKeysCalls += 1; return [...keys, "length"]; },
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
    expect(ownKeysCalls).toBe(1);
    // The one additional descriptor probe is the bounded proof for the first
    // overflow key; this Proxy throws, so no edge-budget evidence is minted.
    expect(descriptorReads).toBe(FAILURE_GRAPH_MAX_NUMERIC_KEYS + 1);
    const hostileLedger = failureLedger(result)!;
    expect(hostileLedger.observedGraph.observationFailures.filter(
      (event) => !(event.value instanceof FailureGraphObservationIssue)
    )).toHaveLength(256);
    expect(observationIssueCodes(result)).toEqual([
      "numeric_key_budget_exceeded",
      "observation_failure_budget_exceeded"
    ]);
    expect(Object.isFrozen(hostileLedger.events)).toBe(true);
    expect(hostileLedger.observedGraph.observationFailures.every(Object.isFrozen)).toBe(true);
    expect(hostileLedger.observedGraph.observationFailures.every(Object.isFrozen)).toBe(true);
    expect(new Set(hostileLedger.events.map((event) => event.order)).size).toBe(
      hostileLedger.events.length
    );
    expect(hostileLedger.events.map((event) => event.order)).toEqual(
      [...hostileLedger.events].map((event) => event.order).sort((left, right) => left - right)
    );
    expect(semanticPrimaryValue(result)).toBe(primary);

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
    expect(observationIssueCodes(freshResult)).toEqual([
      "controlled_operation_budget_exceeded"
    ]);

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
    const result = preserveTaskServiceErrorFailureEntries(
      captureFailureOccurrence("body", primary),
      [captureFailureOccurrence("final_release", compensation)],
      "typed fold"
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
    const proxyResult = preserveTaskServiceErrorFailureEntries(
      captureFailureOccurrence("body", proxy),
      [captureFailureOccurrence("settlement", new Error("proxy compensation"))],
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
      preserveTaskServiceErrorFailureEntries
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
      preserveTaskServiceErrorFailureEntries
    ).catch((error) => error);
    expect(failureEvents(releaseAndSettlement).map((event) => event.phase)).toEqual([
      "initial_release", "settlement"
    ]);

    const undefinedInitialRelease = await runWithPreservedRelease(
      async () => "fulfilled",
      async () => { throw undefined; },
      "undefined initial release",
      undefined,
      preserveTaskServiceErrorFailureEntries
    ).catch((error) => error);
    expect(failureEvents(undefinedInitialRelease).map(({ phase, value }) => ({
      phase,
      value
    }))).toEqual([{ phase: "initial_release", value: undefined }]);

    const falsyBodyAndRelease = await runWithPreservedRelease(
      async () => { throw false; },
      async () => { throw undefined; },
      "falsy body and release",
      undefined,
      preserveTaskServiceErrorFailureEntries
    ).catch((error) => error);
    expect(failureEvents(falsyBodyAndRelease).map(({ phase, value }) => ({
      phase,
      value
    }))).toEqual([
      { phase: "body", value: false },
      { phase: "final_release", value: undefined }
    ]);

    const nullSettlement = await runWithPreservedRelease(
      async () => "fulfilled",
      async () => { throw undefined; },
      "null settlement",
      async () => { throw null; },
      preserveTaskServiceErrorFailureEntries
    ).catch((error) => error);
    expect(failureEvents(nullSettlement).map(({ phase, value }) => ({ phase, value })))
      .toEqual([
        { phase: "initial_release", value: undefined },
        { phase: "settlement", value: null }
      ]);
  });

  test("fails closed before publication for mismatched, duplicate, stale, and reordered occurrences", async () => {
    const primaryA = new Error("protocol primary A");
    const primaryOccurrence = captureFailureOccurrence("body", primaryA);
    const laterOccurrence = captureFailureOccurrence("final_release", new Error("later"));

    const counterfeit = Object.freeze({ ...primaryOccurrence, value: new Error("counterfeit") });
    expectProtocolError(() => mergeTrustedFailureOccurrences(
      counterfeit as typeof primaryOccurrence,
      [],
      "mismatched raw and occurrence"
    ), "untrusted_entry");
    expectProtocolError(() => mergeTrustedFailureOccurrences(
      primaryOccurrence,
      [primaryOccurrence],
      "duplicate occurrence"
    ), "duplicate_entry");

    const firstClaim = mergeTrustedFailureOccurrences(
      primaryOccurrence,
      [laterOccurrence],
      "first claim"
    );
    expect(failureEvents(firstClaim)).toHaveLength(2);
    expectProtocolError(() => mergeTrustedFailureOccurrences(
      primaryOccurrence,
      [],
      "stale claim"
    ), "stale_entry");

    const older = captureFailureOccurrence("body", new Error("older"));
    const newer = captureFailureOccurrence("settlement", new Error("newer"));
    expectProtocolError(() => mergeTrustedFailureOccurrences(
      newer,
      [older],
      "reordered entries"
    ), "reordered_entry");

    const adoptedCarrier = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", new Error("adopted primary")),
      [],
      "adopted carrier"
    );
    const beforeAdoption = captureFailureOccurrence(
      "settlement",
      new Error("before adoption")
    );
    const adoption = adoptFailureCarrier("final_release", adoptedCarrier);
    expectProtocolError(() => mergeTrustedFailureOccurrences(
      adoption,
      [beforeAdoption],
      "reordered adoption"
    ), "reordered_entry");
    const adoptionClaim = mergeTrustedFailureOccurrences(
      beforeAdoption,
      [adoption],
      "ordered adoption"
    );
    expect(semanticPrimaryValue(adoptionClaim)).toBe(beforeAdoption.value);
    expectProtocolError(() => mergeTrustedFailureOccurrences(
      adoption,
      [],
      "stale adoption"
    ), "stale_entry");

    expectProtocolError(
      () => adoptFailureCarrier("body", new Error("not a carrier")),
      "invalid_adoption"
    );
    expectProtocolError(
      () => captureFailureOccurrence("not-a-phase" as never, undefined),
      "invalid_phase"
    );
    const concurrent = captureFailureOccurrence("body", new Error("concurrent"));
    const claims = await Promise.allSettled([
      Promise.resolve().then(() => mergeTrustedFailureOccurrences(concurrent, [], "left")),
      Promise.resolve().then(() => mergeTrustedFailureOccurrences(concurrent, [], "right"))
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
    expect((claims.find((claim) => claim.status === "rejected") as PromiseRejectedResult)
      .reason).toMatchObject({ code: "stale_entry" });
  });

  test("enforces the centralized phase-role grammar transactionally", () => {
    for (const [primaryPhase, laterPhase] of [
      ["settlement", "body"],
      ["settlement", "initial_release"],
      ["body", "observation"],
      ["final_release", "settlement"]
    ] as const) {
      const primary = captureFailureOccurrence(primaryPhase, `${primaryPhase} primary`);
      const later = captureFailureOccurrence(laterPhase, `${laterPhase} later`);
      expectProtocolError(
        () => mergeTrustedFailureOccurrences(primary, [later], "invalid phase roles"),
        "invalid_phase"
      );

      // The invalid vector must claim neither otherwise-valid entry.
      const recoveredPrimary = mergeTrustedFailureOccurrences(
        primary,
        [],
        "primary remains claimable"
      );
      expect(failureEvents(recoveredPrimary)).toEqual([primary]);
      if (laterPhase !== "observation") {
        const recoveredLater = mergeTrustedFailureOccurrences(
          later,
          [],
          "later remains claimable"
        );
        expect(failureEvents(recoveredLater)).toEqual([later]);
      }
    }

    for (const phases of [
      ["body", "final_release"],
      ["initial_release", "settlement"],
      ["settlement", "final_release"],
      ["final_release", "final_release", "final_release"]
    ] as const) {
      const entries = phases.map((phase, index) =>
        captureFailureOccurrence(phase, `${phase}-${index}`)
      );
      const result = mergeTrustedFailureOccurrences(
        entries[0]!,
        entries.slice(1),
        "valid phase roles"
      );
      expect(failureEvents(result)).toEqual(entries);
    }
  });

  test("validates adopted physical history before claiming a fresh phase", () => {
    const observationFailure = new Error("adopted observation tail");
    const primary = new Error("adopted terminal primary");
    Object.defineProperty(primary, "cause", {
      get() {
        throw observationFailure;
      }
    });
    const inherited = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", primary),
      [captureFailureOccurrence("final_release", new Error("terminal release"))],
      "terminal inherited history"
    );
    expect(failureEvents(inherited).map((event) => event.phase)).toEqual([
      "body",
      "final_release",
      "observation"
    ]);
    expect(
      (failurePreservation as unknown as {
        failureTerminalPhysicalPhase(value: unknown): string | undefined;
      }).failureTerminalPhysicalPhase(inherited)
    ).toBe("final_release");

    const invalidAdoption = adoptFailureCarrier("settlement", inherited);
    expectProtocolError(
      () => mergeTrustedFailureOccurrences(invalidAdoption, [], "invalid imported phase"),
      "invalid_phase"
    );
    // The combined-history rejection is transactional: retry reports the same
    // phase error, not a stale token consumed by the first preflight.
    expectProtocolError(
      () => mergeTrustedFailureOccurrences(invalidAdoption, [], "retry imported phase"),
      "invalid_phase"
    );
  });

  test("snapshots a hostile fold vector exactly once before claim", () => {
    const primary = captureFailureOccurrence("body", new Error("snapshot primary"));
    const snapshottedLater = captureFailureOccurrence(
      "settlement",
      new Error("snapshotted later")
    );
    const substitutedLater = captureFailureOccurrence(
      "settlement",
      new Error("substituted later")
    );
    let laterReads = 0;
    const entries = new Proxy([primary, snapshottedLater], {
      get(target, property, receiver) {
        if (property === "1") {
          laterReads += 1;
          return laterReads === 1 ? snapshottedLater : substitutedLater;
        }
        return Reflect.get(target, property, receiver);
      }
    });

    const result = failurePreservation.mergeTrustedFailureOccurrenceVector(
      primary,
      entries,
      "transactional vector snapshot"
    );
    expect(failureEvents(result)).toEqual([primary, snapshottedLater]);
    expect(laterReads).toBe(1);
    expectProtocolError(
      () => mergeTrustedFailureOccurrences(
        snapshottedLater,
        [],
        "snapshotted entry was claimed"
      ),
      "stale_entry"
    );
    expect(failureEvents(mergeTrustedFailureOccurrences(
      substitutedLater,
      [],
      "unobserved substitute remains fresh"
    ))).toEqual([substitutedLater]);
  });

  test("resolves and executes primary classification before claiming entries", () => {
    const getterFailure = new Error("classification getter failed");
    const getterPrimary = captureFailureOccurrence("body", new Error("getter primary"));
    expect(() => failurePreservation.mergeTrustedFailureOccurrenceVector(
      getterPrimary,
      [getterPrimary],
      "throwing classification getter",
      Object.defineProperty({}, "classify", {
        get() {
          throw getterFailure;
        }
      }) as failurePreservation.FailurePrimaryClassification
    )).toThrow(getterFailure);
    expect(failureEvents(mergeTrustedFailureOccurrences(
      getterPrimary,
      [],
      "getter failure leaves occurrence fresh"
    ))).toEqual([getterPrimary]);

    const callableFailure = new Error("classification callable failed");
    const callablePrimary = captureFailureOccurrence("body", new Error("callable primary"));
    expect(() => failurePreservation.mergeTrustedFailureOccurrenceVector(
      callablePrimary,
      [callablePrimary],
      "throwing classification callable",
      { classify: () => { throw callableFailure; } }
    )).toThrow(callableFailure);
    expect(failureEvents(mergeTrustedFailureOccurrences(
      callablePrimary,
      [],
      "callable failure leaves occurrence fresh"
    ))).toEqual([callablePrimary]);
  });

  test("counts reordered canonical numeric keys rather than returned-key positions", () => {
    for (const order of ["reverse", "interleaved"] as const) {
      for (const numericCount of [
        FAILURE_GRAPH_MAX_NUMERIC_KEYS - 1,
        FAILURE_GRAPH_MAX_NUMERIC_KEYS,
        FAILURE_GRAPH_MAX_NUMERIC_KEYS + 1
      ]) {
      const marker = Object.freeze({ numericCount });
      const numericKeys = Array.from({ length: numericCount }, (_, index) => String(index));
      const reversedNumericKeys = [...numericKeys].reverse();
      const returnedKeys = order === "reverse"
        ? reversedNumericKeys
        : reversedNumericKeys.flatMap((key) => [`non-numeric-${key}`, key]);
      const prefixSymbol = Symbol(`prefix-${numericCount}`);
      let ownKeysCalls = 0;
      const errors = new Proxy([], {
        ownKeys() {
          ownKeysCalls += 1;
          return ["length", "prefix", prefixSymbol, ...returnedKeys];
        },
        getOwnPropertyDescriptor(target, property) {
          if (property === "length") return Reflect.getOwnPropertyDescriptor(target, property);
          if (typeof property === "string" && /^\\d+$/.test(property)) {
            return { configurable: true, enumerable: true, value: marker, writable: true };
          }
          return { configurable: true, enumerable: false, value: "nonnumeric", writable: true };
        }
      });
      const primary = new AggregateError([], `reordered ${numericCount}`);
      Object.defineProperty(primary, "errors", { value: errors });

      const result = mergeTrustedFailureOccurrences(
        captureFailureOccurrence("body", primary),
        [],
        `reordered ${numericCount}`
      );
      const ledger = failureLedger(result)!;
      const edges = ledger.observedGraph.nodes[0]!.edges.filter(
        (edge) => edge.kind === "errors"
      );
      const expectedEdgeCount = Math.min(numericCount, FAILURE_GRAPH_MAX_NUMERIC_KEYS);
      const expectedIssues = numericCount > FAILURE_GRAPH_MAX_NUMERIC_KEYS
        ? ["numeric_key_budget_exceeded", "edge_budget_exceeded"]
        : [];

      expect(ownKeysCalls).toBe(1);
      expect(edges.map((edge) => edge.index)).toEqual(
        Array.from({ length: expectedEdgeCount }, (_, index) => index)
      );
      expect(observationIssueCodes(result)).toEqual(expectedIssues);
      expect(Object.isFrozen(ledger.observedGraph.nodes)).toBe(true);
      expect(Object.isFrozen(ledger.observedGraph.nodes[0]!.edges)).toBe(true);
      expect(Object.isFrozen(ledger.observedGraph.observationFailures)).toBe(true);
      expect(ledger.observedGraph.observationFailures.every(Object.isFrozen)).toBe(true);
      expect(Object.isFrozen(ledger.events)).toBe(true);
      expect(new Set(ledger.events.map((event) => event.order)).size).toBe(
        ledger.events.length
      );
      expect(ledger.events.map((event) => event.order)).toEqual(
        [...ledger.events.map((event) => event.order)].sort((left, right) => left - right)
      );
      expect(semanticPrimaryValue(result)).toBe(primary);
      }
    }
  });

  test("reads exact trusted fold-entry values without a parallel raw-value channel", () => {
    const failureFoldEntryValue = (
      failurePreservation as unknown as {
        failureFoldEntryValue?: (entry: unknown) => unknown;
      }
    ).failureFoldEntryValue;
    expect(failureFoldEntryValue).toBeFunction();
    if (!failureFoldEntryValue) return;
    const direct = captureFailureFoldEntry("initial_release", undefined);
    expect(failureFoldEntryValue(direct)).toBeUndefined();

    const carrier = mergeTrustedFailureOccurrences(
      captureFailureFoldEntry("body", "primary"),
      [],
      "accessor carrier"
    );
    const adopted = captureFailureFoldEntry("final_release", carrier);
    expect(failureFoldEntryValue(adopted)).toBe(carrier);
    expect(() => failureFoldEntryValue({} as never)).toThrow(
      new FailureOccurrenceProtocolError("untrusted_entry")
    );
  });

  test("records controlled-work exhaustion without fabricating an unclassified numeric overflow", () => {
    const numericTail = "0";
    const nonnumeric = Array.from(
      { length: FAILURE_GRAPH_MAX_CONTROLLED_OPERATIONS },
      (_, index) => `key-${index}`
    );
    let ownKeysCalls = 0;
    const errors = new Proxy([], {
      ownKeys() {
        ownKeysCalls += 1;
        return ["length", ...nonnumeric, numericTail];
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === "length") return Reflect.getOwnPropertyDescriptor(target, property);
        return { configurable: true, enumerable: true, value: property, writable: true };
      }
    });
    const primary = new AggregateError([], "controlled-work tail");
    Object.defineProperty(primary, "errors", { value: errors });
    const result = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", primary),
      [],
      "controlled-work tail"
    );
    const ledger = failureLedger(result)!;

    expect(ownKeysCalls).toBe(1);
    expect(observationIssueCodes(result)).toEqual([
      "controlled_operation_budget_exceeded"
    ]);
    expect(ledger.observedGraph.nodes[0]!.edges.filter(
      (edge) => edge.kind === "errors"
    )).toEqual([]);
    expect(ledger.observedGraph.observationFailures).toHaveLength(1);
    expect(ledger.observedGraph.observationFailures.every(Object.isFrozen)).toBe(true);
    expect(semanticPrimaryValue(result)).toBe(primary);
  });

  test("records known numeric overflow before a preoccupied semantic edge exhausts the edge budget", () => {
    const marker = Object.freeze({ kind: "numeric-edge-marker" });
    const numericKeys = Array.from(
      { length: FAILURE_GRAPH_MAX_NUMERIC_KEYS + 1 },
      (_, index) => String(index)
    );
    let ownKeysCalls = 0;
    const errors = new Proxy([], {
      ownKeys() {
        ownKeysCalls += 1;
        return ["length", ...numericKeys];
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === "length") {
          return Reflect.getOwnPropertyDescriptor(target, property);
        }
        return {
          configurable: true,
          enumerable: true,
          value: marker,
          writable: true
        };
      }
    });
    const semantic = new Error("preoccupied semantic primary edge");
    const primary = new AggregateError([], "numeric overflow before edge exhaustion");
    Object.defineProperties(primary, {
      semanticPrimary: { value: semantic },
      errors: { value: errors }
    });

    const result = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", primary),
      [],
      "numeric overflow before edge exhaustion"
    );
    const ledger = failureLedger(result)!;
    const primaryNode = ledger.observedGraph.nodes.find((node) => node.value === primary)!;

    expect(ownKeysCalls).toBe(1);
    expect(primaryNode.edges.filter((edge) => edge.kind === "semanticPrimary")).toEqual([
      { kind: "semanticPrimary", target: semantic }
    ]);
    expect(primaryNode.edges.filter((edge) => edge.kind === "errors").map((edge) => edge.index))
      .toEqual(Array.from(
        { length: FAILURE_GRAPH_MAX_EDGES - 1 },
        (_, index) => index
      ));
    expect(observationIssueCodes(result)).toEqual([
      "numeric_key_budget_exceeded",
      "edge_budget_exceeded"
    ]);
    expect(Object.isFrozen(ledger.events)).toBe(true);
    expect(Object.isFrozen(ledger.observedGraph.nodes)).toBe(true);
    expect(Object.isFrozen(primaryNode.edges)).toBe(true);
    expect(Object.isFrozen(ledger.observedGraph.observationFailures)).toBe(true);
    expect(new Set(ledger.events.map((event) => event.order)).size).toBe(
      ledger.events.length
    );
    expect(ledger.events.map((event) => event.order)).toEqual(
      [...ledger.events.map((event) => event.order)].sort((left, right) => left - right)
    );
    expect(semanticPrimaryValue(result)).toBe(primary);
  });

  test("records known numeric overflow before a later nonnumeric tail exhausts controlled work", () => {
    const numericKeys = Array.from(
      { length: FAILURE_GRAPH_MAX_NUMERIC_KEYS + 1 },
      (_, index) => String(index)
    );
    const nonnumericTail = Array.from(
      { length: FAILURE_GRAPH_MAX_CONTROLLED_OPERATIONS },
      (_, index) => `tail-${index}`
    );
    let ownKeysCalls = 0;
    const errors = new Proxy([], {
      ownKeys() {
        ownKeysCalls += 1;
        return ["length", ...numericKeys, ...nonnumericTail];
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === "length") {
          return Reflect.getOwnPropertyDescriptor(target, property);
        }
        return {
          configurable: true,
          enumerable: true,
          value: property,
          writable: true
        };
      }
    });
    const primary = new AggregateError([], "numeric overflow before controlled exhaustion");
    Object.defineProperty(primary, "errors", { value: errors });

    const result = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", primary),
      [],
      "numeric overflow before controlled exhaustion"
    );
    const ledger = failureLedger(result)!;

    expect(ownKeysCalls).toBe(1);
    expect(observationIssueCodes(result)).toEqual([
      "numeric_key_budget_exceeded",
      "controlled_operation_budget_exceeded"
    ]);
    expect(ledger.observedGraph.nodes[0]!.edges.filter(
      (edge) => edge.kind === "errors"
    )).toEqual([]);
    expect(ledger.observedGraph.observationFailures).toHaveLength(2);
    expect(ledger.observedGraph.observationFailures.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(ledger.events)).toBe(true);
    expect(Object.isFrozen(ledger.observedGraph.nodes)).toBe(true);
    expect(Object.isFrozen(ledger.observedGraph.nodes[0]!.edges)).toBe(true);
    expect(new Set(ledger.events.map((event) => event.order)).size).toBe(
      ledger.events.length
    );
    expect(ledger.events.map((event) => event.order)).toEqual(
      [...ledger.events.map((event) => event.order)].sort((left, right) => left - right)
    );
    expect(semanticPrimaryValue(result)).toBe(primary);
  });

  test("does not fabricate edge exhaustion when the omitted reverse/interleaved overflow descriptor is absent", () => {
    for (const order of ["reverse", "interleaved"] as const) {
      const overflowIndex = FAILURE_GRAPH_MAX_NUMERIC_KEYS;
      const marker = Object.freeze({ order });
      const numericKeys = Array.from(
        { length: FAILURE_GRAPH_MAX_NUMERIC_KEYS + 1 },
        (_, index) => String(index)
      ).reverse();
      const returnedKeys = order === "reverse"
        ? numericKeys
        : numericKeys.flatMap((key) => [`non-numeric-${key}`, key]);
      let ownKeysCalls = 0;
      let descriptorReads = 0;
      const errors = new Proxy([], {
        ownKeys() {
          ownKeysCalls += 1;
          return ["length", ...returnedKeys];
        },
        getOwnPropertyDescriptor(target, property) {
          if (property === "length") {
            return Reflect.getOwnPropertyDescriptor(target, property);
          }
          if (typeof property !== "string" || !/^\d+$/.test(property)) {
            return {
              configurable: true,
              enumerable: false,
              value: property,
              writable: true
            };
          }
          descriptorReads += 1;
          if (property === String(overflowIndex)) return undefined;
          return {
            configurable: true,
            enumerable: true,
            value: marker,
            writable: true
          };
        }
      });
      const primary = new AggregateError([], `absent overflow ${order}`);
      Object.defineProperty(primary, "errors", { value: errors });

      const result = mergeTrustedFailureOccurrences(
        captureFailureOccurrence("body", primary),
        [],
        `absent overflow ${order}`
      );
      const ledger = failureLedger(result)!;
      const primaryNode = ledger.observedGraph.nodes.find(
        (node) => node.value === primary
      )!;

      expect(ownKeysCalls).toBe(1);
      expect(descriptorReads).toBe(FAILURE_GRAPH_MAX_NUMERIC_KEYS + 1);
      expect(primaryNode.edges.filter((edge) => edge.kind === "errors").map(
        (edge) => edge.index
      )).toEqual(Array.from(
        { length: FAILURE_GRAPH_MAX_NUMERIC_KEYS },
        (_, index) => index
      ));
      expect(observationIssueCodes(result)).toEqual([
        "numeric_key_budget_exceeded"
      ]);
      expect(Object.isFrozen(ledger.events)).toBe(true);
      expect(Object.isFrozen(ledger.observedGraph.nodes)).toBe(true);
      expect(Object.isFrozen(primaryNode.edges)).toBe(true);
      expect(Object.isFrozen(ledger.observedGraph.observationFailures)).toBe(true);
      expect(ledger.observedGraph.observationFailures.every(Object.isFrozen)).toBe(true);
      expect(new Set(ledger.events.map((event) => event.occurrenceId)).size).toBe(
        ledger.events.length
      );
      expect(new Set(ledger.events.map((event) => event.order)).size).toBe(
        ledger.events.length
      );
      expect(ledger.events.map((event) => event.order)).toEqual(
        [...ledger.events.map((event) => event.order)].sort((left, right) => left - right)
      );
      expect(semanticPrimaryValue(result)).toBe(primary);
    }
  });


});

function expectProtocolError(
  operation: () => unknown,
  code: FailureOccurrenceProtocolError["code"]
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(FailureOccurrenceProtocolError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected failure occurrence protocol error: ${code}.`);
}

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
