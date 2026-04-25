# Patch: Schemas_APIs_CLIs.md additions

**目标文档：** `docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md`  
**目的：** 增加 report export、PI decision、analysis progress、notification API。  
**合并方式：** 在 API 端点列表、WebSocket 端点、Schema Validation 中追加。

## 插入位置 1

在 `# 报告与变更` 端点后追加：

```text
# 报告导出
GET /api/reports/:reportId/export          # ?format=html|markdown，返回 standalone export
POST /api/reports/:reportId/export         # 可选：按 body 参数重新生成 export
```

## 插入位置 2

替换或补充审批 endpoint：

```text
# 审批 — Canonical
POST /api/pi-gates/:gateId/decision        # PI gate decision: approved/rejected/request_revision + comment + evidence_refs

# 审批 — Convenience
POST /api/tasks/:id/approve                # MVP 快捷接口，内部委托到 /api/pi-gates/:gateId/decision
```

## 插入位置 3

在分析端点后追加：

```text
# 分析进度
GET /api/analysis/:analysisPlanId/progress # BatchProgressGrid 数据
```

## 插入位置 4

在通知端点处追加；若 MVP 不暴露 CRUD，可标注 internal：

```text
# 通知
GET /api/tasks/:taskId/notifications       # 最近 notification records，用于 UI 状态显示
```

## 插入位置 5

在 `## 2. WebSocket 端点` 中追加事件列表：

```text
analysis.progress.updated
report.export_ready
pi_gate.decision_recorded
notification.status
```

## 插入位置 6

在 `## 5. Schema Validation (Zod)` 中追加：

```text
NotificationRecord → packages/core/src/domain/schemas/notification.ts
ReportExport → packages/core/src/domain/schemas/report-export.ts
AnalysisProgressPayload → packages/core/src/domain/schemas/analysis-progress.ts
PiGateDecision → packages/core/src/domain/schemas/pi-gate-decision.ts
MemoryNote(pi_decision) → packages/core/src/domain/schemas/note.ts
```

## 插入位置 7

在 `## 6. Report Generation` 后追加：

```markdown
## 7. Operational UX API rules

- Report export endpoint 不改变 report status。
- PI gate decision endpoint 必须服务端校验权限，Agent 不能批准 PI gate。
- reject/request_revision/high-risk approve 必须带 comment。
- Analysis progress endpoint 可以从 RunJob/RunRecord 实时派生，也可以读取 progress artifact。
- Notification API 不返回完整邮件正文或 secrets。
```
