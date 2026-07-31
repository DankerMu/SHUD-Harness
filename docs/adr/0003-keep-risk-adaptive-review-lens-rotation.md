---
status: accepted
---

# ADR-0003: 保留风险自适应交叉评审的 lens rotation

**状态**：accepted（2026-07-26）
**来源**：`subagent-workflow` review-loop accountability audit；达到 8 个带 lens attribution 的多轮合并 PR 决策阈值后，按默认 keep 作出记录。

## 背景

`docs/review-loop-log.jsonl` 已积累 8 个可判定的多轮合并 PR。后续轮次中：

- 固定 core lenses 捕获 2 项；
- rotated-in lenses 捕获 37 项。

这说明缺陷会随修复面迁移；只重复首轮固定视角会系统性漏掉后续出现的 evidence、integration、compatibility、security/performance 与 invariant-state 邻接问题。

## 决策

保留风险自适应 lens rotation：

1. 首轮继续覆盖 correctness、integration、security/performance、test-evidence、spec compliance 与 invariant/state 的完整基线。
2. 修复后的综合轮次保留一个 full-scope reviewer，并按上一轮 failure class、受影响边界与 invariant audit 信号轮换其余 delta lenses。
3. rotation 不能减少 fixture/risk contract 要求的总覆盖面，也不能用多个窄 delta reviewer 替代 full-scope 视角。
4. 每个合并 PR 继续记录 `round_lenses` 与 `catches`，供下一次机械审计使用。

## 后果

- 正面：把后续审核预算集中在实际迁移的风险面；当前样本中 rotated lenses 的有效捕获量显著高于固定 core lenses。
- 代价：编排器必须维护 SHA-bound reviewer attribution，并避免把同一 finding 重复计入多个 lens。
- 不变项：五轮硬上限、独立 verifier、Phase 7 gap sweep、人工 merge gate 与 evidence hygiene 均不因本 ADR 放宽。

## Revisit 触发器

1. 再积累 8 个带完整 attribution 的多轮合并 PR 后重新审计。
2. rotated-in lenses 连续一个样本窗没有独立有效捕获，或其误报显著高于 fixed core lenses。
3. reviewer 角色/fixture contract 发生结构性变化，使当前 lens 分类不再可比。

## 2026-07-31 审计复核

本次机械审计累计 9 个可判定的多轮合并 PR，后续轮次 attribution 为 fixed core `5`、rotated-in `37`。相对本 ADR 作出决策时只新增 1 个样本，且结果继续支持 keep。暂不重开决策；按既定 revisit 触发器，等待再积累 7 个带完整 attribution 的多轮合并 PR 后复核。

## 参照

[`review-loop-log.jsonl`](../review-loop-log.jsonl) · `subagent-workflow` 的 `risk-adaptive-cross-review` 与 `loop_log_audit.py`
