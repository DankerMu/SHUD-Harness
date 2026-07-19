## Context

Issue #108 is split so the reusable failure-occurrence foundation can be
reviewed independently from private exact-transition settlement. Fixture level:
expanded. Repair intensity: high. Project profile: SHUD-Harness.

## Goals / Non-Goals

Goals:
- Preserve physical occurrence multiplicity even when values are equal or
  object identities are reused.
- Isolate every ledger-producing fold behind a unique operation-owned carrier;
  the same raw object reused by sequential, concurrent, or reentrant folds
  cannot select or overwrite another operation's ledger.
- Keep event ID, phase, order, semantic primary, and ordered-distinct identity
  views stable across nested folds.
- Re-observe mutable nested ledger carriers and their raw edges once per fold.
- Bound arbitrary graph observation iteratively and retain stable truncation
  evidence without replacing the semantic primary.
- Preserve the exact raw semantic primary through accessors and preserve trusted
  `TaskServiceError` HTTP behavior without mutating caller error objects.

Non-goals:
- Private transition tickets, watcher behavior, or exact-generation settlement.
- Workspace-record and idempotency business-state changes beyond the narrow
  shared release-producer symbols required for carrier/phase compatibility.
- Serialization of ledgers into public HTTP payloads.
- Recursive discovery of inherited/prototype graph properties.

## Decisions

1. An occurrence, not a thrown value, is the accounting unit. Only
   `captureFailureOccurrence()` can mint trusted immutable tokens. Equal
   primitives and a reused `Error` therefore remain separate events; the
   ordered-distinct view collapses object aliases only and intentionally keeps
   primitive occurrence slots.

2. A ledger-producing fold always returns a fresh operation-owned `Error`
   carrier. Its private `WeakMap` record is the only ledger authority. Raw
   primaries are never ledger keys or compatibility aliases, so two folds that
   reuse the same raw object remain distinguishable. `failureLedger(raw)` is
   undefined; `semanticPrimaryValue(carrier)` returns the exact raw value,
   including `null` and `undefined`, and `semanticPrimaryError(carrier)` returns
   the exact raw `Error` when one exists. A single uncoupled failure may still
   propagate raw when no ledger is created.

3. Graph observation is iterative and all engine-controlled work is bounded.
   A FIFO queue observes at most 4096 unique object nodes and 8192 graph edges.
   After an engine operation returns, the ledger inspects at most 8192 numeric
   keys per container, performs at most 65536 total controlled
   prototype/property/descriptor/accessor operations, and records at most 256
   ordinary observation failures plus one stable occurrence for each exhausted
   budget kind. Every controlled unit is charged before work. It reads only own
   `semanticPrimary`, `errors`, and `cause` descriptors. Normal sparse arrays
   enumerate present numeric own keys in numeric order without scanning by
   `length`; once `Reflect.ownKeys()` or a Proxy trap returns, deceptive key
   lists cannot force unbounded ledger-side filtering, sorting, descriptor
   reads, or event growth. JavaScript cannot bound the engine's allocation of
   the returned key array or preempt a trap that never returns; the guarantee
   begins when that engine operation returns or throws.

4. Any observation failure or truncation is an operation-owned occurrence with
   phase `observation` and a stable exported diagnostic value. Node-limit,
   edge-limit, own-key, descriptor/accessor, array-brand, and primary-brand
   failures are ledger events. Observation never throws a naked traversal or
   stack-overflow error and never changes the semantic primary.

5. Each independent fold rebuilds `observedGraph`. Inherited occurrence tokens
   are reused by ID only through an explicit trusted carrier/ref adoption;
   passing the same raw object again is a new capture, never implicit adoption.
   Inherited graph nodes and edges are not copied. Adoption is cycle-safe and
   queues the carrier/raw semantic primary for fresh observation once. Events
   remain strictly sorted by immutable occurrence order; the semantic primary
   is identified by the separate `primary` field and is never forced to index
   zero.

6. Typed compatibility is capability-based and does not trust prototype shape.
   Real `TaskServiceError` instances receive an unforgeable constructor-owned
   private brand. A controlled factory may create a trusted Proxy and privately
   bind it to the branded target; arbitrary Proxy/target registration is not an
   API. A folded carrier stores a private typed view of the verified target,
   while semantic-primary access returns the exact raw instance or Proxy.
   Prototype-created, prototype-spoofing, raw `AggregateError`, and ledger-like
   values cannot forge typed status/category fields.

7. TaskCard and backend consume only carrier/ledger and trusted typed-boundary
   APIs. The backend resolves a carrier typed view before any raw unwrap, so a
   Proxy is not reclassified or touched twice. Existing typed HTTP status,
   category, message, user message, retryability, evidence references, and
   recommended actions remain byte-for-byte equivalent; unknown values still
   map to the existing generic 500 envelope.

8. Physical phase belongs to the producer catch site. Shared release helpers
   and their TaskCard, idempotency, workspace, and backend call sites transport
   explicit occurrences/refs so these complete vectors are stable:
   `body + failed release -> body, final_release`; fulfilled body plus failed
   first release and failed recovery/settlement -> `initial_release,
   settlement`; a final resource release after settlement -> `final_release`.
   Array position is not used to guess phase after the fact.

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

- Governing invariant: Every physical failure occurrence belongs to exactly one
  immutable operation carrier in strict capture order; independent folds never
  share ledger authority through raw identity, observation work is bounded
  without mutating callers, and only constructor/factory capabilities may
  project a typed boundary.
- Source-of-truth identity/contract: trusted `FailureOccurrence.occurrenceId`,
  `phase`, `order`, ledger primary, and fold-local `observedGraph`.
- Producers: capture/adopt/fold APIs, preservation/release helpers, and generic
  TaskCard/backend/idempotency/workspace compensation/release call sites.
- Validators/preflight: trusted-token validation, cycle-safe nested-ledger
  adoption, error/array brand checks, own descriptor reads, and budgets.
- Storage/cache/query: private fold-owner/ref/carrier/ledger/typed-view brands
  and WeakMaps; raw thrown values are never ledger keys; no persisted state.
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
  - Same raw `Error` used by sequential, concurrent, and reentrant folds ->
    unique carriers, isolated immutable ledgers, raw has no ledger alias.
  - Explicit trusted carrier adoption -> inherited event IDs appear once and
    current edges are freshly observed; recapturing its raw primary does not
    inherit history.
  - Node/edge budget at N-1/N/N+1 -> bounded completion; only the crossing case
    adds a stable observation occurrence; semantic primary remains exact.
  - Max-length sparse errors array with few high numeric own indices -> present
    keys are observed in numeric order without a length-wide scan.
  - 25K+ cause chain, cyclic/fresh-per-hop prototypes, deceptive own keys,
    repeated descriptor failures, aliases, throwing accessor, or trapping
    Proxy -> after each engine call returns, no more than 8192 keys per
    container, 65536 total controlled operations, and 256 ordinary observation
    failures are consumed; one occurrence per exhausted budget, no naked
    RangeError, and unchanged semantic primary.
  - Revoked `errors` array Proxy -> one array-brand observation failure and no
    child edge/node on that failed path.
  - Exact branded or controlled-Proxy `TaskServiceError` plus compensation ->
    semantic accessor returns the exact raw value and backend preserves every
    typed HTTP field from the trusted target.
  - Prototype-created/spoofed typed value, raw `AggregateError`, or untrusted
    ledger shape -> no typed view; backend retains the generic 500 contract.
  - Release helper body/release/settlement failures -> exact complete phase
    vectors and strictly increasing unique event orders at real producers.

## Boundary-Surface Checklist

- Shared helper roots: compensation preservation, release preservation, and
  typed-error constructor brand/adapter.
- Public entrypoints: core barrel exports and backend JSON error boundary.
- Read surfaces: ledger/event/graph/ordered-distinct accessors.
- Producer/consumer evidence boundaries: occurrence capture -> ledger fold ->
  TaskCard/backend consumer -> tracked verification evidence.
- Failure/rollback surfaces: generic TaskCard cleanup folds, backend route
  compensation helpers, and narrow shared release call sites in
  idempotency/workspace services.
- Unchanged downstream consumers: private generation settlement/watchers,
  unrelated workspace/idempotency state transitions, frontend, and Zero.

## Risks / Trade-offs

- The bounded graph can be incomplete by design. Stable observation events make
  truncation explicit while the semantic primary and occurrence history remain
  usable.
- A unique carrier is not `===` the raw `Error` and does not inherit arbitrary
  private-field or external-WeakMap brands. Compatibility is the exact raw
  accessor contract; raw objects remain untouched and their own methods still
  work when invoked on the accessor result.
- `Reflect.ownKeys()` on a normal array is proportional to present own keys. The
  engine constructs its returned array before user code regains control, so a
  hostile same-realm trap can allocate or never return. Ledger-controlled work
  after return/throw is bounded; engine-internal allocation/preemption is an
  explicit platform limit.
- Global numeric order is process-local and monotonic. It is diagnostic
  ordering, not a persisted protocol or cross-process clock.
