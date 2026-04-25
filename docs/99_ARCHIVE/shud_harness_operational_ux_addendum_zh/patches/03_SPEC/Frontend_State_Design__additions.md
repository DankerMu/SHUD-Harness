# Patch: Frontend_State_Design.md additions

**目标文档：** `docs/03_SPEC/Frontend_State_Design.md`  
**目的：** 增加 BatchProgressGrid、ReportExportButton、PIDecisionPanel 和 notification status 的前端状态。  
**合并方式：** 在 ResultsPanel / ReportPanel / entity cache / WebSocket reducer 相关章节追加。

## 插入位置 1

在前端 entity cache / store 章节追加：

```markdown
## Operational UX entity cache

前端应缓存以下 support entities：

```ts
type OperationalUxState = {
  analysisProgress: Record<string, AnalysisProgressPayload>;
  reportExports: Record<string, ReportExport>;
  piGateDecisions: Record<string, PiGateDecision>;
  notifications: Record<string, NotificationRecord>;
};
```

完整日志和大型 timeseries 不进入 React state；只缓存 artifact id、tail、summary 和 pagination cursor。
```

## 插入位置 2

在 ResultsPanel 组件章节追加：

```markdown
## BatchProgressGrid

ResultsPanel 在 AnalysisPlan batch 运行期间显示 BatchProgressGrid。该组件展示每个 parameter set 的状态：

```text
queued | running | collecting | succeeded | failed | cancelled | blocked
```

组件输入：

```ts
{
  analysisPlanId: string;
  progress: AnalysisProgressPayload;
}
```

点击 cell 展开：parameter changes、RunJob status、stdout/stderr tail、log artifact、RunRecord、metrics summary、failure reason、retry action。

失败 cell 不得隐藏；最终 heatmap 生成后仍应保留失败项摘要。
```

## 插入位置 3

在 report view / report panel 章节追加：

```markdown
## ReportExportButton

EvidenceReport panel 应提供导出按钮：

- Export HTML
- Export Markdown

如果报告状态不是 `accepted`，按钮旁提示“导出将包含 draft watermark”。

导出成功后消费 `report.export_ready` 事件或直接下载 `/api/reports/:id/export?format=html`。
```

## 插入位置 4

在 PI approval UI 章节追加：

```markdown
## PIDecisionPanel

PI gate card 应包含 decision buttons 和 comment textarea：

```text
Approve
Request revision
Reject

Comment textarea:
  optional for simple approve
  required for reject / revision / high-risk approve
```

前端可以做 required 提示，但最终校验必须由服务端执行。
```

## 插入位置 5

在 WebSocket reducer 章节追加：

```markdown
## Operational UX WebSocket reducer

新增事件处理：

- `analysis.progress.updated` → update `analysisProgress[analysis_plan_id]`
- `report.export_ready` → update `reportExports[export_id]`
- `pi_gate.decision_recorded` → update `piGateDecisions[decision_id]`
- `notification.status` → update `notifications[notification_id]`
```
