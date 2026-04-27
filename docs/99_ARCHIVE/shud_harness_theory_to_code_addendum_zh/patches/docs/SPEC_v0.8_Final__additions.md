# Patch: docs/SPEC_v0.8_Final.md

## 目标文档

`docs/SPEC_v0.8_Final.md`

## 补充目的

在自包含规格书中加入一段高层原则，避免主规格仍给人“先运行/搜索，后治理”的印象。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

设计原则或 Research Governance 附近。

## 建议新增内容


```markdown
## Theory-to-Code Principle

For SHUD scientific changes, SHUD-Harness prioritizes the reviewable chain:

Research question → theory note → equation spec → derivation record → numerical scheme → implementation mapping → verification case → evidence report → PI decision.

Sensitivity analysis, calibration and controlled search are downstream tools. They must not be used to replace theory review, derivation review, implementation mapping or verification.
```


## 验收标准补充

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。
