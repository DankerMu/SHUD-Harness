# Proposal

## Why

Issue #324 records stale PR-size results because size-exempt changes are absent from subscribed events. Both granting and revoking exemption must reevaluate without empty commits or reopening PRs.

## What Changes

- Explicitly retain opened/synchronize/reopened and subscribe labeled/unlabeled for PRs to main.
- Run the full existing CI on every label event; preserve the sole required all-checks-passed and its failure-on-skipped semantics.
- Reuse one executable aggregator in workflow and guardrail self-tests; add success/failure/cancelled/skipped behavior probes without weakening any gate.
- Record full-CI/cancellation cost, unchanged size threshold and reason requirement in source instructions, mirrors, PR template and a proposed ADR.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `engineering-gates`: add a uniquely named label-triggered exemption reevaluation requirement; existing compiler requirement unchanged.

## Impact

CI workflow, canonical aggregator shell, guardrail self-test, instructions source/rendered projections, constraints comment, PR template and ADR. No permission escalation, branch-protection change, runtime changes or threshold relaxation.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded for shared CI gate/configuration.
Blast radius: PR required-check status following any label change.
Selected risk packs: Public API / CLI / script entry; Config / project setup; Concurrency / shared state / ordering; Error handling / rollback / partial outputs; Documentation / migration notes; Scientific governance / PI gate / evidence lineage.
Evidence floor: before-change missing-event proof, executable aggregator positive/negative tests, actual oversized draft PR grant/revoke runs with same head, full check and guardrails, strict validation, exact-head independent review/CI.
