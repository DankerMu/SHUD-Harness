# Poll persistence-barrier oracle

## Why

Issue #471 recorded a genuine full-coverage failure without a failing trace. A parent-executed controlled RED and single-variable counterfactual now show that a manual tick joining old nonterminal work can trip the test's barrier predicate without any terminal publication. Repair the demonstrated test-oracle ambiguity, not the production scheduler; historical attribution remains explicitly unknown.

## What Changes

- Make the existing lifecycle scenario establish fresh post-exit timer work before manual joins.
- Preserve held persistence, same-run exclusion, healthy-run progress and exact writes; separately hold the publication metadata gate.
- Retain bounded failure evidence and document controlled diagnosis versus unobserved historical cause; no retry/timeout/skip or coverage relaxation.

## Capabilities

### Modified Capabilities
- `engineering-gates`: native settlement prerequisites include a correctly admitted held-barrier oracle and publication-gate evidence.

## Impact

Existing poll-shud-lifecycle.test.ts and Testing_Strategy.md only; no production source, shared harness, host, schema or M3/PI change. Disposable controlled diagnostics remain local evidence, not shipped duplicate implementations.

## Risk triage

Issue type: test
Fixture level: expanded
Upstream suggested level: absent (concurrency and persistence oracle require expanded)
Blast radius: false-positive/false-negative lifecycle regression verdicts
Selected risk packs: File IO; Concurrency/ordering; Error handling; Documentation
Evidence floor: controlled RED/counterfactual already observed; focused lifecycle and sibling tests; negative oracle control; full check; profile smoke; strict fixture and expanded review
