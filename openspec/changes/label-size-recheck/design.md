# Design

## Context

The existing PR-size job consumes labels from the event snapshot. Only default pull_request actions trigger CI, so later label changes are invisible. The required always() aggregator rejects any needs result other than success; skipping unrelated jobs is therefore not an acceptable shortcut.

## Goals / Non-Goals

Governing invariant: granting or revoking size-exempt triggers a fresh check of that event's label set; an over-limit unexempted PR cannot retain a green required aggregate after reevaluation. Every required job must succeed, including on label events.

Must preserve: opened/synchronize/reopened and push-main triggers, base/head diff calculation, 400-line threshold and excluded generated files, logged exemption with PR reason, single required check, read-only permissions, full job set and fail-on-skipped/cancelled/failed aggregate.

Non-goals: runtime label fetching, privileged pull_request_target, workflow dispatch, admin protection changes, filtering labels/job skipping, concurrency redesign, fixing existing unrelated PRs or changing size policy.

## Decisions

Use all five PR event types and run the full suite for every label change, accepting cost for unrelated labels. Keep existing concurrency group and cancel-in-progress; label churn may cancel an older run but the newest event must finish and supply the fresh result.

Extract existing inline aggregator shell into scripts/guardrails/aggregate-checks.sh, keeping success-only decision and diagnostics. Workflow checks out the repository then calls this single owner; guardrail probes invoke the same shell with RESULTS fixtures. No duplicate jq logic or assertions over source text. This is a behavioral-preserving extraction, not an aggregator redesign.

Sibling surfaces: workflow trigger, event label snapshot, pr-size script/log summary, needs list, aggregator, test-guardrails, source instructions/rendered matrix and PR template. Root scripts typecheck remains unaffected by the shell helper.

Seams under test: actual aggregator command and actual hosted pull_request label events. Parent creates a never-merged oversized draft proof PR with the new workflow, retains its fixed head, waits for each event's CI completion before the next label change, and records run ids, pr-size logs and required-check status.

## Required Evidence

Prechange throwaway event-subscription probe demonstrates labeled/unlabeled absent; supplied issue historical runs establish actual stale results. New committed guardrail probes: all success exits0; one failure/cancelled/skipped exits nonzero. Live draft: opened without exemption fails size+aggregate; add size-exempt with a reason -> fresh run succeeds with bypass log; remove label -> fresh size+aggregate failure, no commit/reopen between. Close proof PR without merging after evidence is saved.

## Risks / Trade-offs

- Full CI on arbitrary label changes costs runner time; documented, not hidden through skipped jobs.
- Workflow event snapshot fidelity after unlabeled must be proven by live logs; do not assume or mask a failed revoke probe.
- CI failures in unrelated jobs are not evidence of a correct size-gate failure; retain exact job conclusions and bypass/rejection logs.
- Only owned draft proof branch/files may be discarded; no user branch, worktree, source evidence or protections altered.

## Migration Plan

No migration. Merge normal PR after full validation; future label events automatically reevaluate. Revert this standalone commit if needed. Independent fixture archive, M2 PI acceptance stays open.
