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

- `packages/core/src/domain/services/stack-lock-collector.ts`: collect four gitlink revisions, `renv.lock` state, runtime placeholders, harness identity, and the safe provider projection.
- `packages/core/src/domain/services/stack-lock-collector.test.ts`: positive, negative, no-follow, no-secret, bounded-command, and real-repository regression evidence.
- `packages/core/src/domain/services/index.ts`: public collection contract.
- This fixture and `tasks.md` bookkeeping only.

## Must preserve

- `hashFile` remains the sole sha256 authority for an existing `renv.lock`; this issue does not modify hashing or path-safety helpers.
- The collector executes only `git ls-tree` with fixed arguments, never enters a submodule worktree, never runs checkout/fetch/config/status mutation, and leaves HEAD/index/worktree unchanged.
- Provider API-key values and environment variables are not inputs to the collector, are not logged, and cannot enter the returned object or stable errors.
- Existing core services, StackLock schema, package manifests, dependency lock, routes, workspace record store, submodule pins, and generated schemas remain unchanged.

## Must add/change

- Public `collectStackLockContext({ repositoryRoot, gitCommand?, runtimeVersions? })` returning `{ repos, runtime, harness, llm, degraded }`.
- Four exact repository keys with 40-hex gitlink commits and canonical branch labels; zero must equal `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` in the repository integration test.
- Existing `renv.lock` -> `{ path: "renv.lock", sha256 }`; missing -> `null` plus the sole degradation reason `renv_lock_missing`.
- Runtime placeholders, root-package version when present (otherwise explicit `unknown` rather than an invented release), and the D7a harness constants.
- Provider/model/base URL projection from `config/providers/glm.dmxapi.json`; params digest = sha256 of canonical `{}`, prompt-pack digest = sha256 of empty bytes.
- Stable non-disclosing `StackLockCollectionError`; no partial result after any failed producer/validation boundary.

## Seams under test

- Public service barrel import is the highest core API seam.
- Injected `StackLockGitCommand` proves the exact non-mutating command and deterministic parser without a test-only global hook.
- Real repository collection proves the four actual gitlinks and zero pin while comparing HEAD and tracked status before/after.
- Shared `hashFile` proves real `renv.lock` bytes and symlink rejection.
- Bounded durable JSON reads prove package/provider files are regular, single-link, size-bounded repository files.

## Risk packs considered

- Public API / CLI / script entry: selected — a new public core service/type surface; no CLI or HTTP route.
- Config / project setup: selected — reads the canonical provider config and root package identity without changing either.
- File IO / path safety / overwrite: selected — bounded no-follow JSON reads and shared `hashFile`; zero writes/deletes/overwrites.
- Schema / columns / units / field names: selected — output is the exact `repos/runtime/harness/llm` StackLock projection plus response-level degradation; StackLock schema itself is unchanged.
- Auth / permissions / secrets: selected — provider config is credential-adjacent; API-key bytes must remain non-observable.
- Concurrency / shared state / ordering: selected — file replacement/read drift fails closed; a Git snapshot is parsed as one complete inventory before publication.
- Resource limits / large input / discovery: selected — fixed four paths, 64 KiB Git output cap, 64 KiB JSON caps, 10 s subprocess timeout, and no recursive discovery.
- Legacy compatibility / examples: selected — existing service exports and M1/M2 consumers remain unchanged; canonical branch labels match current schema examples.
- Error handling / rollback / partial outputs: selected — all producer failures map to one stable typed boundary and return no partial collection.
- Release / packaging / dependency compatibility: selected — Node/Bun built-ins only; package/lock/submodule files must not drift.
- Documentation / migration notes: selected — issue fixture and downstream 4.2 contract are recorded; no user migration.

Domain packs:

- Scientific governance / PI gate / evidence lineage: selected — commits and digests are reproduction evidence; no scientific conclusion or PI decision.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: selected — reads three hydrology gitlinks without entering or modifying their worktrees.
- Zero adapter / tool registry / agent role governance: selected — zero runtime pin is part of the reproduction chain; no Zero source or tool registry changes.

## Invariant Matrix

- Governing invariant: a successful collection is a complete, bounded, read-only snapshot of the four superproject gitlinks and canonical local configuration projections, with every digest bound to the bytes it claims and no credential bytes or partial result observable.
- Source-of-truth identity/contract: superproject `HEAD` gitlink entries; root `package.json`; `config/providers/glm.dmxapi.json`; optional root `renv.lock`; design D2/D7a; `StackLockSchema` content fields.
- Producers: fixed `git ls-tree` command, bounded repository JSON reader, shared `hashFile`, runtime placeholder projection, and deterministic digest constants.
- Validators/preflight: exact mode/type/path/count gitlink parser, 40-hex commits, repository path safety + durable single-link reads, provider/model consistency, safe HTTP(S) base URL, and StackLock content projection parse.
- Storage/cache/query: none — returned frozen memory value only; no cache, record store, workspace write, or route.
- Public routes/entrypoints: `packages/core/src/domain/services/index.ts` only; no HTTP/CLI entrypoint.
- Frontend/downstream consumers: future task 4.2 assembly consumes the content fields and task 4.3 carries `degraded`; current frontend/backend remain unchanged.
- Failure paths/rollback/stale state: Git failure/malformed inventory, required config absence/mutation, unsafe URL, invalid/symlink `renv.lock`, or output contract mismatch throws a stable non-disclosing error and publishes nothing.
- Evidence/audit/readiness: focused collector tests, real git mutation guard, source-bound red proof, core-services/typecheck/check, strict OpenSpec, CI, and final PR-head evidence.

Regression rows:

- Stable four gitlinks + valid config + absent `renv.lock` -> exact four revisions, explicit placeholders, two independent deterministic digests, `r_packages_lock=null`, and `renv_lock_missing`.
- Stable four gitlinks + regular `renv.lock` -> shared-file digest with no degradation; byte change changes only the lock digest/content projection.
- Missing/duplicate/wrong-mode gitlink, unsafe provider URL/model mismatch, or symlink `renv.lock` -> typed failure, zero partial output, no secret/path echo, no target modification.
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
- Source-bound red proof: retain tests while independently weakening (1) zero/four-gitlink completeness and (2) digest source separation or `renv.lock` shared hashing; record exact failures and restore immediately.
- `npx --yes bun@1.2.19 run test:core-services`
- `npx --yes bun@1.2.19 run typecheck`
- `npx --yes bun@1.2.19 run check`
- `npx --yes bun@1.2.19 run schema:check`
- `npx --yes bun@1.2.19 run test:perf:api`
- `npx --yes @fission-ai/openspec@1.3.1 validate m2-research-context --strict --no-interactive`
- `git diff --check`; package/lock/submodule/tracked-workspace hygiene.

## Non-goals

- StackLock id/time/fingerprint assembly, persistence/readback, API responses/routes, real runtime command probing, prompt-pack content, provider smoke/network calls, or any submodule worktree access.

## Execution-path deviation

The ChatGPT GitHub-App environment has no native implementer/reviewer/verifier subagent primitive. The implementation, verification synthesis, Git operations, and PR tracking are therefore performed by the orchestrator in one session; this is an execution-path deviation only, not a product/contract deviation. The PR remains Draft until repository CI and explicit review evidence are posted.
