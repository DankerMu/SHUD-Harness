# Idempotency、Concurrency 与 Locking 规范

**状态：** v0.8.1 P0 补充规范  
**适用范围：** RunJob submit/collect、report generation、report export、notification、PI decision、batch analysis、workspace locks。  
**目标：** 防止服务重启、WebSocket 重连、用户重复点击、watcher retry 或并发 worker 导致重复运行、重复 collect、重复通知或状态回退。

## 1. 原则

1. 幂等操作必须有 deterministic key。
2. 可能写文件或改状态的操作必须持有 lock。
3. 重复执行同一 key 不得创建冲突对象。
4. 状态只能向前推进，除非显式 revision flow。
5. lock 过期后可 recovery，但必须写 audit log。

## 2. IdempotencyRecord

```ts
interface IdempotencyRecord {
  key: string;
  scope: "task" | "job" | "report" | "notification" | "pi_gate" | "export";
  request_digest: string;
  status: "started" | "completed" | "failed";
  result_ref?: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
}
```

## 3. LockRecord

```ts
interface LockRecord {
  lock_id: string;
  scope: "task" | "job" | "run" | "report" | "workspace" | "worktree";
  target_id: string;
  holder: string;
  acquired_at: string;
  expires_at: string;
  status: "held" | "released" | "expired" | "stolen_after_recovery";
  reason: string;
}
```

## 4. 必须幂等的操作

| 操作 | idempotency key |
|---|---|
| `POST /api/jobs` | `task_id + plan_step_id + command_digest` |
| `POST /api/jobs/:id/collect` | `job_id + output_digest_or_exit_marker` |
| `POST /api/tasks/:id/report` | `task_id + run_record_ids + report_template_version` |
| `GET /api/reports/:id/export` 触发生成 | `report_id + format + report_sha256 + export_options` |
| Notification send | `task_id + trigger + target_id + recipient` |
| PI gate decision | `gate_id + actor_user_id + decision + evidence_digest` |

## 5. Lock 文件路径

```text
workspace/tasks/TASK-001/locks/task.lock
workspace/jobs/JOB-001/locks/collect.lock
workspace/reports/REPORT-001/locks/report.lock
workspace/artifacts/reports/REPORT-001.export.lock
workspace/tasks/TASK-001/pi_gates/GATE-001.lock
```

## 6. State monotonicity

状态不得从成功回退为运行中。允许的例外：

- PI `request_revision` 后 TaskCard 回到 `planned`，但旧 report 保留；
- report 重新生成时创建新 report artifact，不覆盖 accepted report；
- failed job retry 创建新 RunJob 或 retry attempt，不覆盖旧 FailureRecord。

## 7. Batch 并发

- 同一 `parameter_set_id` 同时只能有一个 active RunJob。
- 多个 parameter set 可并发，但不得共享 run directory。
- batch stop condition 达成后，未启动 job 标记为 `cancelled` 或 `blocked`，不得静默消失。

## 8. 验收标准

- [ ] 用户双击 approve 不产生两个 PiGateDecision。
- [ ] watcher 重启后 collect 不重复创建 RunRecord。
- [ ] report export 重复请求返回同一 export 或创建明确新版本，不覆盖旧文件。
- [ ] 同一 dedupe key notification 只发送一次。
- [ ] lock 过期 recovery 有 audit log。
