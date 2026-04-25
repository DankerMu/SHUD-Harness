# Patch: Memory_Skills_Lite additions

**目标文件：** `docs/03_SPEC/Memory_Skills_Lite.md`

## 插入位置：MemoryNote schema 后

新增：

```markdown
`pi_decision` 类型 MemoryNote 的详细 schema 见 `Support_Schema_Contracts.md` 和 `PI_Decision_Comments_Spec.md`。其 `generalization_allowed` 必须为 false，不得自动升级为跨流域科学事实。
```

## 验收标准补充

```markdown
- [ ] MemoryTool 不自动把 evidence_note 标记为 verified。
- [ ] pi_decision note 只能由 PI decision flow 产生。
```
