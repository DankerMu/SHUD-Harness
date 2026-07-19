## ADDED Requirements

### Requirement: Failure accounting uses trusted physical occurrences

The compensation boundary SHALL represent every caught physical failure with an
immutable operation-owned occurrence carrying a unique ID, phase, monotonic
order, and exact raw value. Equal primitives and reused object identities at
different physical failure sites MUST remain distinct chronological events.
Every ledger-producing fold SHALL return a unique operation-owned `Error`
carrier. A raw primary MUST NOT be a ledger key or compatibility alias; two
independent folds reusing the same raw object MUST have isolated ledgers.
Trusted nested history SHALL be adopted only from an explicit carrier/ref.
Ledger events MUST have strictly increasing unique order, while the separate
primary field identifies semantic primacy without reordering the event vector.
The ordered-distinct compatibility view SHALL collapse repeated object identity
only and SHALL retain distinct primitive occurrence slots. Caller-owned thrown
values and their property graphs MUST NOT be mutated.

#### Scenario: equal and reused values keep physical multiplicity

- **WHEN** equal primitives or one reused `Error` are caught at two phases
- **THEN** the ledger contains two distinct occurrence IDs in phase/order
- **AND** the ordered-distinct view collapses only the reused object identity
- **AND** caller-owned descriptors and graph values remain unchanged

#### Scenario: operation carriers isolate raw identity reuse

- **WHEN** sequential, concurrent, or reentrant folds reuse one raw `Error`
- **THEN** every ledger-producing fold returns a distinct carrier
- **AND** each carrier resolves only its own immutable occurrence history
- **AND** the raw `Error` resolves no ledger
- **AND** semantic-primary access returns the exact raw `Error`

#### Scenario: adoption is explicit and chronological

- **WHEN** one fold explicitly adopts a trusted prior carrier and another fold
  recaptures that carrier's raw semantic primary
- **THEN** only the explicit adoption reuses prior occurrence IDs
- **AND** each reused occurrence appears exactly once
- **AND** every event vector has strictly increasing unique order

#### Scenario: nullish and custom-branded primaries remain exact

- **WHEN** a ledger primary is `null`, `undefined`, a private-field `Error`, or
  an externally WeakMap-branded `Error`
- **THEN** semantic-primary access returns the exact raw value
- **AND** the raw error's descriptors, brand, and methods remain unchanged

### Requirement: Every fold freshly observes a bounded own error graph

Each independent fold SHALL rebuild its graph observation from current own
`semanticPrimary`, `errors`, and `cause` properties. Inherited trusted
occurrence history MAY be reused, but inherited observed graph nodes or edges
MUST NOT be copied as current evidence. A nested ledger carrier and its current
raw edges SHALL be observed exactly once per fold, including cyclic ledgers,
mutable causes, accessors, and proxies.

Observation SHALL use an iterative work queue with a maximum of 4096 unique
object nodes and 8192 graph edges. After an engine operation returns, it SHALL
inspect at most 8192 numeric keys per container, perform at most 65536 total
controlled prototype/property/descriptor/accessor operations, and record at
most 256 ordinary observation failures plus one stable occurrence for each
exhausted budget kind. Every controlled unit SHALL be charged before the work.
For a normal
array in `errors`, discovery SHALL enumerate present numeric own keys, including
high indices, in numeric order without scanning `0..length-1`. A deceptive
Proxy key list MUST NOT cause unbounded ledger-side filtering, sorting,
descriptor reads, or failure-event growth after `Reflect.ownKeys()` returns.
The engine allocation needed to construct that returned key array and a trap
that never returns are explicit JavaScript platform limits. A brand, own-key,
descriptor, accessor, proxy,
node-budget, edge-budget, or work-budget failure SHALL append stable
operation-owned observation evidence and stop only the affected observation
path. An indeterminate array-brand result SHALL stop that `errors` path before a
child edge/node is added. Observation MUST NOT replace the semantic primary or
expose a naked traversal/stack `RangeError`.

#### Scenario: mutable nested ledger is current on every fold

- **WHEN** a nested ledger carrier changes its `cause`, accessor result, or
  proxy-observed raw edge between two independent folds
- **THEN** inherited occurrence IDs remain stable
- **AND** the second ledger graph contains the second fold's current edges once
- **AND** stale nodes or edges from the first fold are absent

#### Scenario: node and edge boundaries are deterministic

- **WHEN** graphs contain N-1, N, or N+1 nodes or edges for N equal to the
  declared budget
- **THEN** N-1 and N complete without a budget occurrence
- **AND** N+1 completes with one stable relevant observation occurrence
- **AND** semantic primary and chronological failure events remain available

#### Scenario: sparse max-length errors array costs present keys

- **WHEN** an `errors` array has maximum legal length and only a few present
  numeric own keys including a high index
- **THEN** only present keys are read and recorded in numeric order
- **AND** no length-wide scan or allocation occurs

#### Scenario: deep and hostile graphs remain bounded

- **WHEN** the graph contains a 25K+ cause chain, cyclic or fresh-per-hop
  prototype Proxy, deceptive key list, repeated descriptor failures, alias,
  throwing accessor, or trapping Proxy that eventually returns or throws
- **THEN** observation finishes iteratively within the declared budgets
- **AND** failures/truncation are ledger observation occurrences
- **AND** each exhausted budget contributes exactly one stable occurrence
- **AND** no more than 8192 returned numeric keys per container, 65536 total
  controlled operations, and 256 ordinary observation failures are consumed
  after the relevant engine calls return
- **AND** no naked stack-overflow or observation `RangeError` escapes

#### Scenario: failed array brand terminates one path

- **WHEN** an `errors` property resolves to a revoked array Proxy
- **THEN** exactly one array-brand observation failure is retained
- **AND** no `errors` child edge or node is added for that failed path

### Requirement: Typed TaskServiceError projection is trusted and compatible

A `TaskServiceError` boundary view SHALL be available only for a
constructor-branded real instance, a Proxy created by the controlled trusted
factory and privately bound to a branded target, or a carrier view derived from
one of those values. Prototype shape and arbitrary Proxy-reported prototypes
MUST NOT be trusted. Caller-shaped objects, raw `AggregateError` graphs, and
untrusted ledger-like values MUST NOT forge typed status/category behavior.
Generic TaskCard and backend consumers SHALL resolve the trusted carrier view
before raw unwrapping and retain their existing HTTP response contract.

#### Scenario: exact typed primary survives compensation

- **WHEN** an exact or proxy-wrapped `TaskServiceError` is the primary and a
  compensation also fails
- **THEN** semantic-primary access returns the exact raw object
- **AND** the trusted boundary returns the branded target used for field reads
- **AND** backend status, category, message, retryability, evidence references,
  and recommended actions remain unchanged
- **AND** both physical failure occurrences remain in the ledger

#### Scenario: forged typed shapes and graphs stay generic

- **WHEN** an untrusted value imitates `TaskServiceError` fields, prototype,
  Proxy prototype, ledger shape, or wraps a typed value in raw `AggregateError`
- **THEN** no trusted typed view is returned
- **AND** backend serialization uses its existing generic 500 envelope

### Requirement: Release producers retain physical phases

Shared release helpers SHALL make their TaskCard, backend, idempotency, and
workspace consumers capture phase at the physical catch site rather than infer it
from array position. Body failure followed by failed release SHALL produce the
complete phase vector `body, final_release`. A fulfilled body followed by failed
initial release and failed recovery/settlement SHALL produce
`initial_release, settlement`. A release after settlement SHALL use
`final_release`.

#### Scenario: body and final release both fail

- **WHEN** a body operation rejects and the subsequent resource release rejects
- **THEN** the ledger contains the complete vector `body, final_release`
- **AND** event orders are strictly increasing and unique

#### Scenario: initial release and settlement both fail

- **WHEN** the body fulfills, the first release rejects, and recovery or
  settlement rejects
- **THEN** the ledger contains `initial_release, settlement`
- **AND** real TaskCard, idempotency, workspace, and backend producer tests use
  the same phase contract where those paths exist

### Requirement: Occurrences are the sole post-catch failure authority

After a physical catch, an occurrence-bearing fold SHALL derive failure
presence, exact raw value, phase, order, adoption, and typed projection from
trusted occurrence/adoption entries only. It MUST NOT accept an independently
authoritative raw value or phase vector. Untrusted, duplicate, stale/reused,
reordered, phase-invalid, or incorrectly adopted entries SHALL fail closed
before publishing a carrier, ledger, or typed view. Nested history SHALL be
reused only through explicit trusted carrier adoption.

An explicit adoption SHALL retain one fresh occurrence whose exact raw value
is the carrier caught at the current physical site and SHALL import the prior
ledger IDs once. A direct `body` or `initial_release` SHALL appear only as the
primary entry; caller-supplied `observation` entries and a `settlement` after
`final_release` MUST fail closed. Real producer vectors `body, final_release`,
`initial_release, settlement`, settlement followed by final release, and
repeated final releases SHALL remain valid where those physical paths exist.

#### Scenario: mismatched or stale occurrence input fails closed

- **WHEN** a caller pairs a trusted occurrence with a different raw value or
  phase, reorders or duplicates occurrence entries, reuses a claimed entry, or
  supplies an invalid adoption
- **THEN** the fold reports a stable protocol error
- **AND** no carrier, ledger, or typed view is published
- **AND** concurrent claims of one fresh occurrence have exactly one winner

#### Scenario: a caught carrier keeps history and the new physical catch

- **WHEN** a trusted carrier is caught again and explicitly adopted into a new
  fold
- **THEN** every inherited occurrence ID appears once
- **AND** one fresh occurrence records the caught carrier's exact value, current
  phase, and later order
- **AND** the prior raw semantic primary remains exact

#### Scenario: invalid phase roles fail before publication

- **WHEN** a vector contains a later `body` or `initial_release`, a
  caller-provided `observation`, or a `settlement` after `final_release`
- **THEN** the fold reports a stable phase protocol error
- **AND** no entry is claimed and no carrier, ledger, or typed view is published

### Requirement: Async rejection presence is discriminated from its value

Release, finalizer, and authority-reconciliation producers SHALL represent
fulfilled, rejected, and not-attempted state with an explicit discriminant.
Exact `undefined`, `null`, and falsy rejection reasons MUST remain present
failures and MUST NOT select success, absence, fallback, or rollback behavior.

#### Scenario: undefined release or reconciliation rejection remains a failure

- **WHEN** cancellation or authority reconciliation rejects with exact
  `undefined`
- **THEN** the rejection occurrence remains in the complete phase/order vector
- **AND** the operation does not report false success or treat authority as
  absent
- **AND** cleanup, binding, cache-claim, snapshot, and durable-record state
  remain consistent with the failed operation

### Requirement: Authority transport uses an unforgeable shared capability

Authority transports SHALL be created and recognized only by a core-owned
closure capability backed by private state. Code MUST NOT recognize a transport
from caller-controlled fields or prototype shape and MUST NOT invoke a
caller-supplied constructor, getter, or reconstruction callback. A genuine
transport SHALL remain the exact ledger semantic primary; its privately trusted
inner `TaskServiceError` MAY provide the existing typed HTTP projection.

#### Scenario: genuine and forged authority transports remain distinct

- **WHEN** a genuine transport and a field-shaped or custom-constructor
  lookalike each cross a compensation/release fold
- **THEN** the genuine transport preserves exact outer identity, inner trusted
  typed projection, and the existing HTTP fields
- **AND** the lookalike constructor/getters are not invoked
- **AND** the lookalike remains generic and cannot replace the carrier or
  promote a nested typed error

### Requirement: Numeric-key budget is independent of key-list ordering

The failure ledger SHALL count canonical numeric keys independently of strings,
symbols, and the `length` key after one `Reflect.ownKeys()` call returns. It
SHALL observe at most 8192 numeric keys and SHALL record one
stable occurrence for every budget actually exhausted. If controlled work is
exhausted before the returned tail is classified, it SHALL record controlled
work exhaustion without claiming an unobserved numeric overflow.

#### Scenario: reordered nonnumeric keys do not consume numeric capacity

- **WHEN** a legal Array Proxy returns `length`, strings, or symbols before N
  or N+1 canonical numeric keys
- **THEN** N numeric keys produce N ordered edges without a numeric budget event
- **AND** N+1 numeric keys produce at most N ordered edges plus exactly one
  numeric-key budget occurrence
- **AND** when N+1 normal present descriptors prove an edge beyond N, exactly
  one edge-budget occurrence is also retained
- **AND** `Reflect.ownKeys()` is called once and every event, issue, and graph
  vector remains frozen with exact semantic primary
