---
status: snapshot
---

# Agent 系统本质审计 (v0.8.3)

**状态**：审计报告（advisory，待逐项决策）
**日期**：2026-07-02
**审查对象**：docs/ 全部活跃规范（95 份）
**审查透镜**：agent 系统与传统信息系统的本质差异
**方法**：6 个文档簇并行取证 + 10 维 rubric + 主审交叉校验（取证结论与已读 canonical spec 冲突处已校准，见 §7）

---

## 1. 审查透镜：十个本质差异

| 维度 | 传统 IS 假设 | Agent 系统现实 |
|---|---|---|
| D1 可复现性 | 版本 = 代码版本 | 版本 = 代码 + prompt + **模型** + skills + memory 状态 |
| D2 非确定性 | 重试 = 相同结果 | LLM 步骤重试 ≠ 相同结果 |
| D3 上下文工程 | 无此概念 | context 是稀缺资源，各阶段进什么内容需要 spec |
| D4 Prompt 生命周期 | 无此概念 | prompt 是行为代码，需版本化 + 回归 |
| D5 Eval 体系 | 测试 = 断言精确输出 | 行为涌现，需 golden 任务集 + 行为回归 |
| D6 威胁模型 | 认证/授权/输入校验 | + prompt 注入、记忆投毒、规则博弈（specification gaming） |
| D7 降级故障 | 服务挂 = 5xx | LLM 挂/限流/行为漂移各有不同任务语义 |
| D8 人机交互 | 请求-响应 | 长自主运行中的打断/转向/竞态 |
| D9 决策可观测 | 日志/指标/追踪 | + 决策理由留痕、session 可审计 |
| D10 IS 思维残留 | — | 把 LLM 当确定性服务对待的条款 |

## 2. 总体结论

**确定性外壳是优秀的，LLM 内核被当成了黑箱。**

这套文档把 agent 系统中所有*确定性*的部分（schema、状态机、API、幂等、artifact、审计）规范到了 95 分；但对系统中唯一的*非确定性*组件——LLM 本身——的工程化（版本锁定、行为评估、故障降级、注入防护、介入协议）接近空白。换句话说：文档治理了 agent 的**手脚**（工具权限、路径边界、状态迁移），没有治理 agent 的**大脑**（模型版本、prompt、context、行为回归）。

这不是细节缺陷。五个 P0 中任何一个在真实使用中暴露，都会直接击穿系统的核心承诺（可复现、PI 主导、治理不可绕过）。

## 3. P0 发现（击穿核心承诺）

### AGA-P0-1 LLM 模型不在版本锁内

- **证据**：StackLock 锁 gcc/SUNDIALS/R 补丁版本（[Minimal_Schemas.md §2](../03_SPEC/Minimal_Schemas.md)）；Dependency_Versioning_Policy 锁 TypeScript/Zod 补丁版本；release manifest 记录 prompt_version——**均无 model_id / 采样参数**。cost_record 有 `provider/model`（[Memory_Skills_Lite.md §7](../03_SPEC/Memory_Skills_Lite.md)，计费用途），复现锁没有。
- **后果**：DoD 把"结果无法绑定 StackLock"列为不合格项，但 agent 行为本身就绑定不了——provider 静默升级模型，全部历史任务行为不可重放，且系统无法察觉。行为最不确定的组件恰恰是唯一不锁版本的组件。
- **修复**：StackLock.harness 增加 `llm: {provider, model_id, params_digest, prompt_pack_digest}`；release manifest 增加 model baseline；模型变更 = stack 变更，触发 eval 子集（依赖 AGA-P0-5）。

### AGA-P0-2 semantic_level 自分类可旁路整条 Theory-to-Code 治理链

- **证据**：Scientific_Change_Gating_Spec 的 gate matrix 按 semantic_level 分流，但**分类本身由 Coder（LLM）自填**（[Roles_and_Boundaries §6](../02_ARCHITECTURE/Roles_and_Boundaries.md)），无任何制衡条款；Preflight 只查状态机状态不查分类合理性（[Preflight_And_Mutation_Boundary_Spec §3](../03_SPEC/Preflight_And_Mutation_Boundary_Spec.md)）。
- **后果**：agent 把触及物理语义的改动标为 `pure_engineering`，整条 bundle→verification→PI gate 链路静默失效。治理链的强度等于其最弱环节，而最弱环节是 LLM 的一次自由填空。
- **修复**：① 建立确定性 path→最低 semantic_level 映射表（如 `SHUD/src/ModelData/*.cpp` ⇒ 至少 `numerical_implementation`），harness 强制取 max(声明值, 映射值)；② Reviewer validator 交叉核对 files_changed 与声明级别；③ 分类降级必须 PI 确认。

### AGA-P0-3 PI 中途介入语义完全未定义

- **证据**：WebSocket_Protocol 的 server→client 事件齐全，client→server 只有语义模糊的 `client.action`（cancel 是取消排队 job、中断运行 job 还是取消任务？未定义）；无 steering/interrupt 消息类型；PI 在 agent 执行长命令期间发消息的排队/合并/抢占规则无任何条款；审批竞态（PI 点批准时任务已超时）无处理规范。
- **后果**："PI 主导"是本系统第一设计原则，但 PI 在 agent 跑 30 天模型时**连方向盘都摸不到**。Zero 代码有 `shouldInterrupt` hook 和消息队列，实现有抓手，spec 层是空白。
- **修复**：Interaction_Model + WebSocket_Protocol 增加介入协议：三级语义（append：注入下轮 context / interrupt：中断当前工具调用后重规划 / abort：取消任务）；多消息 FIFO 合并规则；所有竞态以 server 端状态机为唯一真值，前端 optimistic UI 必须可回滚。

### AGA-P0-4 Prompt 注入威胁模型整体缺失

- **证据**：95 份活跃规范 0 次提及 prompt injection（全库 grep 证实）。Sandbox 防命令危险，Config_Secrets 防 secret 泄露，但**仓库文件内容、数据文件、job 日志、stderr 进入 LLM context 时的信任分级不存在**。Repo Explorer 的职责就是读仓库内容喂给 Coordinator/Coder——这是主注入通道。
- **后果**：一段藏在数据 README 或代码注释里的指令文本，可以驱动 agent 在沙箱允许范围内做任何事（提交 job、写 note 投毒记忆、在报告里塞结论）。路径沙箱防不了这个——攻击面在 context，不在文件系统。
- **修复**：新增 `03_SPEC/Context_Trust_And_Injection_Spec.md`：内容信任分级（PI 输入 > PI-accepted 对象 > 确定性 artifact 摘要 > 仓库/数据/日志原文）；不可信内容进 context 必须带来源标记与隔离包裹；高影响动作（提交 ChangeRequest、写 note）不得以不可信内容为唯一依据。

### AGA-P0-5 Agent 行为 eval 体系缺失

- **证据**：Testing_Strategy 五层测试全部面向确定性组件；LLM 相关测试归入 nightly/manual 且"失败创建 issue，不阻塞 release"（[CICD_Release §8](../04_IMPLEMENTATION/CICD_Release.md) + [Performance_Test_Plan §7](../04_IMPLEMENTATION/Performance_Test_Plan.md)）；W8 E2E 的通过标准是"演示流程走通"，无 golden 任务集、无成功率下限、无行为期望断言、无 flaky eval 处理规则。
- **后果**：prompt 改一行、模型升一版，Coordinator 从"保守诊断"变成"激进重试"，没有任何机制能发现。行为回归是 agent 系统的"单元测试"，缺了它，其他 95 分的测试体系测的都是管道而不是系统。
- **修复**：新增 `04_IMPLEMENTATION/Agent_Behavior_Eval_Spec.md`：golden 任务集（含"编译失败应诊断而非重试>2 次""高风险变更应生成 bundle 而非绕行"等行为断言）；N 次重复的成功率 gate；prompt/model 变更必跑；eval 失败阻塞的范围规则。

## 4. P1 发现（显著风险）

| ID | 发现 | 证据 | 修复方向 |
|---|---|---|---|
| AGA-P1-1 | VerificationCase 期望值自出自判：expected_result/pass_criteria 制定者无独立性要求，agent 可定宽松标准让自己的推导通过 | [Verification_Case_Spec §2](../03_SPEC/Verification_Case_Spec.md) | expected_result 增加来源分级（analytic / published / pi_provided / agent_proposed）；agent_proposed 的 pass_criteria 必须 PI gate 确认 |
| AGA-P1-2 | Reviewer 数学正确性职权不明：清单只查 symbol/unit/跳步（语法层），推导逻辑对错无人担保 | [Roles_and_Boundaries §7C](../02_ARCHITECTURE/Roles_and_Boundaries.md) | 二选一并写明：Reviewer(L) 负责推导合理性但结论仍属 PI，或显式声明数学正确性由 PI/human 承担、Reviewer 只做完整性 |
| AGA-P1-3 | LLM provider 故障零覆盖：Error_Handling 无 LLM 错误类别，告警无 ALERT-LLM-*，Runbook 10 个场景无一涉及 LLM | Error_Handling_Spec / Alerting_Thresholds_Spec / Operations_Runbook | Error_Handling 增加 `llm_provider_error` 类别（限流→退避→park；配额尽→block+通知）；新增 ALERT-LLM-ERROR/LATENCY/QUOTA；Runbook 增加 provider 故障与成本失控两个 scenario |
| AGA-P1-4 | 上下文工程无规范：各阶段进 context 的内容范围、tail 截断行数、超限压缩策略、resume prompt 组装均无 spec | [Sandbox_and_Executor §5](../03_SPEC/Sandbox_and_Executor.md) 只分了 raw/tail/summary 三层，无字节/行数/过滤规则 | 在 Park_Resume + Sandbox spec 中补 context 组装契约（Brief/Resume/Report 阶段各自的内容白名单与预算） |
| AGA-P1-5 | Prompt 生命周期缺失：prompt_pack 只是 StackLock 里的字段名，无版本化、变更审查、回归触发流程 | 全库仅 4 处提及 prompt_pack，均为字段引用 | prompt 变更 = 行为变更：进 CI diff 检查，触发 eval 子集（依赖 AGA-P0-5） |
| AGA-P1-6 | Memory/Skill 信任模型不完整：draft note 被检索时无状态标记进 context；skill 含可执行脚本却在生命周期中移除审查环节；Auth 的 denied_actions 引用不存在的 "verified memory write"（MemoryNote 无 verified 字段，实为 draft/accepted/retired） | [Memory_Skills_Lite §1](../03_SPEC/Memory_Skills_Lite.md)/§6/§8；[User_Session_And_Audit_Schema §5](../03_SPEC/User_Session_And_Audit_Schema.md) | 检索结果强制携带 status 并在 prompt 中区分展示；skill draft→active 需工程师 review 记录（轻量，一行审批即可）；术语统一为 accepted |
| AGA-P1-7 | 决策理由不可观测：ActivityFeed 只展示结果不展示"为什么"；日志 redaction 一刀切禁存 prompt；observability 无 agent 行为指标 | [Interaction_Model §4.B](../02_ARCHITECTURE/Interaction_Model.md)；[Log_Aggregation_Spec §2](../03_SPEC/Log_Aggregation_Spec.md)；[Observability_Monitoring_Spec §3](../03_SPEC/Observability_Monitoring_Spec.md) | agent 决策事件增加 rationale 摘要字段；LLM 请求-响应对脱敏后可选留存 N 天供审计；新增指标：no-progress 触发率、closure 分类分布、每任务重试率 |
| AGA-P1-8 | 前端无法区分"Coordinator 在思考 / job 在运行 / 连接断了"：无 agent.turn 生命周期事件，无 budget 超限、no-progress 计数的 WebSocket 事件 | [WebSocket_Protocol §3](../03_SPEC/WebSocket_Protocol.md)；[Frontend_State_Design §10](../03_SPEC/Frontend_State_Design.md)；[UX_Design_Spec §5.1](../03_SPEC/UX_Design_Spec.md) 反馈矩阵未含 LLM 推理档位 | WebSocket 增加 `agent.turn_started/completed`、`agent.budget_status`、`agent.no_progress` 事件；UX 反馈矩阵补"LLM 推理中"档位 |

## 5. P2 发现（应修但不紧急）

| ID | 发现 | 修复方向 |
|---|---|---|
| AGA-P2-1 | `evidence_usable` 标记的赋予者与时机未定义（agent 能否标记自己的产物） | Artifact_Registry 补权限规则：LLM 生成物默认不可 evidence_usable，需确定性来源或 PI 确认 |
| AGA-P2-2 | 报告引用 artifact 的存在性是事后校验，无生成时防线（幻觉路径先入文再被抓） | report 组装管道在渲染前逐引用校验（确定性代码，不贵） |
| AGA-P2-3 | agent 经 SQL 汇总 DuckDB 指标，无参数化/只读连接约束 | Data_Storage_Provenance 补：agent 侧连接只读 + 查询参数化 |
| AGA-P2-4 | AnalysisPlan 参数集由 agent 生成，"只生成有利参数集"的遗漏偏差检测不到 | 参数空间生成依据入 plan 记录；报告 limitations 必含"未覆盖的参数区域" |
| AGA-P2-5 | `accepted_for_search` 一次批准后同 bundle 可启动多次目标不同的 search | bundle 批准时绑定参数空间声明，超出声明的 search 需重新 preflight |
| AGA-P2-6 | Performance NFR 对 agent 单轮推理延迟无目标也无显式豁免，`max_no_progress_steps: 3` 的时间语义悬空 | 补 advisory 目标（如单轮 P95 ≤ 60s）或显式声明豁免及理由 |
| AGA-P2-7 | 幂等体系对 LLM 步骤的适用边界未显式声明（现设计实际已隔离——重试=重新生成，限于 draft 单元） | Idempotency spec 补一节显式声明，把隐含设计变成契约 |
| AGA-P2-8 | ReportAssertion 机制存在但 MVP 覆盖可选，llm_summary 与 deterministic 的分离在导出物中依赖执行纪律 | Phase 5 激活时把"关键指标必须有 assertion"从建议升为 validator |

## 6. 已做对的部分（审计的另一半职责）

以下设计在 agent 系统语境下是**正确且不常见**的，实现时不要退化：

1. **权力倒置**：PI 决策 / agent 执行，成功标准 = 省时间不是自治程度——绕开了 LLM 科学判断不可靠的根本问题。
2. **恢复领域对象而非对话历史**：parked_state/TaskSnapshot 从磁盘重建 context，不依赖 LLM 上下文窗口存续（[Park_Resume §6](../03_SPEC/Park_Resume_Design.md)）。
3. **LLM 不确定性被隔离在草稿单元**：报告生成失败不删 RunRecord，重试=重新生成且只影响 draft（[Error_Handling §107](../03_SPEC/Error_Handling_Spec.md)）。
4. **具名 gate 是机器强制**：PI gate agent 调用 403、language guard 阻断状态迁移 422、search preflight 409——不是 prompt 恳求。
5. **结构化证据流**：agent 间不用自由文本传话，Coordinator 只读 RunRecord/manifest，幻觉进不了证据位。
6. **PI comment `generalization_allowed=false`**：单次批注不会被泛化成系统级事实。
7. **secret redaction 框架完整**；**budget 软监控**（不硬杀半途任务）对科研场景是正确取舍。

## 7. 交叉校验记录（取证结论的校准）

| 簇结论 | 校准 |
|---|---|
| "报告 LLM 叙述与确定性引用无分离标记" | **降级**：ReportAssertion.generated_by + evidence_level 五级已定义（[Report_Review_And_Evidence_Lineage §2](../03_SPEC/Report_Review_And_Evidence_Lineage_Spec.md)）；真实缺口是 MVP 覆盖可选 + 生成时校验时机（→ AGA-P2-2/P2-8） |
| "Agent 行为治理无强制机制" | **部分驳回**：PI gate/language guard/preflight 均为 API/状态机强制；成立的部分是 [Playbook §4f](../04_IMPLEMENTATION/Scientific_Change_Playbooks.md) 类行为禁令与 semantic_level 分类无机器制衡（→ AGA-P0-2） |
| "模型版本完全无记录" | **修正**：cost_record 有 provider/model（计费粒度）；缺的是复现锁与 release baseline（→ AGA-P0-1 表述已按此校准) |

## 8. 修复路线建议

> **修复状态（2026-07-02）**：下表全部动作已完成**文档层**修复——2 份新 spec 已创建并注册
> （MASTER_INDEX / [CANONICAL_CONTRACTS §15](CANONICAL_CONTRACTS.md) / Phased_Spec_Activation），P0-1..5、P1-1..8、P2-1..8
> 对应 patch 已落入各归属文件（多数补丁带 `AGA-*` 行内标记可 grep 定位，其余为对应文件的新增小节，
> 如 [Interaction_Model §7.1](../02_ARCHITECTURE/Interaction_Model.md)、[Operations_Runbook §10-11](../04_IMPLEMENTATION/Operations_Runbook.md)、CICD_Release 的 llm_baseline/behavior_eval）。
> "建议时机"列仍然有效：它现在指对应**实现**的激活时机，而非文档修改时机。

**新增 spec 仅 2 份**（其余全部 patch 进现有文档，避免文档继续膨胀）：

| 动作 | 文件 | 对应发现 | 建议时机 |
|---|---|---|---|
| 新增 | `03_SPEC/Context_Trust_And_Injection_Spec.md` | P0-4, P1-4 | Phase 2 前（Repo Explorer 上线即是注入面打开时） |
| 新增 | `04_IMPLEMENTATION/Agent_Behavior_Eval_Spec.md` | P0-5, P1-5 | Phase 2 起积累 golden 集，Phase 6（W8 LLM 接入）前必须激活 |
| Patch | Minimal_Schemas（StackLock.llm 字段）+ Dependency_Versioning_Policy + CICD_Release | P0-1 | 立即（schema 根，晚改代价指数增长） |
| Patch | Scientific_Change_Gating_Spec + Roles_and_Boundaries（path→level 映射与制衡） | P0-2 | 立即（治理链完整性） |
| Patch | WebSocket_Protocol + Interaction_Model + Frontend_State_Design（介入协议 + agent 生命周期事件） | P0-3, P1-8 | Phase 2 |
| Patch | Error_Handling + Alerting_Thresholds + Operations_Runbook（LLM 故障类别/告警/runbook） | P1-3 | Phase 2 |
| Patch | Verification_Case_Spec + Roles_and_Boundaries（期望值来源分级、Reviewer 职权声明） | P1-1, P1-2 | Phase 3 追加激活时 |
| Patch | Memory_Skills_Lite + User_Session_And_Audit_Schema（信任标记、术语统一、skill 审查） | P1-6 | Phase 3 |
| Patch | Log_Aggregation + Observability_Monitoring（rationale 留痕、agent 行为指标） | P1-7 | Phase 2-3 |
| Patch | 其余 P2 各归属文件 | P2-* | 对应 Phase 激活时 |

**排序原则**：schema 根（P0-1）和治理链完整性（P0-2）是"晚改代价指数增长"的，立即做；介入协议和注入防护跟随 Phase 2（执行闭环上线即暴露）；eval 体系必须赶在任何真实 LLM 接入之前。

---

*审计方法说明：6 个并行审查单元分别覆盖执行运行时、交互前端、记忆成本可观测、测试实施 CI、科学分析治理、数据 artifact 报告六个文档簇；主审对簇结论与 canonical spec 原文交叉校验后定级。本报告为 advisory，逐项采纳与否由 PI/工程师决策。*
