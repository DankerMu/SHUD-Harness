# Patch: Testing_Strategy.md — add phase matrix

**目标文档：** `docs/04_IMPLEMENTATION/Testing_Strategy.md`  
**插入位置：** `## 1. 测试分层` 之后，或作为新的 `## 1.1 阶段测试矩阵`。  
**目的：** 当前测试策略是横向分层，缺少 Week 1--8 的阶段测试矩阵。

---

## 建议新增章节

```markdown
## 1.1 阶段测试矩阵

| Week | 必须新增的自动化测试 | Fixture | CI 级别 |
|---:|---|---|---|
| W0 | gitmodules parse, docs link, readiness YAML | none | PR |
| W1 | core schema, API task, snapshot reload, UI shell smoke | schema-only | PR |
| W2 | submodule discovery, data sha256, artifact manifest | schema-only | PR |
| W3 | dummy job submit/log/collect, WebSocket reconnect, recovery smoke | dummy-runner | PR |
| W4 | SHUD build/run tiny, RunRecord, hydrograph, WB residual | ccw tiny | nightly/manual |
| W5 | rSHUD roundtrip, old-output fixture, patch bundle | old-output | PR/nightly |
| W6 | batch progress, failed cell, heatmap aggregation | dummy-batch | PR |
| W7 | report guard, PI decision, export, notification mock | report fixture | PR |
| W8 | Zero adapter, LLM stream, natural language e2e | dummy-runner | PR/nightly |
```

## 建议新增引用

在 `Testing_Strategy.md` 末尾加入：

```markdown
详细阶段测试见 `Phase_By_Phase_Test_Plan.md`。Fixture 与命令矩阵见 `Test_Fixtures_And_Command_Matrix.md`。CI 映射见 `CI_Test_Jobs_By_Phase.md`。
```
