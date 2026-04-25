# Patch: MVP_Implementation_Readiness_Checklist.md — closeout workflow

**目标文档：** `docs/04_IMPLEMENTATION/MVP_Implementation_Readiness_Checklist.md`  
**插入位置：** P0/P1 清单之后。  
**目的：** 让 readiness checklist 从“待办列表”变成“签核流程”。

---

## 建议新增内容

```markdown
## Readiness closeout

进入 Week 1 前，工程师必须生成：

```yaml
workspace/readiness/readiness_gate_v0_8_1.yaml
```

字段：

```yaml
version: v0.8.1
checked_at: ...
checked_by: ...
decision: pass | pass_with_notes | block
p0:
  gitmodules_parse: pass | fail
  submodules_checkout: pass | fail
  canonical_index: pass | fail
  core_schema: pass | fail
  support_schema: pass | fail
  api_registry: pass | fail
  error_idempotency: pass | fail
  artifact_registry: pass | fail
  lock_recovery: pass | fail
notes: []
```

若任一 P0 为 fail，则不得进入 Week 1。P1 可以在 Week 1/2 内同步完成，但必须有 owner 和目标周。
```
