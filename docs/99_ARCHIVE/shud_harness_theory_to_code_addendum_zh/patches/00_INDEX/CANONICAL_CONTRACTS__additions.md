# Patch: docs/00_INDEX/CANONICAL_CONTRACTS.md

## 目标文档

`docs/00_INDEX/CANONICAL_CONTRACTS.md`

## 补充目的

声明 Theory-to-Code support schema、API、event、artifact 和 gate 的权威源。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

Support schema / API / event / artifact registry 索引之后。

## 建议新增内容


```markdown
## Theory-to-Code canonical sources

| Contract | Canonical source |
|---|---|
| TheoryToCodeBundle / EquationSpec / NumericalSchemeSpec / ImplementationMapping / VerificationCase | `Support_Schema_Contracts.md` + generated Zod schema |
| Scientific semantic level and gate rules | `Scientific_Change_Gating_Spec.md` |
| Theory-to-Code report section and assertion lineage | `Theory_To_Code_Report_Lineage_Spec.md` |
| Search preflight and mutation boundary | `Preflight_And_Mutation_Boundary_Spec.md` |
| API contracts | `Theory_To_Code_API_Contracts.md` and `Schemas_APIs_CLIs.md` |
| Tests | `Theory_To_Code_Test_Plan.md` |
```

Implementation rule:

```text
Markdown explains semantics; Zod schema is the executable source of truth after implementation.
```


## 验收标准补充

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。
