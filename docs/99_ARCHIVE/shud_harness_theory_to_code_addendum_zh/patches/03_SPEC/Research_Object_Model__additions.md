# Patch: docs/03_SPEC/Research_Object_Model.md

## 目标文档

`docs/03_SPEC/Research_Object_Model.md`

## 补充目的

在不破坏 8 核心对象原则的前提下，增加 Theory-to-Code 支持对象。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

8 个核心对象说明之后，新增“support objects for scientific semantic changes”。

## 建议新增内容


```markdown
## Theory-to-Code support objects

这些对象不是新的核心对象，而是 ChangeRequest、AnalysisPlan、EvidenceReport 和 PiGate 的 support schema：

- TheoryToCodeBundle
- TheoryNote
- EquationSpec
- DerivationRecord
- NumericalSchemeSpec
- ImplementationMapping
- VerificationCase
- PreflightGuardResult
- ExperimentTrial / ExperimentLedger

规则：
- 纯 ops / pure engineering 任务不需要这些对象。
- scientific/numerical semantic change 必须引用 bundle。
- search/calibration 使用 ExperimentLedger，但不能替代理论审查。
```


## 验收标准补充

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。
