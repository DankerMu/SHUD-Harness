# PI Decision Comments 规范

**状态：** v0.8.1 设计补充  
**适用范围：** PI gate、EvidenceReport、MemoryNote、audit log、Workbench approval UI  
**目标：** 让 PI 在 approve / reject / request_revision 时留下科学判断和上下文批注，使决策可复盘、可审计、但不被 Agent 自动泛化。

## 1. 背景

PI 的判断经常不是简单“接受/拒绝”。例如：

```text
这个 peak timing error 可能是 forcing 插值导致，不一定是模型结构问题。
该参数集可作为 ccw tiny 实验候选，但不能写入默认配置。
该报告可用于内部讨论，但不能作为论文结论。
```

因此 PI gate decision 必须支持自由文本 comment。

## 2. Canonical endpoint

推荐 canonical API：

```http
POST /api/pi-gates/:gateId/decision
```

Body：

```json
{
  "decision": "approved",
  "comment": "同意该结果仅作为 ccw tiny benchmark，不作为模型结构验证。",
  "next_action": "generate_patch_bundle",
  "evidence_refs": [
    "reports/REPORT-001.md",
    "runs/RUN-001/metrics.yaml"
  ]
}
```

`POST /api/tasks/:id/approve` 可保留为 MVP convenience endpoint，但内部应委托给 canonical PI gate decision handler。

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

## 7. UI

PI gate card 应包含：

```text
Decision buttons:
  Approve
  Request revision
  Reject

Comment textarea:
  optional for simple approve
  required for reject / revision / high-risk approve

Evidence refs:
  report
  selected run records
  selected artifacts
```

MVP 不做行级批注。后续可扩展为 observation-level comment。

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

Agent 永远不能调用该 endpoint 成功通过权限检查。

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
