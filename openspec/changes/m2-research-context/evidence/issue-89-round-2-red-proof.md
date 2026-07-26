# Issue #89 — Round 2 batched red proof

## Exact binding

- Base: `cfb8ba33077daab151d2e144032eb15f708c1683` (`origin/main`)
- Test/source HEAD: `b8cd98131bf091fbe17b32adb1fdecae8c49e9bd`
- Bun: `1.2.19`
- Disposable worktree: `/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness-issue-89-red-proof`

| Boundary | HEAD blob |
|---|---|
| `packages/core/src/domain/schemas/core-schemas.test.ts` | `4619e2710f897399fe6cfe0e3f0f271d2375548e` |
| `packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts` | `1277d504d584e0822895ab3cce596b8029bebd00` |
| `packages/core/src/domain/schemas/artifact.ts` | `469b6a4558072aa43a067ec9a083f836bd8d1b59` |
| `packages/core/src/domain/schemas/artifact-manifest.ts` | `b8893df1dd7b03e30784845b79713d9d3cb41777` |
| `packages/core/src/domain/schemas/data-provenance.ts` | `4e6444db1646420e30889fd9e47315a96c4e2ed5` |
| `packages/core/src/domain/schemas/stack-lock.ts` | `5a5243fdd30d94d953a841c2c98178dbaa9b2a92` |
| `packages/core/src/domain/schemas/index.ts` | `39e26d3b2540e281818b4fe9bfff83639d11bbc8` |
| `packages/core/src/domain/services/artifact-registry-service.ts` | `3639489c70fb06172902fbc3f23abc40dab39c16` |
| `scripts/schema/generate.ts` | `7cb23ce833e3e9be137e15ca102eac12d063866e` |

Tests remained at the bound HEAD throughout every red configuration. The batch rejected any configuration whose command exited zero or selected zero tests.

## Test inventory and red configuration mapping

| Test behavior group | Red configuration |
|---|---|
| Artifact omitted marker/default, explicit true/false, input/output types, wrong type and unknown-key strictness | `artifact_schema_runtime_and_types` |
| StackLock canonical four-repository/null-lock input, required fields, legacy string/deprecated/unknown rejection and UUID id | `new_stack_lock_module` |
| DataProvenance object window/hashes, required basin/source fields, strict nesting and UUID id | `new_data_provenance_module` |
| ArtifactManifest nested marker states, optional-reference omission, full Artifact/generator requirements, strict fields and UUID references | `new_artifact_manifest_module`; generator array-field row also covers nested documentation |
| Artifact registry normalization, public types, legacy omitted default/read/no rewrite/duplicate convergence, persistence, explicit states and invalid/divergent inputs | `artifact_registry_runtime_and_types` |
| Generator schema-valid examples and UUID overrides | `generator_example_overrides` |
| Generator YAML round-trip and empty record rendering | `generator_yaml_roundtrip_and_empty_records` |
| Generator object-array field expansion | `generator_object_array_fields` |
| Recursive strict closure | `generator_strict_closure` |
| Exact intentional open-record exception | `generator_open_record_exception` |
| Markdown/golden `default` and `pattern` constraints | `generator_default_and_pattern_golden` |

The registry group selected all 13 changed Artifact service rows: legacy 0644, base-writer umask, concurrent duplicate publication, case-alias publication, durable sibling read, path normalization, public input/output types, trailing-space identity, legacy omitted default/no rewrite/duplicate convergence, register/get persistence, explicit true/false, invalid input with no partial manifest, and divergent duplicate preservation.

## Reproducible red configurations

The one batch consisted of 11 red test groups over 10 source configurations; the Artifact schema and registry groups intentionally shared one mutation. Every distinct configuration was restored to HEAD before the next mutation.

New modules were removed individually with:

```sh
git restore --source=origin/main --worktree -- packages/core/src/domain/schemas/artifact-manifest.ts
git restore --source=origin/main --worktree -- packages/core/src/domain/schemas/data-provenance.ts
git restore --source=origin/main --worktree -- packages/core/src/domain/schemas/stack-lock.ts
```

After each individual removal, the retained schema suite was run:

```sh
npx --yes bun@1.2.19 test ./packages/core/src/domain/schemas/core-schemas.test.ts
```

Each command exited 1 with the expected `Cannot find module` collection error and `0 pass / 1 fail`. Each collection failure is counted only for its genuinely new module, never for Artifact, registry, or generator behavior.

The existing Artifact production behavior was restored to its pre-change semantics while retaining HEAD type aliases: `z.strictObject` was changed to `z.object`, and the `llm_generated: z.boolean().default(false)` field was removed. The following retained schema/type rows then ran as one filter:

```sh
npx --yes bun@1.2.19 test ./packages/core/src/domain/schemas/core-schemas.test.ts \
  -t '(Artifact defaults llm_generated to false and preserves an explicit true marker|public schema barrel preserves Artifact and ArtifactManifest input/output requiredness|Artifact remains strict and rejects missing, non-boolean, and unknown fields)'
```

Result: exit 1, `0 pass / 3 fail`; all three selected rows executed.

With that same Artifact mutation still present, the complete changed registry/type group ran:

```sh
npx --yes bun@1.2.19 test ./packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts \
  -t '(legacy ordinary 0644 records normalize through their descriptor before deletion|base-writer umask generations remain safely deletable across every ordinary consumer|Artifact duplicate registration converges across the owned publication window|physical authority identity converges across filesystem case aliases and isolates workspaces|shared durable record reads reject hardlinked records and preserve regular siblings|Artifact registry normalizes artifact paths in stored manifests|Artifact registry public contract accepts optional input and returns stored output|Artifact registry preserves trailing-space artifact path identity|Artifact registry materializes legacy omitted defaults without eager rewrite and duplicate registration converges|Artifact registry register/get persists metadata under manifests only|Artifact registry preserves explicit true and false LLM markers|Artifact registry rejects invalid metadata, id, and path without manifest files|Artifact registry rejects divergent duplicate manifests and preserves the first)'
```

Result: exit 1, `0 pass / 13 fail`; all 13 selected rows executed, including the case-alias row.

The generator semantic protections were removed one configuration at a time:

1. Delete the early `exampleOverrides` path return in `buildExample`.
2. Delete the `[]`, `{}` and `- {}` empty-value branches in `yamlLines`.
3. Replace `nestedObjectSchema` array descent with direct-object-only traversal.
4. Return immediately at the beginning of `assertStrictInputClosed`.
5. Force `isIntentionalOpenRecordBoundary` to return false.
6. Delete the `pattern` and `default` branches from `constraintLabel`.

Configurations 1–5 each ran:

```sh
npx --yes bun@1.2.19 run test:schema-generation
```

All exited 1 for their intended assertions: invalid schema-specific examples; invalid/null empty-record YAML; missing `sources.observations[].station` and `artifacts[].llm_generated`; accepted loose root/nested schemas; and rejected `DataProvenance.preprocess.params`, respectively.

Configuration 6 ran:

```sh
npx --yes bun@1.2.19 run schema:check
```

It exited 1 with tracked golden drift in `artifact.md`, `artifact-manifest.md`, `data-provenance.md`, and `stack-lock.md` after the self-test passed.

Overall batch result: exit 0 with `UNEXPECTED_GREEN_COUNT: 0`. No failure came from dependency setup, timeout, a zero-test filter, or unrelated infrastructure.

## Restoration and green proof

After each source configuration, the batch restored these surfaces from exact HEAD:

```sh
git restore --source=HEAD --worktree -- \
  packages/core/src/domain/schemas/artifact-manifest.ts \
  packages/core/src/domain/schemas/data-provenance.ts \
  packages/core/src/domain/schemas/stack-lock.ts \
  packages/core/src/domain/schemas/artifact.ts \
  scripts/schema/generate.ts \
  docs/generated/schema \
  docs/generated/json-schema
```

The temporary batch script and logs were removed. At exact HEAD, the following passed:

- `npx --yes bun@1.2.19 run test:schema-generation`: exit 0.
- `npx --yes bun@1.2.19 run test:schemas`: exit 0, `21 pass / 0 fail`, 155 assertions.
- The exact 13-row registry filter above: exit 0, `13 pass / 0 fail`, 209 assertions.
- `npx --yes bun@1.2.19 run schema:check`: exit 0 with regeneration and drift check clean.
- `git diff --check`: exit 0.
- `git status --short --untracked-files=all`: empty.
- `git stash list`: empty; no `red-proof` stash.
- `git submodule status zero`: exact pin `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Only ignored `node_modules/` remained in the disposable worktree before its cleanup. Deviation record: none.
