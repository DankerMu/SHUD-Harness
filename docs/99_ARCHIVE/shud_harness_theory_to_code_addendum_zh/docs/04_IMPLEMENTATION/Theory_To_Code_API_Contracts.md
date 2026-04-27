# Theory-to-Code API Contracts

**状态**：v0.8.3 P1 实施补充  
**目标**：为 TheoryToCodeBundle、EquationSpec、ImplementationMapping、VerificationCase 和 PI gate 提供最小 API 契约。

## 1. Bundle API

```http
POST /api/theory-bundles
GET  /api/theory-bundles/:bundleId
PATCH /api/theory-bundles/:bundleId
POST /api/theory-bundles/:bundleId/transition
```

### Create body

```json
{
  "task_id": "TASK-001",
  "change_request_id": "CR-001",
  "title": "Add revised infiltration coupling",
  "semantic_level": "physical_equation",
  "scientific_question": "...",
  "process_scope": "infiltration"
}
```

### Transition body

```json
{
  "target_status": "derivation_review",
  "comment": "EquationSpec reviewed by engineer; PI questions remain.",
  "actor_id": "reviewer_01"
}
```

## 2. Equation / derivation API

```http
POST /api/theory-bundles/:bundleId/equations
PATCH /api/equations/:equationSpecId
POST /api/equations/:equationSpecId/dimension-checks
POST /api/theory-bundles/:bundleId/derivation
PATCH /api/derivations/:derivationRecordId
```

## 3. Numerical scheme API

```http
POST /api/theory-bundles/:bundleId/numerical-schemes
PATCH /api/numerical-schemes/:schemeId
POST /api/numerical-schemes/:schemeId/conservation-expectations
```

## 4. Implementation mapping API

```http
POST /api/theory-bundles/:bundleId/implementation-mapping
PATCH /api/implementation-mappings/:mappingId
POST /api/implementation-mappings/:mappingId/code-targets
POST /api/implementation-mappings/:mappingId/complexity-cost
```

## 5. Verification API

```http
POST /api/theory-bundles/:bundleId/verification-cases
GET  /api/verification-cases/:caseId
POST /api/verification-cases/:caseId/run
POST /api/verification-cases/:caseId/collect
PATCH /api/verification-cases/:caseId/review
```

## 6. Search preflight API

```http
POST /api/analysis/:analysisPlanId/preflight
```

Response:

```json
{
  "status": "fail",
  "blocking_reasons": [
    "TheoryToCodeBundle BUNDLE-001 is not accepted_for_search"
  ],
  "artifact_id": "ART-PREFLIGHT-001"
}
```

## 7. Error codes

| code | 用途 |
|---|---|
| `THEORY_BUNDLE_REQUIRED` | 高风险变更缺少 bundle |
| `THEORY_BUNDLE_STATUS_BLOCKS_SEARCH` | bundle 状态不允许 search |
| `EQUATION_SYMBOL_UNIT_MISSING` | 关键符号缺 unit |
| `DIMENSION_CHECK_FAILED` | dimension check fail |
| `IMPLEMENTATION_MAPPING_REQUIRED` | 缺少 mapping |
| `VERIFICATION_CASE_REQUIRED` | 缺少 verification case |
| `VERIFICATION_ARTIFACT_MISSING` | passed case 缺 artifact |
| `SCIENTIFIC_GATE_COMMENT_REQUIRED` | 高风险 PI decision 缺 comment |

## 8. WebSocket events

```text
theory_bundle.status_updated
equation.dimension_check_updated
implementation_mapping.updated
verification_case.status_updated
verification_case.run_started
verification_case.result_recorded
scientific_gate.required
scientific_gate.decision_recorded
search_preflight.completed
```

## 9. 验收标准

- [ ] 高风险 ChangeRequest create/update 时 API 能提示需要 bundle。
- [ ] transition endpoint 有权限检查和状态机检查。
- [ ] verification run 生成 RunJob/RunRecord 关联。
- [ ] search preflight 能阻止未接受 bundle。
- [ ] 所有错误使用统一 API error envelope。
