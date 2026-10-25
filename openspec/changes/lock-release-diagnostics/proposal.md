# Proposal

## Why

Issue #335 records a real permission failure: metadata unlink fails, descriptor closure releases the kernel guard, live-self metadata then blocks subsequent apply with an indistinguishable holder message. Index initialization can additionally lose its original failure when release also fails. PI chose policy C in comment 6398938492: diagnostics plus explicit operator recovery, no new retry or takeover mechanism.

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent
Blast radius: Critical Path #4 ownership exclusion and persistent index integrity.
Selected risk packs: Public API; File IO; Auth/permissions; Concurrency; Error handling; Resource limits; Legacy compatibility; Documentation.
Evidence floor: semantic fault-injection RED/GREEN, real child exclusion/guard probes, Darwin permission smoke, full check, profile smoke, exact-head Linux CI and three-seat review.

## What Changes

- Release reports stateDir, metadata path, filesystem error code and actual descriptor-close outcome, retaining original errors; double failure never falsely claims the kernel guard is released.
- A free-guard acquisition rejected by matching live-self metadata explicitly identifies suspected self residue, without changing refusal or foreign-holder behavior.
- Index initialization preserves both its original failure and cleanup failure. Existing lifecycle reports once and close keeps the same memoized rejection.
- Document one automatic release attempt, zero retries, safe operator recovery and unchanged availability limitations.

## Capabilities

### Modified Capabilities

- `shud-run-jobs`: add a uniquely named lock-release failure requirement; existing stdout boundary stays intact. Synchronize pending m2-run-chain lock wording as explicitly required by #335, without archiving it or duplicating the new requirement name.

## Impact

Canonical state-lock/state-indexes implementation, existing registry logging boundary only if needed, focused fault/process tests and their existing harness, lifecycle docs and instruction sources/generated projection. Parent owns OpenSpec edits; implementer owns source/tests/instructions. No new public method, state format, dependency, timer, schema, host/submodule change or PI acceptance.
