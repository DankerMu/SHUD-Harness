# 可视化数据规范

**状态：** P1 设计规范  
**适用范围：** HydrographChart、HydrographComparison、ResultsOverview、SensitivityHeatmap、ParameterSetTable  
**目标：** 固定图表组件的数据契约、单位、聚合方式和缺失值处理。

## 1. 基本原则

1. 图表只展示 artifact 化的数据，不直接读取任意输出文件。
2. 每个图表数据集必须记录 RunRecord、变量、单位、聚合方法和时间轴。
3. 前端可以交互选择变量和 run，但不能隐式改变指标计算方法。
4. 图表标题和 tooltip 必须显示单位。
5. 缺失变量应显示 `not_available`，不能静默用 0 替代。

## 2. 通用数据集 envelope

```yaml
visualization_dataset:
  id: VIZ-001
  type: hydrograph | comparison | sensitivity_heatmap | metrics_cards | parameter_table
  run_ids:
    - RUN-001
  generated_at: 2026-04-24T00:00:00-04:00
  source_artifacts:
    - artifacts/metrics/RUN-001.yaml
  variables:
    - rivqdown
  unit: m3/day
  aggregation: outlet
  data: ...
```

## 3. HydrographChart

### 3.1 数据格式

```yaml
hydrograph:
  variable_id: rivqdown
  display_name: Downstream discharge
  unit: m3/day
  location:
    type: river_segment
    id: 103
    label: outlet
  series:
    - run_id: RUN-001
      label: ccw tiny baseline
      points:
        - ["2020-01-01T00:00:00Z", 12.3]
        - ["2020-01-02T00:00:00Z", 15.1]
```

### 3.2 默认变量

MVP 默认显示：

- `rivqdown`：出口或选定河段流量；
- `rivystage`：出口或选定河段水位；
- `eleygw`：流域均值；
- `eleysurf`：流域均值；
- `elevprcp`：流域均值或总量；
- `eleveta`：流域均值。

## 4. HydrographComparison

比较图需要明确 baseline 与 candidate：

```yaml
comparison:
  baseline_run_id: RUN-BASE
  candidate_run_ids:
    - RUN-CAND
  variable_id: rivqdown
  metrics:
    nse: 0.72
    kge: 0.68
    rmse: 14.2
    bias_pct: -3.1
```

如果没有观测数据，不能计算 NSE/KGE，应显示：

```yaml
metric_status: observation_not_available
```

## 5. ResultsOverview

ResultsOverview 使用指标卡：

```yaml
metrics_cards:
  - metric_id: water_balance_residual
    display_name: Water balance residual
    value: 0.0008
    unit: ratio
    status: pass
    threshold:
      pass: "<= 0.01"
      warn: "<= 0.05"
  - metric_id: cvode_failures
    value: 0
    status: pass
```

每个指标必须有来源：

```yaml
source_ref: artifacts/metrics/RUN-001.yaml#numerical_health.water_balance_residual
```

## 6. SensitivityHeatmap

```yaml
sensitivity_heatmap:
  analysis_plan_id: PLAN-001
  metric_id: nse
  parameters:
    - ksath
    - porosity
    - roughness
  rows:
    - parameter: ksath
      perturbation: -20%
      value: 0.61
    - parameter: ksath
      perturbation: +20%
      value: 0.67
```

热力图必须标注：

- 参数名；
- 扰动方式；
- 指标；
- baseline；
- 运行失败项；
- 是否存在观测数据。

## 7. ParameterSetTable

```yaml
parameter_set_table:
  analysis_plan_id: PLAN-001
  rows:
    - parameter_set_id: PSET-001
      run_id: RUN-001
      status: succeeded
      ksath_multiplier: 1.0
      roughness_multiplier: 1.0
      nse: 0.70
      water_balance_residual: 0.001
```

失败运行不应从表中删除，应显示 `failed` 并链接日志。

## 8. 单位策略

| 变量类型 | 推荐单位 |
|---|---|
| 河道流量 | `m3/day`，可前端转换为 `m3/s` |
| 水位/水深 | `m` |
| 面通量 | `m3/m2/day` 或 `m/day`，按 SHUD 输出说明保留原始单位 |
| 面积 | `m2` |
| 无量纲指标 | `ratio` 或空单位 |

前端单位转换必须记录在图表配置中，避免报告中出现单位混乱。

## 9. 缺失值和异常值

- `null` 表示缺失；
- `NaN` 不应进入 JSON，写为 `null` 并标记 `invalid_value_count`；
- 负状态值应作为 numerical health 警告；
- 运行失败的 series 不绘制线，但在 legend 中显示失败状态。

## 10. Artifact API

以下为 canonical data API（权威 endpoint 注册见 `04_IMPLEMENTATION/Schemas_APIs_CLIs.md` §1.1）：

```text
GET /api/artifacts/:artifactId/data                                    # canonical
GET /api/runs/:runId/variables                                         # canonical
GET /api/runs/:runId/series?variable_id=rivqdown&aggregation=outlet    # canonical
GET /api/analysis/:analysisPlanId/heatmap?metric_id=nse                # canonical
```

图表组件应直接调用上述 canonical API。`/api/runs/:id/hydrograph` 等 convenience endpoint 仅供 MVP 快捷调用，内部代理到 canonical 实现。

## 10.1 Batch progress data

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

## 10.2 Exportable static figure requirements

可导出报告中的图表必须满足：

- 有静态 PNG 或 SVG artifact；
- 有 manifest 记录生成参数；
- 有 alt text 或 caption；
- 有数据来源 artifact ref；
- 不依赖浏览器内 runtime state 才能理解。

不应把完整 timeseries JSON 或大型日志内联到 standalone HTML。HTML 中保留 artifact ref 和摘要即可。

## 11. 验收标准

- [ ] 图表数据包含变量、单位、聚合、run_id 和 source_ref。
- [ ] 缺失观测数据时不计算 NSE/KGE。
- [ ] 失败 run 在表格和图例中可见。
- [ ] 前端能切换 `rivqdown`、`eleygw`、`elevprcp`。
- [ ] ResultsOverview 指标能追溯到 metrics artifact。
