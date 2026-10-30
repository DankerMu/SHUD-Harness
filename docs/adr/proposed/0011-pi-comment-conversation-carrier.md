---
status: proposed
kind: architecture
---

# ADR-0011: PI comment 经对话承载、二次审批卡确认

## 背景与依据

M3 的报告终态需要 PI 明确决定与可关联的审计证据，但钉版 dsh 原生审批卡没有 comment 表单。宿主审批结果 `allowed-once | rejected | cancelled | unavailable` 与报告领域结果 `accepted | rejected | revision_requested` 是两个不同的契约：卡片拒绝不等于报告 rejected，也不自动表示需要修订。

本记录说明 [M3 design D9 候选 (a)](../../../openspec/changes/m3-mvp-1/design.md#d9-审批接线report_submitreport_decide-与-pigatedecisioncritical-path-3) 的工具侧实现选择。依据为 [#447](https://github.com/DankerMu/SHUD-Harness/issues/447)、[#426 O5 的已审阅结论](https://github.com/DankerMu/SHUD-Harness/issues/447#issuecomment-6463590574) 与 [PI 批准的最小 raw 路由扩展](https://github.com/DankerMu/SHUD-Harness/issues/447#issuecomment-6525339104)。O5 确认工具公开执行上下文提供 callId，不提供 approval id。这些依据不代表本 ADR 已独立获 PI 接受；状态仍为 proposed。

字段和对话规则的权威源仍为 [PI Decision Comments §7–8](../../03_SPEC/PI_Decision_Comments_Spec.md#7-dsh-审批卡字段) 与 [evidence-reports](../../../openspec/changes/m3-mvp-1/specs/evidence-reports/spec.md)，本记录不另建 schema 或审批服务。

## 选择与所有权

1. coordinator 调用 `report_submit(report_id)`。已安装的 raw-guard 先保护确切报告 JSON/Markdown 与关联 TaskCard；policy-gate 在角色拒绝规则之后返回 ask，宿主 approval 服务决定是否执行。只有 `allowed-once` 的本次执行可写 `accepted`、`comment: null`，并将 TaskCard 转为 done。
2. submit 卡被拒绝、取消或不可用时，工具不执行，报告仍为 reviewed、TaskCard 仍为 reporting，不写任何 PiGateDecision。卡片结果不能由工具、模型或后台回调解释为领域拒绝。
3. coordinator 在同一会话对话中取得 PI 的非空 comment **与明确的** `rejected` 或 `revision_requested`。任一项缺失都不调用 decide，不默认、不推断 disposition。coordinator 指令的交付归其独立 preset 切片；本工具只接受闭合参数并拒绝缺失值。
4. `report_decide(report_id, disposition, comment)` 的第二张审批卡由已有 policy 展示 disposition 与 comment 全文。PI 核对转述并选择 `allowed-once` 后，工具逐字保存原 comment（包括空白与换行），写对应领域终态，并将 TaskCard 转为 cancelled 或 planned。若第二张卡未获确认，仍不执行、不写决定；需要纠正转述后重新请求确认。

工具本身不调用 `ctx.approval`，不订阅审批日志，不增加模型可提供的 approval_ref、decision_id、时间或先前被拒卡引用。决定使用 core 的 DEC 分配与严格 PiGateDecision schema、records 的 `applyDecision` 和合法 `transitionTask`，而不是第二套状态机。

## 审计关联与发布边界

`decision_history[].approval_ref` **精确复制本次已获准执行的 `exec.callId`**。宿主 session log 的审计链为：

```text
PiGateDecision.approval_ref = approval/asked.callId
approval/asked.id          = approval/decided.id
```

callId 不是 approval id，也不直接承载 actor/gate 身份。先前被拒 submit 卡不进入决定对象；同一会话中，两张卡 reason 的同一 report_id 用于关联先前拒绝与后续决定。`displayReason` 是供 PI 核对的展示内容，不作为持久日志证据；不新增 AuditEvent 文件或日志订阅者。

获准执行后先完成独立入口卡片/Markdown 修复，再检查新鲜 reviewed 状态与空历史；随后按报告 JSON → 新鲜同步 TaskCard 转换/写入 → Markdown 顺序发布。JSON 是权威提交点，后续失败保留此前提交并返回受控步骤/report_id，不自动回滚或重试。下次同报告调用先修复持久终态再拒绝错误前态，不补第二条决定。已链接的旧报告入口修复不能移动新报告所属卡片状态；正常获准的 reviewed 决定不额外限制为“最后一份报告”，也不重复 validator 或 closure。

四个报告工具在工具包内共用按物理 cwd/report_id 标识的单进程 promise lane，覆盖入口修复和最终异步 Markdown 发布。生成在新 JSON 提交后、任何 yield 前登记该 id 的后续发布；所有卡片读取—转换—写入仍同步。审批卡等待发生在 lane 外，不同报告可独立推进，失败释放后继操作，已完成尾项移除。这不是跨进程事务或持久锁。

## 备选方案与代价

- **等待或新增 form seam（D9 候选 b）**：可减少转述，但当前钉版宿主没有该入口；为 M3 fork 宿主或发明表单协议会越过 seam-only 边界。
- **PI 专用决定工具（候选 c）**：当前没有已证明的 PI-only 调用入口；给 agent 一个名义上的 PI 工具不能形成独立授权。
- **把 submit 卡 rejected 自动映射为 rejected/revision_requested**：丢失明确处置与 comment，也混淆宿主结果和领域结果，因此不采用。
- **读取日志取得 approval id，或让模型传入审批引用**：分别产生第二套日志消费者或可伪造的授权来源；O5 已提供精确 callId 审计 join，无需这些机制。

选择 (a) 复用现有卡片/策略/宿主权限边界，代价是多一轮对话与第二次确认。PI 必须检查完整转述，系统不对 comment 做科学语义判断，也不把 comment 自动提升为 observations、物理机制或跨任务结论。

## 证据与限制

伴生测试位于 `packages/dsh-shud-tools/src/report-decisions.test.ts`、`report-decision-contract.test.ts`、`report-decision-publication.test.ts`、`report-decision-ordering.test.ts` 与 `report-decision-raw.test.ts`，使用真实 ToolRuntime、已挂载 policy/raw、宿主 approval 边界 double 与真实工作区文件，覆盖终态、拒绝、身份、部分提交/修复、共享发布顺序和 raw-before-ask。

这些测试不证明真实 Web 卡展示、session-log 持久化或 PI 功能验收；approval double 的入参和 logger buffer 不是持久审计证据。真实端到端审计/PI 验收仍由相应验收切片承担。也不宣称防止 PI 自己用 bash 编辑文件、跨进程竞争或外部文件命名空间替换。接受一份报告不是认可普遍科学结论，且本 ADR 的 proposed 状态不因工程测试通过而改变。
