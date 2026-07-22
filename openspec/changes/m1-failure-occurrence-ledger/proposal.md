## Why

M1 compensation paths currently infer failure identity from mutable JavaScript
error graphs and collapse repeated equal primitives or reused `Error` objects.
That loses physical failure occurrences, can make a typed `TaskServiceError`
disappear at a public boundary, and performs recursive or length-wide discovery
on adversarial graphs. Issue #108 requires a reusable ledger foundation before
private exact-transition settlement work continues.

## What Changes

- Add operation-owned failure occurrences with stable IDs, phase, and order.
- Fold occurrences into a unique operation-owned `Error` carrier without
  mutating caller-owned values; recover the exact raw primary only through
  trusted semantic-primary accessors.
- Observe `semanticPrimary`, `errors`, and `cause` iteratively with deterministic
  limits of 4096 nodes and 8192 edges.
- Enumerate present numeric own keys of normal sparse arrays, including high
  indices, without scanning `0..length-1`.
- Append stable operation-owned observation occurrences when a node, edge,
  own-key, descriptor, accessor, proxy-brand, or traversal budget blocks full
  observation; never expose a naked observation `RangeError`.
- Adopt nested history only from an explicit trusted carrier/ref. Reusing the
  same raw `Error` in another fold starts an isolated operation ledger.
- Expose typed `TaskServiceError` compatibility exclusively through a trusted
  constructor brand, controlled Proxy factory, and carrier view; migrate
  generic TaskCard/backend consumers without changing existing HTTP envelopes.
- Bound prototype walking, own-key expansion, descriptor/accessor work, and
  observation-failure growth in addition to node and edge counts.
- Preserve physical `body`, `initial_release`, `settlement`, and
  `final_release` phases at the actual release producers.
- Add a dedicated replayable test file and tracked red-before evidence.

## Capabilities

### New Capabilities

- `failure-occurrence-ledger`: bounded, occurrence-exact failure preservation
  and trusted typed-error boundary projection.

### Modified Capabilities

- None. This is an M1 bug-fix fixture; no archived baseline capability exists.

## Impact

- Core: compensation preservation, typed error adapter/brand, service exports,
  generic TaskCard compensation folds, and the narrow release-producer symbols
  in idempotency/workspace services that consume the shared helper.
- Backend: generic route error serialization and typed-boundary consumers.
- Tests: dedicated ledger contract tests plus backend HTTP compatibility tests.
- No private transition-ticket/generation settlement, watcher, Zero,
  dependency, persisted schema, or public HTTP payload changes. Whole-file
  idempotency/workspace behavior remains out of scope except the shared release
  helper call sites needed for carrier and phase compatibility.
