# Issue #89 — Round 2 Phase 6.2 invariant audit

Invariant audit: clean

## Exact binding and scope

- Base: `cfb8ba33077daab151d2e144032eb15f708c1683` (`origin/main`).
- Runtime/test HEAD: `b8cd98131bf091fbe17b32adb1fdecae8c49e9bd`.
- Evidence-fix HEAD context: `fadb8db680bc1229b718204f420a9963156fc2f6`.
- The prior batched proof is [issue-89-round-2-red-proof.md](./issue-89-round-2-red-proof.md), blob `58e5b32a72a49e054a4c93b1a3ce48d56e20d865` at the evidence-fix HEAD. Its exact runtime/test/source blob table is the binding for the prior red and green results; in particular, `scripts/schema/generate.ts` is blob `7cb23ce833e3e9be137e15ca102eac12d063866e`.
- Audited delta: `cfb8ba33077daab151d2e144032eb15f708c1683..b8cd98131bf091fbe17b32adb1fdecae8c49e9bd`. Evidence-only commits after the runtime/test HEAD do not alter the audited production or test surfaces.
- Scope is task 2.1: the four public schemas, Artifact registry compatibility, schema generation, generated schema documentation, and their tests. Group ArtifactManifest persistence under `workspace/artifacts/manifest-sets/` remains deferred to task 6.2 in `tasks.md` and is not treated as an implemented entrypoint here.

## Eight-category inventory

| Inventory category | Status | Exact inspected files, functions, and sibling surfaces | Result |
|---|---|---|---|
| Shared helper roots | clean | `packages/core/src/domain/schemas/{artifact,artifact-manifest,data-provenance,stack-lock,index}.ts`; `packages/core/src/domain/services/workspace-record-store.ts` functions `assertSafeRecordSegment`, `assertSafeRelativeRecordPath`, `workspaceRecordPath`, `readJsonRecord`, `createJsonRecordIfAbsent`, and `writeJsonRecord`; `packages/core/src/domain/services/workspace-path-safety.ts` function `resolveWorkspacePath`; `scripts/schema/generate.ts` registry and `buildJsonSchema`, `flattenFields`, `constraintLabel`, `buildExample`, `yamlLines`, `assertStrictInputClosed`. Sibling schema roots `task.ts`, `error.ts`, `idempotency.ts`, and `lock.ts` were checked through registry discovery and parity self-tests. | The only shared runtime-schema change is Artifact input/output typing plus default materialization. Shared record-store/path-safety implementations are unchanged. Generator registry discovery covers every exported top-level object schema, with only the two declared nested helpers ignored. |
| Public entrypoints | clean | `packages/core/src/domain/schemas/index.ts` exports; `ArtifactSchema`, `ArtifactManifestSchema`, `DataProvenanceSchema`, `StackLockSchema`; `ArtifactInput`, `StoredArtifact`, `ArtifactManifestInput`, `StoredArtifactManifest`; `packages/core/src/domain/services/artifact-registry-service.ts` interface `ArtifactRegistryService` and factory `createArtifactRegistryService`; package scripts `test:schemas`, `test:schema-generation`, and `schema:check` via `package.json` and `scripts/schema/check.sh`. | Public input types preserve omission where defaults apply; stored output types require the materialized boolean. No hidden production entrypoint for the three new M2 schema modules exists yet, consistent with the deferred storage tasks. |
| Read surfaces | clean | `ArtifactRegistryService.getArtifact` -> private `readArtifactManifest` -> `workspaceRecordPath`/`readJsonRecord(..., ArtifactSchema)` -> `assertArtifactLookupIdentity`; generator `discoverObjectSchemaExports`, `buildJsonSchema`, and `buildMarkdown`; generated JSON/Markdown for Artifact, ArtifactManifest, DataProvenance, and StackLock. | Legacy Artifact JSON with omitted `llm_generated` parses to `false` in memory without eager byte rewrite. Malformed records and lookup-identity mismatches retain their existing errors. The generator reads the same schema objects it documents. |
| Write/delete/overwrite surfaces | clean | `ArtifactRegistryService.registerArtifact`, `normalizeArtifactPath`, `createJsonRecordIfAbsent`, invalid-input `writeJsonRecord` schema gate, `artifactManifestDirectorySegments`, `artifactManifestFileName`, and `artifactManifestEvidenceRef`; generator `recreateGeneratedDirectory`, `writeGeneratedFile`, `assertGeneratedPathSafe`, and `assertExistingPathSegmentsNotSymlinks`. | Artifact records remain create-if-absent and immutable on divergence; invalid metadata/id/path leaves no manifest. There is no Artifact registry delete or overwrite entrypoint. Generated-directory removal/writes remain confined under `docs/generated` and reject unsafe/symlinked paths. |
| Staging/publish/rollback | clean | Unchanged `workspace-record-store.ts` chain `createJsonRecordIfAbsentInternal`, `writeJsonRecordWithDirectoryBindingOperation`, `writePreparedJsonRecordWithDirectoryBindingOperation`, `attemptPreparedJsonRecordWriteWithDirectoryBindingOperation`, and `publishOwnedMutableRecord`, including temporary-generation cleanup/compensation and the rename commit point. Sibling concurrency/case-alias/hardlink/base-writer tests in `idempotency-lock-artifact-services.test.ts` were included in the regression set. | The PR changes no staging, authority, rename-publication, cleanup, or rollback code. Artifact normalization/default materialization occurs before the existing publication chain, and the bound tests retain convergence and failure-preservation guarantees. |
| Producer/consumer evidence boundaries | clean | Producers: M1 Artifact callers and legacy JSON, schema fixtures in `core-schemas.test.ts`, registry fixtures in `idempotency-lock-artifact-services.test.ts`, and `schemaDefinitions`/`exampleOverrides` in `generate.ts`. Consumers: `ArtifactSchema` parsing at registry write/read, `ArtifactManifestSchema` nested Artifact parsing, JSON Schema/Markdown generation, and the checked-in `docs/generated/{json-schema,schema}` goldens. Canonical scope statements in `design.md` and `tasks.md` were cross-checked. | Every changed producer is parsed at its public seam before evidence is persisted or rendered. New StackLock, DataProvenance, and group ArtifactManifest storage consumers are explicitly deferred; their current consumers are schema tests and the generator only. |
| Stale-state/idempotency | clean | `artifactsMatchForDuplicate`, `canonicalJson`, `readArtifactManifest`, create-if-absent publication, legacy omitted-default/no-rewrite tests, concurrent duplicate test, trailing-space identity test, divergent-duplicate test, and generator recreate/regenerate/drift sequence in `scripts/schema/check.sh`. | Omitted legacy state converges with canonical `false`; repeats return the existing record, divergent duplicates preserve the first record, and normalized paths converge without collapsing trailing-space identity. Repeated generation returns the tracked goldens with no drift. |
| Unchanged downstream consumers | clean | Repository-wide searches for `ArtifactRegistryService`, `createArtifactRegistryService`, `registerArtifact`, `getArtifact`, `ArtifactManifestSchema`, `DataProvenanceSchema`, `StackLockSchema`, `ArtifactInput`, and `StoredArtifact`; unchanged TaskCard/ErrorRecord/IdempotencyRecord/LockRecord schema tests and generated outputs; sibling services `task-card-service.ts`, `idempotency-service.ts`, `lock-service.ts`, `workspace-record-store.ts`, and `workspace-path-safety.ts`. | No non-test production caller exists outside `artifact-registry-service.ts`, and no runtime consumer yet imports the three new M2 schemas. The unchanged TaskCard, ErrorRecord, IdempotencyRecord, and LockRecord schemas retain their prior non-strict input semantics and generated artifacts. No downstream code requires unknown Artifact metadata. |

No category produced a finding. No remaining unsafe pattern was found in the audited scope.

## Regression matrix — 16 changed schema behavior rows

All 16 rows below are the test declarations added or replaced between the bound base and runtime/test HEAD in `packages/core/src/domain/schemas/core-schemas.test.ts`. The red configuration names refer to the reproducible recipes in the prior batched proof.

| # | Changed schema behavior row | Red configuration |
|---:|---|---|
| 1 | `Artifact defaults llm_generated to false and preserves an explicit true marker` | `artifact_schema_runtime_and_types` |
| 2 | `public schema barrel preserves Artifact and ArtifactManifest input/output requiredness` | `artifact_schema_runtime_and_types` |
| 3 | `Artifact remains strict and rejects missing, non-boolean, and unknown fields` | `artifact_schema_runtime_and_types` |
| 4 | `StackLock accepts the four-repository shape and nullable R package lock` | `new_stack_lock_module` |
| 5 | `StackLock requires llm.base_url and every canonical repository` | `new_stack_lock_module` |
| 6 | `StackLock rejects the legacy runtime.r_packages_lock string` | `new_stack_lock_module` |
| 7 | `StackLock rejects deprecated or unknown fields at every strict boundary` | `new_stack_lock_module` |
| 8 | `StackLock rejects ids outside STACK-<uuid>` | `new_stack_lock_module` |
| 9 | `DataProvenance accepts the canonical object window and hashed sources` | `new_data_provenance_module` |
| 10 | `DataProvenance rejects the deprecated event window array and missing basin` | `new_data_provenance_module` |
| 11 | `DataProvenance rejects unhashed sources and incomplete observations` | `new_data_provenance_module` |
| 12 | `DataProvenance enforces DATA-<uuid> and strict nested records` | `new_data_provenance_module` |
| 13 | `ArtifactManifest preserves omitted, true, and false Artifact LLM markers` | `new_artifact_manifest_module` |
| 14 | `ArtifactManifest accepts omission of every optional reference and hash field` | `new_artifact_manifest_module` |
| 15 | `ArtifactManifest requires generator and full Artifact entries` | `new_artifact_manifest_module` |
| 16 | `ArtifactManifest enforces MANIFEST-<uuid> references and strict fields` | `new_artifact_manifest_module` |

The collection errors in the batched proof apply only to the three genuinely new schema modules: `stack-lock.ts`, `data-provenance.ts`, and `artifact-manifest.ts`. They are not used as evidence for Artifact behavior, registry behavior, or generator behavior. Artifact's three rows ran against a retained and collected suite and each failed its weakened production contract.

## Regression matrix — 13 changed registry rows

The retained filter selected and executed all 13 affected rows in `packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts` against the weakened Artifact contract; it exited 1 with `0 pass / 13 fail`. The exact rows were:

1. `legacy ordinary 0644 records normalize through their descriptor before deletion`
2. `base-writer umask generations remain safely deletable across every ordinary consumer`
3. `Artifact duplicate registration converges across the owned publication window`
4. `physical authority identity converges across filesystem case aliases and isolates workspaces`
5. `shared durable record reads reject hardlinked records and preserve regular siblings`
6. `Artifact registry normalizes artifact paths in stored manifests`
7. `Artifact registry public contract accepts optional input and returns stored output`
8. `Artifact registry preserves trailing-space artifact path identity`
9. `Artifact registry materializes legacy omitted defaults without eager rewrite and duplicate registration converges`
10. `Artifact registry register/get persists metadata under manifests only`
11. `Artifact registry preserves explicit true and false LLM markers`
12. `Artifact registry rejects invalid metadata, id, and path without manifest files`
13. `Artifact registry rejects divergent duplicate manifests and preserves the first`

This set spans shared deletion/read authority siblings as well as Artifact publication, public typing, normalization, legacy-state convergence, explicit marker persistence, invalid-input atomicity, and immutable duplicate behavior.

## Generator semantic matrix

| Contract | Exact inspected implementation/assertion | Red proof |
|---|---|---|
| Schema-valid UUID examples | `schemaDefinitions[].exampleOverrides` and `buildExample` for `STACK-<uuid>`, `DATA-<uuid>`, and `MANIFEST-<uuid>`/`superseded_by` | Removing the override return made `test:schema-generation` exit 1 for invalid schema-specific examples. |
| YAML round-trip and empty records | `yamlLines`, `parseGeneratedYaml*`, per-definition round-trip/schema parse, `DataProvenance.preprocess.params: {}`; `[]`, `{}`, and `- {}` branches | Removing the empty-value branches made `test:schema-generation` exit 1 for invalid/null empty-record YAML. |
| Object-array expansion | `nestedObjectSchema` plus `flattenFields`; assertions for `sources.observations[].station` and `artifacts[].llm_generated` | Removing array descent made `test:schema-generation` exit 1 for both missing paths. |
| Recursive strict closure | `assertStrictInputClosed` recursion across objects, arrays, `anyOf`, `oneOf`, and `allOf`; synthetic loose root and nested objects | Returning before traversal made `test:schema-generation` exit 1 because loose root/nested objects were accepted. |
| Exact open-record exception | `intentionalOpenRecordBoundary` and `isIntentionalOpenRecordBoundary`, bound by definition name, export name, schema object identity, exact path `DataProvenance.preprocess.params`, no fixed properties, and schema-valued `additionalProperties` | Forcing the predicate false made `test:schema-generation` exit 1 by rejecting the sole intentional record. No other strict object is open. |
| Exact `pattern` + `default` goldens | `constraintLabel`; generated Markdown constraints for UUID patterns and `llm_generated` default | Deleting both branches made `schema:check` exit 1 with exactly the four expected tracked Markdown files. See the fresh replay below. |

## Fresh replay of red configuration 6

At evidence-fix HEAD context, `apply_patch` temporarily removed only these two branches from `constraintLabel` in `scripts/schema/generate.ts`: the `schemaWithoutNull.pattern` branch and the own-property `default` branch. Then:

```text
$ npx --yes bun@1.2.19 run schema:check
$ sh scripts/schema/check.sh
$ bun scripts/schema/generate.ts --self-test
schema generator self-test passed
$ bun scripts/schema/generate.ts
generated schema outputs contain tracked drift:
M	docs/generated/schema/artifact-manifest.md
M	docs/generated/schema/artifact.md
M	docs/generated/schema/data-provenance.md
M	docs/generated/schema/stack-lock.md
error: script "schema:check" exited with code 1
```

Observed exit: 1. The tracked drift set was exactly `artifact.md`, `artifact-manifest.md`, `data-provenance.md`, and `stack-lock.md`; there was no JSON Schema drift and no unrelated Markdown drift.

The reverse `apply_patch` restored the two `constraintLabel` branches. The same command then produced:

```text
$ npx --yes bun@1.2.19 run schema:check
$ sh scripts/schema/check.sh
$ bun scripts/schema/generate.ts --self-test
schema generator self-test passed
$ bun scripts/schema/generate.ts
```

Observed exit: 0. Regeneration restored all temporary generated drift. `git hash-object scripts/schema/generate.ts` returned the bound HEAD blob `7cb23ce833e3e9be137e15ca102eac12d063866e`.

## Prior green evidence and conclusion

The prior SHA/blob-bound green proof recorded:

- `test:schema-generation`: exit 0.
- `test:schemas`: exit 0, `21 pass / 0 fail`, 155 assertions.
- Exact 13-row registry filter: exit 0, `13 pass / 0 fail`, 209 assertions.
- `schema:check`: exit 0 with regeneration and tracked drift clean.
- `git diff --check`: exit 0; worktree and stash clean in the disposable proof tree; `zero` pinned at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Together with the fresh configuration-6 replay, the matrices cover every changed schema row, every changed registry row, and every generator contract requested for UUID examples, YAML empty records, object arrays, recursive strict closure, the exact open-record exception, and `default`/`pattern` goldens. No remaining unsafe pattern was found. Deviation record: none.
