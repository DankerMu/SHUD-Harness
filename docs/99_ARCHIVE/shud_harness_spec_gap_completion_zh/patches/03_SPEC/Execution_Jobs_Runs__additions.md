# Patch: Execution_Jobs_Runs additions

**目标文件：** `docs/03_SPEC/Execution_Jobs_Runs.md`

## 插入位置：执行模式后

新增：

```markdown
各 backend 的 submit/status/cancel/collect 接口见 `Runner_Adapter_Contracts.md`。RunJob.backend 是领域状态，不应暴露 Docker/SLURM 的原始状态。
```

## 插入位置：Collect 阶段或 RunRecord 章节后

新增：

```markdown
Collect 必须幂等。重复 collect 同一 job 不得生成多个 RunRecord。幂等 key、collect.lock、recovery 规则见 `Idempotency_Concurrency_Locking_Spec.md`。
```
