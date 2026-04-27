# Verification Case Spec

**状态**：v0.8.3 P0 补充规范  
**目标**：明确 verification 与 validation/calibration 的边界，并定义验证用例如何绑定 RunJob、RunRecord、Artifact 和 EvidenceReport。

## 1. 概念边界

| 概念 | 问题 | 是否可由 Agent 最终判断 |
|---|---|---:|
| Verification | 代码实现是否符合公式/数值方案？ | 可提供证据，需 reviewer/PI gate |
| Validation | 模型能否解释观测或现实过程？ | 不可，PI 判断 |
| Calibration | 给定模型结构下，参数组合是否改善目标函数？ | 可计算结果，不可做科学结论 |

报告必须避免：

```text
calibration improvement → theory validation
verification passed → model mechanism proven
benchmark improvement → general improvement
```

## 2. Schema

```ts
interface VerificationCase {
  verification_case_id: string;
  bundle_id: string;
  numerical_scheme_id?: string;
  implementation_mapping_id?: string;

  case_type:
    | "dimension_check"
    | "mass_balance"
    | "limiting_case"
    | "manufactured_solution"
    | "regression"
    | "unit_test"
    | "tiny_basin"
    | "output_semantics";

  target_equations: string[];
  target_code_targets?: string[];
  description: string;
  expected_result: string;
  pass_criteria: string;

  runner_backend?: "local_direct" | "local_job" | "docker_job" | "slurm";
  run_job_ids: string[];
  run_record_ids: string[];
  artifact_refs: string[];

  status: "not_run" | "running" | "passed" | "failed" | "inconclusive" | "waived_by_pi";
  failure_reason?: string;
  reviewer_notes?: string[];
}
```

## 3. Verification case 类型

| 类型 | 用途 | 示例 |
|---|---|---|
| `dimension_check` | 检查公式/项单位一致 | flux 与 storage rate 单位兼容 |
| `mass_balance` | 检查水量守恒 | basin water balance residual 阈值 |
| `limiting_case` | 检查极限条件 | zero rainfall → no runoff increase |
| `manufactured_solution` | 人造解析/半解析用例 | 简化 ODE 或单元格测试 |
| `regression` | 证明重构不改变输出 | old vs new output within tolerance |
| `unit_test` | 函数级验证 | source/sink term formula |
| `tiny_basin` | 最小真实 SHUD case | ccw tiny 30-day |
| `output_semantics` | 输出变量语义/单位验证 | rSHUD reader roundtrip |

## 4. Pass/fail 规则

- `passed` 必须有 deterministic artifact 支持。
- `failed` 必须保留 logs、metrics、patch、failure_reason。
- `inconclusive` 必须说明缺少什么证据。
- `waived_by_pi` 只能由 PI 设置，并写明原因。
- verification failure 不一定导致任务失败，但必须阻止 bundle 自动进入 accepted。

## 5. 与 RunRecord 关系

每个运行型 VerificationCase 应绑定：

```text
VerificationCase
→ RunJob
→ RunRecord
→ Artifact(metrics/logs/figures/patch)
→ EvidenceReport assertion
```

如果是非运行型 verification，如 dimension checklist，也应生成 artifact：

```text
artifacts/verification/VC-001_dimension_check.yaml
```

## 6. 验收标准

- [ ] failed VerificationCase 不能从报告中消失。
- [ ] passed case 缺少 artifact 时不能进入 reviewed。
- [ ] calibration result 不能标记为 VerificationCase passed。
- [ ] PI waived case 必须有 comment。
- [ ] Report 显示 verification status table。
