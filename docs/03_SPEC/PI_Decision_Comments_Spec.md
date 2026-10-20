---
status: frozen
canonical_for: [pi-decision-verbs, pi-decision-memory-note]
---

# PI Decision Comments 规范

**状态：** v0.8.1 设计补充  
**适用范围：** PI gate、EvidenceReport、MemoryNote、audit log、dsh 审批卡  
**目标：** 让 PI 在 approve / reject / request_revision 时留下科学判断和上下文批注，使决策可复盘、可审计、但不被 Agent 自动泛化。

## 1. 背景

PI 的判断经常不是简单“接受/拒绝”。例如：

```text
这个 peak timing error 可能是 forcing 插值导致，不一定是模型结构问题。
该参数集可作为 ccw tiny 实验候选，但不能写入默认配置。
该报告可用于内部讨论，但不能作为论文结论。
```

因此 PI gate decision 必须支持自由文本 comment。

## 3. Decision enum

```text
approved
rejected
request_revision
```

报告状态可映射为：

```text
approved → accepted
rejected → rejected
request_revision → revision_requested
```

## 4. Comment 必填规则

| 场景 | comment 是否必填 |
|---|---|
| 普通 approve report | 可选 |
| reject | 必填 |
| request_revision | 必填 |
| approve scientific interpretation | 必填 |
| 将 calibration 结果标记为 validated | 必填 |
| 覆盖 benchmark baseline | 必填 |
| 修改默认参数 | 必填 |
| 应用影响论文结论的 patch | 必填 |

## 5. PiGateDecision schema

> 投影声明：PiGateDecision 字段事实源 = [Support_Schema_Contracts.md](Support_Schema_Contracts.md)，
> 本节为语义解释用投影；本文的 **PiDecisionMemoryNote 是权威源**（Minimal_Schemas 中为其投影）。

```ts
interface PiGateDecision {
  decision_id: string;
  gate_id: string;
  task_id: string;
  actor_user_id: string;
  actor_role: "pi";
  decision: "approved" | "rejected" | "request_revision";
  comment?: string;
  comment_required: boolean;
  next_action?: string;
  evidence_refs: string[];
  created_at: string;
}
```

## 6. MemoryNote(type=pi_decision)

PI comment 可以写入 MemoryNote，但必须保持任务级范围：

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

MVP 用 dsh 自带审批卡（ADR-0004 K7），PI gate 经 `tools/pre-execute` 返回 `ask` 进入 `ctx.approval`。
dsh 审批 seam 的词汇是封闭、单次的（源：`../deepseek-harness` `docs/persistence-catalog.md` `approval/*`、
`.agents/notes/implemented/feature/2026-07-06-approval-seam.md`）：

| 本规范 | dsh 审批 seam | 说明 |
|---|---|---|
| `approved` | `approval/decided` outcome = `allowed-once` | 只放行被询问的那一次调用，不持久授权 |
| `rejected` | outcome = `rejected` | 调用 fail-closed 拒绝 |
| `request_revision` | outcome = `rejected`（与 `rejected` 不可区分） | 审批卡只能放行/拒绝；修订要求的承载与 `comment` 同为开放项 |
| —（非 PI 决定） | outcome = `cancelled` / `unavailable` | 中止或通道缺失，fail-closed 拒绝，不写 PiGateDecision |
| 卡片展示的申请理由 | `ApprovalRequest.reason` / `displayReason` | 由发起方（策略门/agent）填写，**不是** PI comment |
| `comment` | 无字段 | `approval/decided` 只有 `{ id, outcome }`；PI comment 的承载方式（对话 turn 或 user-interaction seam）为开放设计项 |

**开放设计项（M3 审批接线前定）**：PI comment 与 `request_revision` 在该 seam 上无字段。候选：(a) 审批卡只承载放行/拒绝，comment 由 PI 在同一会话的下一轮对话给出，coordinator 以 `approval/decided` 的 `id` 关联写入 `PiGateDecision.comment`，并把"拒绝 + 有 comment"映射为 `request_revision`；(b) dsh 升级若提供 user-interaction / form seam，则在卡片上直接收 comment；(c) 提供 PI 专用 `pi_decide` 工具（agent 身份被策略门 deny），决定与 comment 一次写入。MVP 硬约束不变：reject / request_revision / high-risk approve 没有 comment 时 gate 不得关闭（GR-003）——按 (a) 实现时 coordinator 必须先索要 comment 再落 PiGateDecision。

MVP 不做行级批注。

## 8. 审计

每个 PI decision 必须写 audit log：

```yaml
audit_event:
  id: AUDIT-001
  actor_type: user
  actor_id: user_pi
  action: decide_pi_gate
  target_id: GATE-001
  decision_id: DECISION-001
  result: success
  timestamp: ...
```

Agent 永远不能自行做出 PI decision。

## 9. 报告 decision history

EvidenceReport 应追加：

```yaml
decision_history:
  - decision_id: DECISION-001
    gate_id: GATE-001
    decision: approved
    actor: user_pi
    comment: "同意仅用于 ccw tiny benchmark。"
    timestamp: ...
```

## 10. 验收标准

- [ ] reject/request_revision 缺少 comment 时 server 返回 400。
- [ ] Agent 调用 PI decision endpoint 被拒绝。
- [ ] PI comment 写入 audit log。
- [ ] PI comment 写入 MemoryNote，且 `generalization_allowed=false`。
- [ ] EvidenceReport export 包含 decision history。
- [ ] comment 不作为科学结论自动进入 observations。
