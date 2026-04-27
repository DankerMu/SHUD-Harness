# Patch: docs/03_SPEC/Report_Generation_Spec.md

## 目标文档

`docs/03_SPEC/Report_Generation_Spec.md`

## 补充目的

为科学语义变更报告新增 Theory-to-Code Evidence 章节。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

报告模板章节后、语言约束前。

## 建议新增内容

并入 `Theory_To_Code_Report_Lineage_Spec.md` 的报告模板和 language guard additions。

## 验收标准补充


- [ ] 高风险任务报告缺 Theory-to-Code Evidence 不能进入 reviewed。
- [ ] 报告明确 verification/calibration/validation 区别。
- [ ] HTML export 保留该章节摘要。
