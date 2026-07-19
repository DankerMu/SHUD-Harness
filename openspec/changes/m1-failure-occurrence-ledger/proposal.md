## Why

M1 compensation paths currently infer failure identity from mutable JavaScript
error graphs and collapse repeated equal primitives or reused `Error` objects.
That loses physical failure occurrences, can make a typed `TaskServiceError`
disappear at a public boundary, and performs recursive or length-wide discovery
on adversarial graphs. Issue #108 requires a reusable ledger foundation before
private exact-transition settlement work continues.

## What Changes

- Add operation-owned failure occurrences with stable IDs, phase, and order.
- Fold occurrences into a trusted ledger without mutating caller-owned values.
- Observe `semanticPrimary`, `errors`, and `cause` iteratively with deterministic
  limits of 4096 nodes and 8192 edges.
- Enumerate present numeric own keys of normal sparse arrays, including high
  indices, without scanning `0..length-1`.
- Append stable operation-owned observation occurrences when a node, edge,
  own-key, descriptor, accessor, proxy-brand, or traversal budget blocks full
  observation; never expose a naked observation `RangeError`.
- Refresh every nested ledger carrier and its current raw edges once per
  independent fold while reusing inherited occurrence history only.
- Expose typed `TaskServiceError` compatibility exclusively through a trusted
  ledger view and migrate generic TaskCard/backend consumers without changing
  existing HTTP envelopes.
- Add a dedicated replayable test file and tracked red-before evidence.

## Capabilities

### New Capabilities

- `failure-occurrence-ledger`: bounded, occurrence-exact failure preservation
  and trusted typed-error boundary projection.

### Modified Capabilities

- None. This is an M1 bug-fix fixture; no archived baseline capability exists.

## Impact

- Core: compensation preservation, typed error adapter, service exports, and
  generic TaskCard compensation folds.
- Backend: generic route error serialization and typed-boundary consumers.
- Tests: dedicated ledger contract tests plus backend HTTP compatibility tests.
- No workspace-record-store, idempotency-service, private settlement, Zero,
  dependency, schema, or public HTTP payload changes.
