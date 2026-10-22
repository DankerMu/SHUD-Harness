---
status: accepted
kind: process
---

# ADR-0007: M2 Epic 统一 PI 功能验收

## 背景与授权

ADR-0005 只覆盖 Epic #210（M1），并写明不自动推广到其它 Epic。M2（OpenSpec change `m2-run-chain`）的用户可见行为——一句话跑 ccw、中途重启 dsh、完成后被唤醒拿到 RunRecord——要到作业注册表、工具与验收脚本全部组装后才能完整验收。PI 在 M2 规划时明确决定："epic收口时做功能验收"。

## 决策

1. M2 Epic 的子 PR 在本地规定检查、适用的本机运行（`shud:tiny`、`shud:restart`、`raw-guard:probes`、`profile:smoke`）、风险对应的独立审查与 CI `all-checks-passed` 全部通过后可以合并，对应实现 issue 可以关闭。
2. 子 PR 合并与 issue 关闭只表示工程切片交付，不表示 PI 功能验收通过。
3. Epic 收口时 PI 在 `dsh --profile shud` 的 Web 界面亲自完成一次重启唤醒验收，证据记入 `docs/Migration_Plan_dsh.md`；agent 不得代批或以模拟事件替代。Epic 保持 open、`m2-run-chain` 保持未归档，直到 PI 明确给出验收结果。
4. 验收不通过时 Epic 保持 open，按问题修复；修复 PR 关联 Epic 与问题证据。

## 不变项

CI、代码审查、修复轮次门禁、覆盖率、PR 体积、密钥与 raw 保护、seam-only（ADR-0006 的放宽范围除外）、真实 LLM 探针要求均不调整。

## 权衡

减少中间验收打断，使 PI 面向完整的重启唤醒行为验收；代价是 main 上会存在尚未功能验收的工程切片。以 Epic 保持 open、逐 PR 证据可追溯控制风险。本决策只适用于 M2 Epic。
