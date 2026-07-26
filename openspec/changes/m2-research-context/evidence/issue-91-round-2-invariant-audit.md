# Issue #91 Round 2 Phase 6.2 invariant audit

## Audit binding

- Reviewed SHA: `ba4aff099e45bbac483eaf2cdf33cdebe98281e8`
- Base and merge-base: `13d56d90ba0c2909d1eae6f4aa93d8ca4a20c902`
- Scope: `.gitmodules`, StackLock collector and tests, shared hashing service and tests, service barrel, StackLock schema, and the Issue #91 OpenSpec fixture.
- Repository-wide sibling search: production Git subprocess entries, `hashFile` callers, `collectStackLockContext` consumers, and StackLock branch consumers.
- Worktree: tracked files clean before and after the read-only audit; `.workplans/pr-131/` remained the orchestrator-owned untracked review directory.

## Reusable-pattern inventory

| Category | Status | Evidence |
|---|---|---|
| Identity propagation | `clean` | Gitlink commits come from the fixed superproject `HEAD` tree query; branches come from the exact `.gitmodules` declarations; package, provider and renv identities derive from observed source bytes or digests. |
| State transitions | `clean` | Cheap sources and the complete renv source are each observed twice; publication requires two equal complete snapshots. Provider byte-only drift, renv A→B/missing→present/present→missing, and `.gitmodules` byte/branch drift have regression rows. |
| Retry / idempotency | `clean` | The collector has no retries, persistence or mutation. Stable input takes the same fixed two-observation path; missing `renv.lock` is an explicit `null` plus degraded reason. |
| Concurrency / TOCTOU | `clean` | Package, provider and `.gitmodules` use the durable single-link reader. `renv.lock` is bounded and read through its opened regular-file descriptor. The cross-source generation barrier rejects mismatched snapshots. |
| Resource lifetime / cancellation | `clean` | Git has a 10 second timeout and 64 KiB output bound. `renv.lock` has a 16 MiB opened-descriptor bound. File descriptors close on success and failure, and expensive hashing starts only after all cheap producers succeed. |
| Error mapping / non-disclosure | `clean` | Git, repository JSON, `.gitmodules`, renv and schema failures map to stable typed errors without stderr, paths, source content or credentials. |
| Partial success / atomic publication | `clean` | Intermediate values remain local; both snapshots and final schema parsing must succeed before one frozen result is returned. Failure rows retain an undefined result. |
| Authorization / authority boundaries | `clean` | Git arguments are fixed to `HEAD -- SHUD rSHUD AutoSHUD zero`; the child environment is a minimal platform allowlist plus forced safe Git variables; `.gitmodules` must contain exactly the four expected path/branch declarations. |

## Cross-caller checks

The production collector has one Git subprocess wrapper. It uses a minimal child environment, disables system/global Git configuration, lazy fetch, replace objects, optional locks and interactive credential acquisition, and does not inherit credential, SSH, repository-redirect or trace variables. Real regressions prove that a hostile trace sink is not created, a missing promisor tree neither fetches nor grows the pack inventory, and collection does not change repository HEAD or status. Direct Git calls in the test file only construct fixtures and collect before/after oracles.

The only non-test production `hashFile` consumer is the StackLock collector. `HashingServiceInput` retains the shared file/directory fields, `HashFileInput` alone adds optional `maxBytes`, and `hashDirectory` remains on the base input type. Strict typecheck passed and existing unbounded file callers remain compatible; the new limit does not leak into directory hashing.

The version-controlled branch authority is SHUD/rSHUD/AutoSHUD=`master` and zero=`development`. Local remote refs and containment checks agree with those declarations and the pinned commits. The only current production consumer is the collector projection; tasks 4.2 and 4.3 remain unimplemented, so there is no omitted persistence or API consumer.

## Round 2 finding-to-regression mapping

| Verified finding | Repair source | Regression evidence | Status |
|---|---|---|---|
| Child credential forwarding | minimal environment construction in `stack-lock-collector.ts` | default runner receives required safe variables and no secret/SSH/trace sentinels | `closed` |
| Hard-coded branches and zero=`main` | `.gitmodules` declarations and strict parser/projection | byte/branch drift, invalid inventory, declared branches and real zero=`development` | `closed` |
| Lazy fetch and trace writes | forced Git safety variables and non-inherited trace environment | hostile trace sink and local promisor missing-tree tests | `closed` |
| Unbounded renv and expensive sibling work | file-only `maxBytes`, 16 MiB collector limit and cheap-before-hash ordering | exact-bound/bound+1 descriptor tests and hasher-not-called-on-cheap-failure | `closed` |
| Provider/renv generation coverage | complete two-snapshot comparison | provider byte-only and renv A→B/missing→present/present→missing tests | `closed` |

## Findings and residual risk

No P0, P1 or P2 candidate finding was found.

- The injected `gitCommand` remains a trusted internal seam and must not become user/plugin input in tasks 4.2 or 4.3.
- StackLock dirty-state is a pre-existing schema gap, tracked separately by Issue #132, and was not introduced by Issue #91.
- No-lazy-fetch behavior depends on Git honoring `GIT_NO_LAZY_FETCH`; the current local promisor regression proves the repository's supported environment.

## Independent verification

- Focused collector plus hashing: 64 pass, 0 fail, 246 assertions.
- `npx --yes bun@1.2.19 run typecheck`: pass.
- `git diff --check 13d56d90ba0c2909d1eae6f4aa93d8ca4a20c902...ba4aff099e45bbac483eaf2cdf33cdebe98281e8`: pass.
- Audit-end HEAD remained `ba4aff099e45bbac483eaf2cdf33cdebe98281e8`; tracked worktree remained clean.

## Conclusion

`clean`. All five Round 2 `FIX_NOW` findings have source-to-regression mappings, and all eight reusable-pattern categories are closed for this exact SHA.
