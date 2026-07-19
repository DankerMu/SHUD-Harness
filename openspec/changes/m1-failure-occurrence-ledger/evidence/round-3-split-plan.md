# Round 3 hard-gate split plan

Parent PR: #110  
Reviewed parent head: `1511ca3b69b533ea1eb77f5f8df70c58d6301fd8`  
Gate result: Round 3 not clean; 9 blocking verified findings; breadth retro registered.

PR #110 is the non-mergeable integration parent. Its round counter remains at
three. The following stacked child PRs each enter `subagent-workflow` with a new
gate counter; after they converge into the parent, the parent receives at most
the one comprehensive integration round granted by the breadth retro.

## Child A1 — occurrence ownership and phase authority

Base: the parent integration branch. This child owns the carrier protocol and
the producer/backend migrations that consume its phase and identity contract.

- `ST-R3-01`: validate imported carrier history together with the new adoption
  occurrence so settlement cannot follow final release.
- `ST-R3-02`: infer the physical terminal phase without treating observation as
  a release/settlement event.
- `ST-R3-04`: snapshot and validate the fold vector and classification before
  claiming; a failed preflight must not consume a valid occurrence.
- `CT-R3-01`: prevent callers from extracting and consuming an adoption's child
  occurrence independently of the adoption.
- `CT-R3-02`: reuse the captured S31 occurrence for the same physical rejection
  rather than reminting it with another phase/order.

Acceptance boundary: transactional snapshot/preflight/claim, opaque adoption
ownership, combined-history phase validation, an authoritative physical-phase
accessor, and exactly one occurrence for each physical rejection. Existing
public HTTP envelopes remain unchanged.

## Child A2 — bounded observation and exact semantic lookup

Base: Child A1. This child owns graph observation budgets and exact semantic
lookup behind A1's stable carrier seam.

- `CT-R3-03`: reconcile the per-container numeric inspection limit with the
  deterministic selected-key contract, then enforce the resolved bound.
- `CT-R3-04`: return the exact semantic-primary `Error` independently of the
  graph-node observation budget.
- `PERF-R3-01`: inspect a shared container at most once per fold and reuse the
  same snapshot for every parent edge.

Acceptance boundary: one container inspection per fold, a non-contradictory
numeric-key selection contract with explicit truncation evidence, and exact
semantic-primary identity beyond the graph-node boundary.

## Child A3 — tracked evidence closure

Base: Child A2. This child owns only final cross-child acceptance evidence.

- `TE-R3-01`: track the definitive Phase 6.2 inventory so it is replayable from
  a fresh clone, and record all 13 preserved replay-patch whitespace lines
  (Round 1: 7; Round 2: 6).

Acceptance boundary: tracked audit inputs/results, hashes bound to the final
semantic heads, accurate replay/hygiene exception accounting, strict OpenSpec
validation, and no `.workplans` path used as canonical evidence.

## Merge order

Review and merge `A3 -> A2`, then `A2 -> A1`, then `A1 -> #110`. Only after the
stack has converged may #110 consume its single post-retro integration review.
No child may silently absorb another child's findings or reset #110's ledger.
