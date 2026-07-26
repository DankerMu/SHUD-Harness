# Issue #91 — StackLock collection service fixture and delivery evidence

- Workflow: `subagent-workflow` 0.31.0
- OpenSpec change: `m2-research-context`
- Fixture level: expanded
- Repair intensity: high
- Project profile: SHUD-Harness
- Minimal mergeable slice: one read-only core collection service, its public export, and direct core-service tests; no assembly, fingerprint, persistence, route, or UI work

## Risk triage

Mandatory expanded triggers are public service API, repository/config file reads, a bounded Git subprocess, credential-adjacent provider configuration, evidence hashes, and compatibility with four read-only submodules. High repair intensity applies because the result becomes the reproduction evidence input consumed by tasks 4.2/4.3.

## Change surface

- `packages/core/src/domain/services/stack-lock-collector.ts`: collect and revalidate four gitlink revisions, `renv.lock` state, runtime placeholders, harness identity, and the safe provider projection.
- `packages/core/src/domain/services/stack-lock-collector.test.ts`: positive, negative, no-follow, no-secret, bounded-command, and real-repository regression evidence.
- `packages/core/src/domain/services/index.ts`: public collection contract.
- Root `package.json`: establish the already-canonical SHUD-Harness `0.8.3` release identity required by D7a; `bun.lock` remains byte-identical.
- This fixture and `tasks.md` bookkeeping.

## Must preserve

- `hashFile` remains the sole sha256 authority for an existing `renv.lock`; this issue does not modify hashing or path-safety helpers.
- The collector executes only `git ls-tree` with fixed arguments, never enters a submodule worktree, never runs checkout/fetch/config/status mutation, and leaves HEAD/index/worktree unchanged.
- Provider API-key values and environment variables are not inputs to the collector, are not logged, and cannot enter the returned object or stable errors.
- Existing core services, StackLock schema, dependency lock, routes, workspace record store, submodule pins, and generated schemas remain unchanged. The sole manifest change is the required root `version: 0.8.3`; no dependency or workspace topology changes.

## Must add/change

- Public `collectStackLockContext({ repositoryRoot, gitCommand? })` returning `{ repos, runtime, harness, llm, degraded }`; runtime identity cannot be supplied by callers.
- Four exact repository keys with 40-hex gitlink commits and canonical branch labels; zero must equal `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` in the repository integration test.
- Existing `renv.lock` -> `{ path: "renv.lock", sha256 }`; missing -> `null` plus the sole degradation reason `renv_lock_missing`.
- Internal OS probe plus fixed runtime placeholders, the required root-package version, and the D7a harness constants. Missing/blank/non-string root version is a typed failure, never a silent `unknown` projection.
- Provider/model/base URL projection follows the canonical `default_model` selector from `config/providers/glm.dmxapi.json`; params digest = sha256 of canonical `{}`, prompt-pack digest = sha256 of empty bytes.
- Stable non-disclosing `StackLockCollectionError`; no partial result after any failed producer/validation boundary.
- Two complete source snapshots must match before publication; generation drift maps to `collection_state_changed`.

## Seams under test

- Public service barrel import is the highest core API seam.
- Injected `StackLockGitCommand` proves the exact non-mutating command, deterministic parser, generation barrier, and malformed-result normalization without a test-only global hook.
- The non-barrel process seam proves default-runner timeout/maxBuffer mapping and child-environment sanitation. Real repository collection proves the four actual gitlinks and zero pin while comparing HEAD and complete tracked/untracked status before/after.
- Shared `hashFile` proves real `renv.lock` bytes and symlink rejection.
- Bounded durable JSON reads prove package/provider files are regular, single-link, size-bounded repository files.

## Risk packs considered

- Public API / CLI / script entry: selected — a new public core service/type surface; no CLI or HTTP route.
- Config / project setup: selected — reads the canonical provider config and root package identity without changing either.
- File IO / path safety / overwrite: selected — bounded no-follow JSON reads and shared `hashFile`; zero writes/deletes/overwrites.
- Schema / columns / units / field names: selected — output is the exact `repos/runtime/harness/llm` StackLock projection plus response-level degradation; StackLock schema itself is unchanged.
- Auth / permissions / secrets: selected — provider config is credential-adjacent; API-key bytes must remain non-observable.
- Concurrency / shared state / ordering: selected — durable per-file replacement/read drift fails closed and two complete snapshots must match before publication, preventing mixed-generation evidence.
- Resource limits / large input / discovery: selected — fixed four paths, 64 KiB Git output cap, 64 KiB JSON caps, 10 s subprocess timeout, and no recursive discovery.
- Legacy compatibility / examples: selected — existing service exports and M1/M2 consumers remain unchanged; canonical branch labels match current schema examples.
- Error handling / rollback / partial outputs: selected — all producer failures map to one stable typed boundary and return no partial collection.
- Release / packaging / dependency compatibility: selected — Node/Bun built-ins only; root metadata gains canonical `0.8.3`, while the dependency lock and submodule pins must not drift.
- Documentation / migration notes: selected — issue fixture and downstream 4.2 contract are recorded; no user migration.

Domain packs:

- Scientific governance / PI gate / evidence lineage: selected — commits and digests are reproduction evidence; no scientific conclusion or PI decision.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: selected — reads three hydrology gitlinks without entering or modifying their worktrees.
- Zero adapter / tool registry / agent role governance: selected — zero runtime pin is part of the reproduction chain; no Zero source or tool registry changes.

## Invariant Matrix

- Governing invariant: a successful collection is a complete, bounded, read-only snapshot of the four superproject gitlinks and canonical local configuration projections, with every digest bound to the bytes it claims and no credential bytes or partial result observable.
- Source-of-truth identity/contract: superproject `HEAD` gitlink entries; root `package.json`; `config/providers/glm.dmxapi.json`; optional root `renv.lock`; design D2/D7a; `StackLockSchema` content fields.
- Producers: fixed sanitized-environment `git ls-tree` command, bounded repository JSON reader, shared `hashFile`, internal runtime placeholder projection, and deterministic digest constants.
- Validators/preflight: exact mode/type/path/count gitlink parser, 40-hex commits, two-snapshot source identity comparison, repository path safety + durable single-link reads, required harness version, canonical provider/model selector consistency, safe HTTP(S) base URL, and StackLock content projection parse.
- Storage/cache/query: none — returned frozen memory value only; no cache, record store, workspace write, or route.
- Public routes/entrypoints: `packages/core/src/domain/services/index.ts` only; no HTTP/CLI entrypoint.
- Frontend/downstream consumers: future task 4.2 assembly consumes the content fields and task 4.3 carries `degraded`; current frontend/backend remain unchanged.
- Failure paths/rollback/stale state: Git failure/malformed inventory or hostile redirect, source generation drift, required version/config absence or mutation, unsafe URL, invalid/symlink `renv.lock`, or output contract mismatch throws a stable non-disclosing error and publishes nothing.
- Evidence/audit/readiness: focused collector tests, real git mutation guard, source-bound red proof, core-services/typecheck/check, strict OpenSpec, CI, and final PR-head evidence.

Regression rows:

- Stable four gitlinks + valid config + absent `renv.lock` -> exact four revisions, explicit placeholders, two independent deterministic digests, `r_packages_lock=null`, and `renv_lock_missing`.
- Stable four gitlinks + regular `renv.lock` -> shared-file digest with no degradation; byte change changes only the lock digest/content projection.
- Missing/duplicate/wrong-mode gitlink, malformed injected result, unsafe provider URL/selector/model mismatch, missing/invalid harness version, hostile Git repository environment, source generation drift, or symlink `renv.lock` -> typed failure, zero partial output, no secret/path echo, no target modification.
- Existing hashing/path-safety/core service consumers -> unchanged tests and public contracts remain green.

## Boundary-surface checklist

- Shared helper roots: consume `hashFile`, `resolveWorkspacePath`, durable single-link reader, and StackLock schema; modify none.
- Public entrypoints: one new collector and associated types/constants in the core service barrel.
- Read surfaces: fixed superproject Git tree; fixed package/provider JSON; optional fixed `renv.lock`.
- Write/delete/overwrite surfaces: none.
- Producer/consumer evidence boundary: exact gitlink/config/file bytes -> frozen content projection + degradation list -> future 4.2 assembly.
- Stale-state/idempotency boundary: repeated stable inputs produce identical content/degradation; changed `renv.lock` changes its digest; changing files during safe reads fails closed.
- Unchanged downstream consumers: StackLock schema, hashing/path safety, record store, backend/frontend, provider smoke tooling, package/lock files, and all submodule worktrees.

## Required evidence

- Focused collector tests: injected Git command, missing/existing/symlink renv, provider secret/URL rejection, real four-gitlink/zero-pin and git-mutation guard.
- Git process failure (including the default command timeout/max-buffer failure path) -> `git_read_failed`; malformed injected results and stdout above 64 KiB -> `git_output_invalid`; both errors remain non-disclosing and no partial collection is returned.
- Hostile inherited Git repository/config environment is removed before the default process call; the requested `repositoryRoot` remains authoritative.
- Stable inputs produce matching full snapshots; gitlink or source-byte transition between collection and revalidation -> `collection_state_changed` with no partial result.
- Missing/duplicate/wrong-mode gitlink, missing/invalid harness version, and provider selector/model mismatch matrix rows each produce their stable typed failure.
- Root `package.json` or provider JSON above 64 KiB -> the matching typed `*_invalid` error with no absolute path/config bytes in the error.
- Fixed-file replacement/read drift is owned by `readDurableSingleLinkFile` and proved at that shared authority by `durable parent validators reject callback-time FIFO and socket replacements bounded` and `durable final parent validation rejects a live leaf replacement before return`; the collector maps every non-`read` result to its stable matching `*_invalid` boundary and publishes no partial collection.
- Source-bound red proof: retain tests while independently weakening (1) zero/four-gitlink completeness and (2) digest source separation or `renv.lock` shared hashing; record exact failures and restore immediately.
- `npx --yes bun@1.2.19 run test:core-services`
- `npx --yes bun@1.2.19 run typecheck`
- `npx --yes bun@1.2.19 run check`
- `npx --yes bun@1.2.19 run schema:check`
- `npx --yes bun@1.2.19 run test:perf:api`
- `npx --yes @fission-ai/openspec@1.3.1 validate m2-research-context --strict --no-interactive`
- `git diff --check`; canonical root version, lock/submodule/tracked-workspace hygiene; frozen dependency install and DependencyLock validation.

## Executed verification

- Production-code head `ad236f52b85cf94304199ca43d362b652e23ae85`: standard CI run `30192869203` completed successfully. Linux passed install, `bun run check`, schema drift, PERF-API-001 and zero-pin guard; macOS seatbelt and docs-links also passed.
- Evidence head `1d8b758c7c37b4246b488e7546b770a48e96ad8f`: temporary workflow run `30193158335` completed successfully with the focused green suite, two independent source-bound red mutations, restored green suite, strict OpenSpec validation and repository hygiene.
- Zero-binding red mutation changed only `zero.commit` from the observed zero gitlink to the SHUD gitlink; the named collector test became red, then passed after exact source restoration.
- Digest-separation red mutation changed only `params_digest` from sha256 of canonical `{}` to sha256 of empty bytes; the named collector test became red because the two semantic digests collapsed, then passed after exact source restoration.
- The first temporary proof run `30193116220` had already passed focused green, both red mutations and strict OpenSpec; only its final package/lock comparison lacked a fetched `origin/main` ref in the shallow checkout. That verification-harness defect was fixed without changing production or test source, and run `30193158335` closed it.
- Local TypeScript 5.8.3 strict compile of the collector/public contract and a synthetic four-gitlink `git ls-tree -z --full-tree` parser check also passed before publication.

## Historical upstream review record (superseded for merge gating)

The remote implementation environment exposed no native implementer/reviewer/verifier subagent primitive, so its orchestrator performed separate single-session passes. Those observations are retained below as provenance only and do not satisfy the current merge gate. The adoption workflow for PR #131 runs native fixture reviewer, risk-adaptive reviewer, independent verifier, and final gap-sweep agents against an exact reviewed HEAD; its SHA-bound reports are persisted under `.workplans/issue-91/review/` and posted to the PR before merge approval.

- Correctness: exact four-key inventory, 40-hex gitlinks, canonical branch labels, missing/existing renv semantics, deterministic digest inputs and frozen complete output are covered; no actionable production finding remained.
- Integration: the service is exported only through the core service barrel and has no assembly/persistence/route consumer in this PR; no package or lock edge was added.
- Security/resource: fixed non-shell Git arguments, timeout/output caps, bounded durable config reads, no-follow hashing, stable non-disclosing errors and zero API-key/environment reads are covered; no actionable production finding remained.
- Test evidence: independent oracles, real zero pin, HEAD/status no-mutation guard, secret/path non-disclosure, source-bound red proof and full CI are present.
- Spec compliance: D2/D7a fields and issue #91 boundary are implemented; task 4.2/4.3 responsibilities remain excluded.
- Invariant/state: every producer validates before publication, failures return no partial object, and the collector creates no storage, cache, lock or write surface.
- Confirmed review finding: the temporary evidence workflow initially compared package/lock files against an unfetched `origin/main`; fixed in workflow-only commit `1d8b758c7c37b4246b488e7546b770a48e96ad8f` and proved green. This was not a production-code finding.
- Superseded source-data interpretation: Round 1 independent verification rejected the historical missing-version fallback because D7a permits no harness-version placeholder. The repair establishes the repository's canonical `0.8.3` metadata and makes missing/invalid version a typed failure.

## Local adoption verification

- Round 1 Phase 6.2 reusable-pattern audit: [`issue-91-round-1-invariant-audit.md`](issue-91-round-1-invariant-audit.md); all eight invariant surfaces are `clean`, and all nine verified findings map to concrete green regression rows.

- The first native macOS focused run exposed a test-fixture-only failure: `tmpdir()` returned lexical `/var/...`, while `/var` is a symlink to `/private/var`; the production path-safety boundary correctly rejected the synthetic root before reading `package.json`. Canonicalizing the fixture root with `realpath()` fixed the fixture without weakening production path safety.
- Focused collector suite after Round 1 verified repairs: 28 pass, 0 fail, 99 assertions, including generation drift, default-process resource mapping, hostile Git environment sanitation, malformed injected results, version authority, full inventory, and provider-selector consistency.
- `npx --yes bun@1.2.19 run test:core-services`: 542 pass, 5 platform skips, 0 fail, including the exact shared durable-reader replacement/drift tests cited above.
- `npx --yes bun@1.2.19 run typecheck`: pass.
- Full `npx --yes bun@1.2.19 run check`: exit 0; its collector/core-services stage reported the same 542 pass, 5 platform skips, 0 fail.
- `npx --yes bun@1.2.19 run schema:check`: pass.
- `npx --yes bun@1.2.19 run test:perf:api`: pass; all four PERF-API-001 rows stayed below the 300 ms ceiling.
- `npx --yes @fission-ai/openspec@1.3.1 validate m2-research-context --strict --no-interactive`: pass.
- `bun install --frozen-lockfile --ignore-scripts`, `validate:dependency-lock`, `git diff --check`, lock comparison, all four submodule pins/diffs, tracked-workspace, debug-marker, and red-proof-stash hygiene: pass.

## Non-goals

- StackLock id/time/fingerprint assembly, persistence/readback, API responses/routes, real runtime command probing, prompt-pack content, provider smoke/network calls, or any submodule worktree access.

## Historical execution-path deviation

The original ChatGPT GitHub-App implementation environment had no native implementer/reviewer/verifier subagent primitive. Its implementation, verification synthesis, Git operations, and PR tracking were therefore performed by one orchestrator session. This historical execution-path deviation is not accepted as current review evidence; PR #131 remains Draft until the local adoption workflow replaces it with independent SHA-bound review/verification evidence and re-runs the required checks.
