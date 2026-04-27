# Patch: docs/03_SPEC/Report_Review_And_Evidence_Lineage_Spec.md

## 目标文档

`docs/03_SPEC/Report_Review_And_Evidence_Lineage_Spec.md`

## 补充目的

扩展 assertion taxonomy，支持 theory/equation/derivation/mapping/verification/search evidence。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

Report assertion schema 后。

## 建议新增内容

并入 `Theory_To_Code_Report_Lineage_Spec.md` 中的 assertion types 和 lineage requirements。

## 验收标准补充


- [ ] verification_result assertion 必须有 artifact ref。
- [ ] search_result assertion 必须有 baseline/candidate refs。
- [ ] equation_statement 必须有 equation_id。
