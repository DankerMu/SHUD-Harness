# Patch: CICD_Release.md — add phase jobs

**目标文档：** `docs/04_IMPLEMENTATION/CICD_Release.md`  
**插入位置：** `## 1. CI 阶段` 之后。  
**目的：** 把不同阶段新增能力映射到 CI job。

---

## 建议新增内容

```markdown
## 1.1 CI jobs by phase

| Week | 新增 CI job |
|---:|---|
| W0 | docs, gitmodules parse, readiness YAML check |
| W1 | schema, task API, snapshot, UI shell smoke |
| W2 | stack/data/artifact manifest |
| W3 | runner, websocket, recovery, sandbox path |
| W4 | ccw tiny nightly/manual |
| W5 | rSHUD roundtrip and patch bundle |
| W6 | batch progress and heatmap |
| W7 | report export, PI decision, notification mock |
| W8 | Zero adapter and natural language e2e |

PR 必跑 docs/schema/unit/API/WebSocket/sandbox/UI-dummy；Nightly 跑 ccw tiny、rSHUD roundtrip 和 recovery；Release 跑 manifest、docs zip、schema JSON、accepted report export。
```
