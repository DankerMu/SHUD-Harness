# Theory-to-Code Test Plan

**状态**：v0.8.3 P1 测试补充  
**目标**：定义理论—公式—推导—实现—验证—报告—搜索边界的自动化测试与人工 gate 测试。

## 1. Test categories

| 类别 | 测试对象 | CI 级别 |
|---|---|---|
| schema | TheoryToCodeBundle 等 Zod schema | PR |
| state machine | bundle transition | PR |
| governance | high-risk gate / role permission | PR |
| equation | symbol/unit/dimension check | PR |
| mapping | equation_id → code_target | PR |
| verification | VerificationCase run/collect/status | PR/nightly |
| report | Theory-to-Code Evidence + language guard | PR |
| search boundary | accepted_for_search 前禁止 search | PR |
| artifact retention | failed verification evidence retained | PR |

## 2. Test IDs

| Test ID | 场景 | Pass criterion |
|---|---|---|
| TC-SCHEMA-001 | valid TheoryToCodeBundle | Zod parse pass |
| TC-SCHEMA-002 | missing scientific_question | Zod parse fail |
| TC-EQ-001 | symbol missing unit | cannot enter reviewed |
| TC-EQ-002 | dimension_check fail | bundle cannot enter implementation_review |
| TC-GATE-001 | physical_equation CR without bundle | API 422 |
| TC-GATE-002 | agent attempts accept bundle | API 403 |
| TC-GATE-003 | high-risk approve without comment | API 400 |
| TC-MAP-001 | high-risk code target without equation_id | API 422 |
| TC-VER-001 | passed verification missing artifact | cannot enter reviewed |
| TC-VER-002 | failed verification retains logs/artifacts | artifact query pass |
| TC-REPORT-001 | high-risk report missing Theory-to-Code Evidence | cannot enter reviewed |
| TC-REPORT-002 | calibration-as-validation phrase | language guard fail |
| TC-SEARCH-001 | search before accepted_for_search | API 409 |
| TC-SEARCH-002 | improvement claim without baseline | report guard fail |
| TC-TRACE-001 | equation_id → code_target → verification_case → run_record → report | traceability check pass |

## 3. Fixture strategy

### schema-only fixture

用于 W1/W2，不依赖 SHUD。

### dummy verification fixture

模拟 VerificationCase run/collect：

```text
input: VC-DUMMY-001
job: echo metrics.yaml
expected: RunRecord + artifact + VC passed
```

### ccw tiny verification fixture

用于真实 SHUD tiny case：

```text
case_type: tiny_basin
expected: SHUD run success + water_balance_residual threshold
```

## 4. Negative tests

必须覆盖：

- Agent 自行 accepted；
- 没有 bundle 的 physical equation change；
- 没有 baseline 的 improvement claim；
- passed verification 缺 artifact；
- calibration report 写“结构验证”；
- output semantics change 没有 PI gate；
- failed verification 被隐藏。

## 5. Manual review tests

有些判断不能自动化，应作为 reviewer/PI gate drill：

- 推导是否有未明示假设；
- 边界条件是否合理；
- verification case 是否覆盖关键风险；
- search 是否可能掩盖结构错误。

这些不应阻塞 PR CI，但应进入 release checklist。

## 6. 验收标准

- [ ] P0 tests 进入 CI。
- [ ] TC-REPORT-002 作为 language guard 负例。
- [ ] TC-SEARCH-001 阻止未审查搜索。
- [ ] failed verification artifacts retention 有自动测试。
- [ ] Traceability_Matrix 加入 TC-TRACE-001。
