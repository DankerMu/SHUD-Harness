# Patch: Testing_Strategy.md additions

**目标文档：** `docs/04_IMPLEMENTATION/Testing_Strategy.md`  
**目的：** 增加 notification、report export、batch progress、PI decision comment 的测试。  
**合并方式：** 在对应测试分层中追加；或新增 `Operational UX tests` 小节。

## 新增内容

```markdown
## Operational UX tests

### Notification tests

- [ ] RunRecord/report/analysis completed 后创建 NotificationRecord。
- [ ] SMTP mock 成功后状态为 `sent`。
- [ ] SMTP mock 失败后状态为 `failed`，不回滚任务主流程。
- [ ] 同一 dedupe_key 不重复发送。
- [ ] 无收件人时状态为 `skipped`。
- [ ] 邮件正文不包含 secrets、完整日志或 raw output。

### Report export tests

- [ ] `GET /api/reports/:id/export?format=html` 返回 standalone HTML。
- [ ] draft report HTML 有可见 watermark。
- [ ] accepted report HTML 不显示 draft watermark。
- [ ] export manifest 记录 included/excluded artifacts。
- [ ] 缺失图表时导出仍成功，并标注 missing artifact。

### Batch progress tests

- [ ] AnalysisPlan 创建后 progress total 等于 parameter_sets 数量。
- [ ] job.status 更新能更新对应 cell。
- [ ] failed cell 不从 grid/table/report 中消失。
- [ ] `GET /api/analysis/:id/progress` 聚合计数正确。
- [ ] RuntimeTerminal 不把完整日志塞入 React state。

### PI decision comment tests

- [ ] 普通 approve report 可无 comment。
- [ ] reject 无 comment 返回 400。
- [ ] request_revision 无 comment 返回 400。
- [ ] high-risk approve 无 comment 返回 400。
- [ ] agent 身份调用 PI decision endpoint 返回 403。
- [ ] 成功 decision 写 audit log、MemoryNote 和 report decision history。
- [ ] MemoryNote(type=pi_decision) 的 `generalization_allowed=false`。
```
