# Operational UX API Contracts

**状态：** v0.8.1 实施补充  
**适用范围：** REST API、WebSocket、Zod schema、frontend reducer  
**目标：** 固定 operational UX 四项补充的 API 和事件契约，避免前后端实现漂移。

## 1. REST API

### 1.1 Report export

```http
GET /api/reports/:reportId/export?format=html
GET /api/reports/:reportId/export?format=markdown
```

Response：

- `format=html`：`Content-Type: text/html; charset=utf-8`
- `format=markdown`：`Content-Type: text/markdown; charset=utf-8`

可选：

```http
POST /api/reports/:reportId/export
```

```json
{
  "format": "html",
  "inline_assets": true,
  "include_logs": false,
  "include_manifest": true
}
```

### 1.2 PI gate decision

```http
POST /api/pi-gates/:gateId/decision
```

```json
{
  "decision": "approved",
  "comment": "同意仅作为 ccw tiny benchmark。",
  "next_action": "generate_patch_bundle",
  "evidence_refs": ["reports/REPORT-001.md"]
}
```

Server responsibilities：

- 校验 session；
- 校验 actor 是 `pi` 或授权角色；
- 校验 comment 必填规则；
- 写 audit log；
- 写 `MemoryNote(type=pi_decision)`；
- 更新 report/task/gate 状态；
- emit `pi_gate.decision_recorded`。

### 1.3 Analysis progress

```http
GET /api/analysis/:analysisPlanId/progress
```

返回 `AnalysisProgressPayload`。

### 1.4 Notifications

MVP 通知可以是 internal-only，不必暴露完整 CRUD API。若需要前端显示通知状态，可增加：

```http
GET /api/tasks/:taskId/notifications
```

返回最近 `NotificationRecord[]`。

## 2. WebSocket events

新增事件：

```text
analysis.progress.updated
report.export_ready
pi_gate.decision_recorded
notification.status
```

### 2.1 analysis.progress.updated

```json
{
  "type": "analysis.progress.updated",
  "task_id": "TASK-001",
  "payload": {
    "analysis_plan_id": "PLAN-001",
    "total": 9,
    "running": 2,
    "succeeded": 5,
    "failed": 1,
    "queued": 1,
    "cells": []
  }
}
```

### 2.2 report.export_ready

```json
{
  "type": "report.export_ready",
  "task_id": "TASK-001",
  "payload": {
    "report_id": "REPORT-001",
    "format": "html",
    "export_id": "EXPORT-001",
    "download_url": "/api/reports/REPORT-001/export?format=html",
    "status_at_export": "draft"
  }
}
```

### 2.3 pi_gate.decision_recorded

```json
{
  "type": "pi_gate.decision_recorded",
  "task_id": "TASK-001",
  "payload": {
    "gate_id": "GATE-001",
    "decision_id": "DECISION-001",
    "decision": "approved",
    "has_comment": true,
    "report_id": "REPORT-001"
  }
}
```

### 2.4 notification.status

```json
{
  "type": "notification.status",
  "task_id": "TASK-001",
  "payload": {
    "notification_id": "NOTIFY-001",
    "channel": "email",
    "trigger": "report_draft_created",
    "status": "sent"
  }
}
```

## 3. Client action

现有 `client.action` 可支持：

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

服务端必须重新做权限检查，不能相信前端按钮状态。

## 4. Schema files

建议新增或扩展 Zod schema：

```text
packages/core/src/domain/schemas/notification.ts
packages/core/src/domain/schemas/report-export.ts
packages/core/src/domain/schemas/analysis-progress.ts
packages/core/src/domain/schemas/pi-gate-decision.ts
packages/core/src/domain/schemas/note.ts     # add pi_decision variant
```

## 5. Frontend store

建议新增 entity cache：

```ts
notifications: Record<NotificationId, NotificationRecord>
reportExports: Record<ExportId, ReportExport>
analysisProgress: Record<AnalysisPlanId, AnalysisProgressPayload>
piGateDecisions: Record<DecisionId, PiGateDecision>
```

## 6. Acceptance

- [ ] 所有新增 API 使用 Zod request/response validation。
- [ ] WebSocket 新事件仍使用统一 envelope。
- [ ] 新事件可通过 `seq` replay 或 snapshot 恢复。
- [ ] `POST /api/pi-gates/:id/decision` 不允许 agent 身份通过。
- [ ] report export endpoint 不改变 report status。
