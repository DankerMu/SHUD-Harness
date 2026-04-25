# Patch: Research_Object_Model.md additions

**目标文档：** `docs/03_SPEC/Research_Object_Model.md`  
**目的：** 说明 v0.8.1 operational UX 不新增核心对象，只新增支撑对象。  
**合并方式：** 在 8 个核心对象说明之后新增 support objects 小节；在 MemoryNote 部分增加 `pi_decision`。

## 新增内容

```markdown
## Operational UX support objects

v0.8.1 增加四个 operational UX 能力：notification、report export、batch progress view、PI decision comments。这些能力不改变 8 个核心对象模型，只增加支撑对象：

| 支撑对象 | 绑定核心对象 | 用途 |
|---|---|---|
| `NotificationRecord` | TaskCard / RunJob / AnalysisPlan / EvidenceReport | 记录 email notification 触发、收件人、去重和发送状态。 |
| `ReportExport` | EvidenceReport | 记录 standalone HTML / Markdown export artifact。 |
| `AnalysisProgressPayload` | AnalysisPlan / RunJob / RunRecord | 为 BatchProgressGrid 提供聚合状态。 |
| `PiGateDecision` | TaskCard / EvidenceReport / ChangeRequest | 记录 PI gate decision、comment 和 evidence refs。 |

这些对象是 support schemas，不应升级为新的核心科研对象。

## MemoryNote type=pi_decision

PI decision comment 可以写入 MemoryNote：

```yaml
memory_note:
  type: pi_decision
  task_id: TASK-001
  gate_id: GATE-001
  decision: approved
  comment: "同意仅用于 ccw tiny benchmark，不作为科学验证。"
  evidence_refs:
    - reports/REPORT-001.md
  evidence_level: pi_confirmed
  generalization_allowed: false
```

该 note 只能作为任务级决策上下文，不能被 Agent 自动泛化为跨流域科学事实或 validated conclusion。
```
