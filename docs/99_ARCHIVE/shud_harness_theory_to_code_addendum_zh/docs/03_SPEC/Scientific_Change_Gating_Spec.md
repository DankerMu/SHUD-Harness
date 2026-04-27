# Scientific Change Gating Spec

**状态**：v0.8.3 P0 补充规范  
**目标**：根据科学语义风险对 ChangeRequest 分级，并决定是否需要 Theory-to-Code Bundle、VerificationCase 和 PI approval。

## 1. Semantic level

```ts
type ChangeSemanticLevel =
  | "pure_engineering"
  | "io_format"
  | "output_semantics"
  | "numerical_implementation"
  | "parameter_default"
  | "physical_equation"
  | "model_assumption";
```

## 2. Gate matrix

| semantic_level | 需要 bundle | 需要 verification | 需要 PI gate | 能否进入 search |
|---|---:|---:|---:|---:|
| pure_engineering | 否 | 视情况 | 通常否 | 不相关 |
| io_format | 视情况 | 是，若影响 reader | 视情况 | 可以 |
| output_semantics | 是 | 是 | 是 | accepted_for_search 后 |
| numerical_implementation | 是 | 是 | 是 | accepted_for_search 后 |
| parameter_default | 是 | 是 | 是 | accepted_for_search 后 |
| physical_equation | 是 | 是 | 是 | accepted_for_search 后 |
| model_assumption | 是 | 是 | 是 | accepted_for_search 后 |

## 3. ChangeRequest additions

```ts
interface ChangeRequestScientificAdditions {
  semantic_level: ChangeSemanticLevel;
  theory_bundle_id?: string;
  verification_case_ids?: string[];
  implementation_mapping_id?: string;
  search_allowed_after?: "accepted_for_search" | "accepted";
  pi_gate_required: boolean;
  scientific_risk_summary?: string;
}
```

## 4. 自动 gate 规则

系统应自动生成 PiGate：

- semantic_level in `output_semantics | numerical_implementation | parameter_default | physical_equation | model_assumption`；
- benchmark baseline replacement；
- SHUD output variable unit/meaning change；
- rSHUD reader semantics change；
- VerificationCase waived；
- failed verification 仍想进入 search；
- Agent narrative 想把 calibration 写成 validation。

## 5. Comment required rules

PI decision comment 必填：

| 情况 | comment |
|---|---:|
| rejected | 必填 |
| revision_requested | 必填 |
| approve high-risk semantic change | 必填 |
| waive verification | 必填 |
| accepted_for_search despite inconclusive verification | 必填 |
| accepted report only | 可选 |

## 6. 禁止路径

```text
physical_equation ChangeRequest
→ no bundle
→ direct patch
→ sensitivity search
```

必须被拒绝。

```text
calibration improved
→ report says theory validated
```

必须被 language/lineage guard 拒绝。

## 7. 验收标准

- [ ] semantic_level 高风险但缺 bundle 时 API 返回 422。
- [ ] high-risk approve 无 comment 返回 400。
- [ ] Agent 角色不能 approve scientific gate。
- [ ] PI decision 写入 AuditEvent、MemoryNote、report decision history。
- [ ] search/calibration 前置检查 bundle status。
