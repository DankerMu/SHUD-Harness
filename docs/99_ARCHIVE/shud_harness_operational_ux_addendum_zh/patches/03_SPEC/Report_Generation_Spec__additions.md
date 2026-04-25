# Patch: Report_Generation_Spec.md additions

**目标文档：** `docs/03_SPEC/Report_Generation_Spec.md`  
**目的：** 增加 standalone HTML / Markdown export 和 PI decision history。  
**合并方式：** 在 artifact 引用之后增加导出章节；在报告元数据中增加 exports/decision_history；在验收标准追加导出检查。

## 插入位置 1

建议插入到 `## 7. Artifact 引用` 之后、`## 8. Reviewer 检查清单` 之前。

## 新增内容

```markdown
## Standalone Report Export

EvidenceReport 生成时应同时生成可分享的静态导出 artifact：

```text
artifacts/reports/REPORT-001.md
artifacts/reports/REPORT-001.standalone.html
artifacts/reports/REPORT-001.export_manifest.yaml
```

MVP 支持：

- `html`: 单文件 standalone HTML，可离线阅读，可用浏览器 print to PDF。
- `markdown`: 原始 Markdown，适合复制到论文草稿或协作工具。

导出 API：

```http
GET /api/reports/:reportId/export?format=html
GET /api/reports/:reportId/export?format=markdown
```

如果报告状态不是 `accepted`，HTML 顶部必须显示：

```text
DRAFT — not accepted by PI
```

HTML 可内联小型 PNG/SVG 图表和 metrics summary，但不得内联完整 stdout/stderr、raw SHUD binary output、大型 timeseries 或 secrets。

Export manifest 应记录 included/excluded artifacts，说明哪些图表被内联、哪些大型日志或数据只保留引用。
```

## 插入位置 2

在 `## 10. 报告元数据` 示例中增加：

```yaml
exports:
  - export_id: EXPORT-001
    format: html
    output_path: artifacts/reports/REPORT-001.standalone.html
    status_at_export: draft
    created_at: ...
decision_history:
  - decision_id: DECISION-001
    gate_id: GATE-001
    decision: approved
    actor: user_pi
    comment: "同意仅用于 ccw tiny benchmark。"
    timestamp: ...
```

## 插入位置 3

在 `## 11. 验收标准` 追加：

```markdown
- [ ] 每个 EvidenceReport 可导出 standalone HTML。
- [ ] draft/reviewed/awaiting_pi 状态的 HTML 导出有可见 watermark。
- [ ] HTML 导出不包含 secrets、完整日志或 raw binary output。
- [ ] export manifest 记录 included/excluded artifacts。
- [ ] PI decision comments 出现在 report decision history 中。
```
