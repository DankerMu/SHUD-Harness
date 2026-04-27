# Patch: docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md

## 目标文档

`docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md`

## 补充目的

将 Theory-to-Code API 纳入 API registry。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

现有 REST API registry 后。

## 建议新增内容

并入 `Theory_To_Code_API_Contracts.md` 的 endpoint、error code 和 WebSocket event。

## 验收标准补充


- [ ] API registry 包含 /api/theory-bundles 等 endpoint。
- [ ] 错误码使用统一 API error envelope。
- [ ] search preflight endpoint 有测试。
