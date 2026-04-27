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

## 3.1 Theory-to-Code Trace Chain

科学证据链追踪：equation_id → code_target → verification_case → RunRecord → Report。

```text
TheoryNote.scientific_question
→ EquationSpec.equation_id
→ DerivationRecord.step_id
→ NumericalSchemeSpec.flux/source/boundary ids
→ ImplementationMapping.code_target_id
→ VerificationCase.verification_case_id
→ RunJob.job_id
→ RunRecord.run_id
→ Artifact.artifact_id
→ EvidenceReport.assertion_id
→ PiGateDecision.decision_id
```

### Theory-to-Code Matrix Rows

| Requirement ID | Source Doc | Implementation Module | Test ID | Phase | Release Gate |
|---|---|---|---|---|---|
| FR-TC-001 | Theory_To_Code_Governance_Spec | `theory-bundle-service.ts` | TC-SCHEMA-001 | Phase 3 | tiny-run |
| FR-TC-002 | Equation_And_Derivation_Spec | `equation-service.ts` | TC-EQ-001 | Phase 3 | tiny-run |
| FR-TC-005 | Implementation_Mapping_Spec | `implementation-mapping-service.ts` | TC-MAP-001 | Phase 4/5 | governance |
| FR-TC-006 | Verification_Case_Spec | `verification-service.ts` | TC-VER-001 | Phase 3 | tiny-run |
| GR-TC-001 | Scientific_Change_Gating_Spec | `pi-gate-service.ts` | TC-GATE-002 | Phase 5 | governance |
| TR-TC-006 | Theory_To_Code_Test_Plan | `traceability-check.ts` | TC-TRACE-001 | Phase 5/6 | release |

### Theory-to-Code Release Check

Release 前检查：

- 每个 accepted high-risk ChangeRequest 有 bundle；
- 每个 bundle 有 EquationSpec、NumericalSchemeSpec、ImplementationMapping；
- 每个 accepted_for_search bundle 有至少一个 VerificationCase；
- 每个 verification result 有 artifact；
- 每个 theory-to-code report assertion 有 evidence_refs；
- 每个 PI decision 有 AuditEvent。

### Theory-to-Code Traceability 验收标准

- [ ] accepted high-risk ChangeRequest 有 bundle trace。
- [ ] report assertion 可追到 verification_case 和 artifact。
- [ ] 新增 FR-TC/GR-TC/TR-TC 有测试 ID。

---

## 4. v0.8.2 新增追踪

### 扩展表头

| Requirement ID | Type | Priority | Source Doc | Implementation Module | Test ID | Phase | Release Gate | Status |
|---|---|---:|---|---|---|---|---|---|
| FR-009 | functional | P0 | Observability_Monitoring_Spec.md | apps/server/health | OBS-HEALTH-001 | W1 | skeleton | approved |
| NFR-PERF-001 | non_functional | P0 | Performance_NFR_Spec.md | apps/server/api | PERF-API-001 | W1 | skeleton | approved |
| NFR-REL-001 | non_functional | P0 | Dependency_Versioning_Policy.md | CI | DEP-LOCK-001 | W0/W1 | skeleton | approved |
| GR-001 | governance | P0 | Auth_Permission_Design.md | apps/server/pi-gates | PI-DECISION-001 | W7 | mvp | approved |

### 规则

- P0/P1 release 前必须有 Test ID；
- status=verified 必须有通过记录；
- deprecated requirement 不删除，只标记；
- Traceability check 进入 CI。

## 5. PI governance traceability

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
