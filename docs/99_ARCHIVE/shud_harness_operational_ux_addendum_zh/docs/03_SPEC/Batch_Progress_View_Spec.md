# Batch Progress View 规范

**状态：** v0.8.1 设计补充  
**适用范围：** sensitivity、calibration、benchmark、AnalysisPlan batch、ResultsPanel  
**目标：** 让 PI 和工程师在批运行过程中看到每个 parameter set / RunJob 的状态、失败项、日志和结果链接。

## 1. 为什么需要 BatchProgressGrid

Sensitivity 或 calibration 可能提交多个 RunJob。只有最终 heatmap 会导致中间过程黑箱化。BatchProgressGrid 应显示：

- 哪些参数集已完成；
- 哪些正在运行；
- 哪些失败；
- 哪些仍在排队；
- 失败是否影响最终 heatmap；
- 单个 cell 的日志、metrics 和 retry 入口。

## 2. 状态枚举

```text
queued
running
collecting
succeeded
failed
cancelled
blocked
```

UI 不得只靠颜色表达状态；必须同时显示状态文本或 icon label。

## 3. 数据来源

BatchProgressGrid 不新增核心对象。它从以下对象派生：

```text
AnalysisPlan.parameter_sets
RunJob.status
RunRecord presence
Artifact refs
ErrorRecord / failure reason
```

可选生成 progress artifact：

```text
artifacts/analysis/PLAN-001/progress.json
```

## 4. AnalysisProgressPayload

```ts
interface AnalysisProgressPayload {
  analysis_plan_id: string;
  task_id: string;
  total: number;
  queued: number;
  running: number;
  collecting: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  blocked: number;
  updated_at: string;
  cells: Array<{
    parameter_set_id: string;
    job_id?: string;
    run_id?: string;
    status:
      | "queued"
      | "running"
      | "collecting"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "blocked";
    parameter_changes: Record<string, number | string | boolean>;
    log_artifact_id?: string;
    metrics_artifact_id?: string;
    report_section_ref?: string;
    failure_reason?: string;
    started_at?: string;
    completed_at?: string;
  }>;
}
```

## 5. UI 行为

### 5.1 表格视图

适合 one-at-a-time、少量参数集：

| Parameter Set | Changes | Status | Run | Logs | Metrics |
|---|---|---|---|---|---|
| PSET-001 | `ksath × 1.0` | succeeded | RUN-001 | view | view |
| PSET-002 | `ksath × 1.2` | running | — | tail | — |
| PSET-003 | `ksath × 0.8` | failed | — | view | — |

### 5.2 网格视图

适合二维参数空间：

```text
             roughness -10%   roughness 0%   roughness +10%
ksath -20%       done            running          queued
ksath 0%         done            failed           queued
ksath +20%       queued          queued           queued
```

## 6. Cell detail panel

点击 cell 展开：

- parameter changes；
- RunJob status；
- stdout/stderr tail；
- full log artifact link；
- RunRecord link；
- metrics summary；
- failure reason；
- retry button（若权限和 policy 允许）。

完整日志必须从 artifact 或分页 API 读取，不应全部塞入 React state。

## 7. WebSocket event

可选聚合事件：

```json
{
  "type": "analysis.progress.updated",
  "payload": {
    "analysis_plan_id": "PLAN-001",
    "total": 9,
    "running": 2,
    "succeeded": 5,
    "failed": 1,
    "queued": 1,
    "cells": []
  }
}
```

没有该事件时，前端也可以通过 `job.status`、`runrecord.created`、`artifact.created` 派生。

## 8. 失败项规则

失败参数集不能从 table、grid、heatmap summary 或 EvidenceReport 中消失。最终报告必须说明：

```text
PSET-003 failed because <reason>; it was excluded from heatmap metric aggregation.
```

## 9. 验收标准

- [ ] 批运行开始后 ResultsPanel 显示 progress grid。
- [ ] 单个 job 状态变化能更新对应 cell。
- [ ] 失败 cell 保持可见，并能展开失败原因和日志。
- [ ] 最终 heatmap 不隐藏失败参数集；至少在 summary 中列出 excluded cells。
- [ ] 批进度 UI 不依赖完整日志进入 React state。
