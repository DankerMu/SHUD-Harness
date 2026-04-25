# Patch: Park_Resume_Design.md additions

**目标文档：** `docs/03_SPEC/Park_Resume_Design.md`  
**目的：** 补充浏览器关闭后的 out-of-band notification。  
**合并方式：** 在 Park/Resume 流程说明之后新增小节；在验收标准追加检查项。

## 插入位置 1

在如下流程之后插入：

```text
Plan → Submit RunJob → Park TaskCard → Watch Job → Collect RunRecord → Resume Coordinator → Report
```

## 新增内容

```markdown
## Out-of-band notification after Resume/Report

WebSocket 只覆盖浏览器打开时的实时体验。Park/Resume 的核心场景是长任务运行期间 PI 可能关闭浏览器，因此 long job 完成后的通知不能完全依赖 WebSocket。

通知触发点应在结果可读之后，而不是进程刚退出时：

```text
Single RunJob task:
  Watch Job → Collect RunRecord → Generate report draft → Notify once

Batch AnalysisPlan:
  all jobs terminal or stop condition reached
  → Generate AnalysisPlan summary / report draft
  → Notify once

Critical failure:
  first critical failure may notify immediately
```

MVP 使用 email notification。收件人解析顺序：

```text
task.notification_recipients[]
→ task.pi_owner_email
→ task.reviewer_email
→ HARNESS_DEFAULT_NOTIFY_EMAIL
```

通知必须生成 `NotificationRecord`，使用 deterministic `dedupe_key` 避免 watcher retry 或服务重启后重复发送。

Batch 模式不得对每个 RunJob completion 发送邮件；默认只在 analysis summary 或 report draft 可审阅时发送一封。
```

## 插入位置 2

在 `验收标准` 中追加：

```markdown
- [ ] 浏览器关闭后，RunRecord/report/analysis summary 完成仍能触发 notification。
- [ ] Batch analysis 默认只发送一次 summary notification，不逐 job 打扰 PI。
- [ ] NotificationRecord 有 dedupe_key，服务重启或 retry 不重复发送。
- [ ] notification 失败不回滚 RunRecord 或 EvidenceReport。
```
