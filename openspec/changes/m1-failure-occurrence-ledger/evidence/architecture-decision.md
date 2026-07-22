# Architecture Decision Brief: operation-owned failure carrier

Date: 2026-07-18
Change: `m1-failure-occurrence-ledger`
Status: accepted for Child A fixture repair

## Decision context

Round 1 confirmed that a process-global `WeakMap<raw Error, ledger>` leaks
history across independent operations, lets a later/reentrant fold overwrite an
earlier result, and cannot tell explicit nested adoption from unrelated raw
identity reuse. The fixture simultaneously required the fold result to remain
strictly identical to that raw object. Those requirements are contradictory
when `failureLedger(value)` receives only the thrown value.

The required qualities are:

1. immutable isolation for sequential, concurrent, and reentrant operations;
2. exact raw semantic-primary recovery, including nullish and custom-branded
   errors;
3. unforgeable trusted `TaskServiceError` projection;
4. bounded hostile graph observation;
5. explicit nested adoption and accurate physical phases;
6. migration compatibility for existing internal consumers and HTTP envelopes.

## Options considered

| Option | Operation isolation | Query after propagation | Compatibility / risk | Decision |
|---|---|---|---|---|
| Raw-object single-slot WeakMap | No | Ambiguous after reuse | Current stale/reentrant corruption | Reject |
| Raw-object multimap | Stores copies but cannot select one from the same key | Ambiguous without another token | `latest`, `all`, or `pop` each leaks, loses idempotence, or changes query semantics | Reject |
| AsyncLocalStorage + raw identity | Only while the exact context remains active | Context is lost/restored at outer catch boundaries | Async transport and rethrow are unreliable | Reject |
| Symbol metadata / copy-on-write raw object | No general solution | Ambiguous on first reuse vs nested transport | Mutates frozen/caller/Proxy values; still cannot select a ledger | Reject |
| Opaque token alongside raw error | Yes if every caller carries both | Yes with mandatory token plumbing | Replaces the exception protocol across all callers | Reserve; equivalent to a carrier when thrown |
| Fresh `Error` carrier per ledger-producing fold | Yes | Yes: carrier is the operation identity | Carrier is not raw; exact raw remains available through trusted accessors | Accept |

## Impossibility boundary

For operations A and B that reuse `raw`, if both folds return values satisfying
`resultA === resultB === raw`, then after both complete the calls
`failureLedger(resultA)` and `failureLedger(resultB)` have identical arguments
and ambient state. A deterministic API cannot return A's ledger for one call and
B's ledger for the other. A separate operation identity is therefore required;
the thrown carrier supplies it.

## Chosen contract

- Every ledger-producing fold returns a fresh frozen `Error` carrier. The raw
  primary is never a ledger key or compatibility alias.
- `failureLedger(carrier)` returns that carrier's immutable ledger;
  `failureLedger(raw)` is undefined.
- `semanticPrimaryValue(carrier)` and `semanticPrimaryError(carrier)` recover
  exact raw identity. Null and undefined are values, not an absent-ledger signal.
- Nested history is adopted only through a trusted carrier/ref. Recapturing a
  raw primary starts a new isolated operation.
- `events` is strictly sorted by immutable occurrence order. `primary` remains
  a separate semantic pointer and is not moved to event index zero.
- Real `TaskServiceError` instances use a constructor-owned private brand.
  Trusted Proxy support is available only through a factory that privately owns
  the proxy-to-branded-target binding. Arbitrary prototype or Proxy claims are
  rejected. Carrier typed views return the trusted target; semantic accessors
  still return the exact raw Proxy.
- Observation charges finite budgets before ledger-controlled prototype, key,
  descriptor, accessor, node, edge, and event work after engine calls return.
  Limits are 8192 keys per container, 65536 total controlled property/prototype
  operations, and 256 ordinary observation failures; each exhausted budget kind
  records one stable occurrence. A failed array-brand check terminates that
  path. Engine allocation inside `Reflect.ownKeys()` and a non-returning
  same-realm Proxy trap are explicit JavaScript platform limits.
- Physical failure phases are captured at producer catch sites; release helper
  consumers in TaskCard, backend, idempotency, and workspace are migrated by
  symbol rather than excluded wholesale.

## Compatibility and migration

- Replace `carrier === raw` assertions with exact semantic-primary assertions.
- Custom private-field/external-WeakMap `Error` behavior is preserved on the raw
  object returned by semantic accessors, not on the carrier itself.
- Consumers must inspect the carrier through ledger/typed-boundary accessors;
  generic `instanceof` or prototype walking is not ledger authority.
- Public HTTP payloads and typed field values do not change.
- Private transition tickets/generation settlement remain in the stacked Child
  B; only shared carrier/phase consumer symbols move into Child A.

## Validation and fallback

The decision is falsified if tests cannot demonstrate isolated sequential,
concurrent, and reentrant folds; explicit-only adoption; exact raw recovery;
constructor/factory-only typed trust; bounded hostile work; and complete release
phase vectors without weakening existing consumers. Before merge the fallback
is to abandon Child A and redesign the exception protocol around an explicit
token. Returning to raw-object ledger authority is not a valid fallback.

No repository ADR is added: this contract is still an unmerged, change-local
fixture correction. If merged APIs later become a durable cross-feature
exception protocol, promote this brief to `docs/adr/` with compatibility history.
