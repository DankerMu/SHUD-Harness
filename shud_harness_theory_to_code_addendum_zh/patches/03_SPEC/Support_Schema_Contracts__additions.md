# Patch: docs/03_SPEC/Support_Schema_Contracts.md

## 目标文档

`docs/03_SPEC/Support_Schema_Contracts.md`

## 补充目的

新增 Theory-to-Code support schema，并标记 canonical Zod 源。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

现有 Artifact、PiGate、NotificationRecord 等 support schema 后。

## 建议新增内容

并入 `docs/03_SPEC/Theory_To_Code_Support_Schemas.md` 中列出的 schema；字段详见各正式 spec。

## 验收标准补充


- [ ] Support schema index 包含 TheoryToCodeBundle 等对象。
- [ ] generated JSON Schema 覆盖这些对象。
- [ ] schema drift check 包含 theory-to-code schema。
