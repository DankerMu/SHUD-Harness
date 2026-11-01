---
status: frozen
canonical_for: [pi-decision-verbs, pi-decision-memory-note]
---

# PI Decision Comments 规范

**状态：** v0.8.1 设计补充  
**适用范围：** PI gate、EvidenceReport、MemoryNote、audit log、dsh 审批卡  
**目标：** 让 PI 在接受、拒绝或要求修订时留下明确决定与上下文批注，使决策可复盘，但不被 Agent 自动泛化。

## 1. 背景

PI 的判断经常不是简单“接受/拒绝”。例如：

```text
这个 peak timing error 可能是 forcing 插值导致，不一定是模型结构问题。
该参数集可作为 ccw tiny 实验候选，但不能写入默认配置。
该报告可用于内部讨论，但不能作为论文结论。
```

因此 PI gate decision 必须支持自由文本 comment。

## 3. Decision enum

M3 报告 PiGateDecision 的 outcome 为 `accepted | rejected | revision_requested`，与对应报告终态同名；这是领域结果，不是宿主审批 outcome。宿主 `allowed-once` 只授权执行本次工具，`rejected` 不自动映射为报告 rejected 或 revision_requested。具体双卡流程见 §7。

## 4. Comment 必填规则

| M3 场景 | comment |
|---|---|
| report_submit 获 allowed-once，accepted | null |
| report_decide(rejected) 获 allowed-once | 必填非空 |
| report_decide(revision_requested) 获 allowed-once | 必填非空 |
| 任何工具审批未放行 | 工具不执行，不写领域决定 |

高风险科学变更的额外 comment 要求仍见 [Scientific Change Gating §5](Scientific_Change_Gating_Spec.md#5-comment-required-rules)，属于后续科学变更链，不把这些动作伪装为普通 M3 报告接受。

## 5. PiGateDecision schema

M3 的字段契约为 [evidence-reports / PiGateDecision](../../openspec/specs/evidence-reports/spec.md#requirement-pigatedecision-record)，schema 已同步 [Support_Schema_Contracts](Support_Schema_Contracts.md) 与 Minimal_Schemas。本文不再保留旧 gate_id/actor/decision 字段的第二套接口。`approval_ref` 固定取本次执行 callId，审计关联见 §8。

本文的 **PiDecisionMemoryNote 是后续记忆对象权威源**（Minimal_Schemas 中为其投影），不是 M3 PiGateDecision 的替代持久化路径。

## 6. MemoryNote(type=pi_decision)

MemoryNote 属于后续 M6 记忆评估，M3 不生成；若后续保存 PI comment，必须保持任务级范围：

```ts
interface PiDecisionMemoryNote {
  type: "pi_decision";
  note_id: string;
  task_id: string;
  report_id?: string;
  gate_id: string;
  decision: "approved" | "rejected" | "request_revision";
  comment: string;
  evidence_refs: string[];
  scope: "task" | "report" | "run" | "analysis_plan";
  evidence_level: "pi_confirmed";
  generalization_allowed: false;
  created_by: "pi";
  created_at: string;
}
```

Agent 可以在同一任务上下文中引用该决策记录，但不能把它自动提升为：

- 真实水文机制；
- 默认参数依据；
- 跨流域结论；
- 论文结论；
- validated evidence。

## 7. dsh 审批卡字段

M3 采用 design D9 候选 (a)：dsh 原生审批卡只放行/拒绝，comment 经同一会话对话承载，再以 `report_decide(report_id, disposition, comment)` 二次卡确认。不改宿主，不等新 form seam，也不新增 PI 专用工具。

1. coordinator 调 `report_submit(report_id)`，策略门返回 ask；allowed-once 执行后写 accepted、comment=null。
2. submit 卡未获放行时报告保持 reviewed，TaskCard 保持 reporting，不写 PiGateDecision。
3. coordinator 向 PI 索要非空 comment **及明确 disposition**（rejected 或 revision_requested）；任何一项缺失都不调用 decide，不把“拒绝＋comment”自动解释为修订。
4. coordinator 调 `report_decide`，二次卡完整回显 disposition/comment；只有 allowed-once 后才写决定与终态，TaskCard 分别变 cancelled/planned。
5. 二次卡被拒、取消或审批服务不可用时不执行工具、不写决定；先前被拒 submit 卡的字段不作为模型参数传入或写进决定对象。

| 字段/结果 | dsh seam 与 M3 含义 |
|---|---|
| allowed-once | 仅授权被询问的本次调用，不持久授权 |
| rejected / cancelled / unavailable | fail-closed，报告保持 reviewed，无领域决定 |
| ApprovalRequest.reason / displayReason | 策略门提供展示理由，不是 PI comment；decide 的卡片回显供 PI 核对的完整 comment |
| approval/decided | 只有 id/outcome，无 comment 字段 |
| approval_ref | 本次执行的 exec.callId；#426已证实工具拿不到approval id |

GR-003 在此路径的含义是不允许无 comment 的 rejected/revision_requested 终态；卡片拒绝本身不是报告终态。M3 不做行级批注；原始对话批注不得被自动提升为科学事实。

## 8. 审计

M3 审计使用宿主 session log，不另造 AuditEvent 文件或日志订阅器：工具执行 callId 对应 `approval/asked.callId`，再以 asked.id 关联 decided.id；工具成功结果与持久 decision_history 相互核对。submit 与 decide 的 reason 均含 report_id，便于同会话中关联前次未放行与后次决定。

只有本次获准执行的 callId 写入 approval_ref；不声称它直接携带 actor/gate 身份。Agent 只能转述 PI comment 与明确处置并提交二次卡，不能自行批准 PI 决定。

## 9. 报告 decision history

EvidenceReport 的 decision_history 只追加规范 PiGateDecision，完整字段/状态规则见 §5 的唯一契约；accepted 的 comment 为 null，其余终态保存 PI 确认的非空原文。旧报告终态不覆盖，修订后新 report_id 不继承旧决定历史。

Markdown 展示以 [Decision history Markdown projection](../../openspec/specs/evidence-reports/spec.md#requirement-decision-history-markdown-projection) 为权威契约：现有 §10 附录在各 Run 块之前增加 `### PI decision history`，按持久数组顺序展示 decision_id、report_id、outcome、decided_at、approval_ref、comment 六列，不排序、去重或推断决定，不增加第十一个二级标题。空历史显示 `No PI decision recorded.`，不生成占位决定。

comment 使用 JSON literal：null 显示为 `null`，字符串保留 JSON 引号与转义，因此字符串 `"null"` 不会与 null 混淆，原始空白和换行也不会丢失。六列均经既有结构化 metadata 规则单次转义，不能注入表格列、物理标题或 HTML；模板样式文本不递归插值。comment 不进入 observations，不因出现在报告中就成为科学结论。

报告 JSON 仍是提交与决定历史的权威源；approval_ref 仍是执行 callId，实际批准仍由 §8 的 session log 关联，Markdown 不构成新的审批 authority。新请求的规范渲染包含历史，但不扫描或自动重写旧 Markdown，不改变既有水印、终态历史约束、状态迁移或修复判据，也不修改源 JSON/引用记录的字节或修改时间。

## 10. 验收标准

- [ ] 缺少非空 comment 或明确 disposition 时不调用 report_decide；非法参数被工具校验拒绝，不用 REST 400/403 作为契约。
- [ ] report_submit/report_decide 只在 allowed-once 后执行；其他 outcome 或无审批服务时报告/卡片字节不变。
- [ ] decide 卡完整回显 disposition/comment；PI 未确认不落领域决定。
- [ ] decision_history 的 approval_ref 可经 session log callId/approval id 关联本次批准。
- [ ] M3 不生成 MemoryNote 或独立 AuditEvent；报告 §10 在 Run 块之前按持久顺序完整展示六字段，空历史为 `No PI decision recorded.`，不新增二级标题。
- [ ] accepted/null、rejected/revision_requested 的非空 comment 与字符串 `"null"` 按 JSON literal 区分；结构字符单次转义，重复渲染确定，源 JSON/引用记录的字节与修改时间不变。
- [ ] comment 不作为科学结论自动进入 observations；后续 MemoryNote 保持 generalization_allowed=false。
