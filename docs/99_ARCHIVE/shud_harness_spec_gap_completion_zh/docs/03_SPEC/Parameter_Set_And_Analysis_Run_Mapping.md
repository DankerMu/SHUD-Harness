# Parameter Set 与 Analysis Run Mapping 规范

**状态：** v0.8.1 P1 补充规范  
**适用范围：** AnalysisPlan、sensitivity/calibration/benchmark batch、BatchProgressGrid、RunJob、RunRecord、heatmap。  
**目标：** 统一 parameter_set、RunJob、RunRecord 和 metrics artifact 的关系。

## 1. ParameterSet schema

```ts
interface ParameterSet {
  parameter_set_id: string;
  analysis_plan_id: string;
  label?: string;
  changes: Record<string, number | string | boolean>;
  baseline: boolean;
  status: "queued" | "submitted" | "running" | "collecting" | "succeeded" | "failed" | "cancelled" | "blocked";
  job_id?: string;
  run_id?: string;
  metrics_artifact_id?: string;
  error_id?: string;
}
```

## 2. AnalysisPlan 补充字段

`Minimal_Schemas.md` 的 AnalysisPlan 可保留简洁字段，但实现 schema 应包含：

```yaml
parameter_sets:
  - parameter_set_id: PSET-001
    changes:
      ksath_multiplier: 1.0
      mannings_n_multiplier: 1.0
    baseline: true
    status: queued
batch_policy:
  max_concurrent_jobs: 2
  stop_condition: all_terminal | first_failure | failure_rate_exceeds_threshold
  failure_rate_threshold: 0.5
```

## 3. 映射规则

- 一个 `ParameterSet` 最多一个 active RunJob。
- 一个成功或失败的 RunJob 应生成一个 RunRecord 或 FailureRecord。
- `ParameterSet.status` 从 RunJob/RunRecord 派生，不手动独立维护。
- heatmap 聚合只使用 `succeeded` 的 metrics，但失败项必须进入 excluded list。

## 4. Directory rule

```text
workspace/analysis/PLAN-001/parameter_sets/PSET-001.yaml
workspace/runs/RUN-001/run.yaml
workspace/artifacts/analysis/PLAN-001/progress.json
```

## 5. 验收标准

- [ ] 每个 PSET 可追溯到 job/run/failure。
- [ ] 失败 PSET 不从 progress、table、report 中消失。
- [ ] heatmap excluded cells 明确列出。
- [ ] 并发 batch 不共享 run directory。
