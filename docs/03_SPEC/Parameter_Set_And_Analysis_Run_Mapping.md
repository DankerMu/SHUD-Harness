---
status: frozen
---

# Parameter Set 与 Analysis Run Mapping 规范

**状态：** M5 实现基线，见 [AnalysisPlan 契约](../../openspec/changes/m5-oat-sensitivity/specs/analysis-plans/spec.md)。

**适用范围：** 单流域 OAT 的 AnalysisPlan、RunJob、RunRecord 与报告汇总。

**目标：** 参数集不可变，运行关联可追溯，失败参数集保持可见。

## 1. ParameterSet schema

ParameterSet 是 [Minimal_Schemas §6](Minimal_Schemas.md#6-analysisplan) 的内嵌严格对象，不另设文件或可变状态：

```ts
interface ParameterSet {
  parameter_set_id: "PSET-1" | "PSET-2" | "PSET-3" | "PSET-4" | "PSET-5";
  label: string | null;
  baseline: boolean;
  changes: Partial<Record<"GEOL_KSATH" | "GEOL_KSATV" | "LC_ROUGH" | "RIV_ROUGH", number>>;
}
```

label 非 null 时非空；baseline 的 changes 为空，非 baseline 恰含一个倍率。倍率与七条 refine 只按 §6 校验，不使用 `*_multiplier` 别名。

## 2. AnalysisPlan 补充字段

不再建立另一套“实现扩展”schema；plan 完整字段以 Minimal_Schemas §6 为准。parameter_sets 为 3–5 项，id 按数组顺序分配为 PSET-1..PSET-n；baseline 恰一项。

**D15(4)：M5 范围裁剪、非放宽 baseline。** 不建 batch_policy、progress artifact 或批进度卡；不在 plan 内保存 status、job_id、run_id、metrics_artifact_id、error_id。worker 逐 pset 提交，显式等待与收集；批策略的复活条件见 [M5 Non-Goals](../../openspec/changes/m5-oat-sensitivity/design.md#goals--non-goals)。

## 3. 映射规则

- RunJob/RunRecord 的 `analysis_plan_id` 与 `parameter_set_id` 是唯一关联字段，成对非 null 或成对 null；plan 不回写 run id。
- 同一 plan/pset 已有非终态作业或成功 RunRecord 时拒绝重复提交；已有失败且无非终态作业时可重提，旧失败证据保留。
- 状态只从 RunJob/RunRecord 派生。成功或失败作业按既有 collect 契约生成 RunRecord，收集失败如实保留原因，不声称每个作业都有记录。
- 汇总按 [Sensitivity summary derivation](../../openspec/changes/m5-oat-sensitivity/specs/evidence-reports/spec.md#requirement-sensitivity-summary-derivation) 选择有效 run，失败、缺指标与被取代的运行保持可见；没有 heatmap 聚合。

## 4. Directory rule

```text
workspace/analyses/<analysis_plan_id>.json
workspace/runs/<run_id>/run-job.json
workspace/runs/<run_id>/run-record.json
workspace/runs/<run_id>/metrics.json
workspace/reports/<report_id>.sensitivity.json
```

**D15(8)：M5 范围裁剪、非放宽 baseline。** 旧 PSET-001 改为 PSET-1..PSET-5；旧逐参数 YAML 布局改为 `analyses/<analysis_plan_id>.json` 单文件；changes 直接使用 calib 白名单键，不使用 multiplier 别名。AnalysisPlan 排他原子创建后不可变，不持久化 ParameterSet 状态。

## 5. 验收标准

- 每个 pset 可通过两个关联 id 追溯到作业、运行或失败原因。
- 失败 pset 不从汇总表与报告中消失。
- 各 run 使用独立运行目录，不共享输出。
- 状态不写入 plan；报告汇总引用逐 run metrics，未计算项不伪造。
