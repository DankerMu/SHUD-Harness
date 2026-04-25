# Patch: MASTER_INDEX additions

**目标文件：** `docs/00_INDEX/MASTER_INDEX.md`

## 插入位置 1：核心文件区域

将核心文件路径明确为：

```markdown
1. `../../CLAUDE.md` — 项目定义 + 仓库布局 + 设计决策速查
2. `../SPEC_v0.8_Final.md` — 自包含实施规格书
3. `CANONICAL_CONTRACTS.md` — canonical contract 索引
```

## 插入位置 2：00_INDEX 文档表

新增：

```markdown
| `CANONICAL_CONTRACTS.md` | canonical schema/API/event/path/artifact/lock 的唯一事实源索引 |
| `Spec_Gap_Audit_v0_8_1.md` | v0.8.1 规格缺口审查 |
| `Spec_Gap_Merge_Map.md` | 本轮补充文档合并地图 |
```

## 插入位置 3：03_SPEC 文档表

新增本包中的 10 个 spec 文档。

## 插入位置 4：04_IMPLEMENTATION 文档表

新增：

```markdown
| `API_Error_And_Idempotency_Contracts.md` | REST API 错误响应与幂等请求契约 |
| `Schema_Generation_And_Drift_Control.md` | Zod/JSON Schema/Markdown schema 生成与 drift 检查 |
| `MVP_Implementation_Readiness_Checklist.md` | Week 1 开工前 readiness gate |
```
