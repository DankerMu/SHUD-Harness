# Implementation Mapping Spec

**状态**：v0.8.3 P0 补充规范  
**目标**：把理论公式、符号和数值方案追踪到 SHUD/rSHUD/AutoSHUD/Harness 的具体代码位置、变量、函数和输出语义。

## 1. 为什么需要该规范

代码 diff 只能显示“改了什么文本”，不能说明：

```text
这个代码块实现了哪个 equation term？
变量名对应哪个理论符号？
输出变量语义有没有改变？
这个 patch 是否改变了物理含义？
```

ImplementationMapping 用于填补这个空白。

## 2. Schema

```ts
interface ImplementationMapping {
  implementation_mapping_id: string;
  bundle_id: string;
  numerical_scheme_id: string;

  code_targets: CodeTargetMapping[];
  symbol_mappings: SymbolCodeMapping[];
  output_semantics_changes: OutputSemanticsChange[];
  semantic_risks: SemanticRisk[];
  backward_compatibility_notes: string[];

  status: "draft" | "reviewed" | "revision_requested";
}

interface CodeTargetMapping {
  target_id: string;
  repo: "SHUD" | "rSHUD" | "AutoSHUD" | "Harness";
  file_path: string;
  function_or_block: string;
  line_range_hint?: string;
  related_equation_ids: string[];
  related_symbol_ids: string[];
  expected_semantics: string;
  change_type:
    | "new_code"
    | "modify_code"
    | "remove_code"
    | "refactor_same_semantics"
    | "output_semantics_change";
}

interface SymbolCodeMapping {
  symbol_id: string;
  repo: "SHUD" | "rSHUD" | "AutoSHUD" | "Harness";
  file_path: string;
  code_variable: string;
  unit_in_code?: string;
  conversion_notes?: string;
}

interface OutputSemanticsChange {
  output_id: string;
  output_name: string;
  old_semantics?: string;
  new_semantics: string;
  unit: string;
  requires_rshud_update: boolean;
  requires_report_note: boolean;
}

interface SemanticRisk {
  risk_id: string;
  risk: string;
  severity: "low" | "medium" | "high" | "critical";
  mitigation: string;
  verification_case_refs: string[];
}
```

## 3. Mapping rules

- 每个 high-risk code target 必须引用至少一个 equation_id。
- 每个关键 code variable 应引用 symbol_id。
- 如果 output semantics 变化，必须更新 `SHUD_Output_Variables.md` 或创建补丁说明。
- 如果 rSHUD reader 需要变化，必须在 ChangeRequest 中列出兼容性风险。
- `refactor_same_semantics` 必须有 regression VerificationCase。
- `output_semantics_change` 必须触发 PI gate。

## 4. Complexity cost

ImplementationMapping 应记录复杂度成本，用于防止为了小幅指标改善引入难维护代码：

```ts
interface ComplexityCost {
  lines_added: number;
  lines_deleted: number;
  files_touched: number;
  new_dependencies: string[];
  public_interface_changed: boolean;
  output_format_changed: boolean;
  output_semantics_changed: boolean;
  backward_compatibility_risk: "low" | "medium" | "high";
  scientific_semantics_changed: boolean;
}
```

EvidenceReport 应在 code change 任务中展示 `metric_delta` 和 `complexity_delta`，避免只看指标提升。

## 5. 与 Patch Bundle 的关系

Patch bundle 应包含：

```text
patch.diff
implementation_mapping.yaml
complexity_cost.yaml
verification_cases.yaml
metrics_summary.yaml
review_notes.md
```

失败 patch 不 merge，但仍保留 mapping 和 verification evidence。

## 6. 验收标准

- [ ] numerical/physical ChangeRequest 缺少 ImplementationMapping 不能进入 implementation_review。
- [ ] 每个 high-risk target 引用 equation_id。
- [ ] output semantics change 触发 PI gate。
- [ ] failed patch artifact 被保留。
- [ ] Report 能显示 changed code targets 和 semantic risks。
