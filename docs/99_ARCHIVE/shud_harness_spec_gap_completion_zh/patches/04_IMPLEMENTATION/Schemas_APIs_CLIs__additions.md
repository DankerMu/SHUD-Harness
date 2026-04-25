# Patch: Schemas_APIs_CLIs additions

**目标文件：** `docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md`

## 插入位置：API 端点后

新增：

```markdown
API 错误响应、HTTP status mapping、Idempotency-Key 和 retry policy 见 `API_Error_And_Idempotency_Contracts.md`。
```

## 插入位置：Schema Validation 后

新增：

```markdown
Zod schema 生成 JSON Schema / Markdown schema 的流程见 `Schema_Generation_And_Drift_Control.md`。实现后不再手工维护 generated schema 文档。
```
