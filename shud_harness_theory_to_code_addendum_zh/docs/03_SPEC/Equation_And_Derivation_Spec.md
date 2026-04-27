# Equation and Derivation Spec

**状态**：v0.8.3 P0 补充规范  
**目标**：让公式、符号、单位、推导步骤和假设可审查、可追踪、可引用。

## 1. 为什么需要该规范

对 SHUD 这类物理模型，很多严重问题不会表现为编译错误，而会表现为：

- 公式中符号含义不清；
- 单位或维度不一致；
- 通量方向、源汇项符号、边界条件假设遗漏；
- 公式推导跳步；
- 代码变量和理论符号没有明确对应关系。

因此，任何涉及物理方程、模型假设、数值实现或默认参数语义的任务，都应有 `EquationSpec` 和 `DerivationRecord`。

## 2. TheoryNote

```ts
interface TheoryNote {
  theory_note_id: string;
  bundle_id: string;
  task_id: string;
  title: string;

  scientific_question: string;
  physical_process:
    | "surface_runoff"
    | "infiltration"
    | "groundwater_exchange"
    | "river_routing"
    | "evapotranspiration"
    | "snow_or_energy"
    | "coupled_process"
    | "other";

  motivation: string;
  expected_behavior: string[];
  assumptions: string[];
  non_goals: string[];
  limitations: string[];
  pi_questions: string[];

  source_refs?: string[];
  created_by: string;
  created_at: string;
}
```

## 3. EquationSpec

```ts
interface EquationSpec {
  equation_spec_id: string;
  bundle_id: string;
  title: string;

  symbols: SymbolDefinition[];
  equations: EquationDefinition[];
  dimension_checks: DimensionCheck[];

  status: "draft" | "reviewed" | "revision_requested";
  reviewer_notes?: string[];
}

interface SymbolDefinition {
  symbol_id: string;
  symbol: string;
  meaning: string;
  unit: string;
  dimension: string;
  domain?: "element" | "river" | "lake" | "boundary" | "global";
  sign_convention?: string;
  code_variable_candidates?: string[];
}

interface EquationDefinition {
  equation_id: string;
  latex: string;
  plain_text: string;
  applies_to: string;
  related_symbols: string[];
  assumptions: string[];
  boundary_condition_refs?: string[];
  source_refs?: string[];
}

interface DimensionCheck {
  equation_id: string;
  status: "pass" | "fail" | "not_checked";
  checked_by: "deterministic_script" | "reviewer" | "pi" | "agent";
  notes: string;
}
```

## 4. DerivationRecord

```ts
interface DerivationRecord {
  derivation_record_id: string;
  bundle_id: string;
  equation_spec_id: string;

  steps: DerivationStep[];
  assumptions_used: string[];
  unresolved_questions: string[];
  pi_required_decisions: string[];

  status: "draft" | "reviewed" | "revision_requested";
}

interface DerivationStep {
  step_id: string;
  description: string;
  from_equation_ids: string[];
  to_equation_id?: string;
  assumptions_used: string[];
  algebra_notes?: string;
  reviewer_notes?: string;
}
```

## 5. 最低质量要求

进入 `derivation_review` 前：

- 每个 equation 必须有 equation_id；
- 每个关键 symbol 必须有 unit 和 dimension；
- 每个 equation 必须列出 assumptions；
- 每个推导步骤必须说明使用了哪些 assumptions；
- `unresolved_questions` 不为空时，必须生成 PI question；
- 任何 `dimension_check.status = fail` 的公式不能进入 `reviewed`。

## 6. Dimension check 策略

MVP 不要求自动符号代数系统，但应至少支持 reviewer/manual + deterministic checklist：

```text
1. 检查左右两边是否同量纲。
2. 检查 flux term 是否有面积/长度/时间换算。
3. 检查 source/sink term 是否与 state variable 单位兼容。
4. 检查 sign convention 是否在 equation 和 code mapping 中一致。
5. 检查 boundary condition 是否改变了守恒项。
```

后续可以加入简单 dimension parser，但不应成为 MVP 阻塞。

## 7. 与报告的关系

EvidenceReport 的 Theory-to-Code Evidence 章节应引用：

```text
theory_note_id
equation_spec_id
derivation_record_id
关键 equation_id
关键 unresolved_questions
```

报告不得把 `draft` 状态的 equation/derivation 写成已接受理论依据。

## 8. 验收标准

- [ ] 缺少 unit 的关键 symbol 不能进入 reviewed。
- [ ] dimension_check fail 时 bundle 不能进入 implementation_review。
- [ ] unresolved PI question 会触发 PI gate 或 report question。
- [ ] 报告中的公式摘要引用 equation_id。
- [ ] Agent 生成的推导必须经过 reviewer/PI 才能进入 reviewed。
