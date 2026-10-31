# Design

## Context

See proposal and #479. Historical PR477/496 failures and PR506 control remain immutable local/public evidence. Cancelled-suite IDs exceed successful-suite IDs in the two BLOCKED cases, but not the CLEAN control; this is an observation, not proof of GitHub internals.

## Goals / Non-Goals

Change surface: existing CI aggregate's bounded diagnostic log and Testing_Strategy operator guidance.
Must preserve: all seven needs (lint/test/docs-gate/secrets/sast/pr-size/profile-smoke), always aggregate, failure/cancelled/skipped rejection, full label-event CI, concurrency, permissions, thresholds, protection and rulesets.
Must add: actual event action/run attempt/head/ref correlation, precise hosted reproduction and safe recovery instructions.
Governing invariant: diagnostics/recovery never manufacture a successful check or merge authorization.
Sibling surfaces: job results, aggregate log/check, Actions run/check-suite APIs, commit check-runs, gh required projection, GraphQL merge state and ordinary merge endpoint.
Non-goals: runtime behavior, universal prevention, automatic reruns, undocumented GitHub algorithm claims, policy edits or empty-commit recovery.

## Decisions

Use one inline aggregate step before checkout, fixed printf format and quoted environment values. Allowlist event name/action, run ID/attempt, PR head SHA and workflow SHA/ref; no whole event/context, tokens, arbitrary payload or new API permission. Push events may have no PR action/head, explicitly distinct from missing historical evidence.

The isolated issue PR is the hosted seam; no synthetic local test can prove GitHub mergeability. First create opened/labeled overlap at identical SHA and retain actual action logs. Capture each attempt's seven results, aggregate IDs, suite identities, raw checks, required CLI output, merge state and unchanged authority settings. A natural CLEAN outcome is valid counterevidence, not a passing reproduction of BLOCKED.

If necessary, inject explicit cancellation of an active newer-suite run in that isolated PR, then rerun all jobs of the older suite. Label manual cancellation as such; it tests suite-state selection, not natural cancellation frequency. Rank hypotheses before intervention: suite selection, stale mergeability refresh, hidden authority/head context. Failure to discriminate is a real blocker, not license to assert cause.

Only after observing the specific BLOCKED/required-PASS state, rerun the failed/cancelled suite's entire job graph at the same head. Record resulting checks/state and complete an ordinary non-admin merge after review. Rerunning only the aggregate/failed jobs or an unrelated already-green suite is not equivalent. Recovery is an operator action, not a guarantee or new retry loop.

## Evidence and risks

Parent exercises existing aggregator all-success versus each failure/cancelled/skipped dependency, and local full gate/test-guardrails. Log behavior is smoke-tested as shell data, then checked on actual hosted actions; no permanent source-text/wiring test.

Publish an upstream report with reproducible public facts if the discrepancy belongs to service-side check selection/mergeability; distinguish observations from hypotheses. Documentation must include exact commands, failed-suite selection, unchanged-head/authority checks and escalation when recovery does not clear the gate. No fabricated upstream resolution claim.

Hosted timing is nondeterministic and CI costs remain full. Never discard failed/control attempts; do not change concurrency to force an unproved prevention. Any discovered need for a policy change is outside this fixture and blocks that approach.

Review focus: actual action versus inference; suite/run/check identity separation; unchanged gate semantics; shell/secret safety; exact-head recovery/ordinary merge evidence; truthful limits.
