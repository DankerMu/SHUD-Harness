# Issue #168 implementation evidence

Base: `f8b74e724dc978acb889f715a936feabfd69680d`
Branch: `codex/issue-168-source-ingress-capability`
Fixture: `expanded`; repair intensity: `high`
Date: 2026-07-29 EDT

## Scope

Implemented only the two direct input kinds, descriptor-capability ingress, the
normalized source-record contract, and their public tests. The committed current
oracle (#169), live Git authority (#166), aggregate evidence/publication (#162),
production/runtime/workflows, and network security remain absent.

## Red proof

The implementer stashed only the new `contracts/check.ts` and `contracts/lib/**`
implementation source while leaving the new public tests in place. The focused
run failed as expected with `0 pass, 2 fail, 2 errors` because the public modules
were absent. The source was restored immediately. `git stash list` is empty; no
`red-proof` stash remains.

## Phase 2 verification

- `npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests`:
  19 pass, 0 fail, 458 assertions.
- Both direct `check.ts --input ... --kind ...` commands: exit 0, one exact
  LF-terminated success receipt, empty stderr.
- Capacity: 237 short entries = 8,339 bytes and 512 items, success; 238 = 8,364
  bytes and 514 items, `CONTRACT_JSON_ITEM_LIMIT`.
- Node option 1: 2,048 nodes parses under an independently relaxed item ceiling;
  2,049 returns `CONTRACT_JSON_NODE_LIMIT`.
- `npx --yes bun@1.2.19 run typecheck`: pass.
- `npx --yes bun@1.2.19 run check`: pass.
- `npx --yes @fission-ai/openspec@1.3.1 validate
  m2-capability-observer-spike --strict --no-interactive`: valid.
- `git diff --check`, empty stash, submodule diff, and scope scans: clean.

Darwin executed the descriptor-stress matrix locally. The same platform-branching
suite must execute on Linux CI before the merge gate.

## Deviations

No deviations.
