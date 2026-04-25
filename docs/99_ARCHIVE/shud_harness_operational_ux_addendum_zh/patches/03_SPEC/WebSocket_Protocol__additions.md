# Patch: WebSocket_Protocol.md additions

**目标文档：** `docs/03_SPEC/WebSocket_Protocol.md`  
**目的：** 增加 operational UX 事件和 PI gate decision payload。  
**合并方式：** 在消息类型表中追加；在 PI gate 和 client.action 章节更新。

## 插入位置 1

在 `## 3. 主要消息类型` 表格追加：

```markdown
| `analysis.progress.updated` | server → client | AnalysisPlan batch 进度聚合更新 |
| `report.export_ready` | server → client | EvidenceReport 导出文件已生成 |
| `pi_gate.decision_recorded` | server → client | PI gate decision 已记录 |
| `notification.status` | server → client | email notification sent/failed/skipped 状态 |
```

## 插入位置 2

在 `## 6. PI gate 消息` 后追加：

```markdown
### PI gate decision recorded

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
```

## 插入位置 3

在 `## 10. 客户端动作` 中，将 approve 示例扩展为：

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

服务端必须重新检查权限和 comment 必填规则。

## 插入位置 4

新增 operational UX event payload examples：

```markdown
### Analysis progress updated

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

### Report export ready

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

### Notification status

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
```

## 插入位置 5

在验收标准追加：

```markdown
- [ ] 新增 operational UX events 使用统一 envelope 和 seq。
- [ ] notification.status 不包含完整邮件正文或 secrets。
- [ ] pi_gate.decision_recorded 可 replay，前端重复事件按 event_id 去重。
```
