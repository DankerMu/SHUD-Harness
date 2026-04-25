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
  latest_seq?: number;
  updated_at: string;
}
```

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
2. 拉取 snapshot；
3. 重新建立 WebSocket；
4. 从 snapshot 的 `latest_seq` 后继续 replay。

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
