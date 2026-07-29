Closes #164

## Summary

- add strict bounded source-record and source-identity contract ingress with canonical JSON
- freeze the exact 152-byte three-entry synthetic source frame and SHA-256 oracle
- bind source, platform, and decision commit identities at the contract boundary
- add a no-write/current-index authority checker supporting normal and linked worktrees
- fail closed across common-config extensions, complete index-entry grammar, canonical path identity, and descriptor-bound no-follow worktree reads
- split and complete OpenSpec Task 1.1a while preserving the downstream DAG boundaries

## Scope boundaries

This PR does not implement supply graph semantics (#165), Git authority/profile and gate metadata (#166), row/platform state (#161), evidence publication vocabulary (#162), runtime execution, production imports, package changes, workflows, or network-security behavior.

## Verification

- batched source-only red replay at `a04f5c3` — 41 pass, 6 expected fail, exit 1; restored fixed source — 47 pass, 0 fail, 738 assertions
- `npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests` — 50 pass, 0 fail, 762 assertions
- all three frozen public checker commands — exact success receipts
- `npx --yes @fission-ai/openspec@1.3.1 validate m2-capability-observer-spike --strict --no-interactive` — valid
- `npx --yes bun@1.2.19 run check` — exit 0
- current-source command leaves Git status unchanged
- fixed-base scope, diff, package/workflow/submodule hygiene — pass

## 偏离记录

Round 3 三轮硬闸将失败形态判定为同一 source-authority 不变量的深度缺口；已登记 retro，并以一次综合 invariant-closure retry 修复。Aggregate current-source traversal/read budgets 仍按冻结 DAG 路由到 #162，本 PR 未实现该专属范围。

## Review state

Draft pending final Phase 6.2 audit, post-retro comprehensive cross-review, finding verification, CI, and the human merge gate.
