# Patch: Phased_Plan additions

**目标文件：** `docs/04_IMPLEMENTATION/Phased_Plan.md`

## 插入位置：Week 1 前

新增 Readiness Gate：

```markdown
进入 Week 1 前，必须完成 `MVP_Implementation_Readiness_Checklist.md` 的 P0 项。
```

## 插入位置：Week 1 交付中

补充：

```text
- Artifact schema + artifact registry skeleton
- ErrorRecord schema + API error envelope
- Idempotency/lock service skeleton
- task snapshot skeleton
```

## 插入位置：Week 3 交付中

补充：

```text
- local_job runner adapter
- collect idempotency tests
- service restart recovery smoke
```
