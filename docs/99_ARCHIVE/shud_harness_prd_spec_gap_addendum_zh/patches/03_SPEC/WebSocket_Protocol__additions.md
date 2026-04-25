# Patch: WebSocket_Protocol additions

**目标文档**：`docs/03_SPEC/WebSocket_Protocol.md`  
**插入位置**：event registry 的 system / operational events 附近。

## 新增事件类型

```text
health.status
ops.metric.updated
alert.raised
alert.resolved
ops.incident.created
ops.incident.updated
dependency.lock.updated
requirements.coverage.updated
```

## 示例：health.status

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

## 示例：alert.raised

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

## 规则

- observability events 仍使用统一 envelope；
- alert/health 事件不得包含 secret；
- high-frequency metrics 必须聚合后推送，不逐样本推送；
- PI 科研判断不应依赖 observability event，仍以 RunRecord/EvidenceReport 为准。
