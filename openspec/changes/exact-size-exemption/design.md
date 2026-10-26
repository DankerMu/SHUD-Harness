# Design

## Context

Current CI joins label names with commas into PR_LABELS; pr-size.sh uses a comma-delimited case pattern. Actual --count450 with one label x,size-exempt exits0 and logs bypass. Existing aggregate-checks.sh already uses jq; ADR-0008 documents that system prerequisite.

## Goals / Non-Goals

- Governing invariant: an oversized PR bypasses only when its label-name array contains the exact string size-exempt, and only that branch emits the bypass message/summary.
- Must preserve: 400-line policy and threshold source, generated exclusions, counted diff behavior, all triggers/permissions/concurrency/aggregate semantics, existing log text and case sensitivity.
- Must change: workflow producer, script consumer/comment and self-tests together; PR_LABELS is retired, no dual encoding or shim.
- Non-goals: live GitHub labels/writing probes, policy/required-check changes, input-validation exit-code taxonomy, generic CI cleanup, packages/runtime changes.

## Decisions

- Use PR_LABELS_JSON: toJSON(label-name-array). JSON preserves commas, quotes and whitespace in a single label; newline/delimiter alternatives cannot recover lost boundaries.
- jq membership must first require an array. index on a JSON string is substring lookup and is not a valid label-set test. Non-array or malformed JSON never grants exemption.
- Unset/empty PR_LABELS_JSON means no labels for local use; invalid metadata on an oversized invocation follows the existing non-exempt failure path (exit1), retaining jq diagnostics where applicable, not a new exit2 protocol.
- Preserve exact lower-case spelling; uppercase aliases, prefixes, suffixes and comma-bearing names alone do not qualify. An array containing the exact name alongside those labels does qualify.
- Keep the original bypass stderr text and conditional GITHUB_STEP_SUMMARY write only in the true branch.
- Sibling surfaces: CI environment producer, shell public --count/--base entry, positive and negative self-tests, audit log/summary consumers. Existing policy-only instructions/ADR/constraints need no edits.

## Verification and Migration

- Existing red-repro.json proves actual old-encoding false exemption, not a JSON string fed incorrectly to the old interface.
- Implementer first changes the existing positive self-test to the new variable and adds the comma negative; parent runs RED against old script before implementation. New-format negative cases may already pass before the consumer is migrated; do not falsely claim they transitioned red→green.
- Then migrate producer/consumer and boundary cases; parent runs actual CLI exit/log/summary probes, full test-guardrails and full check. Tests use independent output files; never grep TMP/out through a helper that truncates TMP/out before the grep runs.
- Cases: exact sole/mixed membership, comma prefix/suffix, near-name and uppercase, empty/absent, non-array and malformed metadata; unchanged under/equal/over threshold boundaries. No synthetic GitHub label writes.
- Require exact-head CI with new JSON binding and clean expanded review. Rollback by normal revert PR, not parallel interfaces.

## Risks

- jq errors used inside an unguarded set-e pipeline → put the membership pipeline in the if condition so absent membership fails closed through the established gate path.
- Case-insensitive GitHub expression would change semantics and move policy outside local self-proof → rejected in favor of scripted exact membership.
