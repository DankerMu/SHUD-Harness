---
status: accepted
kind: process
---

# ADR-0014: M4 Epic 回放 PI 功能验收

本记录先登记为 proposed，再依据下述 PI 明确通过与收口授权转入 implemented / accepted；不以自动工程审批代替这一决定。

## 背景与依据

[ADR-0010](../implemented/0010-m3-epic-acceptance.md) 的 M3 安排不自动推广。M4 按 [Epic-close PI acceptance for replay](../../../openspec/specs/known-answer-replay/spec.md#requirement-epic-close-pi-acceptance-for-replay) 在 [#549](https://github.com/DankerMu/SHUD-Harness/issues/549) / [Epic #515](https://github.com/DankerMu/SHUD-Harness/issues/515) 收口时统一验收 CR → base/candidate build/run → VerificationCase → EvidenceReport 的实际 Web 链路；本记录登记既定时点，不新增或扩大合并、审批例外。

PI 授权后，`openspec archive m4-mvp-2 --yes` 已在启用同步与校验的情况下完成；原设计与任务保留于 [M4 archive](../../../openspec/changes/archive/2026-11-05-m4-mvp-2/design.md)，现行要求以上述 canonical spec 为准。归档目录日期不用于改写原始验收事件日期。

## 验收安排

1. 各子 PR 仍须完成规定工程验证、风险对应审查及 CI；子 PR 合并、`shud:replay` 的自动 Allow once、#517 的 ADR 确认均不是 M4 PI 功能验收。
2. PI 必须在 Web 亲自操作至少一次 CR 审批卡和一次报告审批卡，并明确给出阶段结论。Agent 不得代批，不得以脚本事件、报告 accepted 或工程 PASS 推导 PI 验收；重导出切片是否成功以实际记录为准，不预设模型能力。
3. [M4 PI acceptance](../../Migration_Plan_dsh.md#m4-pi-acceptance) 发布 session、CR/build/run/verification/report ID、同调用 asked/decided 序列、最终决定与限制；自动工程会话另列。按本地证据契约保留原件，不强制入库、改写已消费证据或仅以本地路径代替审查摘要。
4. PI 明确通过后才将本 ADR 从 proposed 转入 implemented / accepted，并授权 #549、Epic #515 与 OpenSpec 收口。可选人工 Reject 分支未执行不冒充覆盖，也不新增为必需场景。

## 工程门与适用边界

既定 [Replay acceptance criteria](../../../openspec/specs/known-answer-replay/spec.md#requirement-replay-acceptance-criteria) 及本机 `shud:replay` 阻断门不变；`pnpm run check`、适用 smoke、审查与 CI 不因 PI 通过而豁免。`shud:restart` 仍独立要求 delivered，worker 等待/收集不能替代该门。raw 保护、角色权限、物理方程/默认参数/benchmark 的 PI 审批与科学判断权不变；本安排仅限 M4 Epic #515，不推广其它 proposed ADR。

收益是 PI 验收完整用户链路而非重复验收工程切片；代价是需要明确分账工程通过与功能接受，并保留中途失败及修复来源。停止于工程 PASS 会遗漏真实审批与解释边界，要求额外多线程或科学证明则会扩张已裁定的本次功能验收范围，两者均不采用。

## PI 验收结论

收口对话日期为 2026-11-05。PI 在逐步确认并亲自允许修复 CR 与报告后明确表示「好的，本项通过，M4还有要验收的嘛」，在获知必需场景完成后授权「ok，那就收尾m4，完成剩余工作，停止服务」。原始事件的 `2026-11-06` / `Z` 时间戳及 ID 按原件保留，不推算时区或改写日期；决定 `DEC-20261106T032106-d5dd` 的原始时间为 `2026-11-06T03:21:06.158Z`。

最终链为 `CHG-20261106T023649-3ff0` approved → `BUILD-20261106T024305-265a` / `RUN-20261106T024721-0907` → `VC-20261106T030226-e84c` passed / compatible → `REPORT-20261106T031230-7f3c` accepted → `TASK-20261106T004614-fca9` done。报告经 15 项 pass（4/10/11 vacuous）后由手工 `report_submit` 审批写入决定，没有 `report_decide` 调用；详见上述证据账本。

初始 candidate 的 requested 1 / configured-banner 2 不满足 N=1 前提；保留旧 CR/build/run，经新 CR、人工审批、fresh build/run 修复，不追认旧候选合格。最终仅证明固定 keliya 输入、窗口 12053–12143 的 rivqdown 产物在 SERIAL base 与启用 StrictOMP、单线程请求/配置/banner candidate 间一致；未测量 in-region team size，不证明多线程正确性、跨线程确定性、一般等价、性能或科学有效性。

PI 知悉 notify unreachable/3，闭环依赖显式等待/收集；numerical_health / peak_memory 为 null、DY.dat 空、time.csv 排除、wall_seconds 非求解器耗时。报告历史「实跑 2」措辞及 Task 初始标题/goal 保留并由账本限定含义，不成为额外验收要求。未合入上游 SHUD/submodule/candidate patch；不把功能接受当作每句报告解释正确。服务停止与原件保留按 PI 授权另记于账本，不以关闭服务改写运行证据。
