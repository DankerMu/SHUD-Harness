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
  — Darwin 24 pass, 0 fail, 531 assertions
- `oven/bun:1.2.19` read-only Linux container focused run — 24 pass, 0 fail,
  483 assertions
- both direct public `check.ts` commands — exact success receipt, empty stderr
- compiling Phase 6.2 mutation — 18 pass, 2 named failures; restored focused
  source-ingress suite 20 pass, 0 fail
- `npx --yes bun@1.2.19 run typecheck` — pass
- `npx --yes bun@1.2.19 run check` — pass
- strict OpenSpec validation — valid
- `git diff --check`, stash, scope, and submodule hygiene — clean
- Darwin descriptor-stress matrix — pass; Linux is required in PR CI

## 偏离记录

唯一偏离：为使 Issue 要求的 Darwin/Linux focused suite 成为 required PR
gate，在现有 `linux-base` 与 `macos-seatbelt` job 中各增加一条 pinned test
命令；未增加其他 workflow 或 spike 行为。

## Agent Review

- Round 1 at `89eb2aad7895d837617d243a8ce82e3cdc45b211` recorded seven
  verified findings. Phase 6.2 then found and closed malformed-limit precedence
  and independent Node/Bun/FFI authority-interception gaps; Round 2 has not yet
  run.
- OpenSpec change: `m2-capability-observer-spike`; fixture level: expanded;
  repair intensity: high
