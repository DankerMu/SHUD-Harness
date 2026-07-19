> **Superseded Round-1 evidence.** This file binds only to frozen pre-repair
> head `1a993c89c842b72512768c40b87dd2205562ac05` and MUST NOT be used as current
> merge evidence. Round-1 review invalidated its raw-Error/Proxy-carrier,
> implicit-adoption, bounded-work, typed-trust, phase, and whole-file exclusion
> conclusions. In particular, `exact raw Proxy carrier` and “no
> idempotency/workspace diff” below are historical observations, not current
> requirements. The repair must append a new final-head verification section
> that supersedes every conflicting claim and hash.

> **Round-2 review status.** The binding at `b425a68` is not merge evidence:
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
