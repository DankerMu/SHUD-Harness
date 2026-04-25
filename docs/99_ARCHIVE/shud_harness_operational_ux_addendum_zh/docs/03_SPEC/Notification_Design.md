# Notification 设计

**状态：** v0.8.1 设计补充  
**适用范围：** Park/Resume、RunJob watcher、AnalysisPlan batch、EvidenceReport、critical failure  
**目标：** 当 PI 关闭浏览器或不在 workbench 中时，仍能在任务完成、报告可审阅或严重失败时收到轻量通知。

## 1. 触发原则

通知必须在“结果可读”之后触发，而不是在进程刚结束时触发。优先触发点：

| 触发点 | 说明 | 是否 MVP |
|---|---|---|
| `runrecord_created` | 单 run 已 collect，RunRecord 已落盘 | 是 |
| `report_draft_created` | EvidenceReport 草稿可审阅 | 是 |
| `analysis_completed` | batch 所有 job terminal 或 stop condition 达成，summary artifact 已生成 | 是 |
| `critical_failure` | 编译失败、数据缺失、数值崩溃、权限失败等需要 PI/工程师介入 | 是 |
| `job_completed` | 进程完成但尚未 collect | 否，避免过早通知 |

## 2. Batch 通知策略

Sensitivity / calibration / benchmark 可能提交多个 RunJob。MVP 不对每个 job completion 发邮件，避免打扰 PI。

```text
单 RunJob task:
  collect completed → RunRecord created → optional report draft → notify once

Batch task:
  all jobs terminal or stop condition reached
  → progress summary artifact created
  → EvidenceReport draft or AnalysisPlan summary created
  → notify once

Critical failure:
  first critical failure may notify immediately
  repeated failures use dedupe_key suppress duplicate messages
```

## 3. 收件人解析

不要把收件人硬编码在代码中。推荐解析顺序：

```text
task.notification_recipients[]
→ task.pi_owner_email
→ task.reviewer_email
→ HARNESS_DEFAULT_NOTIFY_EMAIL
```

若没有可用收件人，写入 `NotificationRecord(status=skipped)`，不要中断 task/report 生成。

## 4. NotificationRecord

```ts
interface NotificationRecord {
  notification_id: string;
  task_id: string;
  job_id?: string;
  run_id?: string;
  analysis_plan_id?: string;
  report_id?: string;

  channel: "email";
  trigger:
    | "runrecord_created"
    | "report_draft_created"
    | "analysis_completed"
    | "critical_failure";

  recipient_email: string;
  subject: string;
  body_preview: string;

  status: "pending" | "sent" | "failed" | "skipped";
  dedupe_key: string;
  attempted_at?: string;
  sent_at?: string;
  error?: string;
}
```

## 5. Dedupe key

通知必须有 deterministic dedupe key。示例：

```text
task:TASK-001:report:REPORT-001:draft_created:pi@example.com
task:TASK-002:analysis:PLAN-001:completed:pi@example.com
task:TASK-003:critical_failure:ERR-001:pi@example.com
```

同一 dedupe key 的通知若已 `sent`，服务重启、watcher retry 或 collect retry 后不得重复发送。

## 6. 邮件内容

邮件必须短、可追溯、低敏感。

```text
Subject: SHUD-Harness task ready for review: TASK-001

Task TASK-001 is ready for review.

Status:
- Report: draft created
- Runs: 9 succeeded, 1 failed
- Analysis: PLAN-001 completed

Open workbench:
https://<host>/tasks/TASK-001
```

邮件不得包含：

- secrets / API keys / tokens；
- 完整 stdout/stderr；
- raw SHUD binary output；
- 大型 timeseries；
- 尚未脱敏的路径或凭据；
- 未经 PI 接受的强科学结论。

## 7. Secret 管理

MVP 可使用 SMTP 或 SendGrid。凭据只允许来自：

```text
.env.local
workspace/secrets/
system keyring
```

不得进入 RunRecord、EvidenceReport、artifact manifest 或 git。

## 8. 失败策略

通知失败不得回滚 RunRecord、EvidenceReport 或 AnalysisPlan summary。应写入：

```yaml
notification:
  status: failed
  error: smtp_timeout
```

UI 应显示“通知发送失败”，但任务本身仍可标记为 `awaiting_pi` 或 `done`。

## 9. 验收标准

- [ ] 浏览器关闭不影响 notification 发送。
- [ ] Batch 默认只在 analysis/report ready 后发送一封通知。
- [ ] 同一 dedupe key 不重复发送。
- [ ] 无收件人时写 skipped，不中断 task。
- [ ] 邮件正文不包含 secrets、完整日志或 raw output。
- [ ] SMTP/SendGrid 凭据不进入 report、RunRecord 或 artifact manifest。
