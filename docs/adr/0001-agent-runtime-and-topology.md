---
status: accepted
---

# ADR-0001: Agent 运行时基座与拓扑（Zero + 单 Coordinator 星型）

**状态**: accepted（2026-07-02） · **决策人**: PI + 工程师 · **方法**: future-aware-architecture 分析
**事实基线**: zero@13e25c1（development 分支）· SHUD-Harness v0.8.3（97 篇 spec，零代码）

## 背景

三个约束的交集决定架构：**任务时间尺度倒挂**（LLM 秒级回合 vs SHUD 小时/天级运行）、
**科学正确性不可妥协**（错误结论比无结论更糟）、**1.5 人维护带宽**。
决策分类：complicated 而非 complex——领域工作流（建模→运行→分析→报告）结构已知，
不需要涌现式多 agent 协商；除运行时基座外，各项选择均为双向门。

## 决策

1. **拓扑**：单 Coordinator + spawn 深度 1 星型。治理、审计、成本三个单点收敛到一个 kernel。
2. **kernel**：任务驱动 + park/resume，弃长自主循环——状态归 harness，不归模型。
   （2026 年中 durable execution/HITL 成为主流框架一等公民，验证了该方向。）
3. **基座**：基于 Zero 扩展，评级 **Trial** 而非 Adopt——Week 1-2 spike 验证后转正。
4. **期权结构**：领域治理层（8 对象 + gate matrix + Domain CLI + T0-T4 信任分级）设计上
   运行时无关，是可平移资产——这使基座赌注保持双向门。

## 替代方案与否决理由

| 方案 | 否决理由 |
|---|---|
| 多 agent mesh / pipeline 编排 | "谁批准了什么"变成分布式问题；真实瓶颈是 PI 决策节奏与模型运行时长，不是 agent 间通信带宽 |
| Claude Agent SDK (TS) | 成熟、通用化（2026-06 起 SDK 用量单独计费）；否决理由=自有 Web UI 是产品本体而非附件 + 结构强制治理需 kernel 完全自控。**保留为回退目标** |
| LangGraph | durable execution / HITL 最成熟，但 Python 分栈违反 TS 单语言约束（1.5 人一套工具链） |
| 全自研 runtime | 带宽不允许；Zero 已有 ~7.6 万行可复用基础设施 |

## 实测事实（zero@13e25c1，2026-07-02 取证）

- 9 packages + 3 apps，核心模块实存（agent-loop / spawn-agent / session / memory / channel / observe）。
  上游活跃：本次同步吸收 117 commits（memory 治理重写 R2-R12 对抗加固、core 模块合并重构、
  后台工具完成事件、context 分段预算、DingTalk/Feishu 通道、secrets vault）。
- **上游正向本项目需求收敛**：memory 原生 `draft|verified|archived|conflict` 状态机 +
  governance/lifecycle 端点；`BackgroundToolTaskSink` + `background_tool_completed` 消息
  （park/resume 的天然接缝）；`ContextBudget` 分段预算 + session `context_compression`
  快照（与 session digest 对象同形）。
- **关键缝隙确认**：`AgentLoopHooks.onToolCallStart` 为 void 观测钩子，**不可否决**；
  可阻断缝 = `ToolBase.beforeExecute`（throw 即拒，逐工具模板方法）。中央策略门
  （`ZeroHarnessAdapter.beforeToolCall`）必须在工具注册层自建横切包装；`bash.ts` 无内置
  safety 逻辑，沙箱约束全部为 SHUD 侧扩展。

## 后果

- 正面：治理单点可审计；成本封顶（并发/深度硬限制）；领域层可平移。
- 负面（接受的债）：确定性映射表（semantic floor / 契约面路径集）随上游漂移的维护面；
  阶段重投影丢 warm context 的效果损耗（待实现期实测）；Zero 追 development 分支、
  无稳定 tag，只能以 commit 钉版本。

## Revisit 触发器

1. **Week 1-2 spike**（首项任务）：工具注册层中央策略门 + 一条治理规则端到端穿透。
   工作量超预期 → 启动 Claude Agent SDK (TS) 迁移评估。
2. Zero 上游停更或破坏性重构导致复用矩阵行失效超 1/3 → 同上。
3. submodule bump 频率 > 1 次/季 → 兼容矩阵与契约面探针自动化。
4. 多 PI 需求出现 → ACL 泛化（principal 化设计已留门）。
5. 模型层注入防护实质突破 → T4 处理可放宽（在此之前不放）。
6. `StackLock.llm` 升级且行为 eval 全量达标 → 触发能力护栏减重审查
   （[Control_Kernel §5.2](../02_ARCHITECTURE/Control_Kernel.md)，harness 评审 G5）——
   capability 类护栏逐项评估退役，authority 类不参与；护栏只增不减是另一种熵。

## 参照

[Zero_Reuse_Matrix](../02_ARCHITECTURE/Zero_Reuse_Matrix.md) ·
[Control_Kernel §5](../02_ARCHITECTURE/Control_Kernel.md) ·
[Adversarial_Design_Review_v0_8_3](../00_INDEX/Adversarial_Design_Review_v0_8_3.md) ·
[Context_Trust §5.1](../03_SPEC/Context_Trust_And_Injection_Spec.md) ·
外部 2026 框架综述：morphllm / qubittool / developersdigest / alicelabs（检索于 2026-07-02）
