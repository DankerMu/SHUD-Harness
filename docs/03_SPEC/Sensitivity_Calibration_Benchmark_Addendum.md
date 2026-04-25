# Sensitivity / Calibration / Benchmark 补充规范

**状态：** P1 设计补充  
**适用范围：** AnalysisPlan、RunJob batch、ParameterSetTable、SensitivityHeatmap、EvidenceReport  
**目标：** 明确三类分析的边界、运行结构、指标、报告语言和 PI gate。

## 1. 三类任务的边界

| 类型 | 目标 | 不能自动得出的结论 |
|---|---|---|
| sensitivity | 观察参数扰动对指标或过程线的影响 | 参数就是真实物理因子 |
| calibration | 在给定目标函数和数据窗口下寻找较优参数 | 模型结构已验证 |
| benchmark | 比较 baseline 与 candidate 的工程/数值表现 | candidate 普遍优于 baseline |

## 2. AnalysisPlan

```yaml
analysis_plan:
  id: PLAN-001
  mode: sensitivity | calibration | benchmark
  task_id: TASK-001
  baseline_run_id: RUN-BASE
  basin_id: ccw
  event_window:
    start: 2020-01-01
    end: 2020-01-30
  metrics:
    - water_balance_residual
    - nse
    - kge
  parameter_sets:
    - id: PSET-001
      changes:
        ksath_multiplier: 1.0
```

## 3. Sensitivity

### 3.1 设计

推荐从 one-at-a-time 开始：

```yaml
sensitivity:
  method: one_at_a_time
  parameters:
    - name: ksath
      perturbations: [-0.2, 0.2]
    - name: roughness
      perturbations: [-0.1, 0.1]
```

### 3.2 输出

- 每个 parameter set 一个 RunRecord；
- 一个 AnalysisPlan summary；
- ParameterSetTable；
- SensitivityHeatmap；
- 失败项列表；
- EvidenceReport。

## 4. Calibration

Calibration 必须记录：

- 目标函数；
- 参数空间；
- 训练窗口；
- 验证窗口；
- 观测数据来源；
- 约束和先验；
- 是否允许改变默认参数；
- 是否触发 PI gate。

示例：

```yaml
calibration:
  objective: maximize_kge
  train_window: [2020-01-01, 2020-01-20]
  validation_window: [2020-01-21, 2020-01-30]
  parameters:
    - name: ksath
      min: 0.5
      max: 2.0
      transform: multiplier
```

将 calibration 参数写入默认配置或标记为 validated 必须经过 PI 审批。

## 5. Benchmark

Benchmark 至少包含：

```yaml
benchmark:
  baseline:
    stack_id: STACK-BASE
    run_id: RUN-BASE
  candidate:
    stack_id: STACK-CAND
    run_id: RUN-CAND
  metrics:
    - runtime_seconds
    - water_balance_residual
    - cvode_failures
    - nse
```

如果 candidate 使用 dirty stack，报告必须标注。

## 6. Batch 运行

每个 batch item 应独立：

```text
runs/RUN-001/
runs/RUN-002/
runs/RUN-003/
```

不要让多个参数集共享输出目录。失败运行保留在 table 中。

## 6.1 Batch progress view

Batch analysis 必须在最终 heatmap 之前提供中间进度视图。MVP 使用 BatchProgressGrid，展示每个 parameter set / RunJob 的状态：

```text
queued | running | collecting | succeeded | failed | cancelled | blocked
```

BatchProgressGrid 从以下数据派生：

```text
AnalysisPlan.parameter_sets
RunJob.status
RunRecord presence
Artifact refs
failure reason
```

每个 cell 点击后应展示：

- parameter changes；
- RunJob status；
- stdout/stderr tail；
- log artifact link；
- RunRecord link；
- metrics summary；
- failure reason；
- retry action（若允许）。

失败参数集不能从 grid、ParameterSetTable、summary 或 EvidenceReport 中消失。Heatmap 可以排除失败 cell 的 metric 聚合，但必须显式说明 excluded cells。

### ParameterSet 与运行映射

ParameterSet、parameter_set_id、RunJob、RunRecord、FailureRecord 和 heatmap excluded cells 的映射规则见 [Parameter_Set_And_Analysis_Run_Mapping.md](Parameter_Set_And_Analysis_Run_Mapping.md)。

## 7. 指标解释

| 指标 | 注意事项 |
|---|---|
| NSE/KGE | 需要观测数据；应说明时间窗口和站点 |
| RMSE | 受单位和尺度影响，必须标单位 |
| bias_pct | 可解释为偏差方向，但不等于机制原因 |
| water_balance_residual | 数值守恒诊断，不等于水文真实性 |
| runtime_seconds | 工程性能指标，受机器和线程影响 |

## 8. 报告语言

Sensitivity 报告推荐写法：

```text
在 ccw 30 天窗口中，ksath 的 +20% 扰动使 outlet rivqdown 的峰值变化更明显。
这表明该指标在当前设置下对该参数敏感；是否具有水文机制意义需要 PI 结合流域背景判断。
```

Calibration 报告推荐写法：

```text
在训练窗口内，候选参数集相对 baseline 提高了 KGE。
该结果不构成模型结构验证，也不说明该参数集适用于其他事件。
```

Benchmark 报告推荐写法：

```text
在相同 StackLock/DataProvenance 和 ccw tiny fixture 下，candidate 的 runtime 较 baseline 降低。
该结论仅限当前机器、线程和输入配置。
```

## 9. PI gate

需要 PI gate 的情形：

- 使用 calibration 结果覆盖默认参数；
- 将某结果标为 validated；
- 覆盖 benchmark baseline；
- 接受影响输出格式的代码变更；
- 把 sensitivity 观察写成论文机制解释。

## 10. 验收标准

- [ ] AnalysisPlan 为每个参数集生成独立 RunRecord。
- [ ] 失败参数集不会从表中消失。
- [ ] NSE/KGE 在缺少观测数据时不计算。
- [ ] Calibration 报告包含训练/验证窗口。
- [ ] Benchmark 报告包含 baseline/candidate StackLock。
- [ ] 任何默认参数变更需要 PI gate。
- [ ] Batch analysis 运行中显示 BatchProgressGrid。
- [ ] 失败参数集在最终结果和报告中保持可见。
- [ ] 每个 batch cell 能追溯到 RunJob、RunRecord 或 failure reason。
- [ ] Heatmap 排除失败 cell 时必须记录 excluded cells。
- [ ] 一个 parameter_set 同时只能有一个 active RunJob。
- [ ] Heatmap 排除失败 cell 时写 excluded_cells artifact。
