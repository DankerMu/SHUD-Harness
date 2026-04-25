# Artifact Registry 规范

**状态：** v0.8.1 P0 补充规范  
**适用范围：** RunRecord、EvidenceReport、Visualization、ReportExport、Patch、ToolCall、Batch progress。  
**目标：** 让所有可被报告、图表、导出和复盘引用的文件都有统一登记、校验、retention 和证据等级。

## 1. 为什么需要 Artifact Registry

当前文档大量使用 `artifact_id`、`artifact ref`、`manifest` 和路径引用，但缺少统一 Artifact 对象。没有 registry 会导致：

- 报告引用已删除的临时文件；
- HTML export 不知道哪些图可内联；
- Visualization 无法判断单位和 source_ref；
- failed run 的日志被清理后无法复盘；
- 前端从不同 API 读取重复数据层。

## 2. Artifact 分类

| 类型 | 示例 | 可作为 evidence | 默认 retention |
|---|---|---:|---|
| `log` | stdout/stderr/job.log | 部分可用 | debug |
| `metrics` | metrics.yaml | 是 | evidence |
| `figure` | hydrograph.png/svg | 是，需 source_ref | evidence |
| `timeseries` | rivqdown.json/parquet | 是，需 run_id/variable | evidence |
| `report_markdown` | REPORT-001.md | 是 | accepted_report 或 evidence |
| `report_export` | standalone.html | 分享用，不替代原报告 | accepted_report |
| `patch` | CHG-001.patch | 是，工程证据 | evidence |
| `toolcall` | TOOLCALL-001.json | 调试和审计 | debug |
| `manifest` | artifact_manifest.yaml | 是 | evidence |
| `analysis_progress` | progress.json | 运行状态证据 | evidence |
| `error` | ERR-001.yaml | 失败证据 | evidence |

## 3. Artifact metadata

使用 `Support_Schema_Contracts.md` 中的 `Artifact` schema。每个 artifact 至少包含：

```yaml
artifact_id: ART-001
task_id: TASK-001
type: metrics
path: workspace/artifacts/metrics/RUN-001_metrics.yaml
media_type: application/x-yaml
sha256: sha256:...
evidence_usable: true
retention_class: evidence
source_refs:
  - run:RUN-001
redaction_status: not_needed
created_at: ...
```

## 4. Evidence usable 规则

Artifact 只有满足下列条件才能被 EvidenceReport 当作 deterministic evidence：

1. 有 `artifact_id`；
2. 有 `task_id`，若来自运行则有 `run_id`；
3. 有 `sha256` 或明确说明不可 hash 的原因；
4. 有 `source_refs`；
5. 不在 `workspace/tmp/`；
6. `redaction_status != unsafe`；
7. 若是图表，必须有生成参数和数据来源。

## 5. Artifact manifest

每个 RunRecord 和 EvidenceReport 都应有 manifest：

```yaml
artifact_manifest:
  manifest_id: MANIFEST-001
  task_id: TASK-001
  run_id: RUN-001
  artifacts:
    - artifact_id: LOG-001
      type: log
      path: workspace/artifacts/logs/RUN-001.stderr
    - artifact_id: METRICS-001
      type: metrics
      path: workspace/artifacts/metrics/RUN-001.yaml
  generated_at: ...
```

## 6. Immutability

- `metrics`、`report_markdown`、`report_export`、`patch`、`manifest` 默认不可原地覆盖。
- 重新生成时创建新 `artifact_id`，旧 artifact 标记为 superseded。
- Debug log 可以 append，但 report 引用的 log range 应固定 offset 或 snapshot。

## 7. Artifact API

Canonical data API：

```http
GET /api/artifacts/:artifactId
GET /api/artifacts/:artifactId/data
GET /api/artifacts/:artifactId/download
```

返回 metadata 时不得包含 secrets。大型 artifact 应支持 range 或分页读取。

## 8. Retention

| retention_class | 默认策略 |
|---|---|
| `ephemeral` | 可自动清理，不得进入 report evidence |
| `debug` | 默认保留 14 天或按 task retention policy |
| `evidence` | 至少保留到 task 归档 |
| `accepted_report` | 永久保留，除非 PI 明确归档/删除 |
| `benchmark` | 不自动删除；替换需 PI gate |

## 9. 验收标准

- [ ] Report 引用的每个 artifact 都能查到 metadata。
- [ ] Artifact 不在 `tmp/` 时才可作为 evidence。
- [ ] HTML export 的 included/excluded artifacts 来自 manifest。
- [ ] 清理 debug logs 不会删除 accepted report 依赖的 summary artifact。
- [ ] Artifact API 不泄露绝对敏感路径或 secrets。
