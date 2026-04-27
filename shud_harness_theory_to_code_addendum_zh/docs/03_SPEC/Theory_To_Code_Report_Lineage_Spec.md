# Theory-to-Code Report Lineage Spec

**状态**：v0.8.3 P1 补充规范  
**目标**：让 EvidenceReport 能在科学变更任务中展示理论到代码证据链，并阻止 calibration/search 结果被误写为理论验证。

## 1. 报告新增章节

对以下任务必须增加 `Theory-to-Code Evidence`：

- physical_equation；
- model_assumption；
- numerical_implementation；
- parameter_default；
- output_semantics。

建议模板：

```markdown
## Theory-to-Code Evidence

### Scientific question
...

### Assumptions and limitations
...

### Equation summary
- EQ-001: ...

### Derivation status
- DER-001: reviewed / revision_requested

### Numerical scheme summary
- finite_volume / ODE / boundary conditions / conservation expectations

### Implementation mapping
| equation | symbol | repo/file/function | semantics |

### Verification cases
| case | type | status | evidence |

### Benchmark / validation context
...

### What this report does not prove
- Verification passed does not prove model structure is universally true.
- Calibration improvement does not prove the physical hypothesis.
```

## 2. 新 assertion types

```ts
type TheoryToCodeAssertionType =
  | "theory_assumption"
  | "equation_statement"
  | "derivation_step"
  | "numerical_scheme_statement"
  | "implementation_mapping_statement"
  | "verification_result"
  | "search_result"
  | "validation_context";
```

## 3. Lineage requirements

| assertion type | required refs |
|---|---|
| theory_assumption | theory_note_id |
| equation_statement | equation_id + equation_spec_id |
| derivation_step | derivation_record_id + step_id |
| numerical_scheme_statement | numerical_scheme_id |
| implementation_mapping_statement | implementation_mapping_id + target_id |
| verification_result | verification_case_id + run_record/artifact |
| search_result | analysis_plan_id + baseline/candidate run refs |
| validation_context | observation/data provenance refs |

## 4. Language guard additions

禁止：

- “校准证明模型结构正确”；
- “verification 通过说明物理机制真实”；
- “该公式已经被模型结果证明”；
- “参数搜索确认了理论假设”；
- “无需 PI 审查即可接受该物理变更”。

允许：

- “该 verification case 支持代码实现满足指定公式/用例”；
- “在该 basin/event/window 下，candidate 指标相对 baseline 改善”；
- “该结果支持进一步检查假设，但不足以构成普遍结论”；
- “该解释需要 PI 结合水文背景判断”。

## 5. 验收标准

- [ ] 高风险任务报告缺 Theory-to-Code Evidence 不能进入 reviewed。
- [ ] verification_result assertion 缺 artifact ref 不能进入 reviewed。
- [ ] search_result 缺 baseline ref 不能写 improvement。
- [ ] language guard 拒绝 calibration-as-validation 表述。
- [ ] HTML export 保留 Theory-to-Code Evidence 摘要。
