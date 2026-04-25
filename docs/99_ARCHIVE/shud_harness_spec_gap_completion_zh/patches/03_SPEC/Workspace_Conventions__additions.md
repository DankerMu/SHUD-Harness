# Patch: Workspace_Conventions additions

**目标文件：** `docs/03_SPEC/Workspace_Conventions.md`

## 插入位置：Artifact 目录后

新增目录：

```text
snapshots/
locks/
exports/
packages/
notifications/
```

## 插入位置：清理策略前

新增：

```markdown
锁文件和幂等记录见 `Idempotency_Concurrency_Locking_Spec.md`。Workspace snapshot 和 service restart recovery 见 `Workspace_Snapshot_And_Recovery_Spec.md`。
```
