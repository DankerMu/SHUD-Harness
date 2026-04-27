# Patch: docs/04_IMPLEMENTATION/Testing_Strategy.md

## 目标文档

`docs/04_IMPLEMENTATION/Testing_Strategy.md`

## 补充目的

新增 theory-to-code 测试类别，覆盖 schema、gate、mapping、verification、report、search boundary。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

现有 Requirements tests 或 Report tests 后。

## 建议新增内容

并入 `Theory_To_Code_Test_Plan.md` 的 Test IDs。

## 验收标准补充


- [ ] TC-GATE-001/002/003 进入 PR CI。
- [ ] TC-REPORT-002 进入 language guard 负例。
- [ ] TC-SEARCH-001 阻止未审查 search。
- [ ] TC-TRACE-001 进入 release check。
