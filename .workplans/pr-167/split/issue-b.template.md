Part of #164

Implementation Ready: yes

**Module / Scope:** Committed source-oracle checker and Task 1.1a ownership contract

Depends on #168

**OpenSpec change:** `m2-capability-observer-spike`

## In Scope

- Make the committed-oracle current checker consume the descriptor-capability
  ingress delivered by its dependency.
- Align every Task 1.1a OpenSpec passage with the approved ownership split:
  declaration syntax and initial committed oracle remain here; live enumeration,
  synchronization, and exact Git equality belong to Task 1.1c/#166.
- Add both synchronized frame/sidecar attacks to the public current-check seam
  and prove they bite the frozen-literal binding rather than only mutual digest
  consistency.
- Refresh exact source-only red/green evidence and immutable tree bindings.

## Out of Scope

- Direct-input descriptor capability implementation and capacity proof, owned by
  the dependency issue.
- Any live Git configuration, index, tracked-set, mode, object-format,
  filesystem-generation, enumerator, sync algorithm, or exact-set implementation.
- #162 aggregate evidence budgets/publication, supply authority, runtime,
  production, workflows, and network security.

## Current behavior

Canonical OpenSpec passages disagree: some assign live manifest enumeration,
synchronization, future-path prohibition, and per-HEAD exact equality to Task
1.1a, while the approved split and current tests assign those capabilities to
Task 1.1c and accept canonical future declarations. The exact synthetic oracle
unit tests reject synchronized truncated or same-length forged pairs, but the
public current-check regressions mutate frame and sidecar only independently.

## Desired behavior

Task 1.1a has one unambiguous ownership contract: strict canonical manifest
declarations must include the three committed oracle files and may include
future-owned declarations without discovering their existence. Task 1.1c/#166
alone owns live Git enumeration, synchronization, and exact equality.

Through the public current-check command, a 58-byte prefix frame with its
recomputed sidecar and a same-length mutated frame with its recomputed sidecar
both fail with exit 2, empty stdout, and one exact stable error receipt. A
source-only mutation that preserves frame/sidecar mutual consistency but removes
the frozen literal binding must make both public tests red.

## Key interfaces

- Strict canonical manifest declaration parser with three mandatory committed
  oracle paths and no live discovery.
- Committed metadata/frame/sidecar reader supplied by the dependency's retained
  descriptor capability.
- Exact `source_input_digest_v1` literal oracle, not merely a frame/sidecar
  mutual digest predicate.
- Public `current_source_authority` success/error receipt.

## Tasks

- [ ] Normalize all Task 1.1a design/spec/task ownership statements to the
  approved #166 split, map completion to the `#168 -> #169` child DAG, and keep
  the parent incomplete until both children close, without restoring removed
  live Git behavior.
- [ ] Wire the committed current checker to #168's retained capability and add
  the two synchronized forged frame/sidecar pairs to its public regression
  matrix with zero ambient reopen, cleanup, no-write/no-child exact receipts.
- [ ] Refresh mutation proof, complete contracts-tree binding, manifest, and PR
  evidence at one exact pushed implementation head.

## Acceptance Criteria

- [ ] Semantic ownership audit finds no Task 1.1a claim of live Git enumeration,
  manifest synchronization/exact equality, or prohibition of canonical future
  declarations; Task 1.1c/#166 is the sole owner of those behaviors.
- [ ] Canonical future declarations are accepted without existence or tracked-set
  discovery, while malformed/duplicate/unsorted/unsafe declarations and missing
  mandatory oracle paths fail closed.
- [ ] Task 1.1a is represented as the `#168 -> #169` split and is not marked
  complete until both children close; Task 1.1b remains blocked by the complete
  1.1a parent and Issue #165 still has `Depends on #164`.
- [ ] Public current-check proves that manifest, metadata, frame, and sidecar
  reads use #168's retained capability with zero post-admission root/absolute-
  path reopen, deterministic replacement rejection, and no descriptor growth on
  repeated success or every named failure path on Darwin and Linux.
- [ ] The 58-byte prefix frame plus recomputed sidecar fails through public
  current-check with exit 2, empty stdout, and exact LF error receipt.
- [ ] The same-length mutated frame plus recomputed sidecar fails through the
  same public seam and receipt contract.
- [ ] A frozen-literal-only mutation produces red for both synchronized public
  cases while retaining frame/sidecar mutual consistency; restoration returns
  the full suite green with an identical contracts tree.
- [ ] Focused tests, all three public commands, strict OpenSpec validation, full
  repository check, no-write/status identity, fixed-base scope, and submodule
  hygiene pass on Darwin and Linux.
- [ ] Live Git authority remains absent and no #166/#162/network-security scope
  is implemented.

## Required reading

| Priority | Document / anchor | Focus |
|---|---|---|
| P0 | Issue #164 acceptance criteria | Synchronized attacks and stable public receipts. |
| P0 | OpenSpec change `m2-capability-observer-spike`, Task 1.1a/1.1c | Canonical ownership boundary and public evidence. |
| P0 | PR #167 Round 5 synthesis and verification | `r5-design-01` and `r5-evidence-01` exact evidence. |
| P0 | Dependency issue | Retained descriptor-capability interface and capacity result. |
| P1 | Issue #166 | Sole ownership of live Git enumeration/sync/equality. |

**PR Boundary:** Committed-oracle current checker, synchronized public oracle
fixtures/tests, Task 1.1a ownership text, and exact task-local evidence only. No
direct-ingress capability rewrite, live Git authority, #162 budgets,
production/runtime/workflow, or network-security changes.

**Suggested fixture level:** expanded - public synchronized forgery evidence,
cross-artifact ownership consistency, exact receipts, and immutable red/green
tree binding are merge-critical.

**Minimal mergeable slice:** OpenSpec ownership normalization plus the two public
synchronized-oracle regressions and their frozen-literal mutation proof; they
form one independently reviewable current-oracle contract on top of dependency A.
