## Context

Issue #108 is split so the reusable failure-occurrence foundation can be
reviewed independently from private exact-transition settlement. Fixture level:
expanded. Repair intensity: high. Project profile: SHUD-Harness.

## Goals / Non-Goals

Goals:
- Preserve physical occurrence multiplicity even when values are equal or
  object identities are reused.
- Keep event ID, phase, order, semantic primary, and ordered-distinct identity
  views stable across nested folds.
- Re-observe mutable nested ledger carriers and their raw edges once per fold.
- Bound arbitrary graph observation iteratively and retain stable truncation
  evidence without replacing the semantic primary.
- Preserve exact typed `TaskServiceError` behavior at TaskCard and backend
  boundaries without mutating or replacing caller error objects.

Non-goals:
- Private transition tickets, watcher behavior, exact-generation settlement,
  workspace-record-store, or idempotency-service changes.
- Serialization of ledgers into public HTTP payloads.
- Recursive discovery of inherited/prototype graph properties.

## Decisions

1. An occurrence, not a thrown value, is the accounting unit. Only
   `captureFailureOccurrence()` can mint trusted immutable tokens. Equal
   primitives and a reused `Error` therefore remain separate events; the
   ordered-distinct view collapses object aliases only and intentionally keeps
   primitive occurrence slots.

2. A ledger is operation-owned metadata in a `WeakMap`; no caller error,
   `AggregateError`, array, accessor owner, or proxy target is modified. The
   public carrier remains the semantic primary when it is error-like; a
   `PreservedNonErrorThrownValue` is used only when an object carrier is needed
   for a non-error primary.

3. Graph observation is iterative. A FIFO work queue observes at most 4096
   unique object nodes and records at most 8192 graph edges. It reads only own
   `semanticPrimary`, `errors`, and `cause` descriptors. Normal sparse arrays
   are enumerated through numeric own keys returned by `Reflect.ownKeys()`,
   sorted numerically, so a max-length sparse array with a few present entries
   costs in present keys rather than `length`.

4. Any observation failure or truncation is an operation-owned occurrence with
   phase `observation` and a stable exported diagnostic value. Node-limit,
   edge-limit, own-key, descriptor/accessor, array-brand, and primary-brand
   failures are ledger events. Observation never throws a naked traversal or
   stack-overflow error and never changes the semantic primary.

5. Each independent fold rebuilds `observedGraph`. Inherited occurrence tokens
   are reused by ID, but inherited graph nodes and edges are not copied.
   Encountering a nested ledger adopts its event history once (cycle-safe) and
   queues the carrier for fresh observation once. Mutable cause/accessor/proxy
   state between folds is therefore reflected only in the newer ledger.

6. Typed compatibility is capability-based. The TaskService adapter classifies
   the primary once at the fold boundary, attaches the new ledger to that exact
   `TaskServiceError`, and stores a trusted typed view in a private `WeakMap`.
   `taskServiceErrorAtBoundary()` rejects ledger carriers without that trusted
   view; caller-shaped objects cannot forge typed status/category fields.

7. TaskCard and backend consume only generic ledger APIs. Existing typed HTTP
   status/category/message/evidence fields remain byte-for-byte equivalent;
   unknown values still map to the existing generic 500 envelope.

## Risk Packs

- Public API / CLI / script entry: selected - backend JSON is a public seam.
- Config / project setup: not selected - no setup/config change.
- File IO / path safety / overwrite: not selected - no path authority behavior.
- Schema / columns / units / field names: selected - internal ledger and typed
  adapter contracts are new exported TypeScript shapes; HTTP schema is stable.
- Auth / permissions / secrets: not selected - no authority or secret surface.
- Concurrency / shared state / ordering: selected - global occurrence order and
  fold-local observation order must be deterministic.
- Resource limits / large input / discovery: selected - arbitrary graphs,
  sparse arrays, and 25K+ cause chains are required adversarial inputs.
- Legacy compatibility / examples: selected - TaskCard/backend error consumers
  and unchanged HTTP envelopes must remain compatible.
- Error handling / rollback / partial outputs: selected - the ledger preserves
  primary plus compensation failures and observation truncation.
- Release / packaging / dependency compatibility: selected - exported core API
  changes ship without dependency or Zero changes.
- Documentation / migration notes: selected - replayable tracked evidence and
  OpenSpec fixture document the new internal contract.

Domain packs:
- Scientific governance / PI gate / evidence lineage: selected - verification
  evidence must bind to replayable tests and not `.workplans` state.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no
  solver or R runtime behavior.
- Zero adapter / tool registry / agent role governance: not selected - no Zero
  adapter or role/tool change.

## Invariant Matrix

- Governing invariant: Every physical failure occurrence is retained exactly
  once in operation order, every independent fold freshly and boundedly
  observes the current own error graph without mutating it, and only trusted
  ledger metadata may project an exact typed boundary.
- Source-of-truth identity/contract: trusted `FailureOccurrence.occurrenceId`,
  `phase`, `order`, ledger primary, and fold-local `observedGraph`.
- Producers: `captureFailureOccurrence`, preservation helpers, and generic
  TaskCard/backend compensation fold sites.
- Validators/preflight: trusted-token validation, cycle-safe nested-ledger
  adoption, error/array brand checks, own descriptor reads, and budgets.
- Storage/cache/query: private occurrence/ledger/typed-view WeakMaps; no
  persisted state.
- Public routes/entrypoints: core service exports and backend task API error
  serialization.
- Frontend/downstream consumers: unchanged API clients reading the existing
  error envelope.
- Failure paths/rollback/stale state: TaskCard cleanup folds, nested ledgers,
  hostile accessors/proxies, budget truncation, cyclic/aliased graphs.
- Evidence/audit/readiness: dedicated core test, backend route test, tracked
  red-before report/patch, strict OpenSpec validation, root check, and git/
  submodule hygiene.
- Regression rows:
  - Equal primitives or reused `Error` at two phases -> two event IDs in order;
    ordered-distinct collapses only the reused object identity.
  - Nested ledger carrier changes its cause/accessor/proxy edges between folds
    -> inherited event IDs remain stable and the newer graph contains exactly
    the current edges once, including cycles.
  - Node/edge budget at N-1/N/N+1 -> bounded completion; only the crossing case
    adds a stable observation occurrence; semantic primary remains exact.
  - Max-length sparse errors array with few high numeric own indices -> present
    keys are observed in numeric order without a length-wide scan.
  - 25K+ cause chain, cycles, aliases, throwing accessor, or trapping Proxy ->
    no recursion overflow/naked RangeError; stable observation evidence is
    retained and the primary is unchanged.
  - Exact `TaskServiceError` plus compensation -> TaskCard/backend preserve the
    same typed object and existing HTTP status/category/message/evidence.
  - Forged typed-looking carrier or untrusted ledger shape -> no typed view;
    backend retains the generic 500 contract.

## Boundary-Surface Checklist

- Shared helper roots: compensation preservation and typed-error adapter.
- Public entrypoints: core barrel exports and backend JSON error boundary.
- Read surfaces: ledger/event/graph/ordered-distinct accessors.
- Producer/consumer evidence boundaries: occurrence capture -> ledger fold ->
  TaskCard/backend consumer -> tracked verification evidence.
- Failure/rollback surfaces: generic TaskCard cleanup folds and backend route
  compensation helpers only.
- Unchanged downstream consumers: workspace-record-store,
  idempotency-service, private settlement/watchers, frontend, and Zero.

## Risks / Trade-offs

- The bounded graph can be incomplete by design. Stable observation events make
  truncation explicit while the semantic primary and occurrence history remain
  usable.
- `Reflect.ownKeys()` on a normal array is proportional to present own keys, but
  a proxy may trap or throw. The trap is attempted once, converted to stable
  observation evidence, and traversal stops for that errors container.
- Global numeric order is process-local and monotonic. It is diagnostic
  ordering, not a persisted protocol or cross-process clock.
