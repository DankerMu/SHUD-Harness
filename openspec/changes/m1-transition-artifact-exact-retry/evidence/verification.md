# Verification evidence

Verified on `2026-07-18 11:25:56 EDT` from branch
`codex/issue-108-exact-transition-retry` at base
`5a450a97f2a474af2f4db26bd9ee198adb7395ec`.

## Green tests

- Focused exact-settlement/service regressions:

  ```sh
  npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern 'opt-in|recover restored transition artifacts|stale observed guard consumption'
  ```

  Result: `5 pass`, `394 filtered out`, `0 fail`, `94 expect()`.

- Full core service suite:

  ```sh
  npx --yes bun@1.2.19 run test:core-services
  ```

  Result: `394 pass`, `5 skip`, `0 fail`, `28612 expect()` across 399 tests.

- Keyed HTTP compatibility:

  ```sh
  npx --yes bun@1.2.19 test packages/backend/src/routes/index.test.ts --test-name-pattern 'idempotency digest includes defaulted created_by|same Idempotency-Key with different body'
  ```

  Result: `2 pass`, `152 filtered out`, `0 fail`, `35 expect()`; the route
  produced 201 for the first request, 200 for exact replay, and 422 for a
  different digest. The full `npx --yes bun@1.2.19 run test:backend-api` suite
  also exited `0`.

- Scoped core typecheck:

  ```sh
  npx --yes bun@1.2.19 x tsc --noEmit -p packages/core/tsconfig.json
  ```

  Result: exit `0` with no diagnostics.

## Repository and specification checks

- `openspec validate m1-transition-artifact-exact-retry --strict --no-interactive`:
  `Change 'm1-transition-artifact-exact-retry' is valid`.
- `git diff --check`: exit `0`.
- `git diff --quiet -- zero`: exit `0`.
- `git submodule status -- zero`: `-13e25c116c62411e6ee8a0ad67a6c53dc7c376c6 zero`.
  The leading `-` records that the pinned submodule is not initialized; no
  `zero/` or gitlink change was made.
- `git ls-files workspace | wc -l`: `0`.
- `git stash list | rg 'red-proof'`: no matches.

## Root checks and backend sibling diagnosis

The initial root run found the worktree's pinned `zero` submodule uninitialized.
The orchestrator materialized the repository-pinned
`zero@13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` without changing the gitlink.
Root `npx --yes bun@1.2.19 run typecheck` then passed.

The first full `check` exposed two deterministic S34 backend sibling failures.
The red loop, ranked hypotheses, confirmed cause, and narrow test fix are
recorded in `evidence/backend-s34-diagnosis.md`.  The tests now inject both the
initial post-mutation unlink failure and a distinct exact-settlement failure,
so they continue to exercise a genuinely unrecoverable release while the new
recoverable behavior remains covered by the core/public rows.

Independent orchestrator verification after that fix:

```text
focused S34 backend: 2 pass, 152 filtered, 0 fail, 52 expect()
root check: exit 0
backend API: 154 pass, 0 fail, 5030 expect()
backend WS: 34 pass, 0 fail
frontend: 20 pass, 0 fail
schemas: 6 pass, 0 fail
core services: 394 pass, 5 platform-conditioned skip, 0 fail, 28612 expect()
GLM provider: 60 pass, 0 fail, 553 expect()
```

The final root run therefore satisfies task 4.2; there is no remaining
environment or test blocker.

## PR #106 rebase gate

After #108 merges, PR #106 must rebase onto it, delete its branch-only
fresh-settlement and unconditional-second-settlement helpers, consume the
shared store outcome implemented here, and resume at its existing Round 3
review counter.

## PR #109 Round 1 class-fix verification (pre-re-audit checkpoint)

This checkpoint is retained as historical evidence and is superseded by the
Phase 6.2 re-audit verification below.

Verified through Phase 6.2 on `2026-07-18 13:44:05 EDT` from branch
`codex/issue-108-exact-transition-retry` against fixed review head
`0cda5d0d434f0a96a39e4feb4a43ea229df6aba9`.

The implementer was explicitly prohibited from committing. Green evidence is
therefore bound to the fixed base plus the following uncommitted source/test
tree identities; the orchestrator must replace this section's binding with the
eventual committed implementation SHA after committing:

- source/test binary diff SHA-256:
  `71c1886a7989eda24761d261727f8b2e6a8ae03b37d992683cc92c6f0871f071`;
- `workspace-record-store.ts` blob:
  `66df6d7bfcf63a2d1db332aa95d8af679c74b5e9`;
- `idempotency-service.ts` blob:
  `464c2fd992c7383e8da6be5dae598546063fa71b`;
- core test blob: `f3533377af040bcf7f3825f3a89ca62d98aa6554`;
- backend test blob: `cd6887785bfd233dd101ebeb1f655afa9b671f2a`.

Replayable red evidence is
`evidence/round-1-red-tests.patch` at SHA-256
`7bdd5f69fcad193297d669b747bfeed76b66eb96f4d8f0a57ea7e1d39dfcff31`.
`git apply --check --reverse` succeeds against the final test tree, proving the
recorded patch exactly reconstructs/removes the Round 1 test changes.

### Round 1 focused and full green results

- Round 1 focused core command:

  ```sh
  npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern 'Round 1'
  ```

  Result: `7 pass`, `399 filtered out`, `0 fail`, `288 expect()`.

- Phase 6.2 focused command:

  ```sh
  npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern 'Phase 6.2'
  ```

  Result: `2 pass`, `406 filtered out`, `0 fail`, `87 expect()`. The parent
  composition row includes store plus `complete/fail × guard/cleanup-lock`;
  the error row includes nested `cause` and `AggregateError.errors` at both
  settlement and final release.

- Combined Round 1 and Phase 6.2 focused result: `9 pass`, `399 filtered out`,
  `0 fail`, `375 expect()`.

- Full core command: `npx --yes bun@1.2.19 run test:core-services`.
  Result: `403 pass`, `5 platform-conditioned skip`, `0 fail`,
  `28971 expect()` across 408 tests.

- Keyed backend compatibility command:

  ```sh
  npx --yes bun@1.2.19 test packages/backend/src/routes/index.test.ts --test-name-pattern 'idempotency digest includes defaulted created_by|same Idempotency-Key with different body'
  ```

  Result: `2 pass`, `152 filtered out`, `0 fail`, `35 expect()`; observed
  HTTP `201`, exact replay `200`, and mismatch `422`.

- S34 sibling-epoch compatibility command:

  ```sh
  npx --yes bun@1.2.19 test packages/backend/src/routes/index.test.ts --test-name-pattern 'S34-P62-02 refresh failure settles every transported rejected-decision resource'
  ```

  Result: `1 pass`, `153 filtered out`, `0 fail`, `16 expect()`.

- Phase 6.2 S34 provenance compatibility command:

  ```sh
  npx --yes bun@1.2.19 test packages/backend/src/routes/index.test.ts --test-name-pattern 'S34-P62-01 unrecoverable guard-release and exact-settlement failure|S34-P62-05b|S34-P62-08'
  ```

  Result: `4 pass`, `150 filtered out`, `0 fail`, `80 expect()`.

- Full backend command: `npx --yes bun@1.2.19 run test:backend-api`.
  Result: `154 pass`, `0 fail`, `5030 expect()`.

- Scoped core typecheck:
  `npx --yes bun@1.2.19 x tsc --noEmit -p packages/core/tsconfig.json`;
  exit `0`, no diagnostics.
- Root typecheck: `npx --yes bun@1.2.19 run typecheck`; exit `0`, no
  diagnostics.
- Root verification: `npx --yes bun@1.2.19 run check`; exit `0`. This reran
  typecheck, policy/registry governance, backend API/WebSocket, frontend,
  schemas, all core services, and GLM provider tests.

### Repository and specification hygiene

- `openspec validate m1-transition-artifact-exact-retry --strict --no-interactive`:
  `Change 'm1-transition-artifact-exact-retry' is valid`.
- `git diff --check`: exit `0`.
- `git diff --quiet -- zero`: exit `0`.
- `git submodule status -- zero`:
  `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6 zero (13e25c1)`.
- `git ls-files workspace | wc -l`: `0`.
- `git stash list | rg 'red-proof'`: no matches.

The pre-existing untracked `.review-gate.json` remains untouched. No commit,
index mutation, push, PR comment, `.review-gate.json`, `.workplans`, or `zero/`
change was made.

## Phase 6.2 re-audit final verification

Verified on `2026-07-18 15:02:43 EDT` from branch
`codex/issue-108-exact-transition-retry` against fixed review head
`0cda5d0d434f0a96a39e4feb4a43ea229df6aba9`.

The implementer remained prohibited from committing. The final uncommitted
tree is bound by:

- source/test binary diff SHA-256:
  `41527867a146c17e25a693ba71c5da624c5b686a5988425a0eba3716400c4bda`;
- `workspace-record-store.ts` blob:
  `cf26c1eb04cf677545c9cb83a252ba6a6a8a0d35`;
- `idempotency-service.ts` blob:
  `7314b57254050f489456d53ae4615a73ba9208a6`;
- core test blob: `9726ebc2edf0c836224e2a13c8a5e41c37bf3b43`;
- backend test blob: `cd6887785bfd233dd101ebeb1f655afa9b671f2a`.

Replayable red evidence is
`evidence/round-1-red-tests.patch` at SHA-256
`86aa55bc70835448b9c4de2ad9f9395e8c0b2af4b29e5c311ae38f83cbf9a066`.
`git apply --check --reverse` succeeds against the final test tree. Patch
numstat is `34/9` for the backend route test and `1547/35` for the core service
test.

### Re-audit behavior and regression results

- Phase 6.2 re-audit matrix:

  ```sh
  npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern 'Phase 6.2 re-audit'
  ```

  Result: `3 pass`, `408 filtered out`, `0 fail`, `299 expect()`. It covers
  store and observed-consume paths plus `complete/fail × guard/cleanup-lock`
  across workspace-root and intermediate-directory ABA; every row preserves
  generation A, foreign sentinels, namespace hygiene, and authority/binding
  resource baselines. Error rows cover writable, frozen, non-configurable,
  getter-backed, and throwing getters at settlement and final release, plus
  binding and idempotency folds.

- Re-audit plus the five historically regressed error/replacement classes:
  `8 pass`, `403 filtered out`, `0 fail`, `448 expect()`.
- Error descriptor matrix repeated five times: every run returned `1 pass`,
  `410 filtered out`, `0 fail`, `126 expect()`.
- S33 high-FD regression plus re-audit matrix: `6 pass`, `405 filtered out`,
  `0 fail`, `335 expect()`.
- Full core service command:
  `npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts`.
  Result: `406 pass`, `5 platform-conditioned skip`, `0 fail`,
  `29270 expect()` across 411 tests.
- Full backend route command:
  `npx --yes bun@1.2.19 test packages/backend/src/routes/index.test.ts`.
  Result: `154 pass`, `0 fail`, `5030 expect()`.
- Scoped core typecheck:
  `npx --yes tsc -p packages/core/tsconfig.json --noEmit`; exit `0`, no
  diagnostics.
- Root `npx --yes bun@1.2.19 run check`: exit `0`. It reran typechecks,
  governance checks, backend API/WebSocket, frontend, schemas, the complete
  core suite, and GLM provider tests. Reported sibling totals include backend
  WebSocket `34 pass`, frontend `20 pass`, schemas `6 pass`, and GLM provider
  `60 pass`, all with `0 fail`.

After that complete run, the final resource-lifecycle self-audit stored the
already-started watcher-close settlement Promise for repeated release callers.
That bounded final delta was verified by the re-audit matrix, cleanup-timeout,
transferred-permit, and S33 descriptor-close rows together: `8 pass`, `403
filtered out`, `0 fail`, `380 expect()`. Both scoped and root TypeScript checks
then exited `0` with no diagnostics.

The pathname proof now retains a watched chain from the record parent through
the trusted workspace root. A target/other rename pair invalidates historical
pathname authority; normal descendant-only or sibling-only notifications do
not. Container epoch changes gate the bounded watcher-delivery wait, and
permit settlement waits for every watcher `close` event. The S33 descriptor
probe now enumerates the process's actual `/dev/fd` entries instead of assuming
all active descriptors are numbered at most 2048.

Caller-owned errors are observed once through cached own-property descriptors.
Only shared, accessor-backed, or observation-failing graphs are copied into a
store-owned envelope; independent errors retain exact identity and subtype.
All subsequent graph rewrites are ownership-gated.

## Phase 6.2 third-audit final verification

Verified on `2026-07-18 15:47:59 EDT` from branch
`codex/issue-108-exact-transition-retry` against fixed review head
`0cda5d0d434f0a96a39e4feb4a43ea229df6aba9`.

The final uncommitted source/test tree is bound by:

- source/test binary diff SHA-256:
  `314a2bd5658d19985b8552a1965648ac3b1a13837987187c64508103cc056b33`;
- `workspace-record-store.ts` blob:
  `178704d5356744512b17181fc318b552203a88bc`;
- `idempotency-service.ts` blob:
  `7314b57254050f489456d53ae4615a73ba9208a6`;
- core test blob: `246055bbbc7aa08bdee5c09126c57a96eabe87c6`;
- backend test blob: `cd6887785bfd233dd101ebeb1f655afa9b671f2a`.

Replayable test-only red evidence is
`evidence/round-1-red-tests.patch` at SHA-256
`da33158e222b60240dc3de705fa2b3b26f92c0437ada3ca378ca97e3202d772a`.
`git apply --check --reverse` succeeds against the final test tree. Patch
numstat is `34/9` for the backend route test and `1991/35` for the core
service test.

### Third-audit behavior and tests

- Watchers are registered top-down from the trusted workspace root to the
  record parent. A complete pre-registration chain snapshot is reproved only
  after all watchers are live; the deterministic hook moves either the root
  or an intermediate directory away and back immediately before its watcher
  registration, and every row rejects the changed chain.
- A watched-entry notification is checked against its container epoch. Once
  it confirms pathname drift, invalidation is permanent. This distinguishes
  a real ancestor entry rebound from Darwin's ambiguous descendant-only
  notifications without reopening the authority window.
- The registration-window matrix covers the direct store, observed-consume,
  and `complete/fail × guard/cleanup-lock` public paths across both ancestor
  levels. It preserves generation A and the foreign sentinel, leaves no
  owned namespace, and returns watcher, permit, binding, authority, and exact
  generation-FD counts to baseline.
- Failure-graph ownership is now allocation-local. If no distinct
  compensation remains, the original primary returns before preservation,
  ownership marking, or normalization. Writable, frozen, and
  non-configurable caller-created preservation envelopes remain byte-for-byte
  descriptor-identical through direct store, binding-release, and idempotency
  release folds, with ordered independent identities represented once.

Final focused command:

```sh
npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts -t 'Phase 6.2 third audit|Phase 6.2 re-audit|opt-in cleanup-permit deletion settles only restored exact A|Round 1 exact settlement isolates A'
```

Result: `7 pass`, `406 filtered out`, `0 fail`, `645 expect()`.

The complete core suite checkpoint returned `408 pass`, `5` platform-only
skips, `0 fail`, and `29560 expect()` across 413 tests. The full backend route
suite returned `154 pass`, `0 fail`, and `5030 expect()`. Scoped core and root
TypeScript checks exited `0` without diagnostics. The final
`npx --yes bun@1.2.19 run check` exited `0` after rerunning typecheck,
policy/tool governance, backend API/WebSocket, frontend, schemas, all core
services, and all GLM-provider tests. OpenSpec strict validation returned
`Change 'm1-transition-artifact-exact-retry' is valid`.

Repository hygiene remained clean: `git diff --check` and
`git diff --quiet -- zero` exit `0`; the pinned `zero` gitlink remains
`13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`; no workspace output is tracked;
no `red-proof` stash exists. The pre-existing untracked `.review-gate.json`
was not touched, and no commit, index mutation, push, PR comment, `.workplans`,
or `zero/` change was made.

## Depth-redesign final verification (supersedes watcher-based checkpoints)

Verified on `2026-07-18 17:31:12 EDT` from branch
`codex/issue-108-exact-transition-retry` at fixed review head
`0cda5d0d434f0a96a39e4feb4a43ea229df6aba9`. Earlier watcher/restore
checkpoint descriptions above are historical only; the final implementation
has no watcher registration, event-delivery wait, public restore, or public
re-isolation in the opt-in settlement chain.

The uncommitted source/test slice is bound by binary diff SHA-256
`9ff64742b4f16b184b62dd5dc00db9469efec17932e225c305faea09fffdf2e6`.
Key blob identities are:

- occurrence ledger: `d888bccf4a9eb30204e7c199d4502ff091e645b1`;
- typed adapter: `6a9e3a5850a2ca1b11f540f11b7eb9ee69f5fc55`;
- workspace store: `09e16a4b152f2f54b354b9c49e2ce11f51dd7cb4`;
- idempotency service: `918eca6127eddaa7c798d996b83e5c765c4ce91a`;
- backend route: `afd185b1803e3734feacff06f3c0ee135c0214a0`;
- core matrix: `12109ce37be55a9fbf1e069a5865e69024139ec9`;
- backend matrix: `52688673621f985e2b132044a1a0218116facb4e`.

Focused private-ticket/ledger/public-consumer command:

```sh
npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern 'private-ticket|private namespace cleanup|default conditional delete still|public complete, fail|failure ledger'
```

Result: `9 pass`, `378 filtered out`, `0 fail`, `105 expect()`.

Focused backend typed/settlement command:

```sh
npx --yes bun@1.2.19 test packages/backend/src/routes/index.test.ts --test-name-pattern 'observation body dominates|unrecoverable guard-release|compound settlement and release|digest-mismatch typed acceptance|self-identical release rejection|inner completed-consumption fold'
```

Result: `7 pass`, `147 filtered out`, `0 fail`, `125 expect()`.

Full verification:

- `npx --yes bun@1.2.19 run test:core-services`: `382 pass`, `5` platform-conditioned skip, `0 fail`, `27918 expect()` across 387 tests.
- `npx --yes bun@1.2.19 run test:backend-api`: `154 pass`, `0 fail`, `5029 expect()`.
- scoped core and root `typecheck`: exit `0`, no diagnostics.
- `npx --yes bun@1.2.19 run check`: exit `0`; policy/raw-data `430 pass`, tool governance `11 pass`, backend API `154 pass`, backend WS `34 pass`, frontend `20 pass`, schemas `6 pass`, core services `382 pass` plus 5 platform skips, and GLM provider `60 pass`, all with `0 fail`.
- `openspec validate m1-transition-artifact-exact-retry --strict --no-interactive`: valid.
- `git diff --check` and `git diff --quiet -- zero`: exit `0`.
- `git submodule status -- zero`: pinned `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` with no gitlink change.
- `git ls-files workspace | wc -l`: `0`; `git stash list` contains no `red-proof` entry.

The pre-existing untracked `.review-gate.json` and
`evidence/round-1-red-tests.patch` remain untouched. No commit, index mutation,
push, PR comment, `.workplans`, diagnostics, submodule, or `zero/` edit was made.

## Invariant-closure replacement ledger

The Phase 6.2 deletion audit found 28 removed test declarations. Each old
oracle is replaced below by a current test with equal or stronger coverage;
several old provenance-envelope tests intentionally converge on the same
occurrence-ledger matrix because the new contract has no helper-owned envelope
flattening.

| # | Removed test | Current replacement |
|---:|---|---|
| 1 | `undefined mutable primary precedes later close compensation without false success` | `mutable create and update retain an undefined primary and clean exactly once` |
| 2 | `mutable compensation preserves a frozen custom error contract and aggregates once` | `failure ledger separates exact identities, events, aliases, and caller evidence` |
| 3 | `mutable and hardlink close compensation remains flat through later cleanup failure` | `hardlink and close slots retain undefined failures while terminal namespace cleanup settles`; `failure ledger preserves throwing accessors, primitive slots, and nested folds` |
| 4 | `publication compensation retains an undefined cleanup failure on a frozen primary` | `mutable create and update retain an undefined primary and clean exactly once`; `failure ledger separates exact identities, events, aliases, and caller evidence` |
| 5 | `compensation preservation safely exposes aggregate cause for every cause descriptor kind` | `failure ledger preserves throwing accessors, primitive slots, and nested folds`; `failure ledger observes Error proxies and array traps once per fresh fold` |
| 6 | `compensation preservation keeps private and WeakMap Error brands on the original object` | `failure ledger separates exact identities, events, aliases, and caller evidence`; `failure ledger observes Error proxies and array traps once per fresh fold` |
| 7 | `mutable and hardlink compensation preserve branded Error identity and behavior` | natural-path tests `mutable create and update retain an undefined primary and clean exactly once` and `hardlink and close slots retain undefined failures while terminal namespace cleanup settles`, plus the exact-identity ledger matrix |
| 8 | `compensation preservation retains every undefined and falsy slot in order` | `failure ledger preserves throwing accessors, primitive slots, and nested folds`; `central release lifecycle preserves falsy bodies and flattens repeated envelopes` |
| 9 | `compensation preservation flattens only helper-owned envelopes by provenance` | `failure ledger requires explicit trusted adoption and keeps folds fresh`; `caller writable and non-configurable compatibility envelopes remain exact roots` |
| 10 | `compensation preservation flattens repeated sibling helper envelopes in exact slot order` | `failure ledger separates exact identities, events, aliases, and caller evidence`; `S31-P62-09 repeated folds keep event slots while deduplicating identity views` |
| 11 | `compensation preservation bounds genuine provenance cycles with an explicit marker` | graph-cycle bounding in `failure ledger preserves throwing accessors, primitive slots, and nested folds`; independent-fold coverage in `S32-P62-09 independent provenance folds retain distinct ordered occurrences` |
| 12 | `workspace publication flattens repeated helper compensation slots` | natural mutable/hardlink tests above plus `failure ledger preserves throwing accessors, primitive slots, and nested folds` |
| 13 | `compensation preservation observes positively branded Proxy Error traps without replacing the primary` | `failure ledger observes Error proxies and array traps once per fresh fold` |
| 14 | `mutable compensation keeps positively branded Proxy Error failures ordered before cleanup` | the positive-Proxy row above plus natural mutable cleanup coverage |
| 15 | `indeterminate Proxy brands stay represented raw values across helper, publication, and delete` | the indeterminate-Proxy row in `failure ledger observes Error proxies and array traps once per fresh fold` |
| 16 | `Artifact duplicate registration converges across the owned publication window` | same-named migrated test |
| 17 | `cleanup-permit deletion marks failures after canonical isolation post-mutation` | `exact isolation never republishes A when ticket capture, pinned proof, or legacy normalization fails`; `default conditional delete still restores the isolated generation after callback failure` |
| 18 | `opt-in cleanup-permit deletion settles only restored exact A and preserves converged successors` | `private-ticket settlement deletes only first-isolated A and observes public successors` |
| 19 | `opt-in exact failure settlement runs once only after post-mutation failure` | `exact settlement is not entered after initial success and its permit cannot be reused`; `private-ticket settlement deletes only first-isolated A and observes public successors` |
| 20 | `opt-in exact settlement failure keeps the initial marker primary and settles authority once` | `private-ticket settlement retries transient unlink and fails closed on permanent unlink`; `private namespace cleanup and pinned close failures retain exact phase order` |
| 21 | `completeRecord and failRecord recover restored transition artifacts without surfacing the initial marker` | `public complete, fail, and observed-consume callers recover only private exact artifacts` |
| 22 | `stale observed guard consumption recovers restored exact A before reacquisition` | the observed-consume row in `public complete, fail, and observed-consume callers recover only private exact artifacts` |
| 23 | `owner guard and cleanup-lock releases inherit retained-parent rejection` | `owner guard and cleanup-lock releases settle exact artifacts after sibling epoch advance` |
| 24 | `publish-lock post-mutation failure is recovered before releasing the fulfilled guard` | `persistent publish-lock namespace failure remains observable after releasing the fulfilled guard` |
| 25 | `independent publish-lock and guard post-mutation failures each recover exact A` | `independent persistent publish-lock and guard namespace failures remain ordered` |
| 26 | `exact settlement preserves a replacement installed during restored publish-lock release` | `persistent publish-lock namespace failure preserves a replacement guard` |
| 27 | `S31-P62-09 repeated folds deduplicate prior provenance but preserve sibling multiplicity` | `S31-P62-09 repeated folds keep event slots while deduplicating identity views` |
| 28 | `S32-P62-09 independent provenance cycles retain distinct ordered occurrences` | `S32-P62-09 independent provenance folds retain distinct ordered occurrences` |

The explicit gap migrations are therefore present: writable and
non-configurable caller envelopes remain descriptor-identical roots; natural
mutable and hardlink failures exercise real cleanup paths; initial success
never enters exact-failure settlement and the consumed permit is terminal;
positive and indeterminate Proxy brands, array length/element traps, and fresh
fold observations have direct assertions.

### Invariant-closure final verification

Verified on `2026-07-18 18:25:59 EDT`. The source/test binary diff SHA-256 is
`fbc780a738040482f90e6c9540c41d94ae9a6053baebbef32079fd3b3f5fe94f`.

- PT-1/LG-1/LG-2 focused core rows: `4 pass`, `387 filtered out`, `0 fail`,
  `43 expect()`.
- Delayed-watch green oracle: `1 pass`, `0 fail`, `14 expect()`; 54 ms total,
  zero watcher registrations and events. Harness SHA-256 is
  `fa3893c5077fcee7f36c105fdb7b07ba2f4ea962e0093609c8e9bcc234416e24`;
  its green note SHA-256 is
  `073af2feeb8bc3c981f48ca007c4a38b586e1a7d5f4a81262ac4b24196ccac1b`.
- Complete core matrix: `386 pass`, `5` platform-conditioned skip, `0 fail`,
  `27974 expect()` across 391 tests.
- Complete backend route matrix: `154 pass`, `0 fail`, `5029 expect()`.
- Same-fold typed backend focus after removing all route-level raw
  `TaskServiceError` rereads: `6 pass`, `148 filtered out`, `0 fail`,
  `82 expect()`.
- Scoped core TypeScript check: exit `0`; no diagnostics.
- Root `npx --yes bun@1.2.19 run check`: exit `0`; every typecheck,
  governance, backend API/WebSocket, frontend, schema, core-service, and GLM
  provider stage completed without failure. The core stage repeated the
  `386/5/0` result and GLM reported `60 pass`, `0 fail`.
- OpenSpec strict validation: valid. `git diff --check`: exit `0`.

The only `.workplans` changes are the explicitly authorized delayed-watch
oracle and its same-directory green evidence. The pre-existing untracked
`.review-gate.json` and `evidence/round-1-red-tests.patch` were not modified;
no Git index, commit, push, PR, gate, submodule, or `zero/` mutation was made.

## Final committed implementation binding

Verified on `2026-07-18 22:19:54 EDT` from branch
`codex/issue-108-exact-transition-retry`. This section supersedes every
uncommitted-tree identity above and binds the final source/test slice to
implementation commit
`0e78add340d08f99b1ebfdfb5753f1d988d70b46`.

The binary diff from fixed review head
`0cda5d0d434f0a96a39e4feb4a43ea229df6aba9` through the nine declared
source/test paths has SHA-256
`ce807b9d0b4f9811f1fe99363f99a89216be0c156e1e36398f1b43285125222d`.
The committed blob identities are:

- backend route: `0240c0e1b907e7bbf29e5dcca93b44c380009905`;
- backend route tests: `8c6cb4e959d3dd233d5fee870d6ac1aac957e1bd`;
- occurrence ledger: `93b4f8696f6932c8e88095b5c0148ad5813d23c3`;
- core service matrix: `6f8901e910b174b81ffbbd227c796f520804a048`;
- idempotency service: `0e6e5dde0a1e297c9cad586e4f661a3224553443`;
- service export surface: `ab2427ada0b8476ecde6cc4501bff3d96bb482bb`;
- TaskCard service: `e9c96c0e45a675b0134a367ad491a72926da8ebc`;
- typed TaskServiceError adapter: `a87fe85ddcb5bb05e7e75e01d488a01dc4409010`;
- workspace record store: `589e2a12196045f87c8fe1cafaf1bdb82eadb989`.

The committed replayable red-test patch has SHA-256
`aafbafb87e0e30da9c66554dddaa70291d62763710ccd13906589730f3aee643`.
After mechanical trailing-whitespace cleanup, `git apply --check` succeeds
against the fixed review head archive.

Final orchestrator verification against the committed implementation:

- root `npx --yes bun@1.2.19 run check`: exit `0`; policy/raw-data `430`
  pass, tool governance `11` pass, backend API `157` pass, backend WebSocket
  `34` pass, frontend `20` pass, schemas `6` pass, core services `393` pass
  plus `5` platform-conditioned skips, and GLM provider `60` pass; every
  suite reported `0 fail`;
- delayed-watch private-ticket oracle: `1 pass`, `0 fail`, `14 expect()`;
  it verifies exact settlement is independent of delayed `fs.watch` delivery;
- strict OpenSpec validation: `Change 'm1-transition-artifact-exact-retry' is
  valid`;
- `git diff --check`, `git diff --quiet -- zero`, and stash hygiene: clean;
- the `zero` gitlink remains pinned to
  `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` with no submodule change.

The local `.review-gate.json` and ignored `.workplans/issue-108/` artifacts
are workflow state only and are not part of the implementation commit.
