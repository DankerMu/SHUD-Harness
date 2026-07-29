Closes #164

## Summary

- add strict bounded source-record and four-SHA source-identity contract ingress
  with canonical JSON
- freeze the exact 152-byte three-entry synthetic source frame and SHA-256 oracle
- validate the committed manifest and three mandatory oracle files through
  stable, no-symlink ancestor/final descriptors
- keep `--check-current` pure and no-write while avoiding live repository
  discovery or Git authority
- split and complete OpenSpec Task 1.1a while preserving downstream ownership

## Scope boundaries

This PR does not implement supply graph semantics (#165), live Git
configuration/index/tracked-set/filesystem-generation/mode/object-format or gate
metadata authority (#166), row/platform state (#161), aggregate
collection-wide evidence traversal/read budgets or publication vocabulary
(#162), runtime execution, production imports, package changes, workflows, or
network-security behavior.

## Verification

- final retained-slice mutation replay — 14 pass, 14 expected fail, 138
  assertions, exit 1; restored complete contracts tree — 28 pass, 0 fail, 203 assertions
- `npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests` — 28
  pass, 0 fail, 203 assertions
- all three frozen public checker commands — exact success receipts
- `npx --yes @fission-ai/openspec@1.3.1 validate m2-capability-observer-spike
  --strict --no-interactive` — valid
- `npx --yes bun@1.2.19 run check` — exit 0
- fixed-base scope, no-write, diff, production/package/workflow/submodule hygiene
  — pass

## Deviation record

Round 3 registered a depth-shaped invariant-closure retry. Round 4 then verified
a breadth-shaped ownership failure. The user approved removing live
Git/index/filesystem authority from #164 and routing it to #166, without
implementing #166 here. Exact depth/item fixtures now explicitly prove limit
reachability and may finish at schema validation; the previously approved
node/item option 1 is unchanged.

Phase 6.2 on `5fb069a` verified two P1 closures: retained input paths now use
descriptor-bound `openat` traversal with `O_NOFOLLOW`, and final behavior evidence
binds the complete contracts/test/helper/fixture/golden tree.

## Review state

Draft pending final retained-slice Phase 6.2 audit, the one remaining
comprehensive Round 5 cross-review and finding verification, CI, and the human
merge gate.
