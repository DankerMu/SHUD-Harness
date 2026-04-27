# Theory-to-Code Traceability Addendum

**状态**：建议补到 `Traceability_Matrix.md`  
**目标**：把科学假设、公式、代码、验证和报告连接成可追踪链。

## 1. Trace chain

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

## 2. Matrix rows

| Requirement ID | Source Doc | Implementation Module | Test ID | Phase | Release Gate |
|---|---|---|---|---|---|
| FR-TC-001 | Theory_To_Code_Governance_Spec | `theory-bundle-service.ts` | TC-SCHEMA-001 | Phase 3 | tiny-run |
| FR-TC-002 | Equation_And_Derivation_Spec | `equation-service.ts` | TC-EQ-001 | Phase 3 | tiny-run |
| FR-TC-005 | Implementation_Mapping_Spec | `implementation-mapping-service.ts` | TC-MAP-001 | Phase 4/5 | governance |
| FR-TC-006 | Verification_Case_Spec | `verification-service.ts` | TC-VER-001 | Phase 3 | tiny-run |
| GR-TC-001 | Scientific_Change_Gating_Spec | `pi-gate-service.ts` | TC-GATE-002 | Phase 5 | governance |
| TR-TC-006 | Theory_To_Code_Test_Plan | `traceability-check.ts` | TC-TRACE-001 | Phase 5/6 | release |

## 3. Release check

Release 前检查：

- 每个 accepted high-risk ChangeRequest 有 bundle；
- 每个 bundle 有 EquationSpec、NumericalSchemeSpec、ImplementationMapping；
- 每个 accepted_for_search bundle 有至少一个 VerificationCase；
- 每个 verification result 有 artifact；
- 每个 theory-to-code report assertion 有 evidence_refs；
- 每个 PI decision 有 AuditEvent。
