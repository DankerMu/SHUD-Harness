> **Superseded Round-1 evidence.** This file binds only to frozen pre-repair
> head `1a993c89c842b72512768c40b87dd2205562ac05` and MUST NOT be used as current
> merge evidence. Round-1 review invalidated its raw-Error/Proxy-carrier,
> implicit-adoption, bounded-work, typed-trust, phase, and whole-file exclusion
> conclusions. In particular, `exact raw Proxy carrier` and “no
> idempotency/workspace diff” below are historical observations, not current
> requirements. The repair must append a new final-head verification section
> that supersedes every conflicting claim and hash.

> **Round-2 review status.** The binding at
> `b425a68aa6e3f886c424d439f48bb97ac05bac23` is not merge evidence:
> Round 2 verified six findings and triggered a same-invariant depth retro.
> Tasks 7.1-7.8 and a new final-head binding must be completed before merge.

## Superseded verification evidence

- Date: 2026-07-18 through 2026-07-19 (America/New_York)
- Base source: `5a450a97f2a474af2f4db26bd9ee198adb7395ec`
- Focused command:
  `npx --yes bun@1.2.19 test ./packages/core/src/domain/services/failure-occurrence-ledger.test.ts ./packages/backend/src/routes/failure-occurrence-ledger-routes.test.ts`
- Focused result: exit 0; 10 pass, 0 fail, 62 assertions.
- Round 2 diagnosis command:
  `npx --yes bun@1.2.19 test ./openspec/changes/m1-failure-occurrence-ledger/evidence/diagnosis/occurrence-ledger-round2-diagnosis.test.ts`
- Round 2 diagnosis result on Child A: exit 0; 2 pass, 0 fail, 7
  assertions. The same replay patch on parent source `b6c7977...` exits 1
  with both confirmed behavior failures.
- Restored base-scenario focused command:
  `npx --yes bun@1.2.19 test ./packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts -t 'undefined mutable primary|mutable compensation preserves a frozen|mutable and hardlink close compensation|publication compensation retains|compensation preservation safely exposes|private and WeakMap|branded Error identity|falsy slot|only helper-owned|repeated sibling|genuine provenance cycles|publication flattens repeated|positively branded Proxy|indeterminate Proxy|publish-lock release stays primary|S34-P62-16 shared consume'`.
- Restored base-scenario focused result: exit 0; 17 pass, 0 fail, 658
  assertions.
- Full core command: `npx --yes bun@1.2.19 run test:core-services`.
- Full core result on Child A: exit 0; 397 pass, 5 platform-dependent
  skips, 0 fail across 402 tests in two files. The giant service file retains
  all 394 base declarations (381 ordinary plus 13 conditional), with 389 pass
  and 5 skips; the dedicated ledger file adds 8 passing tests.
- Base comparison: a clean detached `5a450a97...` worktree with the locked
  dependencies ran the same core command at 389 pass, 5 skips, 0 fail across
  394 tests in the giant service file. The temporary worktree was removed
  after the comparison.

Final Round 2 diagnosis green output:

```text
bun test v1.2.19 (aad3abea)

openspec/changes/m1-failure-occurrence-ledger/evidence/diagnosis/occurrence-ledger-round2-diagnosis.test.ts:
(pass) Round 2 occurrence-ledger diagnosis > independent nested fold rereads the current mutable cause [17.96ms]
(pass) Round 2 occurrence-ledger diagnosis > 25K cause chain is iterative, bounded, and retains its primary ledger [39.09ms]

 2 pass
 0 fail
 7 expect() calls
Ran 2 tests across 1 file. [796.00ms]
```
- Root command: `npx --yes bun@1.2.19 run check`
- Root result: exit 0. Included 430 policy tests, 11 registry-governance
  tests, 156 backend route tests, 34 backend WebSocket tests, 20 frontend
  tests, 6 schema tests, 397 passing core-service tests with 5
  platform-dependent skips, and 60 GLM-provider tests.
- Typecheck: `npx --yes bun@1.2.19 run typecheck` -> exit 0.
- OpenSpec: `npx --yes openspec validate m1-failure-occurrence-ledger
  --strict --no-interactive` -> valid.
- Patch replay: `git apply --check --cached
  openspec/changes/m1-failure-occurrence-ledger/evidence/red-before-tests.patch`
  -> exit 0.
- Round 2 replay: `git apply --check
  openspec/changes/m1-failure-occurrence-ledger/evidence/diagnosis/round2-b6c-diagnosis.patch`
  on detached `b6c7977...` -> exit 0 before the recorded red run.
- Hygiene: `git diff --check` -> exit 0; no `red-proof` stash; no Zero,
  dependency-manifest, workspace-record-store, or idempotency-service diff.

Requirement-to-test mapping:

- Physical occurrence identity, phase/order, equal primitive multiplicity, and
  caller-descriptor immutability: `preserves equal primitives and reused Error
  identities as physical occurrences`.
- Fresh mutable/accessor/Proxy observation and nested-history adoption:
  `freshly observes mutable nested causes and accessors on every independent
  fold` and `freshly observes a nested Proxy carrier once per fold and
  terminates cyclic graphs`.
- Node/edge N-1, N, N+1 limits: the two dedicated budget tests.
- Maximum-length sparse arrays: the dedicated sparse-own-key test.
- 25K chain and hostile observation: the dedicated deep/accessor/Proxy test.
- Exact and one-shot Proxy typed projection plus forged rejection: the
  dedicated typed core test and the two backend route tests.
- Generic TaskCard folds: the migrated publication/settlement paths in
  `task-card-service.ts`, exercised by the full TaskCard core-service suite;
  no new private settlement behavior or test seam was added.
- Existing HTTP envelope compatibility: the full 156-test backend route suite.

The old recursive `PreservedErrorCompensationEnvelope` graph assertions were
migrated to ledger event/ordered-distinct/observed-graph assertions. No base
test scenario was removed. The private exact-settlement exclusion limits new
Child A behavior; it does not authorize deleting existing governing coverage.

Restored base-scenario ledger migration (17/17):

| Base test scenario | Migrated oracle |
| --- | --- |
| `undefined mutable primary precedes later close compensation without false success` | represented undefined primary plus physical and ordered-distinct close occurrences; cleanup and missing-path assertions retained |
| `mutable compensation preserves a frozen custom error contract and aggregates once` | exact frozen primary, physical duplicate occurrences, distinct compensation, and prior-cause graph node |
| `mutable and hardlink close compensation remains flat through later cleanup failure` | exact primary plus physical occurrence counts for close, cleanup, authority, and nested typed wrappers; retry/path/inode assertions retained |
| `publication compensation retains an undefined cleanup failure on a frozen primary` | exact frozen primary, undefined settlement occurrence, and prior-cause graph node |
| `compensation preservation safely exposes aggregate cause for every cause descriptor kind` | exact primary, occurrence events, observation failures, and prior-cause graph nodes for data/accessor descriptor variants |
| `compensation preservation keeps private and WeakMap Error brands on the original object` | exact branded identity, descriptors/immutability/behavior, and compensation occurrence |
| `mutable and hardlink compensation preserve branded Error identity and behavior` | exact branded identity and physical/distinct compensation occurrences; mutable/hardlink behavior retained |
| `compensation preservation retains every undefined and falsy slot in order` | chronological raw occurrence values plus prior-cause graph node |
| `compensation preservation flattens only helper-owned envelopes by provenance` | nested history adoption, physical repeated primary events, ordered-distinct projection, caller-owned aggregate graph, and one fresh accessor observation per independent fold (three reads across three nested folds, four after the outer fold) |
| `compensation preservation flattens repeated sibling helper envelopes in exact slot order` | inherited occurrence IDs adopted once while both explicit sibling occurrences remain physical events |
| `compensation preservation bounds genuine provenance cycles with an explicit marker` | finite unique graph node plus distinct trusted occurrence IDs and ordered-distinct cycle identity |
| `workspace publication flattens repeated helper compensation slots` | publication-layer physical repeated occurrences plus distinct identity projection; path cleanup retained |
| `compensation preservation observes positively branded Proxy Error traps without replacing the primary` | exact Proxy primary plus only actually observed descriptor-trap occurrences |
| `mutable compensation keeps positively branded Proxy Error failures ordered before cleanup` | exact Proxy primary, physical cleanup multiplicity, distinct cleanup/observation order, and path cleanup |
| `indeterminate Proxy brands stay represented raw values across helper, publication, and delete` | exact raw Proxy carrier, physical cleanup/observation occurrences, observation ledger, and delete identity/path restoration |
| `publish-lock release stays primary when fulfilled-guard emergency settlement also fails` | exact typed release primary, graph-retained cause, ordered distinct release/namespace/settlement failures, and retry/resource baselines |
| `S34-P62-16 shared consume and guard-release rejection transports the primary once, never as its own compensation` | exact shared primary, no shared identity in ordered compensation, one typed release wrapper, durable replay, and authority baseline |

## Final committed implementation binding

Verified on `2026-07-19 00:35:30 EDT`. The implementation is commit
`2b1e91679733e3f5e42d6ffa5837122129691eb3` on branch
`codex/issue-108-ledger-foundation`, based on
`5a450a97f2a474af2f4db26bd9ee198adb7395ec`.

The binary diff over the nine declared source/test paths has SHA-256
`a35f7ae59751592620aa00570e8baa88209e67f54dff704b040fff627506a015`.
Committed blob identities are:

- backend dedicated tests: `25e1dce38dec37269a76fa02e8bc5c84647fada4`;
- backend route regressions: `20c68d28af9a452a3a73e1628fac0d2e626d0f43`;
- backend route implementation: `ed966c8925b7a991ddbd7a2d8d082edf807749a2`;
- occurrence ledger implementation: `07a3bb63fabeed1124718f4650574ff5341d590e`;
- dedicated core ledger tests: `16e4c690f2a1030b56aadcc848941afb3c7812b5`;
- migrated core service matrix: `af5544b3ea88de73b2014524e1882f7e74fdbafc`;
- core export surface: `ed80bca49bb0ba97872842ccd584ca4aa34c48d7`;
- TaskCard consumer: `ee5f060e72cf34c23a3d7cb2db88e04a6d116929`;
- typed TaskServiceError boundary: `10aabc4a30c40942ceff19124724153bfea58f48`.

Replay evidence identities:

- base red-test patch: `04406e09d0fb24021df711fbc99850009968fb266c1b6ed47e182b8097ea087f`;
- Round 2 `b6c7977` behavior-red patch:
  `233f09518cee245adbfdf28bd3009a8260fc64ebad7035b53f0e18f3900ab3ba`;
- tracked behavior diagnosis test:
  `73e4fad603a229fb3000d48a4ae379373c18aed6d8aa81a0d3f8b70dd6bf7a83`.

The final implementation keeps every base core-service test declaration and
adds eight dedicated ledger tests plus two dedicated backend tests. No
`workspace-record-store.ts`, `idempotency-service.ts`, dependency manifest,
`zero/`, or workspace output is part of this child diff.

## Final Round-1 repair binding (supersedes all evidence above)

Verified on `2026-07-19 05:30:25 EDT`. The verified semantic implementation
head is `68932bc05b73b8f09079e075a80ec3d9b79502ff` on branch
`codex/issue-108-ledger-foundation`, based on
`5a450a97f2a474af2f4db26bd9ee198adb7395ec`. This section supersedes the
pre-repair `1a993c8` and initial implementation `2b1e916` claims above.

### Architecture and deviation binding

- Exact raw `Error` identity plus `failureLedger(error)` lookup cannot isolate
  sequential, concurrent, and reentrant operations that reuse the same raw
  object. The tracked architecture decision therefore selects one immutable
  carrier per ledger-producing fold and exact raw recovery through semantic
  accessors.
- The repair expanded by symbol into the shared idempotency/workspace release
  producers named by the fixture; it did not change their business state,
  generation tickets, private settlement, persisted schema, or public HTTP
  payload.
- Phase 6.2 found one same-class TaskCard sibling outside the initial cited
  lines: raw `instanceof Error` classification before bounded observation.
  The repair removed both TaskCard occurrences, preserved explicit nullish/
  falsy cause presence, and completed cyclic/fresh/throwing public hydration
  and settlement matrices.
- There are no remaining product deviations from the repaired fixture. The
  only evidence-format exception is that full-range `git diff --check` reports
  unified-diff context marker lines inside the tracked replay patch; removing
  those mandatory markers would make the patch invalid. Every incremental
  source/test/evidence diff passed `git diff --check` before commit.

### Replayable red evidence

- Initial behavior red: `evidence/red-before-tests.patch` and
  `evidence/red-before.md` against base `5a450a9`.
- Round-1 repair red: `evidence/repair-round-1/red-before-tests.patch` and
  `red-before-report.md` against `1a993c8`.
- First Phase 6.2 closure red:
  `evidence/repair-round-1/phase-6.2/red-before-tests.patch` and
  `red-before-report.md` against `a370f8e`; the focused command exited 1 with
  1 pass, 4 intended failures, 561 filtered, and 22 assertions. The same
  command on the repair tree passed 5/5 with 47 assertions.
- TaskCard sibling red: the test-only diff obtained with
  `git diff 7ff73f7..68932bc -- packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts`
  was applied in a detached `7ff73f7` worktree with the root dependencies.
  The cyclic and fresh cleanup-settlement rows each hit the one-second
  watchdog (`0 pass, 2 fail, 398 filtered`), with no dependency/import error.
  The temporary worktree was removed. On `68932bc`, all three cyclic/fresh/
  throwing settlement and hydration rows pass.

### Final local verification

- Dedicated ledger/typed-boundary command:
  `npx --yes bun@1.2.19 test ./packages/core/src/domain/services/failure-occurrence-ledger.test.ts ./packages/backend/src/routes/failure-occurrence-ledger-routes.test.ts`
  -> exit 0; 19 pass, 0 fail, 193 assertions.
- TaskCard/settlement focused command:
  `npx --yes bun@1.2.19 test ./packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts -t 'Phase 6\.2 bounds hostile prototype failures|TaskCard hydration distinguishes explicit|TaskCard single settlement retains|S34-P62-03 lost'`
  -> exit 0; 8 pass, 392 filtered, 0 fail, 74 assertions.
- `npx --yes bun@1.2.19 run test:core-services` -> exit 0; 411 pass,
  5 platform-dependent skips, 0 fail across 416 tests.
- `npx --yes bun@1.2.19 run test:backend-api` -> exit 0; 158 pass,
  0 fail.
- `npx --yes bun@1.2.19 run typecheck` -> exit 0.
- `npx --yes bun@1.2.19 run check` -> exit 0; policy, tool-registry,
  backend HTTP/WebSocket, frontend, schemas, core services, and GLM provider
  all passed.
- `npx --yes openspec validate m1-failure-occurrence-ledger --strict --no-interactive`
  -> valid.
- Phase 6.2 full-inventory audit on `68932bc` -> clean; no remaining finding.
- Hygiene -> no `red-proof` stash, no retained temporary worktree, no tracked
  workspace output, no submodule gitlink change, and Zero remains
  `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

### Oracle integrity and declaration retention

- The large core service file retains every base declaration except the two
  fixture-authorized S31/S32 ledger-equivalent names; static declarations are
  382 at base and 386 after repair. The two missing names are replaced by the
  operation-carrier/explicit-adoption equivalents required by the repaired
  contract.
- Backend route declarations are 155 at base and 156 after repair, with none
  removed. Using the repository's static test-declaration convention
  `rg -c '^\s*test\('`, the dedicated ledger and backend files contain 16 and
  3 declarations respectively (19 total, matching the dedicated runtime run).
- The last test-only commit expands one static test into three runtime cases;
  core runtime tests increase by two without deleting a scenario or weakening
  an assertion category.
- No existing spec, acceptance criterion, test gate, or CI command was weakened
  to obtain green results.

### Source and test hash binding

The source diff SHA-256 over the seven product-source paths is
`8a029f4c44f9b7ca6b2224b8a7c8a3da1eeba19d6669aca4585ce58270d6be44`.
The test diff SHA-256 over the four runtime test paths is
`52d314f24aae882db70dee13d866a607871cd36854b7b01b506ef95dba4ab670`.

Final file SHA-256 values:

- `packages/backend/src/routes/index.ts`:
  `efcba7c234416170122b98ec24194df0e9b89f98f73c46c5fd7bea863827375e`;
- `packages/core/src/domain/services/compensation-error-preservation.ts`:
  `fabe513b2fe043a380f3ce1754ea6751ab0f1d6c77898a2253ab5c8266f539bc`;
- `packages/core/src/domain/services/idempotency-service.ts`:
  `f1a98dc0f915fff04aac552129531a24f5b46e0d5e9c03056c59931806453cc5`;
- `packages/core/src/domain/services/index.ts`:
  `1dadcf5373f302392f6847526fd2065f11c73cfe6ea719ac167b7da3bf0cd4a6`;
- `packages/core/src/domain/services/task-card-service.ts`:
  `d4fbc09f8e8fa9c8bf23000fa0182d2e7868a28502bd71deff731b6198982b61`;
- `packages/core/src/domain/services/task-service-error-compensation.ts`:
  `45abe521a5eff5c041e680becf6c5388e0dd30ea184726ffa47fba3d67b3a8b9`;
- `packages/core/src/domain/services/workspace-record-store.ts`:
  `7ea6e0370a5b9f3a6f5c33107339bcb470f873a8793e4621d72a5611deec41ac`;
- `packages/backend/src/routes/failure-occurrence-ledger-routes.test.ts`:
  `7f51a37fc75f8b098471fa90f38b4cd20eb174a3e0568390eeaa797cc288c64f`;
- `packages/backend/src/routes/index.test.ts`:
  `ab251ef3a9d7a99ce949977906fbf25f9aa0a49543ccd9eb1a06f6fe52dd9422`;
- `packages/core/src/domain/services/failure-occurrence-ledger.test.ts`:
  `d07f70e4d992095e9741ae984494b6bfbfdc8e1f48f61bd15816e85f8a7d0557`;
- `packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts`:
  `788bbd462639ff3e15b1b86879e2ee3a5e84b4b7a7cf1c13073870b1d33cc874`.

## Final Round-2 depth repair binding (supersedes all prior merge evidence)

Verified on `2026-07-19 12:39:24 EDT`. The semantic repair head is
`730276230aa6992e09f5e5b3427880a68e5772b1` on branch
`codex/issue-108-ledger-foundation`, based on
`5a450a97f2a474af2f4db26bd9ee198adb7395ec`. This section supersedes the
Round-2 reviewed head `b425a68aa6e3f886c424d439f48bb97ac05bac23`
and every earlier verification count/hash for
merge purposes.

### Corrective-action and architecture closure

- The fold ABI is occurrence/adoption-only. Explicit carrier adoption imports
  prior occurrence IDs once and adds a fresh occurrence for the current
  physical catch; untrusted, duplicate, stale/reused, reordered, cardinality-
  invalid, and phase-invalid entries reject transactionally.
- Exact raw identity and operation-owned lookup are mutually incompatible when
  one raw object is reused sequentially, concurrently, or reentrantly. The
  accepted architecture therefore uses a unique operation carrier plus an
  exact semantic accessor. This is the tracked decision selected after the
  architecture spike, not a compatibility shortcut.
- Exact `undefined`, nullish, and falsy failures use explicit discriminated
  outcomes rather than value sentinels across backend and in-scope core release
  siblings.
- Authority transport is a core-owned closure-branded family; it does not use
  name, field, prototype, constructor, or caller-code inspection.
- Numeric-key accounting selects the lowest canonical present keys with a
  bounded max-heap independent of returned-key position. Known numeric-budget
  exhaustion is recorded when proved, so later edge/control exhaustion cannot
  swallow it; absent descriptors do not fabricate edge evidence.
- TaskCard, backend, idempotency, and workspace callers were migrated by symbol
  without changing private generation settlement, unrelated business state,
  persisted schemas, dependencies, frontend behavior, Zero, or public HTTP
  payloads.

### Replayable red evidence

- `evidence/repair-round-2/red-before-core-depth.patch` plus
  `round2-depth-regression.test.ts` replay on
  `b425a68aa6e3f886c424d439f48bb97ac05bac23`: exit 1; 2 pass,
  3 intended fail, 10 assertions. The identical command on the semantic repair
  head exits 0 with 5 pass, 0 fail, 46 assertions.
- `evidence/repair-round-2/red-before-backend-undefined.patch` replay on
  `b425a68aa6e3f886c424d439f48bb97ac05bac23`: exit 1; the old adapter static
  check fails, exact `undefined`
  finalizer rejection returns 201 instead of 500, and reconciliation loses the
  expected `body, settlement` vector.
- `evidence/repair-round-2/red-before-report.md` records which dirty-baseline
  failures cannot be losslessly replayed because their pre-source state was not
  preserved. Those observations are not presented as replayable proof.

### Final local verification

- Dedicated ledger/backend command:
  `npx --yes bun@1.2.19 test packages/core/src/domain/services/failure-occurrence-ledger.test.ts packages/backend/src/routes/failure-occurrence-ledger-routes.test.ts`
  -> exit 0; 27 pass, 0 fail, 376 assertions.
- Round-2 corrective regression command:
  `npx --yes bun@1.2.19 test openspec/changes/m1-failure-occurrence-ledger/evidence/repair-round-2/round2-depth-regression.test.ts`
  -> exit 0; 5 pass, 0 fail, 46 assertions.
- `npx --yes bun@1.2.19 run test:core-services` -> exit 0; 430 pass,
  5 platform-conditioned skips, 0 fail, 29,117 assertions across 435 tests.
- `npx --yes bun@1.2.19 run test:backend-api` -> exit 0; 161 pass,
  0 fail, 5,092 assertions across 161 tests.
- `npx --yes bun@1.2.19 run typecheck` -> exit 0.
- `npx --yes bun@1.2.19 run check` -> exit 0; policy, tool-registry,
  backend HTTP/WebSocket, frontend, schemas, core services, and GLM provider
  all completed.
- `npx --yes openspec validate m1-failure-occurrence-ledger --strict --no-interactive`
  -> exit 0 (`Change 'm1-failure-occurrence-ledger' is valid`).
- Final Phase 6.2 full-inventory audit:
  `evidence/phase-6.2-definitive-audit.md`
  -> clean; all shared-helper, entrypoint, read/write, release/rollback,
  producer/consumer, stale/idempotency, and unchanged-consumer surfaces were
  covered. The tracked report preserves the historical Round-2 result and
  revalidates the complete inventory on the final A1/A2 semantic stack.

### Oracle, declaration, and hygiene evidence

- Tasks 7.1-7.8 are complete. No acceptance criterion, selected risk-pack
  scenario, existing test, spec requirement, or CI command was weakened or
  deleted to obtain green results.
- Static `test()` declarations are 24 dedicated core plus 3 dedicated backend
  (27 total, matching runtime), 396 large core-service versus 381 at base, and
  158 backend route versus 154 at base.
- No `red-proof` stash remains. No temporary replay worktree is retained. No
  dependency manifest, `zero/` gitlink, tracked workspace output, or submodule
  pin is changed; Zero remains
  `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- Incremental implementation/spec/test whitespace check excluding captured
  replay-patch bytes exits 0. The backend replay patch intentionally retains
  six literal `+ ` blank lines from its captured unified diff; a range-wide
  `git diff --check` reports only those evidence-artifact lines. Removing them
  would change the replay bytes. This is an evidence-format limit, not product
  source whitespace.
- The known monotonic-clock defect is unrelated to this change and is routed to
  follow-up issue `#111`; it is not fixed or silently deferred in this PR.

### Source, test, and replay hash binding

The source diff SHA-256 over the seven product-source paths is
`b5aeb6517f0f9a91dfd1fc4b00b1edfbc974a32dd274f018403f735f83339263`.
The test diff SHA-256 over the four runtime-test paths is
`0f4a32ba42be17a728c6b0f6461389682f7914f2613f85f38f7bafa4b7cd59dc`.

Final file SHA-256 values:

- `packages/backend/src/routes/index.ts`:
  `c8a87246c31f5ae1a0d152787a802cceefea092533f06e7f44e1ded21a7f1760`;
- `packages/core/src/domain/services/compensation-error-preservation.ts`:
  `0ce6063b237170a214604a350e53c316d0bb15de7c3b410f4bd963e0a6a83de2`;
- `packages/core/src/domain/services/idempotency-service.ts`:
  `160729b27297f6dc80d306d989ad9cc8ebe91a3df2b1ac2c522bb639b484c5de`;
- `packages/core/src/domain/services/index.ts`:
  `58a6db996787bed2bd973578127954ca2e69744a4e99ed2e16adb1900b429596`;
- `packages/core/src/domain/services/task-card-service.ts`:
  `a84e2cf9240f67738a73f45d0271036d655771f4db7d10ec9f15b221b436c800`;
- `packages/core/src/domain/services/task-service-error-compensation.ts`:
  `eaa4571425df41a7c6c858c221cf9aea787293ac8d9e0befc2674ebb92a2791f`;
- `packages/core/src/domain/services/workspace-record-store.ts`:
  `737dacfae08b2997d0be139e28f8520c2040f4fc12a4f4bb230fa406d913f2ff`;
- `packages/backend/src/routes/failure-occurrence-ledger-routes.test.ts`:
  `e508e1562b475b5d43d001684a2cd87f634ae919ce22d811a93ef7031ae42a38`;
- `packages/backend/src/routes/index.test.ts`:
  `adc9a93d2a5b69b83e1eaf82d73841a2499b6f73fd65a4dc8d274c21f1ef9b03`;
- `packages/core/src/domain/services/failure-occurrence-ledger.test.ts`:
  `63ece6ca29295e70adec8eb4e424fc3e1486f3bcdc85ec01aa94494653e2572b`;
- `packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts`:
  `fc21a9079b9e710847c0420fcfaaf674acb0851d23e04f8cd273c4318ba0b50e`.

Replay artifact SHA-256 values:

- `red-before-backend-undefined.patch`:
  `a5e3db535e3b4a40fd2606f4bbda8a0f13860ed3bf7294dad7951669808c68e9`;
- `red-before-core-depth.patch`:
  `ae4b91286bbdbaf7a385fc68a932abd77e1f093d9940425eb7dee05cbdbb2912`;
- `round2-depth-regression.test.ts`:
  `dc6f22b7c6a7ef8fe986d813d9617eda9041515fbd45255ef9f6617c4a2b670a`.

## Final Round-3 stacked semantic and evidence binding

Verified on `2026-07-19 17:23:00 EDT`. This section supersedes prior merge
bindings after the Round-3 breadth split.

- Issue base: `5a450a97f2a474af2f4db26bd9ee198adb7395ec`.
- Split base: `1aadd5c613eb383f9e65079066e2459876038811`.
- Child A1 semantic head: `ca67f6fcc2588d719465ee28be791aa80d17660e`
  (tree `62d307803879ab7643428017a5840fdfa2bbfd4e`).
- Child A2 and final semantic head:
  `a070092e02568125b8c0e96810f20dfbb85bbbe3`
  (tree `78bbd7edb25958963b4eed631235070f8191f2db`).
- Child A3 changes tracked evidence only and do not alter product or runtime
  test semantics.

The tracked definitive audit is
`evidence/phase-6.2-definitive-audit.md`. Replay-artifact whitespace accounting
and fresh-clone commands are in `evidence/replay-whitespace-exceptions.md`;
their shared lifecycle authority, canonical verifier, and 48-scenario matrix
are under `evidence/scripts/replay-lifecycle.sh`,
`evidence/scripts/verify-replay-evidence.sh`, and
`evidence/scripts/verify-replay-evidence.test.sh`.
No canonical claim depends on `.workplans`.

The replay transaction atomically establishes a fixed claim symlink containing
a per-invocation token. A signal-immune child performs `mkdir` and publishes the
same root token only after its own atomic creation succeeds. The parent never
infers ownership from root existence: it requires child success plus the exact
claim/root token pair. Signals latch while the parent waits and exit only after
the transaction outcome is knowable. After child spawn, release publication,
outcome reading, child reaping, and ownership reconciliation converge on one
settlement path before claim cleanup or status propagation. EXIT cleanup masks
EXIT/HUP/INT/TERM as its first command; command failures and signals share one
write-once first-status latch. The successful-finalization boundary masks
HUP/INT/TERM without
disarming EXIT, immediately honors any latched status through failure cleanup,
and permits strict teardown only when the latch is clear.

The pre-fix syntax-plus-matrix command exited 1 with
`verifier_finalization_term exited 0, expected 143`. The identical command
after the shared boundary was added exited 0.

The post-spawn red probes first exited 1: an outcome-read TERM preserved 143
but left an owner-marked root, and injected release-publication failure
preserved 67 but left the signal-immune child alive. After the shared
settlement correction, both dedicated probes exit 0 with exact statuses
143/67 and no live child, claim, transaction link, root, owner marker, or
registered worktree.

Verified on `2026-07-19 21:26:38 EDT`, the matrix passed 48/48 named scenarios.
Nine are two-party races with 18 explicit participant outcomes. Coverage
includes the prior 18 baseline cases, seven exact-status cleanup-diagnostic
variants, static verifier/harness collisions, cooperative same-name verifier/
harness races, non-cooperating actor barriers for both scripts, six isolated-
process-group acquisition signal orders, both collision helpers forced to child
status 42, marker-created assertion-window single/double signals, and three
barrier-driven finalization-window cases: verifier TERM, harness TERM, and
verifier HUP→INT return 143/143/129 before any strict teardown; and the two
post-spawn settlement probes cover interrupted outcome reading and failed
release publication. In each
non-cooperating barrier the child pauses before `mkdir`, a foreign actor creates
the exact root/marker without honoring the claim, and the child returns 73 with
foreign bytes unchanged, no owner marker, and no retained claim. Controlled
add/patch/dirty/locked/missing statuses are 74/75/76/78/79/80/81 and survive
injected cleanup status 77. Signal contracts remain 129/130/143; partial/root
contracts remain 38/39/41; collision remains 73. All cases leave zero exact
registered-worktree, claim, token, marker, and owned-filesystem residue.

Final A2 verification:

- Dedicated core/backend ledger suite: 41 pass, 0 fail, 520 assertions.
- Full core services, backend API, typecheck, and root `check`: exit 0.
- Strict OpenSpec: exit 0; change valid.
- Incremental product/spec/test diff check, stash hygiene, submodule hygiene,
  and Zero pin `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`: clean.
- Independent post-repair Phase 6.2 audit, six-lens Round 2, and final gap
  sweep: clean with zero verified remaining findings.

The SHA-256 of the binary diff from the issue base to the final semantic head
over the seven declared product-source paths is
`b3c59fe691bd4dc9a722334d56f928ce1959c71516cc83ffc0cab3880c7266af`.
The corresponding four-runtime-test-path diff SHA-256 is
`11fa8a4f5a38eda9f1dba58a2c124446aa434593657dfee1628d5c6569bf7b1b`.

Final semantic file SHA-256 values:

- `packages/backend/src/routes/index.ts`:
  `434c5dd1291f7978815960e8d9d80cbf0a4bdb4d18d249223c6c61ecd19077c2`;
- `packages/core/src/domain/services/compensation-error-preservation.ts`:
  `d8cd20c7390104b7b57791a4d790f6cb3d5509c36275a22ba736a494b6df26cf`;
- `packages/core/src/domain/services/idempotency-service.ts`:
  `0eb13da856e2467284893e770550b7b92b77fcaa3f7e3396777142d4fe5f9149`;
- `packages/core/src/domain/services/index.ts`:
  `88def0bc3680cc45799f7582bcb3dba4e1656ee2ca76d335cf694086cbc5a58a`;
- `packages/core/src/domain/services/task-card-service.ts`:
  `a84e2cf9240f67738a73f45d0271036d655771f4db7d10ec9f15b221b436c800`;
- `packages/core/src/domain/services/task-service-error-compensation.ts`:
  `8465b5916bce854cf7cc3608ad8cae8de7cebe53ceb14693d963c7dcc3b5244d`;
- `packages/core/src/domain/services/workspace-record-store.ts`:
  `737dacfae08b2997d0be139e28f8520c2040f4fc12a4f4bb230fa406d913f2ff`;
- `packages/backend/src/routes/failure-occurrence-ledger-routes.test.ts`:
  `cfc2580b5b4318f47f519efd49916b26eaa816f99a324ccae9d2bb744536309f`;
- `packages/backend/src/routes/index.test.ts`:
  `6d87e05c1407723d9525bf2795c18f09a48c99474c2a6619d15c147b810cdca7`;
- `packages/core/src/domain/services/failure-occurrence-ledger.test.ts`:
  `e2f98af0c462c9b17fda93ad6510be4983f13f5556aac15984b27c972ef6012c`;
- `packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts`:
  `1d2d90b9f0a2b3ac4225f3325ebd0d73439776f405d4c4ba5a657d9a5842bbff`.

Replay artifact SHA-256 values:

- Round-1 Phase 6.2 `red-before-tests.patch`:
  `b47eb98f90431208d0ebe8bbed6f085a7269b72b8ff91e5c83ae577c0ac958a2`;
- Round-2 `red-before-backend-undefined.patch`:
  `a5e3db535e3b4a40fd2606f4bbda8a0f13860ed3bf7294dad7951669808c68e9`.

## Child A4 pre-spawn claim reconciliation

Verified on `2026-07-19 21:51:13 EDT` against split base
`8f7187d0eb4dcdd0f4fd49c2e5f7e344bbac2f29`.

The first exact-token verification after atomic claim creation is deliberately
signal-capable. The shared lifecycle boundary then masks HUP/INT/TERM and makes
one authoritative exact-token retry before spawning a creation child. It sets
`lifecycle_claim_owned` only when the current physical claim still matches the
invocation token, never removes a mismatched claim, restores signal handlers
only for a clean continuation, and propagates any already-latched status after
the exact owned claim is known to EXIT cleanup.

The initial dynamic verifier and harness probes each returned 143 and retained
their exact claim (`verifier-red-token` and `harness-red-token`), confirming the
R5-FULL-01 window. The batched source-only red proof then ran both new public-
surface cases against the pre-change lifecycle source. Each test exited 1 with
`retained its exact claim`; the source stash was popped immediately and no
`red-proof` stash remains. With the shared reconciliation boundary restored,
both dedicated probes report `1/1 passed`: their child process returns 143 and
leaves no claim, transaction link, root, owner marker, registered worktree, or
creation-child PID.

The canonical replay verifier exits 0, and the expanded lifecycle matrix passes
50/50 named scenarios while retaining nine two-party races and 18 explicit
participant outcomes. A4 adds only the verifier/harness pre-spawn TERM cases;
post-spawn transaction statuses 67/73 and their chronology are unchanged.

Current script SHA-256 values:

- `evidence/scripts/replay-lifecycle.sh`:
  `921953b7f1646f9d6dfe807fa6fa683fd9fe6ff9d90ae7e03effc10a80fc58a5`;
- `evidence/scripts/verify-replay-evidence.sh`:
  `bc858e1144b84662f1ff50fd639828d5dc1ab29de3196f200164fc293fb78381`;
- `evidence/scripts/verify-replay-evidence.test.sh`:
  `07e8fe637158d5073b68d50f4ccd8860b43850262625dd6a1ce8229c71dc4e13`.

The replay patch hashes remain byte-identical at
`b47eb98f90431208d0ebe8bbed6f085a7269b72b8ff91e5c83ae577c0ac958a2`
and `a5e3db535e3b4a40fd2606f4bbda8a0f13860ed3bf7294dad7951669808c68e9`.

### A5 Round-3 shared outcome decoder

Verified on `2026-07-20 04:41:10 EDT`. The Round-3 depth retro found that
handler adoption and ordinary settlement classified the same published
outcome with separate logic: a handler-internal `readlink` failure became an
empty no-op and allowed TERM 143, while settlement mapped the read failure to
protocol status 67.

Both callers now use one side-effect-controlled decoder. It distinguishes no
publication, exact `token:0`, collision `token:73`, unknown/mismatched protocol
values, and a failed read of a published symlink. The last two map to 67.
Signals arriving during ordinary decoding are held in one deferred first-signal
slot; the caller latches any decoded non-zero result before releasing that
signal to the same write-once ledger. Handler adoption masks HUP/INT/TERM while
decoding, preserving its reentrancy boundary. Exact zero still permits the
current signal to win, and verifier/harness TERM-before-publication controls
remain 143. Child release/reap, A4 claim reconciliation, foreign preservation,
strict cleanup, and root ownership are unchanged.

Two deterministic public-surface probes publish a collision outcome, deliver
TERM to the exact transaction parent, and make the handler's outcome read fail.
With the production source stashed back to `a7069a7`, both current tests exit 1
at 73 instead of 67. With the shared decoder restored, verifier and harness
each report `1/1 passed` at 67
with no live creation child, claim, transaction link, marker, root, registered
worktree, watchdog, or probe residue. The pre-existing published-read failure
now also preserves 67 before its injected TERM.

The canonical replay verifier exits 0. The complete lifecycle matrix passes
64/64 named scenarios, comprising 17 two-party races and 34 participant
outcomes. Removing the production settlement release still makes all four
held collision/unknown verifier/harness probes fail with the distinct watchdog
marker; restoring it makes all four green. Syntax and shellcheck pass for all
three replay scripts, and the final A5 gate covers strict OpenSpec, incremental
and exact 13-row range hygiene, replay hashes, gitlink/submodules, stash state,
and replay residue.

Current script SHA-256 values:

- `evidence/scripts/replay-lifecycle.sh`:
  `8e684d04048044c89871b2df84ba57fb8fa7d68fae64dfb5c2a8e72c6cebddba`;
- `evidence/scripts/verify-replay-evidence.sh`:
  `bc858e1144b84662f1ff50fd639828d5dc1ab29de3196f200164fc293fb78381`;
- `evidence/scripts/verify-replay-evidence.test.sh`:
  `9e9fae0a75c3c55b1fd31b2a3e7c3085e86645aede393295b554e4d0a5eb191e`.

The replay patch hashes remain byte-identical at
`b47eb98f90431208d0ebe8bbed6f085a7269b72b8ff91e5c83ae577c0ac958a2`
and `a5e3db535e3b4a40fd2606f4bbda8a0f13860ed3bf7294dad7951669808c68e9`.

Final A5 verification:

- `/bin/sh -n` and `shellcheck -s sh` pass for all three replay scripts.
- The canonical verifier exits 0; the lifecycle matrix reports 64/64 passed.
- `openspec validate m1-failure-occurrence-ledger --strict --no-interactive`
  reports the change valid, and incremental `git diff --check` exits 0.
- Range-wide `git diff --check` from issue base `5a450a9` exits 2 with exactly
  the documented 13 replay-artifact rows and no other finding.
- Zero remains uninitialized in this split worktree; its index gitlink remains
  `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` with no submodule diff.
- No `red-proof` stash, replay temporary root, replay worktree registration,
  fault probe, or out-of-scope changed path remains.

Final A4 verification:

- `/bin/sh -n` and `shellcheck -s sh` pass for all three replay scripts.
- The canonical verifier exits 0; the lifecycle matrix reports 50/50 passed.
- `openspec validate m1-failure-occurrence-ledger --strict --no-interactive`
  reports the change valid, and incremental `git diff --check` exits 0.
- Range-wide `git diff --check` from issue base `5a450a9` exits 2 with exactly
  the documented 13 replay-artifact rows and no other finding.
- The Zero worktree is intentionally uninitialized in this split worktree;
  its index gitlink remains `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`
  with no submodule diff.
- No `red-proof` stash, replay temporary root, replay worktree registration, or
  out-of-scope changed path remains.

## Child A5 post-spawn result chronology

Verified on `2026-07-19 22:19:01 EDT` against split base
`d8a25f27c6e06bc1a4701538ae656a897537a61b`.

The shared lifecycle now records every non-zero post-spawn transaction result
in the same write-once status latch as soon as the result is determined. A
release/wait/read failure records 67 before child settlement or ownership
probes; a published collision outcome records 73 before ownership
reconciliation and transaction cleanup. `lifecycle_latch_status` retains an
earlier signal when one already exists, while a transaction result that arrives
first masks later handled signals during mandatory settlement and cleanup.

Four public-surface tests were added: release failure 67 followed by TERM and
collision outcome 73 followed by TERM, each through both the canonical verifier
and lifecycle harness. Before the shared source changed, the batched red run
reported four failures: every child exited 143 instead of its earlier 67 or 73.
After the correction, all four dedicated scenarios report `1/1 passed`. They
also assert the spawned creation child is reaped and no exact claim,
transaction link, owner marker, owned root, registered worktree, foreign
collision probe, or fault-injection directory remains.

The canonical replay verifier exits 0. The full lifecycle matrix passes 54/54
named scenarios while retaining nine two-party races and 18 explicit
participant outcomes. Existing signal-first, A4 pre-spawn reconciliation,
same-name/static collisions, strict cleanup, and successful-finalization cases
remain green.

Current script SHA-256 values:

- `evidence/scripts/replay-lifecycle.sh`:
  `a49e2505bae5e0de3dc63c5f0c6d4c945790f2d89f815027d24e867396d02b81`;
- `evidence/scripts/verify-replay-evidence.sh`:
  `bc858e1144b84662f1ff50fd639828d5dc1ab29de3196f200164fc293fb78381`;
- `evidence/scripts/verify-replay-evidence.test.sh`:
  `fef0f68f3c510afb54eb41d21337059cd00adece13d09bf3de5d961d4a5c4040`.

The replay patch hashes remain byte-identical at
`b47eb98f90431208d0ebe8bbed6f085a7269b72b8ff91e5c83ae577c0ac958a2`
and `a5e3db535e3b4a40fd2606f4bbda8a0f13860ed3bf7294dad7951669808c68e9`.

### A5 Round-1 outcome-before-wait repair

Verified on `2026-07-19 22:41:17 EDT`. The review regression proved that an
outcome symlink can be authoritative while its creation child is still live:
the prior settlement path waited for that child before reading the published
value, so TERM delivered during the wait became the first latched status.

The batched red run held the creation child after publishing its outcome. The
verifier and harness collision probes both exited 143 instead of 73; their two
unknown-outcome variants likewise exited 143 instead of the required protocol
status 67. The fixed settlement path reads and classifies the published value
before wait/reap. A non-zero 73 or mapped 67 enters the shared write-once latch
first, after which the deterministic hook delivers TERM and releases the held
child. Settlement still reaps the child and reconciles physical claim/marker
ownership before cleanup or propagation. Outcome-read failure remains 67, and
an earlier signal remains authoritative.

All four focused scenarios then reported `1/1 passed` with exact 73/73/67/67.
The full matrix passes 56/56 named scenarios, comprising 11 two-party races and
22 participant outcomes. Each added/strengthened probe asserts no live creation
child, claim, transaction link, owner marker, owned/foreign probe root,
registered worktree, or fault directory remains.

Current script SHA-256 values:

- `evidence/scripts/replay-lifecycle.sh`:
  `ea9df44279d32c9a36eaa6d468fe4e09771f277e67508f8126948477c665f8eb`;
- `evidence/scripts/verify-replay-evidence.sh`:
  `bc858e1144b84662f1ff50fd639828d5dc1ab29de3196f200164fc293fb78381`;
- `evidence/scripts/verify-replay-evidence.test.sh`:
  `d811699d6dc9e245bb2ceae082c1d85073aeadfe68b005e331f193a626fd1b0a`.

### A5 Round-2 publication adoption and watchdog repair

Verified on `2026-07-19 23:11:48 EDT`. While a creation transaction is active,
each HUP/INT/TERM handler now checks the atomic outcome publication before it
records the lifecycle event. If the outcome symlink already publishes collision
73 or another non-zero protocol value, the handler adopts 73 or mapped 67 into
the shared write-once latch first. A TERM that is already latched before outcome
publication remains 143. This changes only parent classification order: every
path still releases or force-terminates, reaps, reconciles, and cleans the
creation child before propagating status.

Four new readlink-window probes hold the creation child after publishing its
outcome, deliver TERM from the parent's first outcome read, and cover collision
73 plus unknown-to-67 through both verifier and harness. Against the pre-repair
lifecycle source, all four exited 1 because the nested child returned 143.
With transaction-active adoption restored, all four report `1/1 passed` at
73/73/67/67. Two verifier/harness controls deliver TERM before the creation
release and outcome publication; both preserve 143.

The held-child watchdog no longer writes the production settlement-release
marker. It writes a distinct watchdog-fired marker and kills the held creation
path only to bound a broken test. Every held publication probe asserts that
marker is absent. In the required mutation run, removing the production release
write made the verifier/harness collision and unknown-outcome probes all exit 1
within two seconds with `used its watchdog instead of the settlement release`;
restoring production release made all four green.

The canonical replay verifier exits 0. The full lifecycle matrix passes 62/62
named scenarios, comprising 15 two-party races and 30 participant outcomes.
Syntax and shellcheck pass for all three replay scripts; strict OpenSpec,
incremental/range hygiene, replay hashes, gitlink/submodule state, stash state,
and replay residue are verified by the final A5 gate.

Current script SHA-256 values:

- `evidence/scripts/replay-lifecycle.sh`:
  `52044ce8c679303fd0fa9861f9ba3d89bc8aad839daf5c09f968726bb8d7422f`;
- `evidence/scripts/verify-replay-evidence.sh`:
  `bc858e1144b84662f1ff50fd639828d5dc1ab29de3196f200164fc293fb78381`;
- `evidence/scripts/verify-replay-evidence.test.sh`:
  `c87be155ad227f4dbfc569e5fcb8bb1275aeecca59d4ed6c35787e71179a3268`.

The replay patch hashes remain byte-identical at
`b47eb98f90431208d0ebe8bbed6f085a7269b72b8ff91e5c83ae577c0ac958a2`
and `a5e3db535e3b4a40fd2606f4bbda8a0f13860ed3bf7294dad7951669808c68e9`.

### A6 Phase-7 atomic decode commit

Verified on `2026-07-20 06:02:01 EDT` against split base
`40fd16a39c06e93f2c2536d8c58fcc90a3a5858e`.

The prior shared decoder cleared `decode_active` after classifying a published
outcome but before its caller latched the decoded status. A TERM handled in that
gap could re-enter adoption, read the outcome a second time, and commit a later
collision 73 ahead of the already-determined read-failure status 67.

Handler adoption and ordinary settlement now share one atomic shell state
boundary. It keeps `decode_active` asserted while it classifies publication,
latches any decoded non-zero result, latches the first deferred event, and only
then clears the flag. Exact `token:0`, collision 73, unknown/read-failure 67,
event-before-publication order, reentrancy masking, mandatory child settlement,
A4 claim reconciliation, and A5 watchdog semantics are unchanged.

Two public-surface probes cover the canonical verifier and recursive harness.
Their first published-outcome read fails to 67 while a TERM burst targets the
decode-to-commit boundary; a forbidden handler re-adoption can then observe the
still-published `token:73`. In the batched red run with only the production
lifecycle source stashed, the old verifier and harness each exited 1: both
re-entered decoding and each dynamically produced the wrong 73 in at least one
focused attempt. The source stash was popped immediately and no `red-proof`
stash remains. With the atomic boundary restored, each focused entrypoint
passes eight consecutive exact-status/zero-residue trials.

The canonical replay verifier exits 0. The full lifecycle matrix passes 66/66
named scenarios, comprising 19 two-party races and 38 participant outcomes.
All existing focused chronology/read-failure, TERM-before-publication, A4 claim,
syntax, and shellcheck controls pass. Removing the production settlement-release
write still makes the four held collision/unknown verifier/harness probes fail
quickly with `used its watchdog instead of the settlement release`; restoring
the write makes them green.

Current script SHA-256 values:

- `evidence/scripts/replay-lifecycle.sh`:
  `45a795249332fd1e8cdc3e4bd39ec34d5d9254631bacccab716f0bc3e540010f`;
- `evidence/scripts/verify-replay-evidence.sh`:
  `bc858e1144b84662f1ff50fd639828d5dc1ab29de3196f200164fc293fb78381`;
- `evidence/scripts/verify-replay-evidence.test.sh`:
  `a90c1e35a15c2466275ff13d2d5ec6115e3e80164502aff4f34aee9608c79ac3`.

The replay patch hashes remain byte-identical at
`b47eb98f90431208d0ebe8bbed6f085a7269b72b8ff91e5c83ae577c0ac958a2`
and `a5e3db535e3b4a40fd2606f4bbda8a0f13860ed3bf7294dad7951669808c68e9`.

### A6 Round-1 exact-zero decode-tail repair

Verified on `2026-07-20 06:29:21 EDT` against reviewed head
`f626fd32ccfa673f1fcaa301fa2979354edfaf63`.

The prior decoder checked the deferred first-signal slot before clearing
`decode_active`. For exact `token:0`, TERM handled after that check but before
the clear entered the deferred slot too late to be consumed, so acquisition
could return 0. The shared boundary now latches any decoded non-zero result
first, clears `decode_active`, and only then consumes the deferred slot. An
event before the clear is therefore deferred and consumed; an event after the
clear reaches the write-once latch directly. Existing non-zero 67/73 outcomes
remain first because they are latched and their handlers masked before the
clear.

Three public-surface probes inject at the exact decode tail: verifier TERM,
harness TERM, and verifier HUP→INT. With only the production lifecycle source
stashed, all three deterministic red cases exited 1 because their nested
entrypoint returned 0 instead of 143/143/129 and did not publish the injection
events. The source stash was popped immediately; no `red-proof` stash remains.
An exact old-order mutation then retained the injection seam but moved deferred
consumption back before the injection and clear. All three event-complete probes
again failed because the nested entrypoint returned 0, directly reproducing the
missed deferred slot. With the repaired ordering restored, each focused
scenario reports `1/1 passed`, proves both ordered events when present, and
leaves no child, claim, transaction link, marker, root, worktree, or probe
residue.

The canonical replay verifier exits 0. The full lifecycle matrix passes 69/69
named scenarios, comprising 19 two-party races and 38 participant outcomes.
Focused release, collision, unknown-protocol, handler-read-failure,
decode-commit, and TERM-before-publication controls retain exact 67/73/143
behavior. Removing the production settlement-release write makes all four
held collision/unknown verifier/harness controls fail quickly with
`used its watchdog instead of the settlement release`; restoring it makes all
four green.

Current script SHA-256 values:

- `evidence/scripts/replay-lifecycle.sh`:
  `30e47015d33d7dd29986bc4b3b1d02d53611a09b33f2970a57b86b62e0fd59bc`;
- `evidence/scripts/verify-replay-evidence.sh`:
  `bc858e1144b84662f1ff50fd639828d5dc1ab29de3196f200164fc293fb78381`;
- `evidence/scripts/verify-replay-evidence.test.sh`:
  `b15ebded7e0af1adc36928f73edac0b6ff6b4031f7569c9008edd0f86b10c960`.

The replay patch hashes remain byte-identical at
`b47eb98f90431208d0ebe8bbed6f085a7269b72b8ff91e5c83ae577c0ac958a2`
and `a5e3db535e3b4a40fd2606f4bbda8a0f13860ed3bf7294dad7951669808c68e9`.

### A6 Round-2 committed outcome settlement repair

Verified on `2026-07-20 07:06:53 EDT`. The semantic implementation is commit
`2a7a6804c4e2eab7d83b5442a324f4ad5ec65ded`, based on A6 Round-1 head
`7ee33f270eba7ada770090a84df91eda07eca7d5`.

Round 2 demonstrated two post-clear re-entry failures. A deferred HUP could be
erased when a later INT re-entered adoption, yielding 130 instead of the first
event's 129. A post-clear TERM could likewise trigger a second publication
read and let read failure 67 or collision 73 enter the latch before 143.

Outcome classification now sets an explicit committed state that remains
active through child settlement. While committed, handlers do not re-adopt
publication. If a deferred event already exists, a post-clear handler commits
that first event before considering its current signal. The committed state is
reset only when the transaction begins or its settlement completes.

Six verifier/harness public-surface regressions cover ordered HUP→INT, a
forbidden second read that fails, and a forbidden second read that would decode
collision 73. The source-only red run made all six fail with the old exact
statuses 130, 67, or 73; its stash was popped immediately. The repaired head
returns 129/129 and 143 for the four TERM cases, with no second read, watchdog,
child, claim, transaction link, marker, root, registered worktree, or probe
residue.

Independent final-head checks passed:

- `/bin/sh -n` and `shellcheck -s sh` for all three replay scripts;
- all six focused committed-outcome scenarios, each `1/1 passed`;
- canonical replay verifier;
- full lifecycle matrix: 75/75 named scenarios, 22 two-party races and 44
  participant outcomes;
- strict OpenSpec validation and clean incremental `git diff --check`;
- exactly the documented 13 issue-base replay-artifact whitespace findings;
- byte-identical replay hashes, Zero gitlink, no submodule diff, no stash,
  debug marker, watchdog/release probe, or replay residue.

Current script SHA-256 values:

- `evidence/scripts/replay-lifecycle.sh`:
  `18ef9a6ff421ae51a21d76642d2612e6de19adcaa37628de8dbaa0a8d56a04c2`;
- `evidence/scripts/verify-replay-evidence.sh`:
  `bc858e1144b84662f1ff50fd639828d5dc1ab29de3196f200164fc293fb78381`;
- `evidence/scripts/verify-replay-evidence.test.sh`:
  `fbb108cc6ddbcf28dc6e79072c1c61adbd8833c2cf971f7b1c6d0fde0b6af6ed`.

The replay patch hashes remain byte-identical at
`b47eb98f90431208d0ebe8bbed6f085a7269b72b8ff91e5c83ae577c0ac958a2`
and `a5e3db535e3b4a40fd2606f4bbda8a0f13860ed3bf7294dad7951669808c68e9`.

### A6 Phase-7 witnessed-publication repair

Verified on `2026-07-20 07:44:07 EDT`. The semantic implementation is commit
`667a54f0ec1c4114615d700cd759eb54e2c474be`, based on clean Round-3 head
`793ac2fe6f21d03b843dcce0ec4b4a542279bd95`.

The Phase-7 gap sweep found that ordinary acquisition could observe the
published outcome and then lose the symlink before the shared decoder's
presence test. That path left classification uncommitted, allowing later TERM
143 or a restored collision 73 to enter the write-once latch before fallback
status 67.

The outcome wait now defers handlers across its presence test and the write of
an explicit witnessed-publication state. A negative probe immediately returns
any deferred event to the existing signal-first latch. A positive probe makes
publication required before handlers can run; the shared decoder then commits
a missing witnessed link as protocol status 67. Both ordinary settlement and
handler adoption pass the same witnessed fact. State resets only at transaction
start/end, and release/reap/reconciliation/cleanup remain unchanged.

Four verifier/harness public-surface regressions cover disappearance followed
by TERM and disappearance followed by restored `token:73` plus TERM. Against
the pre-fix semantics they returned 143/143/73/73; the restoration cases also
classified twice. The fixed cases each pass `1/1`, return exact 67, classify
once, settle the child, and leave no lifecycle, worktree, watchdog, or probe
residue.

Independent final-head checks passed:

- four new cases plus pre-publication TERM and handler-read-failure controls;
- canonical replay verifier and 79/79 lifecycle matrix, comprising 24
  two-party races and 48 participant outcomes;
- `/bin/sh -n`, `shellcheck -s sh`, strict OpenSpec and incremental hygiene;
- exactly 13 documented issue-base replay-artifact whitespace findings;
- byte-identical replay hashes, Zero gitlink, no submodule diff, stash, debug
  marker, watchdog/release probe, or replay residue.

Current script SHA-256 values:

- `evidence/scripts/replay-lifecycle.sh`:
  `69a0b2361ed0a84cd3c319d798aa5e874205ac17dd778b4a1195ac738bb61c77`;
- `evidence/scripts/verify-replay-evidence.sh`:
  `bc858e1144b84662f1ff50fd639828d5dc1ab29de3196f200164fc293fb78381`;
- `evidence/scripts/verify-replay-evidence.test.sh`:
  `31f74d5e3fe9c9a67804f63855fcea7760c1953cf3bc97ac7d53b734cb164861`.

The replay patch hashes remain byte-identical at
`b47eb98f90431208d0ebe8bbed6f085a7269b72b8ff91e5c83ae577c0ac958a2`
and `a5e3db535e3b4a40fd2606f4bbda8a0f13860ed3bf7294dad7951669808c68e9`.
