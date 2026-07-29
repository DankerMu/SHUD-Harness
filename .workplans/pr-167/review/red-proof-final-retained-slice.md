# Final retained-slice behavior red proof

PR: #167
Issue: #164
Base head before the breadth split: `64f548385c9cf3bd6cd7fff3bf244641827a4d61`

## Approved ownership boundary

The user approved the Round 4 breadth retro ownership split. PR #167 retains
strict bounded source ingress, canonical JSON, the exact synthetic oracle,
four-SHA identity binding, and a pure no-write current committed-oracle checker.
Live Git configuration, index/tracked-set, filesystem generation, and executable
mode authority are routed to #166 and are not implemented by this repair.

The exact depth/item boundary values still reach schema validation; only their
`+1` forms must fail the corresponding limit guard. Therefore an exact-boundary
payload may finish with `CONTRACT_SCHEMA_INVALID`. The byte-boundary payload is
otherwise schema-valid and succeeds.

## Immutable replay binding

Mutation patch:
`.workplans/pr-167/review/retained-slice-behavior-mutation.patch`

Patch blob: `b1b1a27064184319480a8d1ce3e0b32ad97f6cda`

Final source blobs before and after the replay:

| File | Blob |
|---|---|
| `check.ts` | `39cc1b3e3182510751e090cc9e4a704c46f4fa78` |
| `canonical-json.ts` | `031db134b51c68775ba71955ea3a266dcf8b3515` |
| `checker.ts` | `ce9cf309412459bc3a5659871432bd4ab26663c2` |
| `constants.ts` | `5da24a2e4f8c28d2edbbe5cf375d14fb4b0287d1` |
| `current-source.ts` | `3631f0442571b74d4f75abcbec7e2cd9f56ceaef` |
| `ingress.ts` | `5e7d0f41cb488d5163d992f018550943cd26adec` |
| `schemas.ts` | `453c3fdb68c9bb2ef30056323bf803834d00ab3e` |
| `source-frame.ts` | `6ab1e6fcd0656bd218f24cff402670d982ac6124` |

Final test blobs:

| File | Blob |
|---|---|
| `current-source-authority.test.ts` | `1d3505c1caed4d9f20a1dbd6cdb706b7126ccaef` |
| `source-identity.test.ts` | `70f79f170bd0e7cd0e34df937206fcfee6be727a` |
| `source-ingress.test.ts` | `30f3f163034a619b3467c089b09b4fdfebc3f756` |
| `synthetic-oracle.test.ts` | `2b1fa4874fca0cea638a647731562bb73d57f489` |

## Exact replay

```sh
git apply --check .workplans/pr-167/review/retained-slice-behavior-mutation.patch
git apply .workplans/pr-167/review/retained-slice-behavior-mutation.patch
npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests
git apply -R .workplans/pr-167/review/retained-slice-behavior-mutation.patch
npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests
```

The mutation deliberately bypassed retained ingress, manifest, oracle, and
identity checks without changing the tests. The red run exited 1 with 16 pass,
8 fail, and 145 assertions. The exact failing behavior groups were:

1. malformed/trailing/duplicate/deep/wide/unknown/missing-schema source ingress;
2. exact depth/item schema reachability and `+1` limit rejection;
3. CR/LF source paths;
4. missing/duplicate/unsorted/unsafe/non-LF/CRLF manifest forms;
5. external same-content ancestor symlinks;
6. metadata/frame/sidecar mutations;
7. strict-subset SHA forgery;
8. malformed/missing/unknown/reordered identity projection.

All failures were expected receipt mismatches: the mutation returned exact
success where the contract required exit 2 / schema-invalid failure. Reversing
the patch exited 0, restored the recorded `current-source.ts` and `schemas.ts`
blobs, and the unchanged suite returned 24 pass, 0 fail, 179 assertions.
No stash was used. `git diff --check` passed after restoration.
