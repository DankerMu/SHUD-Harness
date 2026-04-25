# Schema Generation 与 Drift Control

**状态：** v0.8.1 P1 实施补充  
**适用范围：** Zod schema、JSON Schema、Markdown schema、API request/response validation、CI。  
**目标：** 防止 Markdown 规格、Zod schema 和前端类型长期分叉。

## 1. Source of truth

进入实现后，Zod schema 是字段最高事实源：

```text
packages/core/src/domain/schemas/*.ts
```

Markdown 中的字段表应由脚本生成：

```text
docs/generated/schema/*.md
docs/generated/json-schema/*.json
```

## 2. 推荐脚本

```bash
bun run schema:generate
bun run schema:check
bun run docs:links
bun run docs:lint
```

## 3. 生成内容

每个 schema 生成：

- JSON Schema；
- Markdown 字段表；
- enum 列表；
- example YAML；
- changelog diff。

## 4. Drift check

CI 执行：

```bash
bun run schema:generate
git diff --exit-code docs/generated/schema docs/generated/json-schema
```

如果手写文档引用旧 enum，link/check 脚本应报警。

## 5. Versioning

每个 schema 包含：

```ts
schema_version: "0.8.1"
```

重大字段变更需要：

- changelog；
- migration note；
- test fixture update。

## 6. 验收标准

- [ ] Zod schema 可生成 JSON Schema。
- [ ] Markdown schema generated docs 不手工改。
- [ ] CI 能发现 enum drift。
- [ ] API request/response 都用 schema 校验。
