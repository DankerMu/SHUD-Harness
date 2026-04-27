# Theory-to-Code Support Schemas

**状态**：建议并入 `Support_Schema_Contracts.md`  
**目标**：集中列出本补充涉及的 support schema，便于后续 Zod 实现与 schema drift 控制。

## 1. Schema list

```text
TheoryToCodeBundle
TheoryNote
EquationSpec
SymbolDefinition
EquationDefinition
DimensionCheck
DerivationRecord
DerivationStep
NumericalSchemeSpec
StateVariableSpec
FluxTermSpec
SourceSinkTermSpec
BoundaryConditionSpec
InitialConditionSpec
ConservationExpectation
StabilityExpectation
ImplementationMapping
CodeTargetMapping
SymbolCodeMapping
OutputSemanticsChange
SemanticRisk
ComplexityCost
VerificationCase
PreflightGuardResult
PreflightCheck
ExperimentTrial
ExperimentLedger
BaselineComparisonRef
```

## 2. Canonical source recommendation

合并后建议：

```text
packages/core/src/domain/schemas/theory-to-code.ts
packages/core/src/domain/schemas/equation.ts
packages/core/src/domain/schemas/numerical-scheme.ts
packages/core/src/domain/schemas/implementation-mapping.ts
packages/core/src/domain/schemas/verification.ts
packages/core/src/domain/schemas/controlled-search.ts
```

Markdown 文档应只解释语义，字段细节以 Zod schema + generated JSON Schema 为准。

## 3. Common fields

所有 theory-to-code support schema 应包含：

```ts
interface CommonSupportFields {
  created_at: string;
  updated_at?: string;
  created_by: string;
  reviewed_by?: string;
  artifact_refs?: string[];
  audit_event_refs?: string[];
}
```

## 4. Evidence usability

理论/公式/推导类 artifact 默认是 human-review evidence，不是 deterministic numeric evidence。报告引用时应区分：

```text
human_reviewed_theory
deterministic_verification
pi_confirmed_decision
llm_summary
hypothesis
```

## 5. 验收标准

- [ ] 所有 schema 有 Zod unit test。
- [ ] Support_Schema_Contracts 索引包含上述 schema。
- [ ] Generated schema 无 drift。
- [ ] Report lineage guard 能识别 theory-to-code evidence refs。
