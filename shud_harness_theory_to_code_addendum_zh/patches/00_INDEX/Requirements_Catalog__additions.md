# Patch: docs/00_INDEX/Requirements_Catalog.md

## 目标文档

`docs/00_INDEX/Requirements_Catalog.md`

## 补充目的

把理论到代码治理纳入正式 FR/GR/TR/NFR 需求体系。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

现有 User Stories 和 FR/NFR/GR/TR 表格后，或作为 v0.8.3 subsection。

## 建议新增内容

直接并入 `docs/00_INDEX/Theory_To_Code_Requirements_Addendum.md` 中的 US-TC、FR-TC、GR-TC、TR-TC、NFR-TC。

## 验收标准补充


- [ ] 新需求 ID 不与现有 ID 冲突。
- [ ] P0/P1 需求均有验收标准。
- [ ] Traceability_Matrix 引用新增需求。
