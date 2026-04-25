# Patch: Sensitivity_Calibration_Benchmark_Addendum.md additions

**目标文档：** `docs/03_SPEC/Sensitivity_Calibration_Benchmark_Addendum.md`  
**目的：** 补充 BatchProgressGrid 和批运行中间状态要求。  
**合并方式：** 在 `## 6. Batch 运行` 之后追加；在验收标准追加。

## 插入位置 1

在 `## 6. Batch 运行` 之后追加：

```markdown
## 6.x Batch progress view

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
```

## 插入位置 2

在 `## 10. 验收标准` 追加：

```markdown
- [ ] Batch analysis 运行中显示 BatchProgressGrid。
- [ ] 失败参数集在最终结果和报告中保持可见。
- [ ] 每个 batch cell 能追溯到 RunJob、RunRecord 或 failure reason。
- [ ] Heatmap 排除失败 cell 时必须记录 excluded cells。
```
