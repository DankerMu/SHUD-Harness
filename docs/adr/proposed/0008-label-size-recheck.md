---
status: proposed
kind: process
---

# ADR-0008: 标签变更触发完整 CI 重评

## 背景

[#324](https://github.com/DankerMu/SHUD-Harness/issues/324) 记录 `size-exempt` 在 opened 事件后添加时不生效，以及撤销后保留旧绿色状态。仅重跑 job 继续读取旧事件载荷，空提交或 close/reopen 只是绕行。

## 工程方案

保留 opened/synchronize/reopened 与 push-main，新增 labeled/unlabeled。所有标签增删均运行完整 CI；仍只有 `all-checks-passed` 一个 required check，其依赖 job 必须全部 success，failure/cancelled/skipped 均拒绝。PR-size 使用本次事件的标签快照；400 行阈值、生成文件排除、豁免理由与 bypass 日志不变。

原内联聚合器提取为唯一 `scripts/guardrails/aggregate-checks.sh`，CI 与本机 guardrail 正反例执行同一份逻辑，不复制判据。jq 是既有 CI 工具，也是新增本机自证的显式系统前提。

## 权衡与边界

接受无关标签也启动全量 CI 的 runner 成本，换取无 job 跳过/无额外分支保护的直接语义。同一 PR 的新事件仍会取消在途旧 run，因此验证需等待各事件对应的新 run 完成；不改变 concurrency key。

不采用第二 required check（需要改分支保护），不改为运行时 API 拉标签（不能单独触发撤销重评），不使用 privileged trigger/admin bypass。托管实证必须以同一 oversized draft head 验证加标签绿、删标签红，且不能合并该探针 PR。

此记录说明可回退的工程选择，不代表 M2 PI 功能验收。#293/#318 仍待最后集中验收。
