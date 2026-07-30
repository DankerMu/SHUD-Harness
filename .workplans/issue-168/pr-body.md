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
  — Darwin 25 pass, 0 fail, 541 assertions
- `oven/bun:1.2.19` read-only Linux container focused run — 25 pass, 0 fail,
  493 assertions
- both direct public `check.ts` commands — exact success receipt, empty stderr
- compiling Phase 6.2 mutation — 18 pass, 2 named failures; restored focused
  source-ingress suite 20 pass, 0 fail
- compiling Round 2 production/parser mutation — Darwin and Linux each report
  18 pass, 3 named failures; production write sentinel remains absent
- compiling Round 3 closed-authority production matrix — Darwin/Linux each
  report 19 pass, 2 named failures; six runtime routes are denied without side
  effects and same-module `statSync(URL)` is caught by exact static vocabulary
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
  authority-depth gap; the registered retro corrective action is implemented in
  this tree and awaits the next review gate.
- OpenSpec change: `m2-capability-observer-spike`; fixture level: expanded;
  repair intensity: high
