# Design

## Context

Change surface: existing overlapping manual/timer scenario in poll-shud-lifecycle.test.ts and Testing_Strategy.md.
Parent controlled RED: exact old tail joined, real absent exit/live identity, no new read, publication gate or terminal write; original predicate rejects.
Counterfactual: drain identical old tail before exit/manual admission → fresh step enters barrier; both runs and both metadata gates pass.
The controlled completion delay/frozen cadence establish sufficiency, not the cause of the historical untraced failure. Detailed sanitized observations are published in PR/docs, local raw traces stay untracked.

## Goals / Non-Goals

Governing invariant: a held-barrier test may interpret completion as bypass only for work admitted after its exit evidence and latch are ready; no durable terminal write/completion may pass either held metadata boundary.
Must preserve: genuine registered timer callback plus overlapping manual ticks, one run single-flight, another run completes independently, first remains running/uncompleted with zero terminal attempts/writes until gate release, exactly one terminal attempt/write afterward.
Must preserve: original 15000ms envelope, assertion strength, native execution/IO/identity, all other tests and production bytes; no retries/skips/coverage changes.
Non-goals: production dispatch redesign, historical-cause reconstruction, generic tracing, restart/PI evidence, #437 records behavior.

## Decisions

Use existing selective fake-interval precedent to control only cadence; keep Date, native children, filesystem, release sockets and timeout deadlines real.
Do not admit pre-exit timer steps whose tails the intended manual tick could accidentally join. Establish barrier readiness and real exit before explicitly firing the registered cadence.
Prefer simple ordered setup, including submitting the healthy run after the first is held if needed, over private dispatcher state mutation or production hooks.
Hold initial run metadata, then separately hold the publication metadata check before synchronous terminal conversion; prove running/zero writes at both. Bind their order to the known single admitted run step, not a global unrelated lstat count.
Record bounded failure state before cleanup: current phase, gate entries/release state, terminal attempts/writes, producer completion and durable status plus harness errors; preserve primary exception cause and always release barriers.
No permanent 300-line probe or production instrumentation; the existing scenario is the single canonical test.
Sibling surfaces: other enteredBeforeCompletion uses, shared pollFixture cadence, dispatch/enqueue/runStep catch, readRunFile/regularFile, settle/updateRunJob, cleanup. Inspect them; do not broaden edits without evidence.

## Required Evidence

Already observed: controlled old-tail RED, counterfactual GREEN, both-gate/healthy progress controls and empty cleanup errors; explicitly distinguish from historical cause.
Parent negative control after test change: exercise a genuinely bypassed publication barrier in a disposable test-only seam and require the same gate oracle to fail, without editing production or weakening the saved test.
Run focused lifecycle and relevant poll sibling tests; run built profile smoke and pnpm run check; strict validation.
Publish command results and limitations; focused coverage-floor failure is never confused with semantic test failure or full-check success.

## Risks / Migration

[Clock virtualization corrupts native identity] → fake only interval functions, never Date/real timeout APIs.
[Setup or gate failures hang cleanup] → finally releases every latch and observes admitted ticks before existing native cleanup, restoring timers even on failure.
[Diagnostic claims overreach] → no historical root-cause or production bypass claim without original trace; retained controlled mechanism is explicitly test-owned.
No runtime migration or new dependency. Review focus: gate causality, single-flight/progress strength, real timer path, diagnostics/cleanup and historical limits.
