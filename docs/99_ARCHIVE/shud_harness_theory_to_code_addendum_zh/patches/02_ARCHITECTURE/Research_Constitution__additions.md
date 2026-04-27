# Patch: docs/02_ARCHITECTURE/Research_Constitution.md

## 目标文档

`docs/02_ARCHITECTURE/Research_Constitution.md`

## 补充目的

把“搜索后置于科学正确性”上升为研究宪章原则。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

PI-led governance / forbidden claims 附近。

## 建议新增内容


```markdown
## Search is downstream of scientific correctness

SHUD-Harness 不得用参数搜索、校准或 benchmark improvement 替代理论审查、公式推导、数值离散审查、代码语义映射和 verification。

任何涉及 physical_equation、model_assumption、numerical_implementation、parameter_default 或 output_semantics 的变更，都必须先建立 Theory-to-Code evidence chain，再进入 search/calibration。
```


## 验收标准补充

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。
