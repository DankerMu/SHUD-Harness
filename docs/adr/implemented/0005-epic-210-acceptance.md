---
status: accepted
kind: process
---

# ADR-0005: Epic #210 统一 PI 功能验收

## 背景与授权

Epic #210 的子 issue 按小 PR 串行交付。逐 PR 请求功能验收打断实施，且用户可见的完整行为要到 profile、探针和 Web 审批链组装后才能验收。

PI 在本次实施会话明确决定：「本Epic全部完成后统一验收，可以先merge pr close issue」，随后明确调整政策：「PI验收调整为整个epic验收，继续」。本记录仅适用于 [Epic #210](https://github.com/DankerMu/SHUD-Harness/issues/210)，不推导为其它 Epic 或独立 issue 的默认规则。

## 决策

1. Epic #210 的子 PR 在本地规定检查、适用的真实运行 smoke、风险对应的独立审查及 CI `all-checks-passed` 全部通过后，可以合并；对应实现 issue 可关闭。保留 SHA 绑定的验证、审查与偏离记录。
2. 子 PR 合并和实现 issue 关闭仅表示工程切片已交付，不表示 PI 功能验收通过。不得把本次提前合并授权写成后续功能已经验收。
3. PI 在整个 Epic 的交付物与证据齐备后统一功能验收。Epic #210 保持 open，`m1-skeleton` 保持未归档，直到 PI 明确给出最终验收结果；子任务状态如实记录已完成的工程工作。
4. #223 的 Web 审批往返是实际验收场景：仍需 PI 操作 Allow once，并记录真实 session log、写 raw 无审批卡及前后 md5。不得用模拟事件、自动代批或提前合并授权替代此操作。
5. 若最终验收不通过，保留 Epic open，根据具体问题修复；需要独立修复 PR 时关联 Epic 和问题证据，不将已合并但未验收的工作描述为最终完成。

## 不变项

CI、代码审查、修复轮次门禁、测试覆盖率、PR 体积、密钥与 raw 数据保护、seam-only、真实 LLM 探针要求均不调整。真实 LLM 仍为 `deepseek-flash-guan`，DMXAPI 密钥仅来自环境变量。物理方程、默认参数、benchmark 和运行时 PI 审批门不受本决策影响。

## 权衡与边界

收益是减少中间审批打断，使 PI 面向完整用户行为验收；代价是 main 可能包含尚未完成功能验收的工程切片。通过保留 Epic open、明确验收状态和逐 PR 可追溯证据控制该风险。

本决策部分调整 [ADR-0003](../implemented/0003-keep-risk-adaptive-review-lens-rotation.md) 所保留的人工 merge gate 时点，仅限上述 Epic；风险自适应审查本身不变。仓库控制面由 `instructions/agents/shared.md` 同步后生成根指令，不手工编辑生成物。

## 完成与复查

Epic #210 统一验收后记录结果并归档其 OpenSpec change。本例外不自动推广；其它 Epic 如需同样流程，另由 PI 决定。此政策文件不替代执行环境独立加载的上层约束。
