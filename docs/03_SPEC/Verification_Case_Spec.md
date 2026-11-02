---
status: frozen
---

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

## M4 实现范围

[M4 VerificationCase 契约](../../openspec/changes/m4-mvp-2/specs/verification-cases/spec.md) 与 [Minimal_Schemas §10](Minimal_Schemas.md#10-verificationcase) 是本次实现字段基线；下文通用 Theory-to-Code schema 保留为后续规划，不是第二套 M4 对象。以下为 design D15(1)/(6) 的 M4 范围裁剪、非放宽 baseline：

- 旧 `id` / `verification_case_id` 统一为品牌 `vc_id: VC-YYYYMMDDTHHMMSS-xxxx`；必填 `task_id`、`change_id`，不保留别名。
- `bundle_id` 允许非空字符串或 null，M4 生产者恒写 null；不生产 bundle，不保留 `target_equations`、numerical_scheme/mapping 等无生产者字段。
- `run_job_ids` / `run_record_ids` 改为 `base_run_id` / `candidate_run_id` 与 `base_build_id` / `candidate_build_id` 两对引用；RunJob 经注册表只读查询交叉校验，不另存一份 job 数组。
- 只生产 `case_type: regression`、`expected_result_source: baseline_regression` 与 `status: passed|failed`；拒绝 `agent_proposed`。schema 仍保留其它类型、来源与状态词表，不等于实现了其它生产者。
- `observed` 记录 `compared_path`、`base_sha256`、`candidate_sha256`。比较器只对两份 `output/<project>.out/<project>.rivqdown.dat` 的普通文件字节计算 SHA256；不读数值、无容差、不比较其它输出。
- passed 必须摘要相等、`failure_reason: null`；failed 必须摘要不等且原因非空。缺失、链接或特殊文件是工具错误，不落 failed/inconclusive。`artifact_refs` 恰两项，为真实比较文件的工作区相对路径；报告校验第 (15) 项复核其存在性与摘要。
- `reviewed_by` 非空、`reviewer_notes` 至少一条，`compatibility_verdict` 为 compatible/incompatible/unknown；不另造 ReviewNote。失败 VC 允许进入报告 closure，但必须在风险节呈现，且不能使 `shud:replay` 通过。

M4 只接受同卡、同 project、同钉定 commit、同输入证据的两次成功且已 collected 运行；base 必须来自 null-CR 且 `rhs_openmp: false` 的构建，候选来自 approved CR，两次 `threads: 1`。bitwise 一致只支持 N=1 与 serial baseline 输出一致，不构成并行正确性、性能或模型改进结论。

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
  expected_result_source:            // AGA-P1-1：期望值不能自出自判
    | "analytic"                     // 解析解/量纲推导，可独立复核
    | "published"                    // 文献/手册值，附引用
    | "pi_provided"                  // PI 给定
    | "baseline_regression"          // 已有 baseline 输出（regression 类）
    | "agent_proposed";              // agent 自拟——见下方独立性规则
  pass_criteria: string;
  pass_criteria_confirmed_by?: string;  // agent_proposed 时必填（PI/工程师 user id）

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

### 4.1 期望值独立性规则（AGA-P1-1）

出题人和判卷人不能是同一个 LLM 会话：

- `expected_result_source = agent_proposed` 的 case，**其 `passed` 不能计入 bundle 进入 `accepted_for_search` 的验证证据**，除非 `pass_criteria_confirmed_by` 已由 PI/工程师填写（gate 上一并确认，不要求单独流程）。
- pass_criteria 必须是确定性可求值表达式（阈值/容差），judgement 型标准（"结果看起来合理"）拒绝进 schema。
- 报告的 Theory-to-Code Evidence 章节必须展示每个 case 的 expected_result_source——PI 一眼能看出哪些期望值是 agent 自拟的。

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
