# Issue #91 — Round 1 Phase 6.2 invariant audit

- Audited product/evidence head: `9ae95d9792344f5f4396a176a8eeabb87dfab171`
- Base: `origin/main@13d56d90ba0c2909d1eae6f4aa93d8ca4a20c902`
- Trigger: Round 1 verified reusable `concurrency` and Git repository-authority patterns
- Overall: `clean`
- Audited failure classes: `concurrency`, `wrapper`, `contract`, `altitude`, `test-evidence`

The governing invariant is that every successful result comes from two matching, complete, bounded, read-only source observations. Git authority remains bound to `repositoryRoot`; every producer or validator failure crosses one stable non-disclosing typed boundary and returns no partial result.

## Eight invariant surfaces

| Category | Status | Inspected surfaces and unchanged siblings |
|---|---|---|
| Shared helper roots | `clean` | `hashFile`, `resolveWorkspacePath`, `isSafeExistingDirectoryPath`, `readDurableSingleLinkFile`, and `StackLockSchema` are consumed without modification. Their no-follow, bounded-read, parent/leaf replacement, FIFO/socket, and identity-drift regressions remain green. The provider authority uses the same `default_model -> provider/model` selector semantics. |
| Public entrypoints | `clean` | The service barrel exposes the collector, typed error, and authorized Git command seam. `runtimeVersions` is absent from the options/types/barrel. The lower process test seam is not exported through the barrel or package export map. Existing backend/frontend core consumers typecheck. |
| Read surfaces | `clean` | Git uses fixed `ls-tree -z --full-tree HEAD` arguments for exactly four paths under a sanitized child environment. Package/provider JSON use the bounded durable single-link reader; optional `renv.lock` uses `hashFile`. Size, path, type, link count, raw source digest, and projection are all validated before return. |
| Write/delete/overwrite | `clean` | The runtime collector performs no write, delete, overwrite, checkout, fetch, config, or status mutation. The root manifest's canonical `0.8.3` version is the only declared metadata change; lockfile, subpackage manifests, and submodule pins do not drift. The real-repository test compares complete tracked and untracked status. |
| Staging/publish/rollback | `clean` | There is no storage transaction in this service. The only publication is the frozen in-memory result after matching source snapshots and schema validation. Every failure returns no result; task 4.2 remains the future record-store publication boundary. |
| Producer/consumer evidence | `clean` | Producers are the Git tree, package/provider bytes, optional lock bytes, internal runtime placeholders, and fixed digest inputs. `sourceDigest` is used only for revalidation and cannot disclose config/API-key bytes. Current consumption stops at the frozen schema projection; 4.2/4.3 remain unimplemented. |
| Stale state/idempotency | `clean` | `collectSnapshot` re-reads all four source classes and compares gitlinks, package raw digest/version, provider raw digest/projection, and renv digest/degradation. Any mismatch yields `collection_state_changed`; stable inputs are deterministic and no cache/shared mutable state exists. |
| Unchanged downstream consumers | `clean` | StackLock schema, path/hashing/durable helpers, record store, routes, frontend/backend, provider tooling, DependencyLock, lockfile, and all four submodules remain compatible. No 4.2/4.3 wiring is introduced. |

## Round 1 finding-to-regression mapping

| Finding | Closure proof |
|---|---|
| `cand-01` concurrency | Git revision drift and package byte-only drift between the two full observations both yield `collection_state_changed` and no result. |
| `cand-02` default runner bounds | The lower process seam proves `timeout=10000`, `maxBuffer=64 KiB`, and callback failure -> non-disclosing `git_read_failed`. |
| `cand-03` untracked guard | The real repository guard uses complete `git status --porcelain=v1` before and after collection. |
| `cand-04` validator matrix | Wrong-mode, missing, and duplicate gitlinks plus provider selector/provider/model/syntax and target/nested id drift are covered. |
| `cand-05` malformed injected result | Null results and throwing `stdout` getters yield stable `git_output_invalid`. |
| `cand-06` provider selector | `default_model` is parsed and bound to `default_provider`, the selected model entry, and `target_model_id`; all drift rows reject. |
| `cand-07` harness version | The root manifest supplies `0.8.3`; missing, blank, and non-string fixture versions yield `package_json_invalid`; the live repository projection equals the manifest. |
| `cand-08` producer altitude | Runtime identity has no caller override; the public contract contains only `repositoryRoot` and the authorized Git seam. |
| `cand-09` Git wrapper authority | Repository/object/ref/config redirect variables are removed, read-only/non-interactive flags are set, and a real collection under hostile `GIT_DIR`/`GIT_WORK_TREE` still reads the requested repository. |

## Verification

- Focused collector: 28 pass, 0 fail, 99 assertions.
- Core services: 542 pass, 5 platform skips, 0 fail.
- Typecheck, schema drift, DependencyLock, strict OpenSpec, diff/lock/package/submodule/workspace hygiene: pass.
- Orchestrator additionally ran the complete `bun run check` and PERF-API-001 successfully before this audit was persisted.

No remaining P0/P1/P2 finding or analogous unsafe sibling was identified.
