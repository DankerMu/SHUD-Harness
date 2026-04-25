# Report Export 规范

**状态：** v0.8.1 设计补充  
**适用范围：** EvidenceReport、ResultsPanel、artifact storage、collaboration/offline review  
**目标：** 每个 EvidenceReport 可导出为 standalone HTML，并可选导出 Markdown，使 PI 能发给合作者、贴到论文草稿、会议展示或离线阅读。

## 1. 导出格式

MVP 支持：

| 格式 | 用途 | 是否 MVP |
|---|---|---|
| `html` | 单文件，可离线阅读，可浏览器 print to PDF | 是 |
| `markdown` | 论文草稿、协作、轻量复制 | 是 |
| `pdf` | 直接 PDF 文件 | 否，后续用浏览器打印替代 |

## 2. 导出产物

报告生成时建议同时写出：

```text
artifacts/reports/REPORT-001.md
artifacts/reports/REPORT-001.standalone.html
artifacts/reports/REPORT-001.export_manifest.yaml
```

`GET /api/reports/:id/export?format=html` 返回已生成的 HTML artifact。若 artifact 不存在，后端可按当前 report metadata 幂等生成。

## 3. Standalone HTML 内容

HTML 应包含：

- report title、report_id、task_id；
- report status；
- draft / reviewed / awaiting_pi / accepted 标记；
- StackLock 摘要；
- DataProvenance 摘要；
- RunRecord 列表；
- metrics tables；
- 静态图表；
- observations；
- limitations；
- PI questions；
- decision history；
- artifact manifest 摘要；
- generated_at 和 exported_at；
- Harness version。

## 4. Draft watermark

如果报告状态不是 `accepted`，HTML 顶部必须显示：

```text
DRAFT — not accepted by PI
```

中文 UI 可显示：

```text
草稿 — 尚未由 PI 接受
```

该水印不能只靠 CSS 隐藏，应作为 HTML 可见正文的一部分。

## 5. 图表内联规则

允许内联：

- PNG；
- SVG；
- 小型 summary table；
- 小型 metrics JSON 摘要。

不建议内联：

- 全量 hydrograph timeseries JSON；
- 全量 SHUD binary output；
- 大型 stdout/stderr；
- secrets 或本地绝对路径。

对于大型数据，HTML 中只保留 artifact ref 和摘要。

## 6. Export manifest

```yaml
report_export:
  export_id: EXPORT-001
  report_id: REPORT-001
  task_id: TASK-001
  format: html
  status_at_export: draft
  created_at: "2026-04-25T12:00:00Z"
  exported_by: system
  source_markdown: artifacts/reports/REPORT-001.md
  output_path: artifacts/reports/REPORT-001.standalone.html
  inline_assets: true
  included_artifacts:
    - artifact_id: FIG-001
      path: artifacts/figures/RUN-001_rivqdown.png
      embedded: true
    - artifact_id: METRICS-001
      path: artifacts/metrics/RUN-001.yaml
      embedded: summary_only
  excluded_artifacts:
    - artifact_id: LOG-001
      reason: large_log_not_embedded
```

## 7. API

```http
GET /api/reports/:reportId/export?format=html
GET /api/reports/:reportId/export?format=markdown
```

MVP 可选：

```http
POST /api/reports/:reportId/export
```

```json
{
  "format": "html",
  "inline_assets": true,
  "include_logs": false,
  "include_manifest": true
}
```

## 8. 权限

- `viewer` 可下载已可见 report 的 export。
- `engineer/reviewer/pi` 可触发重新导出。
- `accepted` 状态只能由 PI 或授权用户设置；导出 API 不得改变 report status。

## 9. 验收标准

- [ ] `GET /api/reports/:id/export?format=html` 返回可离线打开的 HTML。
- [ ] draft report 导出有可见 watermark。
- [ ] HTML 中不包含 secrets、大型 raw output 或完整日志。
- [ ] HTML 中所有关键指标来自 deterministic artifact。
- [ ] export manifest 记录 included/excluded artifacts。
- [ ] 缺失图表时 HTML 仍可导出，并标注 missing artifact。
