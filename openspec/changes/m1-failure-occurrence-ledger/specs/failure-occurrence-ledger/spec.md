## ADDED Requirements

### Requirement: Failure accounting uses trusted physical occurrences

The compensation boundary SHALL represent every caught physical failure with an
immutable operation-owned occurrence carrying a unique ID, phase, monotonic
order, and exact raw value. Equal primitives and reused object identities at
different physical failure sites MUST remain distinct chronological events.
The ordered-distinct compatibility view SHALL collapse repeated object identity
only and SHALL retain distinct primitive occurrence slots. Caller-owned thrown
values and their property graphs MUST NOT be mutated.

#### Scenario: equal and reused values keep physical multiplicity

- **WHEN** equal primitives or one reused `Error` are caught at two phases
- **THEN** the ledger contains two distinct occurrence IDs in phase/order
- **AND** the ordered-distinct view collapses only the reused object identity
- **AND** caller-owned descriptors and graph values remain unchanged

### Requirement: Every fold freshly observes a bounded own error graph

Each independent fold SHALL rebuild its graph observation from current own
`semanticPrimary`, `errors`, and `cause` properties. Inherited trusted
occurrence history MAY be reused, but inherited observed graph nodes or edges
MUST NOT be copied as current evidence. A nested ledger carrier and its current
raw edges SHALL be observed exactly once per fold, including cyclic ledgers,
mutable causes, accessors, and proxies.

Observation SHALL use an iterative work queue with a maximum of 4096 unique
object nodes and 8192 graph edges. For a normal array in `errors`, discovery
SHALL enumerate present numeric own keys, including high indices, in numeric
order without scanning `0..length-1`. A brand, own-key, descriptor, accessor,
proxy, node-budget, or edge-budget failure SHALL append stable operation-owned
observation evidence and stop only the affected observation path. It MUST NOT
replace the semantic primary or expose a naked traversal/stack `RangeError`.

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

- **WHEN** the graph contains a 25K+ cause chain, cycle, alias, throwing
  accessor, or trapping Proxy
- **THEN** observation finishes iteratively within the declared budgets
- **AND** failures/truncation are ledger observation occurrences
- **AND** no naked stack-overflow or observation `RangeError` escapes

### Requirement: Typed TaskServiceError projection is trusted and compatible

A `TaskServiceError` boundary view SHALL be available only when the exact
semantic primary was classified by the trusted ledger fold. Caller-shaped
objects, raw `AggregateError` graphs, and untrusted ledger-like values MUST NOT
forge typed status/category behavior. Generic TaskCard and backend consumers
SHALL use the trusted view and retain their existing HTTP response contract.

#### Scenario: exact typed primary survives compensation

- **WHEN** an exact or proxy-wrapped `TaskServiceError` is the primary and a
  compensation also fails
- **THEN** the trusted boundary returns that exact primary object
- **AND** backend status, category, message, retryability, evidence references,
  and recommended actions remain unchanged
- **AND** both physical failure occurrences remain in the ledger

#### Scenario: forged typed shape stays generic

- **WHEN** an untrusted value imitates `TaskServiceError` fields or ledger shape
- **THEN** no trusted typed view is returned
- **AND** backend serialization uses its existing generic 500 envelope
