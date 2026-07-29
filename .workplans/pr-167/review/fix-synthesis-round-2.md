# Phase 5 fix synthesis — Round 2

PR: #167
Round 2 reviewed SHA: `618bc86f1708513d3bf2666537fde0359019c800`
Fixture: expanded, repair intensity high

## Verified finding

- `cand-r2-01`: CONFIRMED / FIX_NOW, P1 `compatibility`. The shared `readIndex` parser accepts only Git index v2/v3, causing legal v4 normal and linked worktree indexes to fail the public `--check-current` authority seam.

## Invariant closure

Invariant: every admitted, checksum-valid Git index representation required by the frozen Task 1.1a source-authority contract must yield the same exact manifest/index/worktree authority result without invoking Git or a child helper; unknown or malformed versions remain fail-closed.

Required surfaces:

- Shared helper root: `spikes/git-status-capability/contracts/lib/current-source.ts:readIndex`.
- Public entrypoint: `check.ts --repository-root ... --manifest ... --check-current`.
- Read surfaces: normal `.git/index`; linked-worktree per-worktree index plus common object format.
- Evidence: public success receipt repeated twice, status/inventory equality, no writes, no child launch.
- Downstream scope: no Git/HEAD authority, worktree traversal budget, or evidence publication behavior from #166/#162.

## Fix checklist

1. Add bounded, fail-closed Git index v4 prefix-compression decoding while retaining v2/v3 and rejecting unknown/corrupt representations.
2. Add normal and linked-worktree v4 public seam tests, each with two exact receipts and no status/file/process side effects.
3. Re-run the focused contract suite, all three public commands, strict OpenSpec validation, default repository check, and hygiene checks.

Post-fix: run Phase 6.2 invariant audit for the shared parser, then comprehensive Round 3.
