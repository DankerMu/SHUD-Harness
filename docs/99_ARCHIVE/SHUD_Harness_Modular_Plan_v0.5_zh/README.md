# SHUD-Harness 模块化详细方案包（v0.5）

本压缩包是基于你前面的 v0.2 / v0.3 / v0.4 文档、关于主 Agent 固定控制环的讨论，以及 ZeRo 当前实现现状整理出的**模块化详细方案**。

## 打开方式
1. 先看 `00_MAIN_INDEX.md`
2. 再按索引进入对应子文档
3. 如需快速判断 ZeRo 关系，直接看 `02_ZERO_REFERENCE/02_Reuse_Modify_Add_Matrix.md`

## 包内原则
- 主文档只放索引，不重复展开正文
- 各领域 / 各模块独立成子文档
- 每份子文档都显式标注 `[R] / [M] / [N]`
- 所有能力都按“**可独立实现**，但可参考 ZeRo 加速”来写
- 方案默认版本：**v0.5 模块化详细方案**

> 状态标签说明  
> **[R] 已实现可复用**：ZeRo 当前已有对应能力，可直接复用或小幅包装。  
> **[M] 需修改后复用**：ZeRo 当前有相邻能力，但不满足 SHUD-Harness 的科研语义、治理要求或对象模型，需要改造。  
> **[N] 必须新增**：ZeRo 当前没有这层能力，SHUD-Harness 必须新增实现。  
> **独立实现要求**：本方案的所有模块都要求在**不依赖 ZeRo** 的情况下可实现；ZeRo 仅作为参考实现和加速来源，不是硬前置。

## 建议阅读顺序
- `00_MAIN_INDEX.md`
- `01_GOVERNANCE/02_Commander_Runtime_Control_Kernel.md`
- `02_ZERO_REFERENCE/02_Reuse_Modify_Add_Matrix.md`
- `04_RESEARCH_DOMAIN/01_Research_Object_Model.md`
- `05_IMPLEMENTATION/03_Phased_Implementation_Plan.md`

## 与上一版的主要差异
- 从“单文档大而全”改成“主索引 + 子文档”
- 把主 Agent 从“固定科研流程”改为“固定 runtime control kernel + 可变 scientific work graph”
- 正式加入 ZeRo 对照层，明确哪些可直接借、哪些必须改、哪些必须新增
- 明确支持**无 ZeRo 独立落地**
