# Proposal

## Why

Issue #352 identifies four test consumers that treat a joined manual tick as settlement. A real full-suite failure at `poll-shud.test.ts:70` is retained in `.workplans/issue-349/check-fix1.txt` and issue comment 6400746544; the other three sites remain source-traced, not claimed reproduced. Production joining behavior is correct.

## Triage

Issue type: test
Fixture level: expanded
Upstream suggested level: absent
Blast radius: false test failures or hidden bad-entry mutation during bounded waiting; no production behavior changes.
Selected risk packs: Concurrency / shared state / ordering; Error handling / rollback / partial outputs; Documentation / migration notes.
Evidence floor: four native test sites, unchanged protected assertions/production source, full check and exact-head CI.
Expanded reason: concurrency-sensitive consumer preconditions and per-iteration isolation invariants across three files.

## What Changes

Use the existing bounded `waitForRecovery` convention to drive `pollOnce` until each consumer's completion prerequisite is observable. Preserve every assertion, including bad-entry invariants on each iteration. The fourth site's actual detached producer has no completion array: wait for an explicit durable collectible state instead. No new helper or timer configuration.

## Capabilities

### Modified Capabilities

- `engineering-gates`: native settlement-dependent test assertions wait for observable prerequisites rather than treating one accepted tick as a completion barrier.

## Impact

Only four sites in `poll-shud.test.ts`, `poll-shud-identity.test.ts`, and `detached-shud.test.ts`, plus this fixture. Existing protected tests, production queues, APIs, cleanup, schema, defaults and dependencies stay unchanged. Fixture/spec documents the test contract; no runtime documentation changes are needed.
