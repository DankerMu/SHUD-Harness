# Traceability Matrix

**状态：** v0.8.1 实施追踪补充  
**目标：** 将核心需求、文档来源、实现模块、测试用例和 release gate 关联起来。

---

## 1. 核心 traceability

| 需求 | Canonical 文档 | 实现模块 | 测试 |
|---|---|---|---|
| TaskCard lifecycle | Minimal_Schemas.md | `packages/core/domain/schemas/task.ts`, `task-service.ts` | W1 schema/API/UI |
| StackLock | Minimal_Schemas.md | `stack-service.ts` | W2 submodule discovery |
| DataProvenance | Minimal_Schemas.md | `data-service.ts` | W2 data register |
| RunJob | Minimal_Schemas.md, Runner_Adapter_Contracts.md | `job-service.ts`, `runner-adapters/*` | W3 runner/collect |
| RunRecord | Minimal_Schemas.md | `run-record-service.ts` | W3/W4 collect |
| Artifact | Support_Schema_Contracts.md, Artifact_Registry_Spec.md | `artifact-registry.ts` | W2/W3/W7 artifact tests |
| WebSocket event | WebSocket_Protocol.md | `ws/events.ts`, `useWebSocket.ts` | W3 reconnect/replay |
| Snapshot recovery | Workspace_Snapshot_And_Recovery_Spec.md | `snapshot-service.ts` | W3 recovery |
| API error | API_Error_And_Idempotency_Contracts.md | `middleware/error.ts` | W1/W3/W7 negative tests |
| Idempotency | Idempotency_Concurrency_Locking_Spec.md | `idempotency-service.ts` | W3 collect, W7 export/decision |
| Report | Report_Generation_Spec.md | `report-generator.ts` | W7 language guard |
| Report export | Report_Export_Spec.md | `report-export-service.ts` | W7 export snapshot |
| PI decision | PI_Decision_Comments_Spec.md | `pi-gate-service.ts`, `PIDecisionPanel.tsx` | W7 permission/comment/audit |
| Batch progress | Batch_Progress_View_Spec.md | `analysis-service.ts`, `BatchProgressGrid.tsx` | W6 progress tests |
| Notification | Notification_Design.md | `notification-service.ts` | W7/W8 mock/dedupe |
| Zero adapter | Zero_Reuse_Matrix.md | `agent/zero-adapter.ts` | W8 adapter tests |

---

## 2. Release traceability

| Release | 必须通过 |
|---|---|
| 0.8.1-skeleton | W1 + W2 + W3 dummy closed loop |
| 0.8.2-tiny-run | W4 ccw tiny + report basic |
| 0.8.3-operational-ux | W6 batch progress + W7 report export/PI decision |
| 0.8.4-zero-agent | W8 Zero/LLM demo |

---

## 3. Evidence chain traceability

任何报告中的 observation 必须能追溯到：

```text
EvidenceReport.observation
→ artifact_id / run_id / analysis_plan_id
→ RunRecord
→ RunJob
→ StackLock + DataProvenance
→ source files + command trace
```

测试中必须包含：

- artifact missing 时 observation 不得进入 accepted report；
- RunRecord 缺 stack_id/data_id 时 report 只能 draft；
- accepted report export 必须包含 export manifest。

---

## 4. PI governance traceability

任何高风险动作必须能追溯到：

```text
ChangeRequest / PiGate
→ PiGateDecision
→ AuditEvent
→ MemoryNote(type=pi_decision, generalization_allowed=false)
→ linked EvidenceReport / RunRecord / Artifact
```

测试中必须包含：

- Agent 角色不能 approve；
- reject/revision 必须有 comment；
- high-risk approve 必须有 comment；
- comment 不自动泛化为科学事实。
