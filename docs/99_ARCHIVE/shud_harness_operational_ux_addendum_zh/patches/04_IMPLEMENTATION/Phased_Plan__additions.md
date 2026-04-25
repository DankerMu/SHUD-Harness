# Patch: Phased_Plan.md additions

**目标文档：** `docs/04_IMPLEMENTATION/Phased_Plan.md`  
**目的：** 将 operational UX 四项能力纳入实施计划。  
**合并方式：** 在 W5-W8 中追加，或新增 `v0.8.1 Operational UX Sprint` 小节。

## 推荐新增小节

```markdown
## v0.8.1 Operational UX Sprint

在 deterministic skeleton、RunJob/RunRecord、EvidenceReport 基本闭环之后，增加以下轻量能力。

### P0: PI decision comments

交付：

- `POST /api/pi-gates/:gateId/decision`
- comment 必填规则
- audit log
- `MemoryNote(type=pi_decision)`
- report decision history
- PIDecisionPanel textarea

### P0: Report HTML export

交付：

- standalone HTML template
- draft watermark
- export manifest
- `GET /api/reports/:id/export?format=html`
- ReportExportButton

### P1: Batch progress grid

交付：

- `AnalysisProgressPayload`
- `GET /api/analysis/:id/progress`
- optional `analysis.progress.updated` event
- BatchProgressGrid
- cell detail panel
- failed parameter set remains visible

### P1: Email notification

交付：

- NotificationRecord
- recipient resolver
- SMTP/SendGrid provider interface
- dedupe key
- notification after report/analysis ready
- notification.status UI

### Recommended order

```text
1. PI decision comments
2. Report HTML export
3. Batch progress grid
4. Email notification
```

通知建议在 Park/Resume watcher 和 collect/report 语义稳定后接入，避免过早绑定到 job_completed。
```
