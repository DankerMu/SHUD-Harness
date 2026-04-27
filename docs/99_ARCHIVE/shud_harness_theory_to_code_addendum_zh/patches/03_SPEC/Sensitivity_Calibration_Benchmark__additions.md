# Patch: docs/03_SPEC/Sensitivity_Calibration_Benchmark.md

## 目标文档

`docs/03_SPEC/Sensitivity_Calibration_Benchmark.md`

## 补充目的

明确 sensitivity/calibration/search 是后置层，不能替代理论/实现验证。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

“Sensitivity 不等于 calibration”之前或之后。

## 建议新增内容


```markdown
## Search precondition for scientific changes

如果 sensitivity/calibration/search 依赖的 ChangeRequest 属于 high-risk semantic level：

```text
output_semantics | numerical_implementation | parameter_default | physical_equation | model_assumption
```

则 AnalysisPlan 必须引用 `requires_theory_bundle_id`，且该 bundle 状态必须为：

```text
accepted_for_search | accepted
```

没有 baseline_run_id 时，报告不得生成 improvement claim。
```


## 验收标准补充

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。
