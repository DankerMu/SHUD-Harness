# PR #170 terminal round-ceiling split

Decision date: 2026-07-30
Issue: #168
PR: #170
Terminal reviewed head: `02ba5189e938c7c04018555ec0347945dc15e829`
Gate: Round 5 `not-clean`; 3 verified P1/FIX_NOW `test-evidence` findings; hard round ceiling reached.

## Decision

The ordinary review/fix loop is closed for PR #170. No Round 6, Phase 6 fix,
Phase 7 gap sweep, CI-for-merge wait, or merge is permitted on this PR. The
maintainer handoff required terminal handling through either this two-lane split
or an explicit descope/stop decision; no descope or stop was directed. The gate
default is therefore applied: PR #170 is superseded by two dependency-ordered,
implementation-ready issues.

## Verified Round 5 findings

- `CAND-R5-01` -> CONFIRMED / FIX_NOW: persisted Round-1 assertion and 237/238
  byte counts are stale (`529`, `5100`, `5116` are authoritative).
- `CAND-R5-02` -> CONFIRMED / FIX_NOW: constructor-created dynamic execution can
  create a Worker that reads ambient bytes while both current proof layers stay
  silent.
- `CAND-R5-03` -> CONFIRMED / FIX_NOW: direct Worker realms do not inherit the
  main-realm preload patches and can read ambient bytes with no guard event.

Authoritative verdicts:

- `.workplans/issue-168/review/verify-test-evidence-round-5-a.md`
- `.workplans/issue-168/review/verify-test-evidence-round-5-b.md`
- `.workplans/issue-168/review/verify-test-evidence-round-5-c.md`

## Replacement issues

1. #171 — core retained source ingress and normalized record contract.
   - Anchors #168's declared minimal mergeable slice.
   - Owns production ingress/capability/schema behavior, exact direct receipts,
     replacement/cleanup regressions, and the 237/238 normalized capacity contract.
   - Excludes exhaustive hostile-source AST/preload proof and historical review
     evidence reconciliation.
2. #172 — source-ingress authority proof harness and exact evidence closure.
   - Depends on #171.
   - Owns all three Round 5 findings: constructor/dynamic-code vocabulary,
     Worker/new-realm active interception, Darwin/Linux compiling mutation proof,
     and exact historical evidence correction.
   - Is proof/evidence-only after #171; no core ingress/schema behavior change.

Dependency: `#171 -> #172 -> #169` for the source-ingress/oracle lane. Existing
#166, #162, production/runtime/workflows, supply authority, and network security
remain outside both children.

## Accountability classification

Sizing-retro verdict: `slice-error`. #168 combined an independently mergeable
core ingress/contract lane with an exhaustive hostile-authority proof/evidence
lane. Future Stage 5 slices must separate behavior ownership from adversarial
proof-harness closure before implementation.
