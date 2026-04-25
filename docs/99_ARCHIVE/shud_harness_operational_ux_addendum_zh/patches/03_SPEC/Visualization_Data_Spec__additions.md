# Patch: Visualization_Data_Spec.md additions

**目标文档：** `docs/03_SPEC/Visualization_Data_Spec.md`  
**目的：** 增加 batch progress JSON 和 report export 静态图表要求。  
**合并方式：** 在 heatmap / metrics / artifact data 章节之后追加。

## 新增内容

```markdown
## Batch progress data

BatchProgressGrid 使用 `AnalysisProgressPayload`：

```json
{
  "analysis_plan_id": "PLAN-001",
  "task_id": "TASK-001",
  "total": 9,
  "queued": 1,
  "running": 2,
  "collecting": 0,
  "succeeded": 5,
  "failed": 1,
  "cancelled": 0,
  "blocked": 0,
  "updated_at": "2026-04-25T12:00:00Z",
  "cells": [
    {
      "parameter_set_id": "PSET-001",
      "job_id": "JOB-001",
      "run_id": "RUN-001",
      "status": "succeeded",
      "parameter_changes": {"ksath_multiplier": 1.2},
      "log_artifact_id": "LOG-001",
      "metrics_artifact_id": "METRICS-001"
    }
  ]
}
```

Endpoint：

```http
GET /api/analysis/:analysisPlanId/progress
```

## Exportable static figure requirements

可导出报告中的图表必须满足：

- 有静态 PNG 或 SVG artifact；
- 有 manifest 记录生成参数；
- 有 alt text 或 caption；
- 有数据来源 artifact ref；
- 不依赖浏览器内 runtime state 才能理解。

不应把完整 timeseries JSON 或大型日志内联到 standalone HTML。HTML 中保留 artifact ref 和摘要即可。
```
