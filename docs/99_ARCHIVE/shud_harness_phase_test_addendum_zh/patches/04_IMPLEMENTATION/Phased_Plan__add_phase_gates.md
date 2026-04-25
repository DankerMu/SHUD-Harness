# Patch: Phased_Plan.md — add phase gates

**目标文档：** `docs/04_IMPLEMENTATION/Phased_Plan.md`  
**插入位置：** 每个 Week 小节的“验收”之后。  
**目的：** 当前 `Phased_Plan.md` 已有交付和验收，但测试不够细；建议增加每周 `Test Gate` 和 `Exit Gate`。

---

## 建议新增内容

### Week 1 Test Gate

```text
- schema: TaskCard / Artifact / ErrorRecord valid+invalid tests
- API: POST/GET task success + schema_error
- snapshot: task snapshot write/read/reload
- UI: Dashboard → Workbench smoke
- CI: typecheck + docs link + basic unit tests
```

### Week 2 Test Gate

```text
- submodule commit discovery
- DataProvenance path + sha256 validation
- ArtifactManifest integrity
- Artifact evidence_usable rules
- ResearchContext UI smoke
```

### Week 3 Test Gate

```text
- dummy local_job submit/status/collect
- collect idempotency
- WebSocket seq/reconnect/snapshot_required
- RuntimeTerminal log chunk streaming
- service restart recovery smoke
- sandbox path escape negative test
```

### Week 4 Test Gate

```text
- SHUD build exit_code=0
- ccw END=30 patch in task workspace only
- run exits 0
- RunRecord + metrics artifact + hydrograph artifact
- water_balance_residual threshold
- missing output produces ErrorRecord
```

### Week 5 Test Gate

```text
- rSHUD current output read
- old-output fixture compatibility
- ChangeRequest risk/interface impact rules
- patch bundle sha256
- DiffViewer smoke
```

### Week 6 Test Gate

```text
- 3x3 parameter set generation
- parameter_set ↔ job ↔ run mapping
- failed cell remains visible
- progress aggregate counts
- heatmap shape and metric aggregation
```

### Week 7 Test Gate

```text
- report language guard
- report with missing artifact limitation
- PI decision comment required rules
- agent role forbidden on PI decision endpoint
- standalone HTML export watermark
- notification mock dedupe
```

### Week 8 Test Gate

```text
- Zero event adapter
- Zero tool call through Harness sandbox
- Zero memory create does not default verified
- LLM streaming reconnect/interruption
- natural language → task → dummy job → report e2e
```

---

## 合并后效果

`Phased_Plan.md` 将从“交付计划”升级为“交付 + 测试 + 出口标准”的实施计划。
