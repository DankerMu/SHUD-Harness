# Phase 6 implementation — Round 1

PR: #167
Committed Phase 6 head: `618bc86f1708513d3bf2666537fde0359019c800`

## Implemented closure

- `DI-01`: the public current-source checker now inventories every governed lane before reading candidate content: the spike tree, exact workflow, mandatory OpenSpec core files, and recursive `specs/**/spec.md` files. Missing mandatory files, untracked candidates, symlinks, non-regular candidates, and symlinked governed ancestors are rejected. Unrelated paths and OpenSpec evidence remain excluded.
- `TE-02`: every named synthetic frame/sidecar mutation now traverses the public `--check-current` seam, including synchronized truncation and same-length mutation cases, with exact failure receipts, no child launch, and repository status/no-write checks.
- `TE-01` and `CT-02`: user-approved node/item option 1 is now explicit in the OpenSpec fixture. Public evidence proves real-profile byte, depth, and item exact/+1 behavior; isolated parser evidence proves source and metadata node exact/+1 with only the dominated item ceiling relaxed. No parser counting rule or profile ceiling changed.

Files changed:

- `spikes/git-status-capability/contracts/lib/current-source.ts`
- `spikes/git-status-capability/contracts/tests/current-source-authority.test.ts`
- `spikes/git-status-capability/contracts/tests/source-ingress.test.ts`

## Verification

- Candidate-set regression loop: red before the fix; green after the fix.
- Governed symlink-ancestor regression: red before the follow-up fix; green after the fix.
- Focused contract suite: 27 pass, 0 fail, 366 assertions.
- Strict OpenSpec validation: valid.
- Full repository check: exit 0.
- Three public input/current-source commands: exact success receipts.
- `git diff --check`: clean.
- Git stash: empty.

## Frozen-contract decision applied

The user approved option 1. Under the frozen parser definition every non-root JSON value is both one node and one object member or array element, so every complete document has `nodes = items + 1`. The frozen source and metadata profiles (`2,048/512` and `32,768/8,192`) therefore hit their item ceilings before their node ceilings.

The node ceiling remains an unchanged defense-in-depth parser guard. The fixture now makes no false public real-profile node-boundary claim: public tests cover byte/depth/item exact/+1 behavior, and isolated parser tests retain node exact/+1 coverage with only the dominated item ceiling relaxed. This is a clarification of executable evidence, not a runtime, profile, or counting-rule change.

Next: Phase 6.2 invariant audit, then comprehensive Round 2 on this committed head.

## Round 2 follow-up repair

Round 2 independently confirmed that `readIndex` rejected legal Git index v4
prefix-compressed entries. Commit `3a61a5449aae4620189d18112d5c2e9f066b1ec3`
adds bounded v4 decoding and normal/linked public seam regression coverage. The
implementer proved both new tests red against the prior source and green after the
repair; the full contract suite is 29 pass, 0 fail, 378 assertions. A new Phase 6.2
audit is required because `readIndex` is a shared source-authority parser.

The v4 parser audit then found a verified malformed-extension/noncandidate-duplicate
closure gap. Commit `3d0d35a110ed66b80a2b4cca95b1028bfdc09853` consumes bounded
extension envelopes through the checksum boundary, verifies all stage-0 paths before
candidate filtering, and adds public normal/linked mutation tests. The focused suite
is now 32 pass, 0 fail, 420 assertions; another invariant audit remains mandatory.
Commit `72d71e468a8938b92e98be27ed2fd3af257ada06` closes the follow-up
ordering gap at the parser owner: every decoded stage-0 path must be strictly
increasing in raw UTF-8 byte order before candidate filtering. Normal/linked v4
reorder mutations fail closed, while v2/v3 acceptance remains covered. The focused
suite is 34 pass, 0 fail, 448 assertions and the full repository check exits 0.
