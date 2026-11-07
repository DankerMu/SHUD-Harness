---
status: frozen
---

# Sensitivity / Calibration / Benchmark 补充规范

**状态：** M5 实现基线与后续规划边界。

**适用范围：** M5 的单流域 OAT、AnalysisPlan、RunJob/RunRecord 与 EvidenceReport；calibration、通用 benchmark 与 UI 扩展仅作后续规划。

**目标：** 明确运行结构、指标、报告语言和 PI gate，不把未实现的后续能力写成 M5 入口。

## 1. 三类任务的边界

| 类型 | 目标 | 不能自动得出的结论 |
|---|---|---|
| sensitivity | 观察参数扰动对指标或过程线的影响 | 参数就是真实物理因子 |
| calibration | 在给定目标函数和数据窗口下寻找较优参数 | 模型结构已验证 |
| benchmark | 比较 baseline 与 candidate 的工程/数值表现 | candidate 普遍优于 baseline |

## 2. AnalysisPlan

M5 对象只按 [Minimal_Schemas §6](Minimal_Schemas.md#6-analysisplan) 与 [analysis-plans](../../openspec/changes/m5-oat-sensitivity/specs/analysis-plans/spec.md) 定义：品牌 PLAN id、不可变单文件、3–5 个 pset、恰一个 baseline，输入摘要绑定同一批校验字节。旧嵌套 analysis_plan/id、baseline_run_id、basin_id、event_window、metrics 示例不是 M5 接口。

M5 Non-Goals 与复活条件统一见 [design](../../openspec/changes/m5-oat-sensitivity/design.md#goals--non-goals)：calibration、观测类指标、heatmap/tornado、批进度卡、plan 确认卡、多流域/holdout、敏感性指数、排名和机制解释均不在本轮。后续章节不能扩大该边界。

## 3. Sensitivity

### 3.1 设计

M5 固定 one_at_a_time；非 baseline pset 恰一个白名单键，四键为 GEOL_KSATH、GEOL_KSATV、LC_ROUGH、RIV_ROUGH，倍率 [0.5, 2.0] 且不为 1。参数只是作用于运行副本的 calib 倍率，不改默认参数或类别表。

**D15(5)：M5 范围裁剪、非放宽 baseline。** rationale 的 proposed_by 固定 agent、confirmed_by 恒 null；报告必须标注“参数范围为 agent 建议值”，没有 plan 确认卡。

### 3.2 输出

每个 pset 通过 RunJob/RunRecord 关联，成功 run 的 collect 计算逐 run metrics；失败原因及缺失指标保持可见。

**D15(7)：M5 范围裁剪、非放宽 baseline。** `report_generate` 派生 `reports/<report_id>.sensitivity.json`，EvidenceReport 用 path/sha256 引用；没有独立 sensitivity_table artifact、AnalysisPlan summary 文件、SensitivityHeatmap 或额外汇总工具。

## 4. Calibration

本节为 M5 之后的规划；M5 不生产 CalibrationPlan 或观测类指标。

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
runs/<run_id>/run-job.json
runs/<run_id>/run-record.json
runs/<run_id>/metrics.json
```

不要让多个参数集共享输出目录。失败运行保留在 table 中。

## 6.1 Batch progress view

**D15(4)：M5 范围裁剪、非放宽 baseline。** 不生产 AnalysisProgressPayload、progress artifact 或批进度卡，也不建 batch_policy；pset 状态只从 RunJob/RunRecord 派生。模型显式等待作业并收集，不以 UI 存在代替运行证据。

失败参数集必须在汇总表与 EvidenceReport 保持可见。Heatmap、excluded_cells artifact 是 M5 之后的 UI 规划，不能作为本轮验收条件。

### ParameterSet 与运行映射

不可变 plan、关联 id 与有效 run 的映射见 [Parameter_Set_And_Analysis_Run_Mapping.md](Parameter_Set_And_Analysis_Run_Mapping.md)；不另建 ParameterSet 状态文件或 FailureRecord 契约。

## 7. 指标解释

| 指标 | 注意事项 |
|---|---|
| NSE/KGE | 需要观测数据；应说明时间窗口和站点 |
| RMSE | 受单位和尺度影响，必须标单位 |
| bias_pct | 可解释为偏差方向，但不等于机制原因 |
| water_balance_residual | 数值守恒诊断，不等于水文真实性 |
| runtime_seconds | 工程性能指标，受机器和线程影响 |

## 8. 报告语言

M5 sensitivity 报告只陈述单流域、单窗口内相对 baseline 的变化，例如：

```text
在 ccw 的本次窗口内，PSET-2 的出口峰值相对 baseline 的变化见汇总表。
参数范围为 agent 建议值；结论只覆盖本次计划列出的单键倍率。
```

不得由 Δ 推出敏感性指数、参数排名或机制解释；下列 calibration/benchmark 写法仅用于后续对应能力，不是 M5 sensitivity 结论模板。

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

- [ ] M5 plan 为单流域 OAT，字段及七条 refine 与 Minimal_Schemas §6 一致。
- [ ] 各参数集使用独立 run 目录，plan/pset 关联可追溯，失败及被取代运行在报告中保持可见。
- [ ] 汇总表由报告派生，引用逐 run metrics；不新增独立 sensitivity_table artifact。
- [ ] rationale 的 confirmed_by 恒 null，报告含 agent 建议值与覆盖声明。
- [ ] 不计算 NSE/KGE、敏感性指数或排名，不给机制解释。
- [ ] 不生产 AnalysisProgressPayload、heatmap 或 excluded_cells artifact；这些能力按 Non-Goals 另行立项。
- [ ] 默认参数与 benchmark baseline 变更仍须 PI gate。
