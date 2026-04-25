# WebSocket 协议

**状态：** P0 设计规范  
**适用范围：** `WS /ws/session/:sessionId`、AgentActivityFeed、RuntimeTerminal、CostMonitor、ResultsPanel  
**目标：** 固定实时事件 envelope、消息类型、payload 和断线恢复规则，使前后端可以并行开发。

## 1. 连接

```text
WS /ws/session/:sessionId?task_id=TASK-...&since_seq=123
```

连接建立后，服务端必须发送 `session.connected`，包含当前 session、用户权限、最新 seq 和可恢复范围。

## 2. 事件 envelope

所有消息使用统一 envelope：

```ts
interface WsEvent<T = unknown> {
  seq: number;
  event_id: string;
  type: string;
  session_id: string;
  task_id?: string;
  workspace_id?: string;
  run_id?: string;
  job_id?: string;
  timestamp: string;
  source: "server" | "coordinator" | "worker" | "coder" | "reviewer" | "job" | "tool" | "client";
  visibility: "user_visible" | "internal";
  payload: T;
}
```

`seq` 在 session 内单调递增。前端 reducer 应按 seq 应用事件，重复事件按 `event_id` 去重。

## 3. 主要消息类型

| 类型 | 方向 | 用途 |
|---|---|---|
| `session.connected` | server → client | 连接确认和恢复范围 |
| `session.heartbeat` | 双向 | 心跳 |
| `agent.message` | server → client | Agent 可见消息 |
| `agent.status` | server → client | Agent 状态变更 |
| `task.updated` | server → client | TaskCard 状态或字段变更 |
| `plan.created` | server → client | Coordinator 生成计划 |
| `tool.started` | server → client | 工具调用开始 |
| `tool.stdout` | server → client | stdout 分片 |
| `tool.stderr` | server → client | stderr 分片 |
| `tool.completed` | server → client | 工具调用成功 |
| `tool.failed` | server → client | 工具调用失败 |
| `job.submitted` | server → client | RunJob 已提交 |
| `job.status` | server → client | RunJob 状态更新 |
| `job.log` | server → client | job 日志分片 |
| `runrecord.created` | server → client | RunRecord 已生成 |
| `artifact.created` | server → client | 图表、metrics、patch、report 等 artifact 生成 |
| `report.draft_created` | server → client | EvidenceReport 草稿生成 |
| `pi_gate.required` | server → client | 需要 PI 审批 |
| `cost.updated` | server → client | token/tool/runtime 成本更新 |
| `client.ack` | client → server | 前端确认 seq |
| `analysis.progress.updated` | server → client | AnalysisPlan batch 进度聚合更新 |
| `report.export_ready` | server → client | EvidenceReport 导出文件已生成 |
| `pi_gate.decision_recorded` | server → client | PI gate decision 已记录 |
| `notification.status` | server → client | email notification sent/failed/skipped 状态 |
| `client.action` | client → server | 用户操作，如 approve、cancel、resume |
| `health.status` | server → client | 服务健康状态变更 |
| `ops.metric.updated` | server → client | 运维指标聚合更新 |
| `alert.raised` | server → client | 告警触发 |
| `alert.resolved` | server → client | 告警解除 |
| `ops.incident.created` | server → client | 运维事件创建 |
| `ops.incident.updated` | server → client | 运维事件状态变更 |
| `dependency.lock.updated` | server → client | DependencyLock 更新 |
| `requirements.coverage.updated` | server → client | 需求覆盖率更新 |

## 4. 日志分片

stdout/stderr/job log 使用分片发送：

```json
{
  "type": "job.log",
  "payload": {
    "stream": "stdout",
    "chunk_id": 42,
    "text": "CVODE step...\n",
    "offset": 8192,
    "truncated": false
  }
}
```

服务端也应将完整日志写入文件。WebSocket 只用于实时展示，不是唯一日志来源。

## 5. Agent 消息

```json
{
  "type": "agent.message",
  "source": "coordinator",
  "visibility": "user_visible",
  "payload": {
    "role": "coordinator",
    "title": "计划已生成",
    "markdown": "将运行 ccw tiny fixture，并检查 water balance。",
    "refs": [
      {"kind": "plan", "path": "tasks/TASK-001/plan.md"}
    ]
  }
}
```

Agent 消息不得包含未落盘的证据引用。若引用日志、图表或指标，必须提供 artifact ref。

## 6. PI gate 消息

```json
{
  "type": "pi_gate.required",
  "payload": {
    "gate_id": "GATE-001",
    "reason": "将 calibration 结果标记为 validated 需要 PI 审批",
    "required_role": "pi",
    "options": ["approve", "reject", "request_revision"],
    "evidence_refs": ["reports/REPORT-001.md"]
  }
}
```

前端必须根据用户权限决定是否显示 approve/reject 按钮。

### 6.1 PI gate decision recorded

```json
{
  "type": "pi_gate.decision_recorded",
  "payload": {
    "gate_id": "GATE-001",
    "decision_id": "DECISION-001",
    "decision": "approved",
    "has_comment": true,
    "report_id": "REPORT-001"
  }
}
```

### 6.2 Analysis progress updated

```json
{
  "type": "analysis.progress.updated",
  "payload": {
    "analysis_plan_id": "PLAN-001",
    "total": 9,
    "queued": 1,
    "running": 2,
    "collecting": 0,
    "succeeded": 5,
    "failed": 1,
    "cancelled": 0,
    "blocked": 0,
    "cells": []
  }
}
```

### 6.3 Report export ready

```json
{
  "type": "report.export_ready",
  "payload": {
    "report_id": "REPORT-001",
    "export_id": "EXPORT-001",
    "format": "html",
    "download_url": "/api/reports/REPORT-001/export?format=html",
    "status_at_export": "draft"
  }
}
```

### 6.4 Notification status

```json
{
  "type": "notification.status",
  "payload": {
    "notification_id": "NOTIFY-001",
    "channel": "email",
    "trigger": "report_draft_created",
    "status": "sent"
  }
}
```

## 7. 成本事件

```json
{
  "type": "cost.updated",
  "payload": {
    "task_id": "TASK-001",
    "llm_tokens_in": 12000,
    "llm_tokens_out": 3400,
    "tool_calls": 8,
    "job_runtime_seconds": 92,
    "budget_status": "ok | warn | exceeded",
    "advisory_message": "已接近本任务建议推理预算。"
  }
}
```

成本预算是软提醒，不应自动中断科研任务，除非用户或权限策略明确要求。

## 8. 断线重连

前端断线后用 `since_seq` 重连。服务端返回从该 seq 之后的事件；若事件已超出保留范围，则返回 snapshot：

```json
{
  "type": "session.snapshot_required",
  "payload": {
    "reason": "requested seq is older than retained event log",
    "snapshot_url": "/api/sessions/SESSION-001/snapshot"
  }
}
```

### Snapshot 与 Recovery

snapshot_required 后的 snapshot schema、event retention、replay gap 处理和服务重启恢复见 [Workspace_Snapshot_And_Recovery_Spec.md](Workspace_Snapshot_And_Recovery_Spec.md)。

## 9. 心跳

推荐每 15 秒心跳一次：

```json
{"type":"session.heartbeat","payload":{"side":"client","time":"..."}}
```

连续 3 次心跳失败后前端显示 reconnecting，但不应清空状态。

## 10. 客户端动作

用户操作通过 `client.action` 发送：

```json
{
  "type": "client.action",
  "payload": {
    "action": "approve_pi_gate",
    "target_id": "GATE-001",
    "comment": "同意进入 benchmark comparison。"
  }
}
```

PI gate decision 扩展：

```json
{
  "type": "client.action",
  "payload": {
    "action": "decide_pi_gate",
    "target_id": "GATE-001",
    "decision": "request_revision",
    "comment": "请补充失败参数集对 heatmap 的影响说明。",
    "evidence_refs": ["reports/REPORT-001.md"]
  }
}
```

服务端必须重新检查权限和 comment 必填规则，不能只相信前端按钮状态。

## 11. 事件持久化

建议将用户可见事件写入：

```text
workspace/sessions/<session_id>/events.ndjson
```

内部事件可写入 separate audit log。EvidenceReport 不应引用 WebSocket 事件本身作为证据，而应引用 RunRecord 或 artifact。

### 事件不可作为证据源

WebSocket event 不得作为 EvidenceReport 的 evidence source。报告只能引用 RunRecord、Artifact、PiGateDecision、DataProvenance 等持久化对象。

## 12. Observability 事件示例

### health.status

```json
{
  "type": "health.status",
  "seq": 120,
  "payload": {
    "status": "degraded",
    "checks": [
      {"name": "workspace_writable", "status": "ok"},
      {"name": "watcher_running", "status": "warn"}
    ]
  }
}
```

### alert.raised

```json
{
  "type": "alert.raised",
  "seq": 121,
  "payload": {
    "alert_id": "ALERT-001",
    "rule_id": "ALERT-DISK-002",
    "severity": "critical",
    "message": "Workspace free space below 5%",
    "evidence_refs": ["ops/metrics/storage-2026-04-25.json"]
  }
}
```

### Observability 事件规则

- observability events 仍使用统一 envelope；
- alert/health 事件不得包含 secret；
- high-frequency metrics 必须聚合后推送，不逐样本推送；
- PI 科研判断不应依赖 observability event，仍以 RunRecord/EvidenceReport 为准。

## 13. 验收标准

- [ ] 所有事件有 `seq`、`event_id`、`type`、`timestamp`。
- [ ] 前端能通过 seq 重连并恢复日志。
- [ ] RuntimeTerminal 能消费 `tool.stdout`、`tool.stderr`、`job.log`。
- [ ] PI gate 只能由有权限用户动作触发。
- [ ] 成本事件不会自动终止任务。
- [ ] WebSocket 不作为唯一证据存储。
- [ ] 新增 operational UX events 使用统一 envelope 和 seq。
- [ ] notification.status 不包含完整邮件正文或 secrets。
- [ ] pi_gate.decision_recorded 可 replay，前端重复事件按 event_id 去重。
- [ ] health/alert/ops.incident 事件使用统一 envelope 且含 seq。
- [ ] observability 事件不包含 secret。
- [ ] high-frequency metrics 聚合后推送。
