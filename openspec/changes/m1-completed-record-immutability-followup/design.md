## Context

`writeFailedRecord` currently calls `writeJsonRecord` after a deciding lookup without carrying that observation into the mutable write. `recoverCompletedRecordAfterRollbackFailure` likewise reads, removes a recoverable transition guard, then mutates through a fresh-baseline writer. In both cases a replacement generation can appear between decision and mutation. The record store then treats that newer generation as its baseline, so a completed record can be destroyed. Existing in-band guards make the first path defense-in-depth; the second API has no production caller today, but its exported contract must be safe before one is added.

## Decisions

1. Recovery mutation is generation-bound. Reuse the record store's observation plus exact-replacement/cleanup-permit machinery, or acquire and retain the idempotency transition guard through decision and write. Do not add another publication primitive.
2. A writer that loses its observed generation must re-read/reclassify or return the stable existing transition result. It must not capture the replacement as a new mutable baseline.
3. Completed generations are immutable across both same-process in-band schedules and the out-of-band raw-writer seam used for defense-in-depth tests.
4. `consumeCompletedRecord` settles any transported mutation authority/rejected reason before every error exit after fulfillment, including the defensive invalid-authority branch. The comments enumerate all three windows: release failure, post-release authority-state validation, and cleanup-permit refresh.
5. The record-store observation test seam explicitly documents that committed-then-throw is an intentional fail-loud tripwire; implementation semantics stay unchanged.

## Fixture

Fixture level: expanded. Repair intensity: high. Project profile: SHUD-Harness.

Change surface:
- Shared idempotency state machine and recovery writers in `idempotency-service.ts`.
- Mutable JSON publication/observation contract consumed from `workspace-record-store.ts`.
- Core service regression and AST/pin tests.

Must preserve:
- Completed idempotency records remain replayable and immutable.
- Same-key digest/result mismatch errors, failed-record recovery, transition-guard cleanup, compensation ordering, and resource accounting remain stable.
- S34-P62-06 in-band cleanup-lock protection and S34-P62-16 primary-once settlement oracle remain green.
- No public schema/API change; zero submodule diff remains empty.

Seams under test:
- `createIdempotencyRecordService` public methods: highest stable seam for recovery transitions and resource ownership.
- `runWithWorkspaceRecordPublicationHooks` / observation hooks: existing deterministic schedule seam for the decision-to-write race; no new test-only seam.
- Existing source-structure pin test: appropriate only for the documented throw-window count and settlement-owner call sites.

Risk packs considered:
- Public API / CLI / script entry: selected - exported recovery service methods are callable contracts even with zero current production callers.
- Config / project setup: not selected - no configuration or workspace layout change.
- File IO / path safety / overwrite: selected - mutable record replacement must bind the exact observed generation.
- Schema / columns / units / field names: selected - persisted `status`, `request_digest`, and `result_ref` semantics must remain stable; shapes do not change.
- Auth / permissions / secrets: not selected - no credential or authorization surface.
- Concurrency / shared state / ordering: selected - the defect is a check-then-act generation race and settlement ordering gap.
- Resource limits / large input / discovery: selected - cleanup permits, guards, and transported authorities must settle exactly once with no capacity leak.
- Legacy compatibility / examples: selected - existing failed/completed recovery and replay callers/tests must remain compatible.
- Error handling / rollback / partial outputs: selected - rollback recovery must not destroy a newer terminal record; compensation keeps the semantic primary.
- Release / packaging / dependency compatibility: not selected - no dependency or packaging change.
- Documentation / migration notes: selected - three-window and committed-then-throw seam contracts must be accurate; no migration.
- Scientific governance / PI gate / evidence lineage: not selected - no scientific result or evidence classification changes.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - solver/toolbox/pipeline untouched.
- Zero adapter / tool registry / agent role governance: not selected - Zero and tool surfaces untouched.

## Invariant Matrix

Governing invariant: once a deciding observation sees generation A, a recovery transition may replace only A under its pinned authority; any generation B that appears before commit is preserved and reclassified, and every transported authority is settled exactly once on all exits.

Source-of-truth identity/contract: normalized workspace + scope + sha256(key), `request_digest`, status/result_ref, observed physical generation and cleanup permit, transition guard ownership.

Surfaces:
- Producers: `beginRecord`, `completeRecord`, failed recovery writers, completed rollback recovery.
- Validators/preflight: lookup classification, digest/result binding, transition-guard validation, exact observation comparison.
- Storage/cache/query: idempotency JSON record, cleanup permit, transition guard/cleanup-lock registries.
- Public routes/entrypoints: service API methods; `POST /api/tasks` is an unchanged downstream consumer.
- Frontend/downstream consumers: completed replay and task creation; no frontend code changes.
- Failure paths/rollback/stale state: first-write catch, plain failed write, rollback-completion recovery, guard release, invalid authority state, permit refresh.
- Evidence/audit/readiness: core regressions, structural pins, full check, OpenSpec validation, git/submodule/workspace gates.

Regression rows:
- observed started A + raw or in-band completed B inserted before recovery write -> B remains byte-for-byte authoritative; recovery does not overwrite it.
- observed started A unchanged through recovery write -> requested failed/completed transition succeeds once and remains replayable.
- fulfilled completed-consumption result + failure in any of the three post-fulfillment windows -> mutation authority and rejected-reason resources settle once; original failure remains semantic primary.
- existing same-key mismatch, invalid-completed, failed recovery, S34-P62-06, and S34-P62-16 scenarios -> unchanged results and no authority/capacity leak.

## Boundary-Surface Checklist

- Shared helper roots: reuse observation/exact-replacement and transition-guard helpers; no new publication helper.
- Public entrypoints: both recovery methods and unchanged task route consumer.
- Read surfaces: lookup/replay and exact record observation.
- Write/delete/overwrite surfaces: failed/completed recovery replacement only.
- Staging/publish/rollback surfaces: mutable JSON commit, transition guard removal/release, compensation.
- Producer/consumer evidence boundaries: observed generation/digest/result_ref must describe the bytes replaced.
- Stale-state/idempotency boundaries: replacement generation, invalid completed record, guard contention, retry/reclassification.
- Unchanged downstream consumers: task create/replay, normal `completeRecord`, invalidation/quarantine.

## Non-Goals

- Cross-process recovery ownership, lease/supervisor work, or adding a production caller to `recoverCompletedRecordAfterRollbackFailure`.
- Capacity re-scoping (#82), error taxonomy (#80), lane cleanup ordering (#81), or test-infrastructure hygiene (#83).
- Changing record schemas, HTTP envelopes, idempotency applicability lists, or record-store commit semantics.
