# Issue #89 — M2 core schema delivery evidence

- Workflow: `subagent-workflow`
- Fixture: expanded
- Repair intensity: high
- Scope: `packages/core` Zod schemas/tests + schema generator registry + `docs/generated/**`
- Parent task: `openspec/changes/m2-research-context/tasks.md` 2.1
- PR: #129

## Invariant matrix

| Invariant | Boundary | Evidence |
|---|---|---|
| Persisted M2 research-context records accept only their canonical field sets. | StackLock, DataProvenance and ArtifactManifest root/nested objects | All new fixed-shape objects use `z.strictObject`; generated input JSON Schemas carry explicit closed object boundaries, while `preprocess.params` remains the intentional record-valued exception. |
| Reproduction identity is complete. | StackLock | Exact `SHUD`/`rSHUD`/`AutoSHUD`/`zero` repositories, required `llm.base_url`, object-or-null `r_packages_lock`, UUID-prefixed id, and rejection of deprecated/response-only fields are covered by positive and negative tests. |
| Data lineage retains the canonical object window and server-computed source hashes. | DataProvenance | Object `event_window`, required basin, exact source groups and complete observation entries are accepted; array windows, missing hashes/fields and unknown nested fields are rejected. |
| Manifest entries contain complete durable Artifact records. | ArtifactManifest / Artifact | `artifacts` is `Artifact[]`; `generator` is required; `report_id`, `superseded_by` and `manifest_sha256` remain optional; nested omitted `llm_generated` materializes as `false`. |
| LLM-origin state cannot disappear through omission. | Artifact parse output | `llm_generated` accepts boolean input, defaults omitted input to persisted `false`, and rejects non-boolean or unknown fields. |
| Generated documentation stays aligned with runtime input semantics. | `scripts/schema/generate.ts` and `docs/generated/**` | Registry coverage includes all exported top-level object schemas; strict definitions recursively require explicit `additionalProperties` policy, and Markdown exposes UUID patterns/defaults. |
| Existing M1 contracts remain unchanged. | TaskCard, ErrorRecord, IdempotencyRecord, LockRecord | Their existing positive/negative tests and non-strict JSON-schema parity self-test remain in the same suite and pass under the full repository check. |

## Scenario evidence

- StackLock: four-repository positive fixture, nullable/object `r_packages_lock`, required `llm.base_url`, UUID id, and deprecated `runtime.container` / root `limits` / `policy_version` / response `degraded` rejection.
- DataProvenance: canonical object window and hashed source positive fixture; array window, missing basin/hash/station, invalid id and unknown nested key rejection.
- ArtifactManifest: complete nested Artifact positive fixture, optional reference omission, required generator, compact-artifact rejection, strict unknown-key and manifest-id/successor-id rejection.
- Artifact: omitted marker becomes `false`, explicit `true` survives, non-boolean marker and unknown key fail.

## Semantic red proof

GitHub Actions run `30012805157`, artifact `8565786709` (`sha256:d0000d631400a304f643736b24768b28fe253ea73731a61c90084029536c0264`) independently weakened two production contracts while retaining the new tests:

1. Replacing `z.boolean().default(false)` with `z.boolean().optional()` made the Artifact default test fail with `Expected: false; Received: undefined`.
2. Making `llm.base_url` optional made the missing-base-url test fail with `Expected: false; Received: true`.

After each mutation the source was restored, and the complete `test:schemas` suite passed.

## Generator and OpenSpec verification

GitHub Actions run `30013150853` used Bun `1.2.19` and the repository's Zod dependency to:

- pass the generator self-test with mixed strict/non-strict input semantics;
- regenerate JSON Schema and Markdown artifacts;
- pass `bun run test:schemas` and `bun run typecheck`;
- pass `@fission-ai/openspec@1.3.1 validate m2-research-context --strict --no-interactive`;
- verify generated StackLock `zero`/`base_url`, Artifact `llm_generated`, and ArtifactManifest `superseded_by` fields;
- publish the generated source/artifacts and the task fixture to the PR branch.

The temporary generation/red-proof workflows are verification harnesses only and are removed from the final PR tree.

## Static compatibility review

- Preserved the existing public `ArtifactType`, `ArtifactCreatedBy`, `ArtifactRetentionClass` and `ArtifactRedactionStatus` type exports.
- Kept public `Artifact` and `ArtifactManifest` types aligned with their optional-input canonical contracts, while exposing `StoredArtifact` and `StoredArtifactManifest` for post-parse records whose defaulted fields are materialized.
- Aligned `ArtifactRegistryService` with that same boundary: it accepts `ArtifactInput` and returns `StoredArtifact`; runtime publication/path/duplicate logic is unchanged.
- Confirmed the final diff does not alter TaskCard, ErrorRecord, IdempotencyRecord, LockRecord, route logic, package manifests or dependency locks.

## M1 Artifact compatibility repair

The original PR head exposed the additive default to existing M1 exact-equality fixtures. The focused pre-repair command
`npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts -t "Artifact registry register/get persists metadata under manifests only"`
failed `0 pass / 1 fail`; the only value difference was the canonical parsed output adding `llm_generated: false`. The remote `test:core-services` job reported nine failures in the same class.

The repair preserves `.default(false)` and adds boundary evidence instead of weakening the schema:

- omitted M1 input registers, persists and reads back with explicit `llm_generated: false`;
- a pre-existing JSON record that omits the field reads as false in memory without eager byte rewrite, and repeated legacy registration converges;
- explicit true and false survive register/get, persisted JSON and nested ArtifactManifest parsing;
- non-boolean/unknown metadata is rejected without a manifest file;
- public barrel/type assertions prove optional Artifact input and required boolean StoredArtifact output, including the registry service return contract.

Post-repair local verification on the merged-with-current-main worktree passed: the three focused registry rows (`1/0` each), `test:schemas` (`19/0`), `test:core-services` (`514 pass / 5 platform skips / 0 fail`), `schema:check`, `typecheck`, the full `check`, strict OpenSpec validation, `git diff --check`, and package/lock/submodule/workspace hygiene.

## Cross-review round 1 repair

The first six-lens review of commit `0a9418449dad1e36f1e07595a1ee8b259263a986` produced four deduplicated candidates. Independent verification confirmed three `FIX_NOW` findings and refuted one path-normalization concern:

- generated Markdown examples used semantically invalid placeholder identifiers, rendered empty `preprocess.params` as YAML null, and omitted fields of object-valued array items from field tables and changelogs;
- the schema suite lacked explicit rejection of the deprecated string-valued `r_packages_lock` and a positive ArtifactManifest fixture omitting every optional field;
- the strict-input closure self-test accepted `additionalProperties: {}` on arbitrary fixed objects instead of limiting that exception to `DataProvenance.preprocess.params`;
- the alleged weakened dotted-path normalization oracle was refuted because the caller normalizes that path before comparison and the existing fixture necessarily exercises the fallback branch.

The repair adds semantic round-trip validation for every generated Markdown YAML example against its source Zod schema, emits valid schema-specific example identifiers, preserves empty maps as `{}`, and recursively documents object-array fields such as `sources.observations[].station` and `artifacts[].llm_generated`. The strict-input checker now requires `additionalProperties: false` on fixed objects and permits the open-record schema only at the exact `DataProvenance.preprocess.params` identity/path. Focused mutation proofs made the generator self-test fail with eight aggregated semantic errors, made the legacy string lock fixture fail acceptance, and made the optional-manifest fixture fail when an optional field was artificially required; all mutations were restored before the final run.

Post-round verification passed: generator semantic self-test, generated artifact regeneration and drift check, `test:schemas` (`21 pass / 0 fail`), `typecheck`, full `check`, strict OpenSpec validation, `git diff --check`, and package/lock/submodule/workspace/stash hygiene.

## Cross-review round 2 evidence closure

Round 2 independently confirmed one blocking `test-evidence` gap: the earlier focused mutations did not account for the complete new-behavior test set. A disposable exact-HEAD worktree then ran one batched proof over 11 red groups and 10 source-only configurations, mapping the new StackLock/DataProvenance/ArtifactManifest contracts, Artifact default/strict/type behavior, all 13 changed registry rows, and the generator example/YAML/object-array/strict/open-record/golden behaviors to an observed red result. The batch rejected unexpected green or zero-test selections and finished with `UNEXPECTED_GREEN_COUNT: 0`.

The exact SHA/blob binding, inventory, mutation recipe, commands, red summaries, restoration and green results are recorded in [issue-89-round-2-red-proof.md](./issue-89-round-2-red-proof.md). The disposable tree was restored to `b8cd98131bf091fbe17b32adb1fdecae8c49e9bd`; generator/schema/13-row registry/schema-drift checks passed, status and stash were empty, and the temporary script/logs were removed.

Round 2 also observed that the baseline Artifact schema stripped unknown keys while this change rejects them. Independent verification disposed that candidate as non-actionable: tasks 2.1 and the expanded fixture explicitly require direct and nested Artifact unknown-key rejection, canonical support contracts enumerate the accepted fields, no repository caller or registry-produced persisted record relies on unknown metadata, and the supported compatibility invariant is omission of `llm_generated` rather than arbitrary extensions.

## Boundary and hygiene

- No route, workspace write-path implementation, package manifest, dependency lock or submodule source is changed. The only service production delta is the Artifact registry's input/output type alignment; its runtime write/path/publication flow is preserved.
- No TaskCard, error, idempotency or lock schema semantics are intentionally changed.
- No generated file is hand-authored; all generated files come from the checked-in generator.
- Final required CI and exact final head are recorded in PR #129 after the temporary workflows are removed.

## Deviation record

- Implementation-path deviation: `artifact-registry-service.ts` was added to the repair surface because its public return type still represented optional caller input after runtime parsing had begun returning a materialized field. The change is restricted to `ArtifactInput`/`StoredArtifact` type alignment and the invalid-input generic return typing; no I/O、path、publication or duplicate runtime behavior changed.
- Historical execution-path deviation: initial generation and semantic red proof ran in temporary same-repository GitHub Actions workflows because that earlier interactive environment lacked the Bun/OpenSpec toolchain. Those workflows remain excluded from the final tree; the current local worktree subsequently reran the complete Bun/OpenSpec verification successfully.
