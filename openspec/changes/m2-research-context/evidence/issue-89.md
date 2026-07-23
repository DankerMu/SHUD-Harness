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
- Confirmed the final diff does not alter TaskCard, ErrorRecord, IdempotencyRecord, LockRecord, service logic, route logic, package manifests or dependency locks.

## Boundary and hygiene

- No service, route, workspace write path, package manifest, dependency lock or submodule source is changed.
- No TaskCard, error, idempotency or lock schema semantics are intentionally changed.
- No generated file is hand-authored; all generated files come from the checked-in generator.
- Final required CI and exact final head are recorded in PR #129 after the temporary workflows are removed.

## Deviation record

No product, schema or PR-boundary deviation. Execution-path deviation only: the interactive environment lacked the repository Bun/OpenSpec toolchain, so source-bound generation, semantic red proof and strict OpenSpec validation ran in temporary same-repository GitHub Actions workflows; those workflows are excluded from the final tree.
