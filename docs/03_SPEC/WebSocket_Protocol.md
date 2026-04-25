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
| `client.action` | client → server | 用户操作，如 approve、cancel、resume |

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

服务端必须重新检查权限，不能只相信前端按钮状态。

## 11. 事件持久化

建议将用户可见事件写入：

```text
workspace/sessions/<session_id>/events.ndjson
```

内部事件可写入 separate audit log。EvidenceReport 不应引用 WebSocket 事件本身作为证据，而应引用 RunRecord 或 artifact。

## 12. 验收标准

- [ ] 所有事件有 `seq`、`event_id`、`type`、`timestamp`。
- [ ] 前端能通过 seq 重连并恢复日志。
- [ ] RuntimeTerminal 能消费 `tool.stdout`、`tool.stderr`、`job.log`。
- [ ] PI gate 只能由有权限用户动作触发。
- [ ] 成本事件不会自动终止任务。
- [ ] WebSocket 不作为唯一证据存储。
