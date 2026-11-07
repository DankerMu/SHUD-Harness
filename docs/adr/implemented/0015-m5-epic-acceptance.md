---
status: accepted
kind: process
---

# ADR-0015: M5 工程合并流程与 PI 功能验收分离

## 背景与依据

根工程规则要求 Epic 统一收口验收须有已接受 ADR，既有例外只覆盖已收口的 Epic。M5 [#639](https://github.com/DankerMu/SHUD-Harness/issues/639) 原安排让子 PR 先按工程门合并，而 [#674](https://github.com/DankerMu/SHUD-Harness/issues/674) 又在 #673 后才起草 proposed ADR、等 #675 功能验收后转 accepted；两者形成流程授权的时序缺口。

PI 在 2026-11-07 的本次 issue 队列对话中明确选择「先接受 M5 流程 ADR」，未选择「逐 PR 验收」。选项内容是：先登记并接受仅限 #639 的流程例外，子 PR 工程闸通过后合并；PI 功能验收仍由 #675 在最终 Web 操作后完成；同步 #674 的时序与状态约定，不代表 M5 功能已验收。公开记录见 [#674 决定记录](https://github.com/DankerMu/SHUD-Harness/issues/674#issuecomment-6707660269) 与 [Epic 决定记录](https://github.com/DankerMu/SHUD-Harness/issues/639#issuecomment-6707660585)。这是一项明确流程授权，不由 agent 从工程 PASS 推导。

## 决定与适用范围

1. 本决定仅限 M5 Epic #639，不推广到其它里程碑或其它 proposed ADR。#674 提前于代码队列完成，不再依赖 #673；本 ADR 的 accepted 表示 PI 已接受工程合并安排，不表示 sensitivity 功能已验收。
2. 子 PR 完成规定工程验证、风险对应审查及 CI 后可合并，对应工程 issue 可关闭。工程门包括 `pnpm run check`、适用的本机 `shud:tiny` / `shud:first-task` / `shud:replay` / `shud:restart` / `shud:sensitivity`、Critical Path reviewer 白盒审查、同 head 的 `all-checks-passed`。没有跳过、放宽或新设豁免。
3. 功能验收仍只在 [#675](https://github.com/DankerMu/SHUD-Harness/issues/675) 收口时由 PI 亲自执行：在 `dsh --profile shud` Web 内完成 sensitivity 建卡、analysis_create、绑定 plan 的逐 pset 运行/收集与报告生成/校验，并亲自对报告审批卡作出放行决定，再明确给出功能结论。
4. 工程自动 Allow once、子 PR 合并、工程 issue 关闭、报告 accepted 与本 ADR accepted 均不替代 PI 实际操作和功能结论。agent 不得代批，不用模拟或脚本事件冒充 PI 会话。
5. PI 明确功能通过前，#639/#422/#675 保持 open，`m5-oat-sensitivity` 不归档。通过后在本 ADR 追加功能验收证据链接，按 #675 同步 canonical specs 与链接、由 PI 关闭 #422 并收口 Epic；不再重复首次接受流程 ADR 的状态迁移。PI 不通过时保留原失败证据，修复 PR 关联本 Epic，仍不收口。

## 证据与科学边界

工程判据唯一来源为 [Sensitivity acceptance criteria](../../../openspec/changes/m5-oat-sensitivity/specs/oat-sensitivity/spec.md#requirement-sensitivity-acceptance-criteria)，功能验收契约见 [Epic-close PI acceptance for sensitivity](../../../openspec/changes/m5-oat-sensitivity/specs/oat-sensitivity/spec.md#requirement-epic-close-pi-acceptance-for-sensitivity)。本记录不复制或改写工程判据；`shud:sensitivity` exit 1/2 分类、重复运行不一致即 FAIL、`shud:restart` 必须 delivered 的要求不变。

PI 功能会话的 session id、task_id、analysis_plan_id、各 run_id/parameter_set_id、report_id、汇总文件路径、审批 callId 与 approval/asked|decided 摘录，记入 `docs/Migration_Plan_dsh.md` 的 M5 验收节；与 shud:sensitivity 自动审批工程会话分别记账。按 [ADR-0009](0009-local-evidence-boundary.md) 保存本机原件，公开可审查摘要，不重写已消费的证据字节。

措辞只限 ccw 单流域、90 天窗口、相对 baseline 的变化；参数范围标为 agent 建议值。不作模型改进或校准结论，不给敏感性指数、排名、机制解释或普遍化结论。raw 保护、角色权限、运行时审批、物理方程/默认参数/benchmark 的 PI gate 与科学判断权均不改变。

## 取舍与恢复

收益是提前消除子 PR 工程交付与 Epic 功能验收之间的授权时序冲突，让 PI 在完整用户链路上验收，而不重复验收工程切片。代价是必须严格区分两个状态：流程已接受，功能尚待验收。逐 PR 功能验收作为备选未被 PI 选择；先合代码后补授权也不采用。若 PI 撤销该安排，后续未合并 PR 恢复逐 PR 验收，不追认或篡改已有工程/功能证据，另行登记替代决定。

## 接受记录与当前状态

本记录先在 proposed 起草，再依据上述 PI 2026-11-07 明确选择转入 implemented / accepted。接受仅确认本记录的流程安排；**M5 功能尚未验收**，无 PI Web 功能通过记录，Epic、#422、#675 与 change 均未收口。
