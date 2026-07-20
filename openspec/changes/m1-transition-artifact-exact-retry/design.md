## Context

`WorkspaceRecordCleanupPermit` pins the observed physical generation and retains its descriptor until terminal settlement. The existing conditional-delete path isolates a public generation into a store-owned namespace before unlink. Child B keeps that first private authority instead of reconstructing public pathname history.

This change consumes the public occurrence ledger delivered by `m1-failure-occurrence-ledger`; it does not replace, copy, or extend that ledger's protocol.

## Decisions

1. `conditionalDeleteJsonRecordWithCleanupPermitAndExactFailureSettlement` is an explicit opt-in sibling of the legacy API. Default callers retain restoration semantics.
2. The first successful isolation captures a private ticket containing the permit, private path, namespace baseline, and exact generation expectation.
3. A ticket has one canonical settlement promise. Concurrent requests for the same ticket receive that promise; the private unlink runs once.
4. Successful private settlement returns `{ status: "recovered", settlement: "deleted" }`. Initial success and a false predicate are terminal and never start settlement.
5. After ticket capture the public pathname is observation-only. Missing public state, successor B, and ancestor ABA cannot authorize or block deletion of private A.
6. A private proof failure is irreversible for the attempt. Only a raw transient unlink rejection is retried; restored hardlink or namespace-mode drift is not reclassified as safe.
7. Action and directory-binding finalizer outcomes are captured separately. A successful finalizer cannot relabel an action rejection, while one object rejected at two physical release points produces two occurrences.
8. Transition guard and cleanup-lock consumers use the opt-in operation. A genuinely benign pre-mutation convergence is accepted only when the typed error explicitly carries `preMutationDisposition: "benign_convergence"` and is not already a ledger carrier.

## Result Matrix

| Initial operation | Private settlement | Final release | Result |
| --- | --- | --- | --- |
| deleted/missing/superseded/condition-not-met | not run | success | original result |
| pre-mutation failure | not run | success | original typed failure |
| post-isolation failure | private A deleted | success | recovered/deleted |
| post-isolation failure | private proof/unlink/namespace failure | success | initial-release primary plus settlement occurrence |
| any failure | any | final release fails | prior occurrences followed by final-release occurrence |

## Invariants

- Only the ticket's private physical A can be deleted.
- Public B is preserved byte-for-byte and by physical identity.
- No filesystem watcher or delayed callback participates in authority.
- Each permit, pinned descriptor, capacity slot, mutex, binding, unlink, and namespace cleanup reaches one terminal state.
- Existing occurrence-ledger phase/order and trusted typed-boundary rules remain authoritative.

## Risks and Controls

- The Node pathname unlink retains a proof-to-syscall window; native dirfd-relative unlink remains out of scope.
- Internal namespace cleanup may retry, so tests assert truthful physical occurrences without hard-coding incidental graph alias counts.
- Backend route tests are updated only where the new recovered guard terminal state removes the obsolete manual-unlink step; production backend code is unchanged.
