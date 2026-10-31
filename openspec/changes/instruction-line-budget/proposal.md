# Rendered instruction budget

## Why

Issue #478: the declared rendered AGENTS.md limit is 320 lines, but the current projection is 353 lines and the default checker detects byte drift only. Restore the budget without removing effective rules and make the existing instructions/docs path enforce it.

## What Changes

- Move the complete Enforcement Index table to existing Testing_Strategy documentation and keep an explicit mandatory root reference; replace the redundant role table with the existing canonical Roles_and_Boundaries reference and explicit PI-only scientific authority.
- Check only AGENTS.md against constraints.yaml thresholds.agents_md_max_lines after normal projection verification; keep threshold 320 and both generated files source-owned.
- Add real renderer boundary self-tests and run them through existing guardrail self-proof and CI docs-gate.

## Capabilities

### Modified Capabilities
- `engineering-gates`: rendered agent-instruction budget is part of the normal executable documentation gate.

## Impact

Canonical shared instruction source and generated projections, existing docs, renderer, a small Python checker/self-test, guardrail fixture and docs CI step. No Runtime Lifecycle content, product, host, eng-init skill or CLAUDE budget change.

## Risk triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (shared CLI/config/CI and governance instructions)
Blast radius: dropped operating rules or false-positive/false-negative default documentation gate
Selected risk packs: Public CLI; Config; File IO; Error handling; Documentation
Evidence floor: 320 PASS /321 semantic RED then GREEN rejection, config-sourced limit, CLAUDE-only excess accepted, drift unchanged, rule-preservation inventory, render/default docs/full check/guardrails and strict validation
