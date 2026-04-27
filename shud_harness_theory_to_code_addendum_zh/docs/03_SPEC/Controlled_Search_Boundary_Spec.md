# Controlled Search Boundary Spec

**状态**：v0.8.3 P1 补充规范  
**目标**：吸收实验搜索/ledger 的有用思想，但把它限定为 Theory-to-Code 链路通过之后的下游工具。

## 1. 定位

Controlled Search Loop 适用于：

- 参数搜索；
- sensitivity analysis；
- calibration；
- benchmark regression comparison；
- 数值性能优化；
- 低风险工程实现替代方案比较。

不适用于：

- 新物理过程加入；
- 控制方程修改；
- 模型假设修改；
- 默认参数物理意义修改；
- 输出语义改变；
- validated/accepted 科学结论升级。

## 2. 前置条件

```text
If AnalysisPlan.mode in sensitivity | calibration | controlled_search
and task/change semantic_level is high-risk:
  require TheoryToCodeBundle.status in accepted_for_search | accepted
```

## 3. Baseline-first rule

任何 improvement claim 必须有 baseline：

```ts
interface BaselineComparisonRef {
  baseline_run_id: string;
  candidate_run_id: string;
  same_stack_lock: boolean;
  same_data_id: boolean;
  same_eval_script_hash: boolean;
  metric_delta: Record<string, number>;
}
```

没有 baseline 时，报告只能写：

```text
candidate result observed
```

不能写：

```text
improved / better / worse
```

## 4. ExperimentTrial 与 Ledger

```ts
interface ExperimentTrial {
  trial_id: string;
  analysis_plan_id: string;
  task_id: string;
  parameter_set_id?: string;
  change_request_id?: string;
  parent_trial_id?: string;

  baseline_run_id?: string;
  candidate_run_id?: string;
  run_record_ids: string[];
  patch_artifact_id?: string;

  decision: "keep" | "discard" | "crash" | "needs_pi_review" | "inconclusive";
  decision_reason: string;
  primary_metric_delta?: number;
  secondary_metric_deltas?: Record<string, number>;
  complexity_cost_id?: string;
  artifact_refs: string[];
}

interface ExperimentLedger {
  ledger_id: string;
  task_id: string;
  analysis_plan_id?: string;
  trials: ExperimentTrial[];
  summary_artifact_id: string;
}
```

## 5. Decision rule

| 决策 | 含义 |
|---|---|
| `keep` | 工程/指标上值得保留，但不自动成为科学结论 |
| `discard` | 不采用，但保留证据 |
| `crash` | 运行失败，保留 logs/patch |
| `needs_pi_review` | 指标冲突、科学解释不明确或高风险 |
| `inconclusive` | 数据/验证不足 |

## 6. No-progress policy

如果连续 N 个 trial 没有有效改善：

```text
mark trajectory = plateauing
recommend strategy_shift
```

对 SHUD，strategy shift 示例：

- 从参数微调转向 forcing/observation alignment 检查；
- 从 roughness 调整转向 soil/landcover mapping 检查；
- 从 calibration 转向 sensitivity diagnostic；
- 从代码 patch 转向 verification/regression isolation。

## 7. 与 EvidenceReport 的关系

Report 可以显示 ledger summary：

```text
trials total / kept / discarded / failed / inconclusive
best candidate metrics
failure modes
complexity cost
limitations
```

但不得自动写成：

```text
model structure validated
```

## 8. 验收标准

- [ ] 没有 baseline 的 improvement claim 被 report guard 拒绝。
- [ ] discarded/crash trial 保留 patch/log/metrics artifact。
- [ ] high-risk change 未 accepted_for_search 不能启动 search。
- [ ] ledger summary 可导出到 report artifact。
