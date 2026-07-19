## 1. Ledger Contract

- [x] 1.1 Add immutable trusted occurrence tokens with stable ID, phase, order,
  and raw value; preserve equal primitives and reused objects as independent
  physical events.
- [x] 1.2 Add immutable ledger accessors for semantic primary, chronological
  events, compensations, ordered-distinct identity, and fold-local graph.
- [x] 1.3 Merge nested ledgers cycle-safely by reusing occurrence history while
  freshly observing each current nested carrier/raw edge exactly once per fold.
- [x] 1.4 Keep all caller values and graphs unchanged.

## 2. Bounded Iterative Observation

- [x] 2.1 Replace recursive traversal with a FIFO queue bounded to 4096 unique
  nodes and 8192 edges.
- [x] 2.2 Enumerate only present numeric own keys of normal sparse `errors`
  arrays, including high indices, in numeric order; never scan by length.
- [x] 2.3 Convert brand, own-key, descriptor, accessor, proxy, node-budget, and
  edge-budget failures into stable operation-owned observation occurrences;
  retain semantic primary and never expose a naked `RangeError`.

## 3. Trusted Typed Boundary and Consumers

- [x] 3.1 Project a `TaskServiceError` only from the exact primary classified at
  the trusted fold boundary; reject forged/untrusted carriers.
- [x] 3.2 Export ledger reads and typed-boundary helpers from the core barrel.
- [x] 3.3 Migrate generic TaskCard compensation folds and backend JSON/error
  consumers while preserving existing HTTP envelopes.

## 4. Requirement-to-Test Evidence

- [x] 4.1 Dedicated core test: equal primitives and reused `Error` values at
  distinct phases -> unique occurrence IDs and stable phase/order; caller
  descriptors/graphs remain unchanged.
- [x] 4.2 Dedicated core test: mutable `cause`, accessor result, and Proxy raw
  edges across two independent folds plus cyclic nested ledgers -> inherited
  history reused and each current graph freshly observed once.
- [x] 4.3 Dedicated core test: node and edge budgets at N-1/N/N+1 -> exact
  boundary behavior, stable truncation occurrence, unchanged primary.
- [x] 4.4 Dedicated core test: max-length sparse errors array with few low/high
  numeric keys -> no length-wide reads and numeric present-key order.
- [x] 4.5 Dedicated core test: 25K+ cause chain, graph cycle/alias, throwing
  accessor, and trapping Proxy -> bounded completion, no stack overflow or
  naked RangeError, stable observation occurrence.
- [x] 4.6 Dedicated core test: trusted exact and Proxy `TaskServiceError` ->
  exact typed boundary; forged typed-looking value -> undefined.
- [x] 4.7 Generic TaskCard test: publication cleanup primary and compensation ->
  exact typed error plus ledger, no private settlement behavior.
- [x] 4.8 Backend route test: trusted typed primary plus compensation -> existing
  status/category/message/evidence JSON; unknown/untrusted input -> generic 500.
- [x] 4.9 Red proof: run the dedicated core and backend patterns on base
  `5a450a97f2a474af2f4db26bd9ee198adb7395ec`; persist exact command, exit,
  failure summary, and replayable test patch under tracked `evidence/`.
- [x] 4.10 Round 2 diagnosis: replay mutable nested-fold and 25K iterative
  traversal tests on parent source `b6c7977...`; persist the applicable patch,
  exact red output, and Child A green result under tracked `evidence/`.
- [x] 4.11 Restore all 17 base service scenarios that had obsolete envelope
  assertions and migrate each one to exact-primary, occurrence-event,
  ordered-distinct, or observed-graph assertions without dropping mutable,
  hardlink, publication, Proxy, undefined/falsy, cycle, release, consume,
  cleanup, retry, identity, or resource coverage. Record the deliberate
  accessor oracle change from one global read to one fresh read per fold.

## 5. Risk-Pack and Completion Evidence

- [x] 5.1 Public/schema/legacy compatibility: focused TaskCard and backend
  public-boundary tests pass with unchanged response shapes.
- [x] 5.2 Concurrency/order and error handling: dedicated occurrence/phase/order,
  cycle, alias, accessor, Proxy, and nested-fold tests pass.
- [x] 5.3 Resource limits: N-1/N/N+1 node/edge rows, max sparse array, and 25K+
  chain pass within deterministic budgets.
- [x] 5.4 Evidence lineage: red-before patch/report replay from a clean checkout;
  no `.workplans` dependency and no `red-proof` stash remains.
- [x] 5.5 Release compatibility: no dependency manifest, Zero, workspace store,
  idempotency service, watcher, or private settlement diff.
- [x] 5.6 Run focused tests, full core/backend tests, typecheck,
  `npx --yes bun@1.2.19 run check`, strict OpenSpec validation,
  `git diff --check`, stash hygiene, and zero/submodule diff checks.
- [x] 5.7 Compare the giant core-service test declarations and full-suite pass
  count with base `5a450a97...`; retain every base declaration (S31/S32 may use
  their ledger-equivalent names) and add the dedicated ledger coverage without
  weakening or deleting a base scenario.
