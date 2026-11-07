---
status: frozen
---

# 参数敏感性、校准与 Benchmark

## 1. 参数敏感性分析是一等能力

M5 只交付单流域、单窗口的 one-at-a-time（OAT）比较：一个不可变 AnalysisPlan，3–5 个 pset，恰一个 baseline；非 baseline 每项仅扰动一个 calib 白名单键。四键为 GEOL_KSATH、GEOL_KSATV、LC_ROUGH、RIV_ROUGH，倍率范围 [0.5, 2.0] 且不得为 1。字段、品牌 id 与完整示例统一见 [Minimal_Schemas §6](Minimal_Schemas.md#6-analysisplan)，不再保留旧 parameters/metrics/outputs 示例作为第二套 schema。

M5 规范与后续实现的边界见 [Goals / Non-Goals](../../openspec/changes/m5-oat-sensitivity/design.md#goals--non-goals)：不做 calibration、controlled search、holdout、多流域、观测类指标（NSE/KGE/peak_flow_error）、heatmap/tornado、批进度卡、plan 确认卡、敏感性指数、排名或机制解释。校准课题由 PI 启动；观测指标先核实数据质量；UI 能力须 K7 解除或 M6 立项；参数扩面须 PI 授权并核对施加语义。其余复活条件以该 Non-Goals 为准。下文 calibration、search 与通用 benchmark 内容是后续规划，不是 M5 已支持的入口。

**D15(7)：M5 范围裁剪、非放宽 baseline。** 汇总表由 `report_generate` 从有效 run 的 metrics 确定性派生到 `reports/<report_id>.sensitivity.json`，由 EvidenceReport 引用，不设独立 sensitivity_table artifact 或工具；只列相对 baseline 的变化。逐 run 指标公式统一见 [SHUD_Output_Variables §12](SHUD_Output_Variables.md#12-水量平衡最小变量集)。

### 1.1 参数空间来源记录（AGA-P2）

参数空间本身是科学选择。M5 的 `parameter_space_rationale` 严格含 `proposed_by: agent`、非空 `basis`、`confirmed_by: null`；由模型提出的范围不自动成为 PI 确认。

**D15(5)：M5 范围裁剪、非放宽 baseline。** confirmed_by 恒 null，没有运行前 plan 确认路径。报告强制标注“参数范围为 agent 建议值”，并由确定性生成器追加覆盖声明：逐键列出已测倍率，明确未测区域不在结论范围。失败参数集保持可见，不由模型删去。

## 2. Sensitivity 不等于 calibration

M5 敏感性报告只陈述：

```text
在指定流域与窗口内，各参数集相对 baseline 的指标变化是多少？
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
- “在该流域与窗口内，PSET-2 的峰值相对 baseline 变化为表中 Δ%”；
- “参数范围为 agent 建议值”；
- “仅覆盖计划列出的单键倍率，未覆盖其它区域”。
```

M5 不以这些变化给出敏感性指数、参数排名、机制解释或校准结论，不推广到单流域单窗口以外。
