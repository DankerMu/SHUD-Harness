# Numerical Scheme Spec

**状态**：v0.8.3 P0 补充规范  
**目标**：将连续公式与 SHUD 的数值离散、ODE/state 变量、通量项、源汇项、边界/初始条件、守恒/稳定性预期连接起来。

## 1. 为什么需要该规范

公式正确不代表数值实现正确。SHUD 的模型行为受到离散化、控制体积、时间积分、边界条件、初始条件、数值容差和输出写法共同影响。没有 NumericalSchemeSpec，代码 patch 很容易只在局部 diff 层面被审查，而缺少数值语义审查。

## 2. Schema

```ts
interface NumericalSchemeSpec {
  numerical_scheme_id: string;
  bundle_id: string;
  equation_spec_id: string;

  discretization_type:
    | "finite_volume"
    | "finite_difference"
    | "ode_system"
    | "algebraic_update"
    | "hybrid"
    | "other";

  spatial_domain: "element" | "river" | "lake" | "coupled" | "global";
  temporal_domain: "continuous_time_ode" | "time_stepped" | "event_based" | "other";

  state_variables: StateVariableSpec[];
  flux_terms: FluxTermSpec[];
  source_sink_terms: SourceSinkTermSpec[];
  boundary_conditions: BoundaryConditionSpec[];
  initial_conditions: InitialConditionSpec[];

  conservation_expectations: ConservationExpectation[];
  stability_expectations: StabilityExpectation[];
  tolerance_assumptions: ToleranceAssumption[];

  status: "draft" | "reviewed" | "revision_requested";
}
```

## 3. 子 schema

```ts
interface StateVariableSpec {
  variable_id: string;
  symbol_id: string;
  name: string;
  unit: string;
  code_variable_candidates?: string[];
  storage_role: "surface" | "soil" | "groundwater" | "river" | "lake" | "other";
}

interface FluxTermSpec {
  flux_id: string;
  equation_id: string;
  name: string;
  direction_convention: string;
  unit: string;
  from_domain?: string;
  to_domain?: string;
  expected_sign: string;
}

interface SourceSinkTermSpec {
  term_id: string;
  equation_id: string;
  name: string;
  unit: string;
  positive_means: string;
  expected_range?: string;
}

interface BoundaryConditionSpec {
  bc_id: string;
  type: "dirichlet" | "neumann" | "flux" | "rating_curve" | "outlet" | "other";
  applies_to: string;
  equation_refs: string[];
  assumptions: string[];
}

interface InitialConditionSpec {
  ic_id: string;
  variable_refs: string[];
  source: "input_file" | "computed" | "constant" | "other";
  assumptions: string[];
}

interface ConservationExpectation {
  expectation_id: string;
  scope: "element" | "river" | "basin" | "global";
  statement: string;
  metric_name: string;
  threshold: string;
}

interface StabilityExpectation {
  expectation_id: string;
  risk: string;
  diagnostic: string;
  acceptable_threshold: string;
}

interface ToleranceAssumption {
  solver_or_method: string;
  tolerance_name: string;
  value_or_range: string;
  rationale: string;
}
```

## 4. Review checklist

- [ ] state variable 与 EquationSpec 中的 symbol 对应。
- [ ] flux/source/sink 的单位与状态变量变化率兼容。
- [ ] flux direction convention 与代码实现 mapping 一致。
- [ ] boundary condition 明确写入 conservation expectation。
- [ ] stability expectation 包含 CVODE failure、negative storage、water balance residual 等风险。
- [ ] tolerance assumption 没有被 calibration/search 隐式修改。

## 5. 与 VerificationCase 的关系

每个 NumericalSchemeSpec 至少应产生以下一种 VerificationCase：

| scheme risk | 推荐 verification |
|---|---|
| mass conservation | `mass_balance` |
| limiting behavior | `limiting_case` |
| code refactor | `regression` |
| new source/sink term | `dimension_check` + `tiny_basin` |
| analytic case available | `manufactured_solution` |

## 6. 验收标准

- [ ] physical/numerical change 缺少 NumericalSchemeSpec 不能进入 implementation_review。
- [ ] conservation expectation 至少一条。
- [ ] stability expectation 至少一条。
- [ ] VerificationCase 引用 numerical_scheme_id。
- [ ] Report 中能显示数值方案摘要和未决风险。
