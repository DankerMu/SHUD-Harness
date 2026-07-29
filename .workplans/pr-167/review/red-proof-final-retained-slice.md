# Final retained-slice behavior red proof

PR: #167
Issue: #164
Final implementation commit: `6b474b4f78295cab8df59a785913955729943640`
Contracts tree: `db1a3a878b1fcef37e0fc90e08e07637adda7e5d`
Library tree: `8eb2f27d24762d8683798bb573a3e103c763fc7f`
Test tree: `0405242b01a49cf62c097c677e3ff90eee03f982`
Fixture tree: `afdc54361292be70f1489a90be391491b51b80b6`
Golden tree: `d1da1e41530a64a42546ea8c8a2d6b33356cb8d8`

## Approved ownership boundary

The user approved the Round 4 breadth split. PR #167 retains strict bounded
source ingress, canonical JSON, the exact synthetic oracle, four-SHA identity,
and a pure no-write committed-oracle checker. Live Git configuration,
index/tracked-set, filesystem generation, mode, and object-format authority are
routed to #166 and are not implemented here. Aggregate collection budgets stay
in #162; network security is excluded.

Exact depth/item values reach schema validation and may return
`CONTRACT_SCHEMA_INVALID`; their `+1` forms fail the corresponding limit. The
exact byte fixture remains schema-valid and succeeds. The approved node/item
option 1 is unchanged.

## Immutable replay binding

Mutation patch:
`.workplans/pr-167/review/retained-slice-behavior-mutation.patch`

Patch blob: `d434eb4c1823141f81db462a75cf10f888d589f2`

The complete contracts subtree at the implementation commit is bound by the
tree hashes above. Its recursive blob inventory is:

```text
39cc1b3e3182510751e090cc9e4a704c46f4fa78 check.ts
2a4ac4cd2d1b0f8ae965ec021fa492aa7a0353f8 contract-v1.json
84c0f7bee7c25dde25b68b43bd9b967e35e18ebb fixtures/invalid/duplicate-key.json
06d923d625d3a0c18a2482760103a04b954dbd43 fixtures/invalid/malformed.json
6fc07db218519e8858900582e64994fa97539c84 fixtures/invalid/trailing.json
d4d8c64814f05817f8b1d48367b29e3285a640cc fixtures/valid/source-identity-projection-v1.json
27ae6f2ea8e50c2e4098f386bfda995c08842745 fixtures/valid/source-input-record-paired-surrogate.json
56f7916df766b2729e8bb4fdf22db0abe19bcb1c goldens/source-input-v1.synthetic.frame
fce3b8fdfa094805d95598845b5b1e964e5150aa goldens/source-input-v1.synthetic.sha256
031db134b51c68775ba71955ea3a266dcf8b3515 lib/canonical-json.ts
1de3a29713d068e1ace33a42f0f6c60fd152c50b lib/checker.ts
5da24a2e4f8c28d2edbbe5cf375d14fb4b0287d1 lib/constants.ts
8f9a3d8473da7ccbcf3bdb53fc4754c6554d6a57 lib/current-source.ts
b8a713d134f1b30e73e55f0e4084557be9536e14 lib/ingress.ts
453c3fdb68c9bb2ef30056323bf803834d00ab3e lib/schemas.ts
6ab1e6fcd0656bd218f24cff402670d982ac6124 lib/source-frame.ts
65a88e17966e8197c9f0c44a9011cfe87c7fa2ae source-input-v1.paths
9c3f4044aa33bdfe874f47e2ddfc57f175bcfe7c tests/current-source-authority.test.ts
11e11a09cfa3a7fb0a4f32bcf073bb701f3d6719 tests/helpers.ts
70f79f170bd0e7cd0e34df937206fcfee6be727a tests/source-identity.test.ts
c11b23294c805cc4dae82ecae3118cdeaa7be107 tests/source-ingress.test.ts
2b1fa4874fca0cea638a647731562bb73d57f489 tests/synthetic-oracle.test.ts
```

No test, helper, fixture, golden, or source overlay is omitted.

## Exact clean-archive replay

From a clean checkout/archive of the evidence carrier whose contracts subtree
is the recorded implementation tree:

```sh
test "$(git rev-parse HEAD:spikes/git-status-capability/contracts)" = db1a3a878b1fcef37e0fc90e08e07637adda7e5d
test "$(git hash-object .workplans/pr-167/review/retained-slice-behavior-mutation.patch)" = d434eb4c1823141f81db462a75cf10f888d589f2
git apply --check .workplans/pr-167/review/retained-slice-behavior-mutation.patch
git apply .workplans/pr-167/review/retained-slice-behavior-mutation.patch
npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests
git apply -R .workplans/pr-167/review/retained-slice-behavior-mutation.patch
npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests
test "$(git rev-parse HEAD:spikes/git-status-capability/contracts)" = db1a3a878b1fcef37e0fc90e08e07637adda7e5d
git diff --exit-code -- spikes/git-status-capability/contracts
git diff --check
```

The mutation disables the retained schema, manifest, oracle, `O_NOFOLLOW`, and
descriptor-path stability checks without changing tests, helpers, fixtures, or
goldens. The red run exited 1 with 14 pass, 14 fail, and 138 assertions. Exact
failing behavior groups were:

1. malformed/trailing/duplicate/deep/wide/unknown/missing-schema ingress;
2. exact depth/item schema reachability;
3. CR/LF source paths;
4. both input kinds through a symlinked parent;
5. both input kinds after parent replacement;
6. invalid manifest forms;
7. missing/symlink/nonregular retained files;
8. external same-content declared-file ancestor symlinks;
9. repository-root upper symlink alias;
10. repository-root ancestor replacement for every retained file;
11. metadata/frame/sidecar mutations;
12. final-file symlink/foreign replacement after admission;
13. strict-subset four-SHA forgery;
14. malformed/missing/unknown/reordered identity projection.

All mismatches were the intended red signal: the mutated source emitted success
where the contract required rejection. Reversing the patch exited 0 and the
unchanged green suite returned 28 pass, 0 fail, 203 assertions. The contracts
tree hash returned exactly to the recorded value; no stash was used and
`git diff --check` passed.
