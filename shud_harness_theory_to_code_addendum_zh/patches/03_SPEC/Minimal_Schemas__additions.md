# Patch: docs/03_SPEC/Minimal_Schemas.md

## 目标文档

`docs/03_SPEC/Minimal_Schemas.md`

## 补充目的

给核心对象增加最少字段引用，让 support schema 能被 TaskCard、ChangeRequest、AnalysisPlan、EvidenceReport 关联。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

TaskCard、AnalysisPlan、EvidenceReport、ChangeRequest 字段定义附近。

## 建议新增内容


```ts
// TaskCard optional additions
theory_bundle_ids?: string[];

// ChangeRequest additions
semantic_level?:
  | "pure_engineering"
  | "io_format"
  | "output_semantics"
  | "numerical_implementation"
  | "parameter_default"
  | "physical_equation"
  | "model_assumption";
theory_bundle_id?: string;
verification_case_ids?: string[];
pi_gate_required?: boolean;

// AnalysisPlan additions
requires_theory_bundle_id?: string;
baseline_run_id?: string;
search_preflight_status?: "not_run" | "passed" | "failed";
experiment_ledger_id?: string;

// EvidenceReport additions
theory_bundle_ids?: string[];
verification_case_ids?: string[];
```


## 验收标准补充


- [ ] 字段为 optional，不破坏现有 8 核心对象。
- [ ] high-risk semantic_level 触发 Scientific_Change_Gating_Spec。
- [ ] AnalysisPlan search 前置检查能读取 `requires_theory_bundle_id`。
