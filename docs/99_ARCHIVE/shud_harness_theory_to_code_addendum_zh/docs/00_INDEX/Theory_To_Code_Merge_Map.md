# Theory-to-Code 合并地图

**状态**：v0.8.3 merge guide  
**用途**：告诉 Claude/维护者每个补充点应放入哪个现有文档、哪个章节，以及为什么补。

## 1. 新增文档

| 新增文档 | 放置位置 | 优先级 | 理由 |
|---|---|---:|---|
| `Theory_To_Code_Governance_Spec.md` | `docs/03_SPEC/` | P0 | 建立理论到代码的主链路与 gate |
| `Equation_And_Derivation_Spec.md` | `docs/03_SPEC/` | P0 | 公式、符号、单位和推导是 SHUD 科学正确性的核心 |
| `Numerical_Scheme_Spec.md` | `docs/03_SPEC/` | P0 | 连续公式正确不等于离散实现正确 |
| `Implementation_Mapping_Spec.md` | `docs/03_SPEC/` | P0 | 需要 equation_id → code_target 的可追踪关系 |
| `Verification_Case_Spec.md` | `docs/03_SPEC/` | P0 | verification 与 calibration/validation 必须分开 |
| `Scientific_Change_Gating_Spec.md` | `docs/03_SPEC/` | P0 | 物理/数值/默认参数变更必须 PI gate |
| `Controlled_Search_Boundary_Spec.md` | `docs/03_SPEC/` | P1 | 保留 autoresearch 启发，但限定为后置搜索 |
| `Preflight_And_Mutation_Boundary_Spec.md` | `docs/03_SPEC/` | P1 | 防止 Agent 修改评价基准、raw data 或未授权公式 |
| `Theory_To_Code_Report_Lineage_Spec.md` | `docs/03_SPEC/` | P1 | EvidenceReport 需要展示理论到代码证据链 |
| `Theory_To_Code_API_Contracts.md` | `docs/04_IMPLEMENTATION/` | P1 | 定义 bundle、equation、mapping、verification API |
| `Theory_To_Code_Test_Plan.md` | `docs/04_IMPLEMENTATION/` | P1 | 定义 schema、gate、verification、report 测试 |
| `Scientific_Change_Playbooks.md` | `docs/04_IMPLEMENTATION/` | P2 | 给 Claude/工程师执行高风险科学变更的步骤 |

## 2. 需要补到现有文档的位置

| 目标文档 | 插入位置 | 补充内容 |
|---|---|---|
| `MASTER_INDEX.md` | `03_SPEC/报告与证据` 或新增 `理论到代码治理` 小节 | 加入所有新文档链接 |
| `CANONICAL_CONTRACTS.md` | Schema / artifact / gate 索引后 | 声明 TheoryToCodeBundle support schema 权威源 |
| `Requirements_Catalog.md` | FR/GR/TR/NFR 后 | 新增 FR-TC、GR-TC、TR-TC 需求 |
| `Research_Object_Model.md` | 8 个核心对象后 | 增加支持对象：TheoryNote、EquationSpec 等 |
| `Minimal_Schemas.md` | ChangeRequest / AnalysisPlan / EvidenceReport 附近 | 增加 `semantic_level`、`theory_bundle_id`、`baseline_policy` 字段建议 |
| `Support_Schema_Contracts.md` | Artifact/PiGate 后 | 增加 TheoryToCodeBundle、EquationSpec、VerificationCase 等 schema |
| `Sensitivity_Calibration_Benchmark.md` | Sensitivity 与 calibration 之前 | 增加“搜索后置”前置条件 |
| `Report_Generation_Spec.md` | 报告模板后 | 增加 Theory-to-Code Evidence 章节 |
| `Report_Review_And_Evidence_Lineage_Spec.md` | assertion 类型后 | 增加 theory/equation/code/verification assertion |
| `Auth_Permission_Design.md` | PI gate 规则后 | 增加 scientific change gate |
| `Sandbox_and_Executor.md` | Diff policy 后 | 增加 mutation boundary |
| `Runner_Adapter_Contracts.md` | Submit request 前/后 | 增加 preflight guard contract |
| `Testing_Strategy.md` | Report/fixture tests 后 | 增加 verification、mapping、scientific gate 测试 |
| `Traceability_Matrix.md` | Evidence chain traceability 后 | 增加 equation_id → code_target → verification_case → RunRecord → Report |
| `Phased_Spec_Activation.md` | Phase 3/4/5 | Phase 3 激活 theory-to-code，Phase 4 才激活 search |

## 3. 合并顺序建议

```text
Step 1: 合并 P0 正式规范
  Theory_To_Code_Governance_Spec.md
  Equation_And_Derivation_Spec.md
  Numerical_Scheme_Spec.md
  Implementation_Mapping_Spec.md
  Verification_Case_Spec.md
  Scientific_Change_Gating_Spec.md

Step 2: 合并 support schema / requirements / canonical contracts patch
  Requirements_Catalog
  CANONICAL_CONTRACTS
  Support_Schema_Contracts
  Minimal_Schemas

Step 3: 合并报告、权限、沙箱、runner patch
  Report_Generation
  Evidence_Lineage
  Auth_Permission
  Sandbox
  Runner

Step 4: 合并测试与阶段计划
  Testing_Strategy
  Traceability_Matrix
  Phased_Spec_Activation
  Phased_Plan

Step 5: Claude 审核冲突
  检查是否与 8 核心对象原则冲突
  检查是否把 search 放到了 theory gate 前
  检查是否出现 Agent 自行 accepted 的路径
```

## 4. 合并后的目标状态

合并后，SHUD-Harness 的任务链路应变为：

```text
TaskCard
→ 如果是 scientific/numerical change：TheoryToCodeBundle
→ EquationSpec / DerivationRecord / NumericalSchemeSpec
→ ImplementationMapping
→ VerificationCase
→ RunJob / RunRecord / Artifact
→ EvidenceReport with Theory-to-Code Evidence
→ PI gate
→ 若 accepted_for_search：Sensitivity / Calibration / Controlled Search
```
