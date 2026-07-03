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

## 开放项处置（M1 grill 定案，2026-07-03）

原四个开放项 + M1 开工三决（共七项议程）经 M1 grill 逐项定案：

| # | 议题 | 定案 |
|---|---|---|
| 1 | 回放切片粒度与 SHUD pin | 单个自包含 PR 尺寸切片（StrictOMP RHS 单 phase/函数级 + deterministic gather），素材自 openMP P1e 已交付 patch 抽取，具体 PR 到 M9 备料时选；pin = task workspace 内检出 openMP 侧 SHUD pin（P1e 收口 `3341368d` 或含 nested-Timer fix 的 `7a1dc8f`）及其基线体系（B0-tag / baseline-P1e），Harness 根 submodule 不动；小流域 fixture = keliya（484 单元，本地秒级） |
| 2 | InferenceBudget 三档默认值 | call 数三档不动（6/12/30）；USD 初值 = M1 冒烟实测均价 × call 数 × 2 裕度，拿不到计费回执时现值 ÷10 占位（0.03 / 0.10 / 0.50）；M7 CostRecord 实测后校准写回 Cost_Inference_Budget |
| 3 | SMTP 发件账号 | PI 自有 Gmail + 应用专用密码（smtp.gmail.com:587，发件人 = 收件人 = PI 邮箱）；凭据经 SMTP_* 环境变量注入（Config_Secrets §4，SecretRef purpose=smtp），不入 git/对象/报告 |
| 4 | 金样 eval plan B | 分层递进：① 提示工程迭代一轮（限单 issue 尺寸）→ ② 治理关键节点（closure 判定 / gate 判定 / language guard）经 zero 按功能选模型切强模型，其余调用留 GLM → ③ 整体能力性不达标（非治理单点）才换供应商/模型重议（回 revisit 触发器 1） |

**M1 开工三决**（同场定案，细节固化于 openspec change `m1-foundation` 与 Phased_Plan M1）：
① zero M1 **不 fork**——保持根目录 submodule 钉 13e25c1 相对引用，引用技术形态由策略门 spike 条 1 实测确认，fork 决策挂 ADR-0001 触发器；
② role→tool_id 五角色工具面**照准草案**（coordinator 调度面含 file_read 无 bash；repo_explorer/reviewer 纯只读；worker sandbox bash + artifact 写；coder worktree 内 read/write/edit + patch + bash），落 packages/core 常量 + 快照测试；
③ GLM api key 环境变量名 = **`GLM_API_KEY`**（`api_key_ref: env:GLM_API_KEY`；Config_Secrets §4 补行走 ADR 例外，账本例外批次 4）。

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
