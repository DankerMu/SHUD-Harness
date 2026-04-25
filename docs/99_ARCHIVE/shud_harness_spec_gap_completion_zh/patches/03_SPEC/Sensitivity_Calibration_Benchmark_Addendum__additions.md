# Patch: Sensitivity_Calibration_Benchmark_Addendum additions

**目标文件：** `docs/03_SPEC/Sensitivity_Calibration_Benchmark_Addendum.md`

## 插入位置：Batch 运行后

新增：

```markdown
ParameterSet、parameter_set_id、RunJob、RunRecord、FailureRecord 和 heatmap excluded cells 的映射见 `Parameter_Set_And_Analysis_Run_Mapping.md`。
```

## 验收标准补充

```markdown
- [ ] 一个 parameter_set 同时只能有一个 active RunJob。
- [ ] Heatmap 排除失败 cell 时写 excluded_cells artifact。
```
