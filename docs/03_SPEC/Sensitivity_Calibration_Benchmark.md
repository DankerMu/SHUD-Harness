# 参数敏感性、校准与 Benchmark

## 1. 参数敏感性分析是一等能力

在水文建模中，参数敏感性分析不是 ExperimentSpec 的附属字段，而是高频核心能力。

v0.6 使用 `AnalysisPlan.mode = sensitivity` 表达。

示例：

```yaml
analysis_id: PLAN-SENS-0001
mode: sensitivity
task_id: TASK-0002
baseline_run: RUN-BASE-0001
parameters:
  ksat_multiplier: [0.5, 1.0, 2.0]
  mannings_n_multiplier: [0.7, 1.0, 1.3]
strategy:
  type: one_at_a_time
metrics:
  - peak_flow_error
  - peak_timing_error
  - event_runoff_coefficient
  - water_balance_residual
outputs:
  - sensitivity_table
  - tornado_plot
  - PI_summary
```

### 1.1 参数空间来源记录（AGA-P2）

`parameters` 的取值网格常由 LLM 起草，而参数空间本身就是科学选择。AnalysisPlan 必须记录来源与理由：

```yaml
parameter_space_rationale:
  proposed_by: agent | pi | engineer
  basis: "ksat 倍率按常见物理范围取对数均匀 3 点；mannings_n 参考文献区间"
  confirmed_by: null        # PI/工程师确认后填写
```

规则：

- agent 起草的参数空间是 T3 内容：未经确认时，报告必须标注“参数范围为 agent 建议值”；
- 报告 limitations 必须包含未覆盖的参数区域（如“仅测试 ksat×[0.5,2]，未覆盖极端值”）——
  sensitivity/calibration 模式下，limitations 至少含 1 条 coverage 声明，由 Reviewer validator 强制。

## 2. Sensitivity 不等于 calibration

敏感性分析回答：

```text
哪些参数对目标指标敏感？
```

校准回答：

```text
在给定搜索空间内，哪些参数组合能改善目标函数？
```

科学判断回答：

```text
这种改善是否说明模型结构或物理机制正确？
```

第三个问题只由 PI 判断。

## 2.1 Search precondition for scientific changes

如果 sensitivity/calibration/search 依赖的 ChangeRequest 属于 high-risk semantic level：

```text
output_semantics | numerical_implementation | parameter_default | physical_equation | model_assumption
```

则 AnalysisPlan 必须引用 `requires_theory_bundle_id`，且该 bundle 状态必须为：

```text
accepted_for_search | accepted
```

没有 baseline_run_id 时，报告不得生成 improvement claim。

## 3. CalibrationPlan

```yaml
analysis_id: PLAN-CAL-0001
mode: calibration
task_id: TASK-0003
allowed_parameters:
  ksat_multiplier: [0.25, 2.0]
  mannings_n_multiplier: [0.5, 1.5]
objective:
  primary: peak_flow_error
  secondary:
    - water_balance_residual
    - peak_timing_error
holdout:
  enabled: true
  events:
    - storm_2009_08_21
rules:
  - Do not tune hidden numerical tolerances.
  - Do not generalize beyond holdout.
  - Present results as calibration performance, not structural proof.
```

## 4. Benchmark tiers

MVP 只保留三层 benchmark，但不做复杂对象：

### smoke

```text
- build SHUD
- run tiny case
- parse output
- basic water balance
```

### engineering regression

```text
- old-output compatibility
- rSHUD roundtrip
- fixed event case
- runtime/memory threshold
```

### science-assist benchmark

```text
- PI 指定 basin/event
- sensitivity or calibration table
- holdout comparison if available
```

## 5. Benchmark baseline 更新

规则：

```text
- agent 不得覆盖 baseline；
- baseline replacement requires PI approval；
- replacement report must include old vs new summary；
- stack_id and data_id must match or explain drift。
```

## 6. 报告语言约束

Agent 报告中禁止：

```text
- “证明了模型机制”；
- “验证了某物理过程”；
- “模型普遍改进”。
```

允许：

```text
- “在该 basin/event 上，指标 X 改善”；
- “该参数对洪峰误差更敏感”；
- “该观察需要 PI 判断是否支持假设 H1”；
- “holdout 尚未运行，因此不能推广”。
```
