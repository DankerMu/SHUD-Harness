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
- Change: four no-follow checkout directory capabilities and actual `commit/branch/detached/dirty` join the two-snapshot checks, two consecutive complete publication sweeps, and the final unified observable-identity recheck；dirty is produced from one immutable helper-free observation snapshot that freezes every admitted safe status input.
- Preserve: superproject `HEAD` gitlinks and exact `HEAD:.gitmodules` remain the trusted path/generation authority；worktree `.gitmodules` never becomes authority.
- Preserve: minimal non-secret Git environment, `--no-lazy-fetch`, bounded output, typed non-disclosing errors, zero partial publication, no fetch/checkout/reset/write；status disables repo-local fsmonitor, overrides nested-submodule ignore, and is preceded by recursive non-executing clean/process filter rejection.
- Preserve: #92 owns assembly/fingerprint/persistence and #93 owns routes；this issue only makes their future contract require complete repo revision propagation.

## Seams under test

- Public `StackLockSchema.safeParse` and generated JSON/Markdown prove required boolean, invalid/missing rejection, strict unknown/deprecated-field behavior, and four-repo positive examples.
- Public `collectStackLockContext({ repositoryRoot, gitCommand? })` proves actual HEAD/branch/detached/dirty observation, stable errors, and all-or-error publication without partial content.
- Synthetic independent Git repositories are the standard CI seam；a canonical full-root check may run only when all four repo checkouts are present.
- Future fingerprint/API behavior is a spec/task assertion only in #132；runtime verification remains owned by #92/#93.

## Risk packs considered

- Public API / CLI / script entry: selected — public core schema and collector output contract change；no CLI/HTTP implementation.
- Config / project setup: selected — committed `.gitmodules` maps the four trusted checkout paths and branch declarations.
- File IO / path safety / overwrite: selected — four filesystem checkout roots are admitted no-follow and must reject path replacement/symlink without target access.
- Schema / columns / units / field names: selected — required `dirty:boolean` changes the strict StackLock graph and generated schema.
- Auth / permissions / secrets: selected — Git subprocess environment and errors must not forward or disclose credentials, trace sinks, paths, or config bytes.
- Concurrency / shared state / ordering: selected — actual checkout state and physical identity must match across two snapshots.
- Resource limits / large input / discovery: selected — Git output and each captured index/auxiliary file remain bounded；exactly four top-level repos are published, while initialized stage-0 nested checkouts are recursively observed. Collection-global recursive depth/entry/command budgeting remains solely Issue #134.
- Legacy compatibility / examples: selected — old repo revisions without `dirty` are intentionally rejected；canonical and generated examples are updated together.
- Error handling / rollback / partial outputs: selected — any malformed output, unsafe path, missing repo, or observable state drift returns a stable typed error with no partial content；handle cleanup preserves primary-error precedence.
- Release / packaging / dependency compatibility: selected — generated artifacts and public types change；package manifests, lockfile, dependencies, and submodule pins remain unchanged.
- Documentation / migration notes: selected — frozen-spec bug correction is recorded in the activation ledger and canonical schema.
- Scientific governance / PI gate / evidence lineage: selected — dirty state is P0 reproducibility evidence, not a scientific conclusion.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: selected — all three runtime repos must report their actual local state without source mutation.
- Zero adapter / tool registry / agent role governance: selected — zero is the fourth runtime repo and retains its pinned-clean evidence when canonical.

## Invariant Matrix

Governing invariant: a successful StackLock collection records the actual four-checkout map accepted by a fixed-order first-sweep followed by a fixed-order second-sweep, where both completed maps equal the snapshot, and a subsequent unified root/four-path identity recheck；gitlinks remain internal path/generation authority. This is not a strong atomic or return-time contemporaneity guarantee and has no shared three-field final command: commit, branch/detached, and dirty each become eligible for the public exclusion only after that field's own final HEAD, branch, or frozen-status/nested observation；mutation after final pathname identity and ABA wholly between observations are also not guaranteed detectable.

Source-of-truth identity/contract: superproject `HEAD` inventory + exact `HEAD:.gitmodules` declarations + each checkout no-follow directory descriptor/cwd capability `(path, dev, ino)` + actual Git `HEAD`/branch/detached/porcelain status + strict StackLock schema.

- Producers: superproject inventory/blob reader；one collection-wide external temporary-parent authority；four serial descriptor-bound checkout top-level/HEAD/branch/immutable-dirty-snapshot observers plus recursively discovered initialized/present-deinitialized/stably-absent stage-0 nested observers；two post-freeze complete publication sweeps；one unified final observable-identity recheck.
- Validators/preflight: physical root identity, exact Git top-level and empty prefix, 40-hex HEAD, bounded single-line branch, canonical Git booleans and `core.checkStat`, safe config/ignore/text-conversion/stat-refresh capture, standalone/split-index dependency capture, three-state nested stability, protected temporary-parent scope/identity, helper-free porcelain dirty boolean, strict schema parse.
- Storage/cache/query: none — current collector returns frozen memory content；#92/#93 remain future consumers.
- Public routes/entrypoints: core schema and collector barrel only；no backend route change.
- Frontend/downstream consumers: generated schema now；future #92 fingerprint/store and #93 API must preserve all four repo-revision fields.
- Failure paths/rollback/stale state: missing/replaced/symlink checkout, malformed Git result, or cross-snapshot gitlink/checkout drift → typed failure and no result.
- Evidence/audit/readiness: focused schema/collector tests, generated-schema drift, strict OpenSpec, full core/backend/check/perf/docs and Git/submodule hygiene.

Regression rows:

- Actual checkout HEAD differs from gitlink → actual commit/branch recorded, no rejection or fallback.
- Tracked or untracked change in one repo → its `dirty=true`, unchanged siblings remain false.
- Detached checkout → `branch="detached", detached=true`；attached branch `detached` → same branch string with `detached=false`.
- Observable checkout physical identity or commit/branch/detached/dirty changes before the relevant field-specific final observation in the two snapshots or hash/schema/freeze/publication sweeps → `collection_state_changed`, no partial output；mutation after that field's final observation, after final pathname identity, or wholly unobserved ABA remains explicitly excluded；first failure leaves no active sibling producer or open owned handle.
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
| Config / stat refresh | effective main-local、linked-worktree、nested-include `core.trustctime`/`core.checkStat`/`core.ignoreStat`；unsupported token | same-size/restored-mtime native-clean parity；canonical values frozen；Git/parser rejection remains typed and non-disclosing |
| File IO / path safety | checkout missing, non-directory, nested top-level, symlink leaf/ancestor, or same-path replacement | `collection_contract_invalid` at admission or `collection_state_changed` after admission；no target bytes read/written |
| Auth / permissions / secrets | inherited credential/askpass/trace variables and failing Git command | child receives only allowlisted non-secret env；`git_read_failed` message/output contains no secret, absolute path, stderr, or trace file |
| Concurrency / ordering | each early repo drifts after first-sweep read as next sibling begins；three early repos mutate commit/branch after the respective second-sweep final field read and dirty after its final frozen-status/nested read；checkout identity changes through two publication sweeps；swap-use-restore；first sibling failure | first-sweep drift is caught by second-sweep/final identity；two completed maps must match；each field's post-final-observation mutation is an explicit exclusion and no status call is mislabeled as a shared final observation；transient swap cannot redirect reads/publish target；post-final-identity/fully unobserved ABA excluded；no partial repo map or orphan producer |
| Process/config isolation | `.`/empty/relative PATH component；Git exit 73 vs cwd mismatch；main/linked/nested worktree-scope and included clean/process filter；audit→external injection；fsmonitor | resolve one absolute trusted Git before repo cwd or fail；marker-qualified mismatch only；pre-existing filter typed-fails before observer，post-audit injection cannot execute in isolated observer；fsmonitor disabled |
| Resource/error precedence | authority acquired before outer postcondition；producer and close both fail；success then close fails | acquisition-time owner closes every handle；primary error preserved；close failure becomes primary only when no earlier error；FD baseline restored |
| Resource limits / discovery | HEAD/branch empty, unterminated, multi-line, non-UTF-8, or above 64 KiB；real status above bound；standalone/split index or safe auxiliary input missing/replaced/oversized/drifting；initialized/deinitialized/absent nested；Git timeout | invalid/maxBuffer output → `git_output_invalid`；timeout/nonzero → `git_read_failed`；status empty → clean and one/many porcelain records → dirty；four fixed published repos plus nested recursive reads，with collection-global recursion budgeting deferred only to #134 |
| Temporary write authority | TMPDIR at superproject、published child、nested child or any symlink alias；external parent replacement | reject before transient creation；creator call count remains zero；external identity drift → `collection_state_changed` |
| Legacy compatibility | legacy StackLock repo revision lacks dirty | intentional strict rejection；canonical/generated migration note updated；package/lock/submodule pins unchanged |
| Error / rollback | any producer or final schema validation fails | stable typed error and no returned content；no rollback because the operation is read-only |
| Release / docs | regenerate StackLock JSON/Markdown after source schema change | `schema:check` clean；no hand-edited drift or dependency changes |
| Scientific evidence lineage | actual HEAD differs from gitlink or clean↔dirty changes | actual checkout truth is retained；future #92 fingerprint must change for content change |
| Hydrology/Zero governance | run every state row for SHUD/rSHUD/AutoSHUD/zero | identical semantics for all four；no source or Git mutation |

## Boundary-surface checklist

- Shared helper roots: collector Git process seam and root identity helpers；no generic path/hash helper change unless a verified finding requires it.
- Public entrypoints: StackLock schema/type and `collectStackLockContext` output.
- Read surfaces: exact four declared published checkout roots plus recursively discovered initialized、present-deinitialized and stably-absent stage-0 nested paths，all through per-command/per-file bounds；#134 remains the sole owner of collection-global depth/entry/command budgets.
- Write/delete/overwrite: helper-free temporary Git contexts may be created only under one identity-bound external parent outside the canonical superproject protection scope and are removed on every path；protected roots have zero transient creation。Tests mutate only their unique fixtures.
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

### Phase 6.2 invariant closure (2026-07-27)

- Frozen status config now preserves effective main-local、linked-worktree and nested-include `core.trustctime`、`core.checkStat=default|minimal` and `core.ignoreStat` semantics. The two boolean keys reuse canonical Git aliases/valueless=true；unsupported values remain typed and non-disclosing. Deterministic whole-second same-size/restored-mtime fixtures prove native-clean parity while inspecting the frozen config at the injected Git seam.
- Stage-0 nested state is explicitly `initialized | deinitialized | absent`. Present deinitialized directories retain native clean and upward-discovery rejection；stably absent direct or recursively nested paths contribute dirty；appearance、disappearance and same-path replacement after audit fail `collection_state_changed`.
- Temporary authority is resolved once per collection, physically normalized and identity-bound outside the canonical superproject protection scope before any creation. Superproject、published child、nested child and physical/symlink aliases reject before any `stack-lock-status-*` transient is observable；external parent replacement fails before the injected creator is called.
- Requirement-driven RED was observed before production repair: config matrix `0 pass / 10 fail`（the same-stat oracle was then corrected to whole-second native-Git authority before acceptance）；protected-temp matrix exposed four failing sibling/alias rows and two already-safe descendant controls, after which the final six rows were all placed inside the collection protection scope；nested matrix exposed direct/recursive absent and absent→present failures while retaining deinitialized disappearance/replacement guards. Pre-commit GREEN is focused `24 pass / 0 fail`、dirty-state `165 pass / 0 fail / 591 expect`、collector `73 pass / 0 fail / 237 expect`、aggregate core services `753 pass / 5 skip / 0 fail / 30684 expect`。The detached pre-commit proof rehearsal twice produced RED `3/3` exact semantic failures and GREEN `3/3` exact semantic passes with successful cleanup. The final committed-SHA/blob-bound replay remains intentionally deferred until the orchestrator commits the green tree.
- Final pre-commit gates passed: aggregate `check`、typecheck、schema generator self-test/drift、`39 pass / 0 fail / 188 expect` schema suite、strict OpenSpec、PERF-API-001、docs self-test + 343-file link scan、dependency-lock validation/self-test、submodule pins、proof shell syntax/ShellCheck and worktree hygiene.
- Issue #134 remains the sole owner of collection-global recursion depth/entry/command budgeting；this closure adds no recursion budget、#92/#93 behavior、dependency/workflow/submodule change.

### Round 4 gate-selected depth redesign (2026-07-27)

- Replaced the partial temporary-Git-dir emulator with one immutable `RepositoryRevision` dirty observation snapshot. The snapshot audits helper-bearing config, parses Git booleans with canonical aliases and a documented valueless=true policy, captures safe ignore/attributes/line-ending config, and identity-stably captures standalone or split index bytes plus the referenced shared companion and source timestamps before helper-free status consumes them.
- The isolated observer rejects a physical or symlink-aliased temporary parent inside the observed checkout, never counts its own files, and preserves primary-error precedence and cleanup. Initialized nested checkouts must prove their own exact top-level and recurse；a deinitialized stage-0 checkout remains native-clean without upward parent discovery. Collection-global recursive budgeting remains exclusively #134.
- Added real-Git RED→GREEN rows for same-length byte changes/index timestamp authority, main/linked/nested ignore parity, local excludes, autocrlf/eol, main clean/staged/unstaged and linked/nested split index, split companion missing/oversized/replaced/drifting typed failure, canonical boolean aliases, hostile checkout-local TMPDIR, deinitialized nested, and clean-runner nested author identity. The committed-SHA/blob-bound Round 4 replay passed on `6a81d7c51eeaae6d5c09cc3130bb9aa1e2267ce9`: six governing blobs were bound；both repetitions produced RED `9/9` exact named semantic failures and GREEN `9/9` exact named passes in isolated Bun 1.2.19 processes, then removed the detached worktree without modifying source/index. An earlier aggregate-selector replay was rejected and repaired at the proof-harness layer before any result was accepted；runtime and test behavior were unchanged.
- Publication wording and tests now use field-specific boundaries: commit after its final HEAD read, branch/detached after its final branch read, and dirty after its final frozen-status/nested observation. The three early repositories have empty-commit and branch-rename seam rows between the respective final field read and the following dirty observation；no status invocation is described as a shared three-field final observation.
- Pre-commit GREEN verification: dirty-state real-Git matrix `142 pass / 0 fail / 421 expect`；collector unit seam `73 pass / 0 fail / 237 expect`；schema `39 pass / 0 fail / 188 expect`；aggregate `check` passed, including core services `730 pass / 5 skip / 0 fail / 30514 expect`。Typecheck、schema generation/drift、strict OpenSpec、PERF-API-001、docs self-test + 343-file link scan、frozen install、dependency-lock validation/self-test、submodule pins、proof-script syntax and `git diff --check` also passed.

### Round 3 gate-selected depth repair (2026-07-27)

- Replaced check-then-use filter preflight with a two-phase dirty protocol: main/linked/nested effective local+worktree+include config and strict NUL/stage-aware index audit, followed by a frozen-index/minimal-config status context that reads its worktree and object directory relative to the already descriptor-bound cwd. Parent status uses `--ignore-submodules=all`; stage-0 gitlinks recurse explicitly, so audit-after injection cannot execute a helper and nested `ignore=all`/fsmonitor semantics remain intact.
- Added deterministic non-barrel test hook coverage for audit→external filter injection；real main/linked/nested worktree-scope clean/process including include expansion；LF/U+2028/U+2029 stage-0 pathname recursion；stage 1/2/3 conflicts and malformed/unknown records before status；staged plus clean/dirty/fsmonitor/ignore=all nested regression rows；all marker and temporary-context checks leave no residue.
- Round 3 publication evidence distinguished first-sweep→second-sweep fallback from a then-status-based exclusion boundary. Round 4 found that `statusReads===8` was not a shared final observation for commit/branch and superseded that wording with the field-specific authority above；the historical first-sweep drift matrix remains valid and no third sweep was added.
- Focused collector = `73 pass / 0 fail / 237 expect`；dirty-state plus collector required two-file batch = `168 pass / 0 fail / 534 expect`。Attached/detached tests each carry a 30s bound；six concurrent exact invocations each ran both tests, producing `12 pass / 0 fail` actual executions with every invocation finishing in 6.19–6.67s.
- `test:schemas` = `39 pass / 0 fail / 188 expect`；`test:core-services` and the final aggregate `check` passed (`683 pass / 5 skip / 0 fail` in core services)；`typecheck`、schema generator self-test/drift check、strict OpenSpec、PERF-API-001、docs self-test、343-file link scan、frozen install、`git diff --check`、stash/temp-marker hygiene passed。The aggregate includes backend API/WebSocket、frontend、schema、core-service and GLM provider suites.
- The committed replay `issue-132-round-3-red-proof.sh` ran against `92b5422bb2ff1ff0f6646d67257c0b9a21476582`, bound five committed blobs, and twice produced RED `0 pass / 15 named semantic fail / exit 1` followed by GREEN `15 pass / 0 fail / exit 0` after restoring the committed collector. It rejected an earlier `1 pass / 14 fail` attempt, which exposed and then closed a test-oracle gap at the isolated `--git-dir` boundary. Harness/import/timeout failures remain forbidden；the detached proof worktree was removed and source/index remained unchanged.
- Issue #134 nested global resource budgeting remains explicitly out of scope；Round 3 adds no recursive global budget or package/lock/zero/#92/#93/runtime surface change.

### Round 2 verified-finding repair (2026-07-27)

- Focused collector/dirty-state batch: `141 pass / 0 fail / 452 expect`，覆盖两个完整 publication sweeps、三仓 next-sibling × commit/branch/dirty/identity 12 格、绝对 PATH、Git exit marker、handle/FD/primary precedence、no-follow-before-realpath 与真实 clean/process/nested filter marker。
- `test:schemas`: `39 pass / 0 fail / 188 expect`；`test:core-services`: `656 pass / 5 skip / 0 fail / 30308 expect`。
- 24-way transient replacement-wrapper stress: `24 pass / 0 fail`；所有进程 settlement 后 `stack-lock-dirty-*` temp residue = 0，环境变更 confined to child processes。
- `schema:check`、`typecheck`、strict OpenSpec 与 `git diff --check`: pass。
- Blob-bound semantic red proof 在 committed green tree `f493e77235acbe26ff3f8587192a9eab32efa77e` 上完成；五个 governing blob 已记录，两轮均为 RED `0 pass / 17 named semantic fail`、GREEN `17 pass / 0 fail`，且 detached worktree 完整清理。首次 replay 的缺失 `zero` workspace 与未到达 checkout command 的 PATH fixture 均被 proof 自身拒绝并修正，未用 harness/setup failure 冒充红证据。

### Round 1 confirmed-finding repair (2026-07-27)

- Historical Round 1 run fixed production sources to base `c9ea4fb325f2b4c9ff5c4693ffb90aa13ae8445e` while retaining the then-final three test files and reported RED `89 pass / 69 fail`, then GREEN `158 pass / 0 fail`. Round 2 determined that its replay implementation was not admissible because it copied caller worktree files and accepted arbitrary non-zero RED；the historical record is retained in `evidence/issue-132-round-1-red-proof.md`, while the old script path now delegates to the blob-bound Round 2 proof.
- Added two-sweep publication coverage for every early repo's commit/branch/dirty/identity drift at the next sibling boundary, plus dirty-after-second-renv, physical identity and transient swap-use-restore windows；all observable drift fails without partial output or proves replacement target cannot redirect reads.
- Added real repo-local/included clean/process filter non-execution (including nested submodules), fsmonitor non-execution, nested submodule `ignore=all` override, absolute-PATH/exit-marker isolation, acquisition-time handle/FD/error-precedence checks, real >64 KiB status/maxBuffer mapping, attached/detached collision, positive dirty-worktree `.gitmodules` authority and serial failure-settlement coverage.
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
