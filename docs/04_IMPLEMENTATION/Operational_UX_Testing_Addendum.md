# Operational UX Testing Addendum

**状态：** v0.8.1 测试补充  
**适用范围：** notification、report export、batch progress、PI comments  
**目标：** 为四个 operational UX 补充提供明确测试矩阵。

## 1. Unit tests

| 模块 | 测试 |
|---|---|
| NotificationRecord schema | trigger/status/dedupe_key 校验。 |
| notification recipient resolver | `notification_recipients → pi_owner_email → reviewer_email → env` 顺序。 |
| dedupe key builder | 同一 task/report/recipient 输出稳定 key。 |
| ReportExport schema | format/status_at_export/included_artifacts/excluded_artifacts。 |
| HTML sanitizer/redactor | secrets、tokens、本地凭据路径不出现在 HTML。 |
| AnalysisProgress reducer | job.status/runrecord.created 更新对应 cell。 |
| PI decision validator | reject/revision/high-risk approve 缺 comment 返回错误。 |
| MemoryNote pi_decision variant | `generalization_allowed=false` 必须存在。 |

## 2. Integration tests

### 2.1 Notification

- RunRecord created 后生成 `NotificationRecord(pending)`。
- SMTP mock 成功后状态为 `sent`。
- SMTP mock 失败后状态为 `failed`，task/report 不回滚。
- 同一 dedupe key 重试不重复发送。
- 无收件人时状态为 `skipped`。

### 2.2 Report export

- `GET /api/reports/:id/export?format=html` 返回 HTML。
- draft report HTML 包含可见 watermark。
- accepted report HTML 不显示 draft watermark。
- 缺失 figure artifact 时 HTML 仍返回，并标注 missing artifact。
- export manifest 正确记录 included/excluded artifacts。

### 2.3 Batch progress

- `POST /api/analysis/sensitivity` 创建 progress payload。
- job 状态从 `queued → running → collecting → succeeded` 后 cell 更新。
- failed job 保持在 table/grid 中。
- `GET /api/analysis/:id/progress` 返回聚合计数正确。

### 2.4 PI comments

- PI approve simple report 可以无 comment。
- PI reject 无 comment 返回 400。
- PI request_revision 无 comment 返回 400。
- high-risk approve 无 comment 返回 400。
- agent 身份调用 decision endpoint 返回 403。
- 成功 decision 写 audit log、MemoryNote 和 report decision history。

## 3. WebSocket tests

- `analysis.progress.updated` 使用统一 envelope。
- `report.export_ready` 可 replay。
- `pi_gate.decision_recorded` 去重。
- `notification.status` 不包含完整邮件正文或 secrets。
- reconnect with `since_seq` 能恢复新增事件。

## 4. UI tests

| 组件 | 测试 |
|---|---|
| BatchProgressGrid | 显示 queued/running/collecting/succeeded/failed/cancelled/blocked。 |
| Batch cell detail | 点击 cell 能显示参数、日志 tail、failure reason。 |
| ReportExportButton | 点击可下载 HTML；draft 状态显示 watermark 提示。 |
| PIDecisionPanel | reject/revision 时 comment textarea required。 |
| NotificationStatus | 显示 sent/failed/skipped，不阻塞 task 状态。 |

## 5. E2E smoke tests

### 5.1 Dummy batch

```text
create task
create sensitivity analysis with 4 parameter sets
run dummy jobs
mark one failed
observe BatchProgressGrid
export report HTML
PI request revision with comment
verify MemoryNote(type=pi_decision)
```

### 5.2 Park/Resume notification

```text
submit long dummy job
close websocket/session
job completes
collect creates RunRecord/report draft
SMTP mock receives one email
reopen workbench
notification status visible
```

## 6. Acceptance

- [ ] Operational UX tests can run without real SHUD dependency using dummy runner.
- [ ] ccw tiny E2E can optionally cover report export and batch progress.
- [ ] No test requires sending real email; use SMTP mock or fake provider.
- [ ] CI fails if HTML export includes known secret patterns.
- [ ] CI fails if PI comment high-risk rule is not enforced server-side.
