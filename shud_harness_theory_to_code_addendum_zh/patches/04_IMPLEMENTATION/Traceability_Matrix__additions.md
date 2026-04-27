# Patch: docs/04_IMPLEMENTATION/Traceability_Matrix.md

## 目标文档

`docs/04_IMPLEMENTATION/Traceability_Matrix.md`

## 补充目的

增加 equation_id → code_target → verification_case → RunRecord → Report 的科学证据链追踪。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

Evidence chain traceability 后。

## 建议新增内容

并入 `Theory_To_Code_Traceability_Addendum.md`。

## 验收标准补充


- [ ] accepted high-risk ChangeRequest 有 bundle trace。
- [ ] report assertion 可追到 verification_case 和 artifact。
- [ ]新增 FR-TC/GR-TC/TR-TC 有测试 ID。
