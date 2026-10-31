# Design

## Context

Current shared source has 338 lines; generated AGENTS/CLAUDE are 353/350. render.sh already owns both projections and --check/--root; docs:check/CI call it. CI docs-gate has Python but intentionally does not install Node dependencies.
Existing Python doc checks read narrow owned constraints sections with standard-library regex; reuse that dependency-free convention, not a new YAML dependency or hardcoded fallback.

## Goals / Non-Goals

Governing invariant: root-size reduction changes rule placement, not authority, and every default instruction check rejects a rendered AGENTS file exceeding the canonical 320 limit.
Must preserve: byte-drift checking for both files, --root fixture support, all effective rule rows, role authority, existing default gates and CI dependency/cancellation semantics.
Must preserve: Runtime Lifecycle section byte-for-byte; no threshold increase, CLAUDE limit, eng-init projection edit, scientific/PI decision or product change.
Non-goals: broad docs refresh, #503 stale layout status, root-rule minification or line-joining to game the budget.

## Decisions

Move the full Enforcement Index table verbatim from shared.md to an existing Testing_Strategy section; retain root Enforcement Index heading with mandatory read/comply link before implementation/review/submission.
Remove only redundant Agent Roles table: keep canonical enum/reference, explicit PI-only scientific judgment and mandatory canonical role responsibilities; existing Roles_and_Boundaries §0/§1 already contains them.
Parent compares the frozen rule inventory, relocated table and untouched Runtime Lifecycle; generated roots are produced only by instructions:render, never hand-edited.
Extend renderer --check to invoke a small Python stdlib checker using its own script directory and supplied ROOT. Render mode remains rendering-only so oversized source fixtures can be generated and then rejected by the actual check.
Read exactly one valid positive decimal agents_md_max_lines from the thresholds section; missing/malformed/duplicate budget fails clearly, never defaults to 320. Count LF-delimited physical lines, including a final unterminated line; check AGENTS only.
Retain cmp failures; budget failure makes the same default command nonzero, without bypassing CLAUDE drift validation.
Use real temporary render fixtures for boundary self-tests, computing header overhead rather than pinning its formatting. Check 320 accepted,321 rejected, changed fixture threshold honored and oversized CLAUDE alone accepted.
Wire self-test into existing test-guardrails and CI docs-gate; adapt existing generated-drift fixture to carry constraints.yaml. No pnpm install/new runtime dependency needed in docs-gate.
Sibling surfaces: canonical shared/codex/claude sources, generated roots, constraints metadata, root package scripts, render --root, guardrails fixture, docs links/path checks and CI aggregate. Keep unrelated behavior.

## Required Evidence

Stage A self-test on old renderer must fail because byte-matching 321-line AGENTS is accepted, not because an executable/config is missing.
After implementation self-tests, current render/check, default docs gate, test-guardrails and full pnpm check pass; AGENTS ≤320 and constraint remains320.
Parent independent temporary smoke exercises actual instructions/docs command path at the boundary and verifies no CLAUDE budget.
Rule audit: every old Enforcement row retained, authoritative role duties mapped, all other shared sections including Runtime Lifecycle unchanged. No permanent test that pins copied prose; parent evidence audit only.

## Risks / Rollback

[Linked rules become optional] → root reference explicitly preserves mandatory authority and reviewer audits complete mapping.
[Budget fails on generated drift instead] → render each fixture first and prove matching bytes before check; preserve old drift regression.
[Threshold parser silently misses config] → require unambiguous numeric field, test error path; no fallback/dependency installation.
Normal revert plus re-render rolls back; no runtime migration. Review focus: rule completeness, threshold source/line boundary, CLI/root scope, CI/guardrail coverage and generated provenance.
