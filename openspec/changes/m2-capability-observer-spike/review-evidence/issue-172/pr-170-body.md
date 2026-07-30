Closes #168

## Summary

- retain the root, directory-chain, and final-file capabilities for both direct
  source-input kinds and perform every post-admission check descriptor-relatively
- normalize source records to one admitted path/mode set with digest/count-bound
  primary and witness results
- freeze public path-replacement, cleanup, exact receipt, four-SHA, and 237/238
  capacity evidence under the unchanged source ingress profile

## Scope

This is split A of #164. It contains only direct source-input ingress and record
capacity. The committed current oracle and final Task 1.1a ownership rewrite are
owned by #169. Live Git authority (#166), aggregate evidence/publication (#162),
production/runtime/workflows, and network security remain out of scope.

## Verification

- `npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests`
  — Darwin 25 pass, 0 fail, 527 assertions
- `oven/bun:1.2.19` read-only Linux container focused run — 25 pass, 0 fail,
  479 assertions
- both direct public `check.ts` commands — exact success receipt, empty stderr
- compiling Phase 6.2 mutation — 18 pass, 2 named failures; restored focused
  source-ingress suite 20 pass, 0 fail
- compiling Round 2 production/parser mutation — Darwin and Linux each report
  18 pass, 3 named failures; production write sentinel remains absent
- compiling Round 3 closed-authority production matrix — Darwin/Linux each
  report 19 pass, 2 named failures; six runtime routes are denied without side
  effects and same-module `statSync(URL)` is caught by exact static vocabulary
- compiling Round 4 computed-loader production matrix — Darwin 19 pass / 2 fail /
  499 assertions and Linux 19 / 2 / 451; all three loaders, cached `bun:ffi`,
  cached `child_process`, and eight file/library/process routes are denied before
  side effects, while the AST gate independently rejects the mutation
- `npx --yes bun@1.2.19 run typecheck` — pass
- `npx --yes bun@1.2.19 run check` — pass
- strict OpenSpec validation — valid
- `git diff --check`, stash, scope, and submodule hygiene — clean
- Darwin descriptor-stress matrix — pass; read-only Linux Bun 1.2.19 container
  supplies exact-tree cross-platform evidence without changing existing CI

## 偏离记录

无偏离：现有 CI workflow 与 `origin/main` 保持一致；本 issue 未增加独立
workflow，Darwin/Linux focused 证据由 exact-tree 本地与只读容器运行提供。

## Agent Review

- Round 1 at `89eb2aad7895d837617d243a8ce82e3cdc45b211` recorded seven
  verified findings. Phase 6.2 closed two more gaps. Round 2 at `f49ac270` found
  four verified findings. Round 3 at `17f89edd` found a recurring PathLike/promise
  authority-depth gap. Round 4 at `cc89c89d` found computed-loader/API-name depth
  gaps and consumed the final post-retro budget.
- Round 5 at `02ba5189e938c7c04018555ec0347945dc15e829` verified three P1
  `test-evidence` findings: stale historical counts, constructor-created dynamic
  execution outside both proof layers, and Worker new-realm authority outside
  the main-realm preload patches.
- The Round 5 ledger is `not-clean`; the five-round terminal ceiling is locked.
  No Round 6, Phase 6/7 repair, CI-for-merge wait, or merge is permitted. PR
  #170 is superseded by implementation-ready Issues #171 and #172, ordered
  `#171 -> #172 -> #169`.
- OpenSpec change: `m2-capability-observer-spike`; fixture level: expanded;
  repair intensity: high.
