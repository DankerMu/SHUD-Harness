Closes #171

## Summary

- retain root, directory-chain, and final-file capabilities for both direct source inputs and perform post-admission checks descriptor-relatively
- normalize source records to one admitted path/mode set with digest/count-bound primary and witness results
- preserve exact direct receipts, canonical JSON, four-SHA binding, parser option 1, and the exact 237/238 capacity boundary

## Scope

This is the core behavior lane split from superseded PR #170. It includes only
the two direct input kinds and their narrow actual-implementation tripwire.
Issue #172 owns exhaustive hostile-source AST/preload proof and historical
evidence reconciliation. Issue #169 owns committed-current wiring. Live Git,
publication, production/runtime/workflows, and network security remain out of
scope.

## Verification

- Darwin focused contracts — 24 pass / 0 fail / 513 assertions
- Linux Bun 1.2.19 read-only container — 24 pass / 0 fail / 465 assertions
- both direct public commands on Darwin and Linux — exact success receipts
- 237 entries — 512 items / 5,100 bytes / success
- 238 entries — 514 items / 5,116 bytes / `CONTRACT_JSON_ITEM_LIMIT`
- `npx --yes bun@1.2.19 run typecheck` — pass
- `npx --yes bun@1.2.19 run check` — pass
- strict OpenSpec validation — valid
- `git diff --check`, stash, scope, and pinned-zero hygiene — clean

## 偏离记录

无偏离。

## Agent Review

Review evidence will be added after risk-adaptive cross-review on the pushed
implementation head.
