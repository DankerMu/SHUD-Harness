---
status: frozen
canonical_for: [event-replay-snapshot-recovery]
---

# Workspace Snapshot 与 Recovery 规范

**状态：** v0.8.1 P1 补充规范  
**适用范围：** WebSocket reconnect、页面刷新、服务重启、parked jobs、event replay、session snapshot。  
**目标：** 让 workbench 可以从文件系统事实源恢复，而不是依赖浏览器内存或 LLM 上下文。

## 1. Snapshot 类型

| Snapshot | 用途 | 路径 |
|---|---|---|
| workspace snapshot | Dashboard 和任务列表恢复 | `workspace/snapshots/workspace.json` |
| session snapshot | WebSocket reconnect | `workspace/sessions/SESSION-001/snapshot.json` |
| task snapshot | 单任务四栏状态恢复 | `workspace/tasks/TASK-001/snapshot.json` |
| parked snapshot | Park/Resume 恢复 | `workspace/tasks/TASK-001/parked_state.yaml` |

## 2. TaskSnapshot schema

```ts
interface TaskSnapshot {
  task_id: string;
  status: string;
  runtime_phase?: string | null;
  stack_id?: string;
  data_id?: string;
  linked_jobs: string[];
  linked_runs: string[];
  linked_reports: string[];
  active_analysis_plan_id?: string;
  latest_report_id?: string;
  pending_pi_gates: string[];
  latest_seq: number;   // 必填：snapshot 落盘时在事件总线临界区读取（WebSocket_Protocol §2.1，对抗审查 A08-3）
  updated_at: string;
}
```

**seq 一致性契约（对抗审查 A08-3）**：snapshot 生成与 `latest_seq` 读取在事件总线同一临界区完成
（[WebSocket_Protocol §2.1](WebSocket_Protocol.md) 的单一分配点），恢复侧从 `latest_seq + 1` replay 即无缝。
events.ndjson 裁剪规则：只允许裁到**最新 snapshot 的 latest_seq** 为止——先出新 snapshot，
才可裁其之前的事件，保证 `[latest_seq + 1, now]` 永远可回放；replay gap（§4）只在
"请求的 seq 早于全部现存 snapshot"时出现。

## 3. Session event replay

WebSocket event log：

```text
workspace/sessions/SESSION-001/events.ndjson
```

保留策略：

- 用户可见事件至少保留到 task 结束后 30 天；
- 内部事件可按 debug retention 清理；
- report 不引用 WebSocket event 作为 evidence。

## 4. Replay gap

若 `since_seq` 已过期，服务端发送：

```json
{
  "type": "session.snapshot_required",
  "payload": {
    "reason": "requested seq is older than retained event log",
    "snapshot_url": "/api/sessions/SESSION-001/snapshot"
  }
}
```

前端必须：

1. 丢弃旧 reducer 缓存；
2. 拉取 snapshot（实体状态：任务/job/run/report/gates）；
3. 经事件回放接口补齐叙事流：`GET /api/sessions/:id/events?before_seq=<latest_seq>&limit=N`
   分页读取 events.ndjson 的用户可见事件——snapshot 是实体快照、不含 activityStore，
   B 栏 AgentActivityFeed 的历史必须走本接口重建（首屏取最近 N 条，向上翻页取更早；
   对抗审查 A08-2：否则 seq 过期后 B 栏必然空白）；
4. 重新建立 WebSocket；
5. 从 snapshot 的 `latest_seq` 后继续 replay。

## 5. Service startup recovery

服务启动时扫描：

```text
workspace/tasks/*/parked_state.yaml
workspace/jobs/*/job.yaml
workspace/tasks/*/locks/*.lock
workspace/sessions/*/events.ndjson
```

恢复规则：

- job running：重新 attach watcher；
- job terminal but uncollected：进入 collect；
- collect completed but no report：进入 reporting 或 awaiting manual；
- lock expired：标记 expired 并尝试 recovery；
- 状态冲突：TaskCard → blocked，写 ErrorRecord。

## 6. 验收标准

- [ ] 浏览器刷新后四栏状态可从 snapshot 恢复。
- [ ] 服务重启后 parked job watcher 可恢复。
- [ ] since_seq 过期时前端走 snapshot_required 流程。
- [ ] snapshot 不包含 secrets 或完整大日志。
- [ ] TaskSnapshot 能重建 ResultsPanel 的基本状态。
