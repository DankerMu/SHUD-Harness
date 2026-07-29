# Round 3 invariant-closure batched red proof

PR: #167
Issue: #164
Pre-repair source baseline: `a04f5c379a290ade2fe43a408e613bd95fc88088`

## Source-only replay binding

The new regression tests remained in the worktree while only these three source
files were replaced with their blobs from the pre-repair baseline:

| Source file | Baseline blob | Restored fixed working blob |
|---|---|---|
| `spikes/git-status-capability/contracts/lib/current-source.ts` | `7ca7bbf373dbfcb6dda60d09700a8d347d8091b1` | `2e9bd81b965996e636d128f5227a8937ca2c1d2b` |
| `spikes/git-status-capability/contracts/lib/schemas.ts` | `e54feac4d50aaa0a1639d94f225c071cf1e26e66` | `453c3fdb68c9bb2ef30056323bf803834d00ab3e` |
| `spikes/git-status-capability/contracts/lib/source-frame.ts` | `07b2e95b26d6b0801cbfdc86399e65ba54b80009` | `6ab1e6fcd0656bd218f24cff402670d982ac6124` |

Exact batched command:

```sh
bun test ./spikes/git-status-capability/contracts/tests/current-source-authority.test.ts ./spikes/git-status-capability/contracts/tests/source-ingress.test.ts ./spikes/git-status-capability/contracts/tests/synthetic-oracle.test.ts
```

Expected new failure classes:

- repository-extension policy;
- quoted `objectFormat` trailing whitespace;
- global noncandidate index-mode validation;
- descriptor-bound pathname replacement;
- source-record CR/LF path grammar;
- source-frame CR/LF path grammar.

Observed red result:

```text
6 tests failed:
(fail) current source authority > the Git-compatible noop repository extension is strict across normal and linked SHA-1 and SHA-256 repositories
(fail) current source authority > quoted objectFormat trailing whitespace is preserved and fails closed across repository layouts and object formats
(fail) current source authority > every index entry mode is validated before governed candidate filtering across versions, layouts, and hashes
(fail) current source authority > worktree verification binds admission and content hashing to one no-follow descriptor
(fail) strict source ingress > source input records reject CR and LF path identities
(fail) exact source_input_digest_v1 synthetic oracle > encoder rejects unsafe, duplicate, and unsupported entries

41 pass
6 fail
630 expect() calls
Ran 47 tests across 3 files. [30.95s]
RED_EXIT=1
```

This proves all six new requirement groups bite against the source-only
pre-repair baseline. The first red attempt also exposed and corrected a test
fixture assertion that had mistaken ordinary staged `git status` output for a
required empty result; the final test asserts Git command success instead and
retains explicit SHA-1 `objectFormat` coverage.

## Restoration and green replay

The fixed source blobs above were restored without changing the new tests.
Restoration reported `POP_EXIT=0`, and no stash matching `red-proof` remained.
The exact same command then produced:

```text
47 pass
0 fail
738 expect() calls
Ran 47 tests across 3 files. [15.40s]
exit=0
```

The complete contract suite then produced:

```text
bun test ./spikes/git-status-capability/contracts/tests
50 pass
0 fail
762 expect() calls
Ran 50 tests across 4 files. [15.33s]
exit=0
```

Final replay hygiene: fixed working blob hashes match the table, no red-proof
stash remains, and `git diff --check` exits `0`.
