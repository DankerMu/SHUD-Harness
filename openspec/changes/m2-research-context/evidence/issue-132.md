# Issue #132 — StackLock actual checkout state fixture

Issue type: bugfix
Project profile: SHUD-Harness
Blast radius: high
Fixture level: expanded
Upstream suggested level: absent
Repair intensity: high
OpenSpec change: `m2-research-context` (existing)
Minimal mergeable slice: schema + collector + tests + generated schema + canonical/OpenSpec correction；不实现 #92/#93 service/route。

## Change surface and must-preserve behavior

- Change: `RepositoryRevision` requires `{ commit, branch, detached, dirty }` for SHUD/rSHUD/AutoSHUD/zero；collector records each actual checkout state rather than projecting gitlink values，且合法 attached 分支 `detached` 与 detached HEAD 无碰撞。
- Change: four no-follow checkout directory capabilities and actual `commit/branch/detached/dirty` join the two-snapshot checks and the post-schema/freeze publication barrier.
- Preserve: superproject `HEAD` gitlinks and exact `HEAD:.gitmodules` remain the trusted path/generation authority；worktree `.gitmodules` never becomes authority.
- Preserve: minimal non-secret Git environment, `--no-lazy-fetch`, bounded output, typed non-disclosing errors, zero partial publication, no fetch/checkout/reset/write；status disables repo-local fsmonitor and overrides nested-submodule ignore.
- Preserve: #92 owns assembly/fingerprint/persistence and #93 owns routes；this issue only makes their future contract require complete repo revision propagation.

## Seams under test

- Public `StackLockSchema.safeParse` and generated JSON/Markdown prove required boolean, invalid/missing rejection, strict unknown/deprecated-field behavior, and four-repo positive examples.
- Public `collectStackLockContext({ repositoryRoot, gitCommand? })` proves actual HEAD/branch/detached/dirty observation, stable errors, and atomic result publication.
- Synthetic independent Git repositories are the standard CI seam；a canonical full-root check may run only when all four repo checkouts are present.
- Future fingerprint/API behavior is a spec/task assertion only in #132；runtime verification remains owned by #92/#93.

## Risk packs considered

- Public API / CLI / script entry: selected — public core schema and collector output contract change；no CLI/HTTP implementation.
- Config / project setup: selected — committed `.gitmodules` maps the four trusted checkout paths and branch declarations.
- File IO / path safety / overwrite: selected — four filesystem checkout roots are admitted no-follow and must reject path replacement/symlink without target access.
- Schema / columns / units / field names: selected — required `dirty:boolean` changes the strict StackLock graph and generated schema.
- Auth / permissions / secrets: selected — Git subprocess environment and errors must not forward or disclose credentials, trace sinks, paths, or config bytes.
- Concurrency / shared state / ordering: selected — actual checkout state and physical identity must match across two snapshots.
- Resource limits / large input / discovery: selected — Git output remains bounded；the observer touches exactly four declared repos with fixed commands.
- Legacy compatibility / examples: selected — old repo revisions without `dirty` are intentionally rejected；canonical and generated examples are updated together.
- Error handling / rollback / partial outputs: selected — any malformed output, unsafe path, missing repo, or state drift fails atomically with a stable typed error.
- Release / packaging / dependency compatibility: selected — generated artifacts and public types change；package manifests, lockfile, dependencies, and submodule pins remain unchanged.
- Documentation / migration notes: selected — frozen-spec bug correction is recorded in the activation ledger and canonical schema.
- Scientific governance / PI gate / evidence lineage: selected — dirty state is P0 reproducibility evidence, not a scientific conclusion.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: selected — all three runtime repos must report their actual local state without source mutation.
- Zero adapter / tool registry / agent role governance: selected — zero is the fourth runtime repo and retains its pinned-clean evidence when canonical.

## Invariant Matrix

Governing invariant: a successful StackLock collection records one complete, contemporaneous view of the actual reproducible state of all four checkout directories while gitlinks remain internal path/generation authority.

Source-of-truth identity/contract: superproject `HEAD` inventory + exact `HEAD:.gitmodules` declarations + each checkout no-follow directory descriptor/cwd capability `(path, dev, ino)` + actual Git `HEAD`/branch/detached/porcelain status + strict StackLock schema.

- Producers: superproject inventory/blob reader；four serial descriptor-bound checkout top-level/HEAD/branch/status observers；post-freeze publication observers.
- Validators/preflight: physical root identity, exact Git top-level and empty prefix, 40-hex HEAD, bounded single-line branch, porcelain dirty boolean, strict schema parse.
- Storage/cache/query: none — current collector returns frozen memory content；#92/#93 remain future consumers.
- Public routes/entrypoints: core schema and collector barrel only；no backend route change.
- Frontend/downstream consumers: generated schema now；future #92 fingerprint/store and #93 API must preserve all four repo-revision fields.
- Failure paths/rollback/stale state: missing/replaced/symlink checkout, malformed Git result, or cross-snapshot gitlink/checkout drift → typed failure and no result.
- Evidence/audit/readiness: focused schema/collector tests, generated-schema drift, strict OpenSpec, full core/backend/check/perf/docs and Git/submodule hygiene.

Regression rows:

- Actual checkout HEAD differs from gitlink → actual commit/branch recorded, no rejection or fallback.
- Tracked or untracked change in one repo → its `dirty=true`, unchanged siblings remain false.
- Detached checkout → `branch="detached", detached=true`；attached branch `detached` → same branch string with `detached=false`.
- Checkout physical identity or commit/branch/detached/dirty changes between snapshots or in the hash/schema/freeze/publication window → `collection_state_changed`, no partial output；first failure leaves no active sibling producer.
- Stable clean four-repo fixture → all dirty values false and no HEAD/index/tracked/untracked byte mutation.
- Checkout path replaced by symlink → rejected without reading or modifying the target.
- StackLock missing/non-boolean dirty or unknown/deprecated key → strict schema rejection；complete boolean shape passes.
- Future identical full repo state → same fingerprint；clean↔dirty or attached↔detached flip → changed fingerprint；future persistence/API round-trip preserves both booleans.

## Per-repository state matrix

The collector suite SHALL parameterize the following rows across `SHUD`, `rSHUD`, `AutoSHUD`, and `zero` rather than proving only one representative repo:

| Input per repo | Expected repo output | Expected siblings |
| --- | --- | --- |
| clean checkout at gitlink HEAD and declared branch | actual 40-hex HEAD, actual branch, `dirty=false` | unchanged exact values |
| local commit or branch differs from gitlink/declaration | actual new HEAD and actual branch, `dirty=false` | unchanged exact values |
| tracked modification | actual HEAD/branch, `dirty=true` | `dirty=false` |
| untracked file | actual HEAD/branch, `dirty=true` | `dirty=false` |
| detached HEAD | actual HEAD, `branch="detached"`, `detached=true`, observed dirty boolean | unchanged exact values |
| attached branch named `detached` | actual HEAD, `branch="detached"`, `detached=false`, observed dirty boolean | unchanged exact values |

Schema tests SHALL also parameterize all four keys: removing `dirty` or replacing it with a non-boolean rejects the full StackLock；complete boolean values pass and unknown keys remain rejected.

## Risk-pack scenario mapping

| Risk pack | Input / action | Expected output or non-goal |
| --- | --- | --- |
| Public API + schema | omit/non-boolean `dirty` on each repo；add unknown/deprecated key | strict parse rejects；complete four-repo boolean shape passes；HTTP/CLI is a #93 non-goal |
| Config / project setup | `.gitmodules` missing one declaration, wrong path, nested repo path, or branch declaration drift | `gitmodules_invalid` or `collection_contract_invalid` as contract-specific；zero partial result |
| File IO / path safety | checkout missing, non-directory, nested top-level, symlink leaf/ancestor, or same-path replacement | `collection_contract_invalid` at admission or `collection_state_changed` after admission；no target bytes read/written |
| Auth / permissions / secrets | inherited credential/askpass/trace variables and failing Git command | child receives only allowlisted non-secret env；`git_read_failed` message/output contains no secret, absolute path, stderr, or trace file |
| Concurrency / ordering | checkout physical identity or commit/branch/detached/dirty changes through publication；swap-use-restore；first sibling failure | observable drift → `collection_state_changed`；transient swap cannot redirect reads/publish target；no partial repo map or orphan producer |
| Resource limits / discovery | HEAD/branch empty, unterminated, multi-line, non-UTF-8, or above 64 KiB；real status above bound；Git timeout | invalid/maxBuffer output → `git_output_invalid`；timeout/nonzero → `git_read_failed`；status empty → clean and one/many porcelain records → dirty；exactly four fixed repos, no recursive discovery |
| Legacy compatibility | legacy StackLock repo revision lacks dirty | intentional strict rejection；canonical/generated migration note updated；package/lock/submodule pins unchanged |
| Error / rollback | any producer or final schema validation fails | stable typed error and no returned content；no rollback because the operation is read-only |
| Release / docs | regenerate StackLock JSON/Markdown after source schema change | `schema:check` clean；no hand-edited drift or dependency changes |
| Scientific evidence lineage | actual HEAD differs from gitlink or clean↔dirty changes | actual checkout truth is retained；future #92 fingerprint must change for content change |
| Hydrology/Zero governance | run every state row for SHUD/rSHUD/AutoSHUD/zero | identical semantics for all four；no source or Git mutation |

## Boundary-surface checklist

- Shared helper roots: collector Git process seam and root identity helpers；no generic path/hash helper change unless a verified finding requires it.
- Public entrypoints: StackLock schema/type and `collectStackLockContext` output.
- Read surfaces: exact four declared checkout roots with fixed bounded Git commands.
- Write/delete/overwrite: none；tests may mutate only their own unique temporary fixtures and must clean them.
- Producer/consumer evidence: gitlink/path authority + actual checkout observations → frozen content → future #92/#93.
- Stale-state/idempotency: both snapshots must match；no cache or idempotent write in this issue.
- Unchanged downstream consumers: backend/frontend, record store, package/dependency files, and all four read-only repo sources.

## Required evidence

- Focused schema and actual-state collector tests: all regression rows above pass.
- Batched source-bound red proof: new dirty schema/observer/snapshot tests fail against pre-#132 production source and pass after restore；no `red-proof` stash remains.
- `npx --yes bun@1.2.19 run test:schemas`
- `npx --yes bun@1.2.19 run test:core-services`
- `npx --yes bun@1.2.19 run test:backend-api`
- `npx --yes bun@1.2.19 run schema:check`
- `npx --yes bun@1.2.19 run typecheck`
- `npx --yes bun@1.2.19 run check`
- `npx --yes bun@1.2.19 run test:perf:api`
- `npx --yes openspec validate m2-research-context --strict --no-interactive`
- docs links, `git diff --check`, package/lock/submodule/workspace/stash/debug-marker hygiene.

## Executed evidence

### Round 1 confirmed-finding repair (2026-07-27)

- Reproducible source-bound proof: `evidence/issue-132-round-1-red-proof.sh` fixed production sources to base `c9ea4fb325f2b4c9ff5c4693ffb90aa13ae8445e` while retaining the final three test files. The exact focused command produced RED `89 pass / 69 fail`, then GREEN `158 pass / 0 fail` after restoring the two final production sources. Full command/source/cleanup record: `evidence/issue-132-round-1-red-proof.md`.
- Added final publication-barrier coverage for independent commit-only, branch-only, dirty-after-second-renv, physical identity and transient swap-use-restore windows；all fail atomically or prove replacement target cannot redirect reads.
- Added real repo-local fsmonitor non-execution, nested submodule `ignore=all` override, real >64 KiB status/maxBuffer mapping, attached/detached collision, positive dirty-worktree `.gitmodules` authority and serial failure-settlement coverage.
- Replacement wrappers use 10-second readiness, unconditional release/restore, and pending settlement before cleanup；focused high-risk selection passed `10/10` without test bleed.
- Final Round 1 suites: `test:schemas` = 39 pass / 0 fail；`test:core-services` = 634 pass / 5 skip / 0 fail；`test:backend-api` = 184 pass / 1 skip / 0 fail；local-token contracts = 92 pass / 2 skip / 0 fail；the unchanged full `bun run check` completed successfully. Schema generator self-test/drift check, `typecheck`, `PERF-API-001`, strict OpenSpec, docs self-test and 343-file link scan, `git diff --check`, package/lock/zero/workspace/stash hygiene all passed.

- Pre-Round-1 source-bound red proof: with only the pre-#132 production schema and collector restored while retaining the then-current tests, the focused batch reported `0 pass / 52 fail`; after restoring the implementation it reported `52 pass / 0 fail`. Round 1 superseded this conversation-only record with the committed reproducible 158-test proof above.
- Focused StackLock batch: `52 pass / 0 fail` (`152 expect()` calls).
- Schema suite: `38 pass / 0 fail` (`184 expect()` calls).
- Core services: `624 pass / 5 skip / 0 fail` (`30228 expect()` calls).
- Backend API: `184 pass / 1 skip / 0 fail`; local-token contracts: `92 pass / 2 skip / 0 fail`.
- `typecheck`, `PERF-API-001`, `schema:check`, strict OpenSpec validation, docs link self-test, and the 343-file docs link scan passed.
- Package/lockfile, zero pin/source, workspace tracking, debug-marker, stash, and `git diff --check` hygiene passed.
- First aggregate `bun run check` attempt reported two unrelated macOS Seatbelt/Rscript timing failures after 5,002 ms and 1,006 ms. The exact two-test loop then passed in 41 ms and 102 ms, the complete 430-test policy-gate suite passed, and an unchanged full aggregate rerun passed. No #132 file touches that sandbox path; without a deterministic red loop no unrelated code was changed.

## Non-goals

- No #92 StackLock assembly/fingerprint/store implementation and no #93 HTTP routes.
- No automatic rejection or cleanup of dirty developer runs；downstream governance consumes the evidence later.
- No checkout/fetch/reset, no modification of SHUD/rSHUD/AutoSHUD/zero sources, no real runtime version probing.

## Review focus

- Actual checkout truth must never be replaced by gitlink or fixed branch labels.
- The consistency barrier must bind both physical checkout identity and logical Git state.
- Dirty detection includes tracked and untracked files without Git mutation or credential/trace leakage.
- Test fixtures must use unique temporary paths and remain parallel/retry safe.
