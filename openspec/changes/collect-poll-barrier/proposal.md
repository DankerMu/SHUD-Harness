## Why

#710: on PR #709 CI (run 42702562153, job 129450816174) `shud-run-lifecycle.test.ts > public kill of a tool-created run persists intent and reaches actual producer completion` failed with `expected 'cancelled' to be 'collected'` / `Matcher did not succeed in time` after 1326ms. The durable record was already `cancelled`; only the `collected` projection had not landed. `expect.poll` defaults to 1000ms (vitest 5.1.0) and the root config does not override it. Collection happens on a later registry tick plus `collectRun` file IO (`shud-poll.ts:561-574`, `:916-925`), so a 1s budget is a test barrier gap under coverage + 4 workers, not an observed production defect. The previous head of the same PR passed and the diff did not touch shud-run/jobs/kill paths. Exact timing root cause was not traced (no stage trace).

Issue type: test
Fixture level: none
Upstream suggested level: absent (isolated test-barrier update; no runtime changes)
Blast radius: the required `test:coverage` gate (intermittent red CI masking real regressions); not production behavior.
Selected risk packs: Concurrency / shared state / ordering (wait on the durable projection with a bounded deadline, keep every outcome assertion).
Evidence floor: controlled delay RED/GREEN on one site; repeated whole-file runs of both files; default `pnpm run check`; exact-head CI.

## What Changes

- `packages/dsh-shud-tools/src/shud-run-lifecycle.test.ts`: every `expect.poll` in the file gets `{ timeout: 5000 }` — the `collected` projection polls (`:48`, `:75`, the observed failure), the first-invocation polls (`:33/:67/:101/:179`), the signal-observation polls (`:107-110/:186-188`) and the public-status polls (`:38/:73/:199`). Public status is not instantaneous from the poll's start: it covers native exit, up to one pump tick, `readExit`/`waitForLocalExit` and `lifecycle.settle` IO, the same class of dependency as the others; one uniform bound avoids a per-site judgement with no observed failure to separate them.
- `packages/dsh-shud-jobs/src/collect-shud.test.ts:152-154`: the `run-record.json` appearance poll after `producer.doneObserved` gets `{ timeout: 5000 }` (`run-record.json` is written by `collectRun` on a later tick, `shud-poll.ts:556-574`, `shud-collect.ts:144`). `:176` is unchanged: it follows the explicit `collectShud` at `:168`, which awaits `collectRun` and `projectCollected` (`shud-poll.ts:241`, `shud-collect.ts:345`).
- A repository grep found no other default-budget `collected`/`run-record.json` poll (`wake-shud.test.ts:73/162/284` already pass 5000ms).
- Precedent: #393 (`c8152117`, `teardown-shud.test.ts:350`), `kill-shud-races.test.ts:228/468`, `poll-shud-lifecycle.test.ts:419/499`, `detached-shud.test.ts:74/105`, `wake-shud.test.ts`.

## Capabilities

### Modified Capabilities

- `engineering-gates`: extend "Native settlement tests observe completion prerequisites" to durable `collected` projections / `run-record.json` after public settlement, and to post-submission native evidence and public-settlement polls (explicit bounded timeout).

## Impact

Test files only. No production code, global vitest timeout/retry, coverage threshold, skip or dependency change. Per-test limits (15_000ms) unchanged. Not PI acceptance.
