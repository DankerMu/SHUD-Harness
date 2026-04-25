# Patch: Error_Handling_Spec.md additions

**目标文档：** `docs/03_SPEC/Error_Handling_Spec.md`  
**目的：** 补充 notification failure 和 critical failure notification。  
**合并方式：** 在错误分类或 retry 策略章节追加；若没有 notification 章节，则新增。

## 新增内容

```markdown
## Notification-related errors

Notification 是辅助通道，不是科研证据链的一部分。通知失败不得回滚 RunRecord、EvidenceReport、AnalysisPlan summary 或 PI gate 状态。

### Error classes

| 错误 | 严重性 | 处理 |
|---|---|---|
| `notification.no_recipient` | warning | 写 `NotificationRecord(status=skipped)` |
| `notification.smtp_timeout` | warning | 写 failed，可按 retry policy 重试 |
| `notification.provider_auth_failed` | warning/high | 写 failed，提示工程师检查 secret |
| `notification.dedupe_suppressed` | info | 不发送，记录 suppressed |

### Critical failure notification

对于需要人工介入的严重失败，可触发 immediate notification：

- SHUD build failed；
- sandbox permission denied for required path；
- raw data missing/corrupted；
- numerical crash with no recoverable RunRecord；
- repeated batch failures exceed stop condition。

Critical failure notification 仍必须使用 dedupe key，避免同一错误反复打扰 PI。

### Redaction

错误消息进入 notification 前必须脱敏：

- API keys；
- tokens；
- passwords；
- private SSH path；
- local absolute paths if configured as sensitive。
```

## 验收标准追加

```markdown
- [ ] notification failure 不改变 task/report/run 的主状态。
- [ ] critical failure notification 使用 dedupe key。
- [ ] notification body 经过 secret redaction。
```
