---
status: accepted
---

# ADR-0002: MVP 现实锚定（部署 / 首任务 / 模型）

**状态**：accepted（2026-07-02）
**来源**：grill-me 方案压测——spec 冻结后、实施记录重建前，对"只有 PI 能回答的现实假设"做 9 问对抗压测，全部分支收敛。
**背景**：v0.8.3 规格体系经 4 轮文档级对抗审查后冻结，但方案对 PI 现实（部署环境、首个任务、用户面、开发模式、模型预算）的假设从未被验证。旧 openspec changes（4 月产物，9 个 bundle）因漂移已整体清理，重建实施记录前需先锚定这些决策。

## 决策（D1–D9）

| # | 决策 | 直接后果 |
|---|---|---|
| D1 | 全本机 Mac 部署（开发 + Hono 服务 + SHUD local runner 同机），机器常开不睡眠 = 常驻服务器 | slurm/HPC 适配器 MVP 不实现；沙箱按本机进程级起步 |
| D2 | 工具链已验证：SHUD 曾在本机编译跑通，rSHUD 2.5.0 在位 | M1 第 0 项降为一次 `make` 复验 + GLM provider 配置 |
| D3 | 首个真实任务 = 从兄弟项目 `../openMP` 抽取 RHS 并行切片做**已知答案回放**（code_change 类）；该项目 P1e epic 已交付 StrictOMP RHS（heihe_x4 1.729×，基线/验收门/决定论机制齐备） | Harness 的首任务自带 ground truth，评价 Harness 本身极易 |
| D4 | 回放验收 = 治理链路走通 + 正确性门（serial baseline 一致性判定），**不做性能复现**；小流域 fixture | heihe 级性能任务留待链路走通后 |
| D5 | MVP 主链 = ChangeRequest + VerificationCase；敏感性压缩为最小 OAT（3–5 run，保 AnalysisPlan 对象与 batch 汇总）；Controlled_Search/校准边界仅 schema 占位 | 激活账本 Phase 3/4 重心随之调整 |
| D6 | 单用户（PI = 工程师 = 唯一账号）；Auth 缩为单账号 + localhost；Multiuser_Harness_Versioning 停用至出现第二个真实用户 | agent 侧角色剖面（治理核心）不受影响 |
| D7 | 邮件通知保留 MVP（机器常开，"人离开、任务继续、邮件唤回"成立）；SMTP 发件账号 M1 定 | outbox/dedupe 照 spec 实现 |
| D8 | 代码全部由 coding agent 写、PI 只审批验收；弹性里程碑 M1..Mn 取代日历周承诺 | Phased_Plan 的周序保留为依赖参考；issue 按单 agent-PR 尺寸切 |
| D9 | 运行时模型 = **GLM 5.2**（第三方 OpenAI 兼容端点）；Zero 原生支持（`providers` 配置：`api_type: openai_chat_completions` + `base_url` + `api_key_ref` + `fallback_chain`），零额外开发 | StackLock.llm 必须连 `base_url` 一起锁；golden eval 首跑 = 模型准入测试 |

## 后果

- **正面**：首任务自带已知答案（openMP 项目的基线锁与 A3a 决定论机制），Harness 正确性可客观评判；GLM 成本低一个量级；"不信模型信闸门"的确定性护栏设计因弱模型而更有价值。
- **负面（接受的债）**：第三方端点可能静默换版/量化——以 StackLock 锁 base_url + nightly 行为 eval 作漂移保险；GLM 治理遵循能力未知——治理类 eval 5/5 是准入门，不达标时按开放项 B 计划处理。
- **对 ADR-0001 的修订**：D9 使"Claude Agent SDK (TS) 迁移"作为首选备胎的前提（Anthropic 生态运行时）不再成立，备选顺序改写——见 ADR-0001 2026-07-02 修订注。

## 开放项（M1 grill 靶子）

1. 回放切片的 PR 粒度与 SHUD 基线 pin（openMP 的 B0/P1e-tag 基线体系 vs Harness submodule 现状）。
2. GLM 定价下 InferenceBudget 三档默认值。
3. SMTP 发件账号与凭据来源。
4. GLM 治理 eval 不达标的 B 计划（提示工程 / 治理节点切强模型 / 换供应商）。

## Revisit 触发器

1. GLM 端点持续故障或治理类 eval 不达标 → 模型/供应商重议（D9）。
2. 出现第二个真实用户 → D6 失效，Multiuser 层激活。
3. 需要性能复现类任务 → 突破 D4 边界，引入 heihe 级 fixture 与计时基础设施。
4. Mac 本机资源成为瓶颈（大流域/长 batch）→ D1 重议，slurm adapter 前移。

## 参照

[ADR-0001](0001-agent-runtime-and-topology.md) ·
[Phased_Spec_Activation](../Phased_Spec_Activation.md)（例外批次 2 + MVP 范围调整）·
[Minimal_Schemas](../03_SPEC/Minimal_Schemas.md)（StackLock.llm base_url）·
兄弟项目 `../openMP/SHUD_openMP_master_plan.md`（v1.5，P1e COMPLETE / P2a NO-GO）
