# Patch: docs/00_INDEX/MASTER_INDEX.md

## 目标文档

`docs/00_INDEX/MASTER_INDEX.md`

## 补充目的

将 Theory-to-Code 相关规范纳入主索引，避免 Claude 审核时把新增文档视为临时补丁。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

`03_SPEC/` 中“报告与证据”之后新增“理论到代码治理”小节；`04_IMPLEMENTATION/` 中测试与实施附近加入 API/test/playbook。

## 建议新增内容


```markdown
### 理论到代码治理
| 文件 | 用途 |
|---|---|
| [`Theory_To_Code_Governance_Spec.md`](../03_SPEC/Theory_To_Code_Governance_Spec.md) | 科学假设→公式→推导→数值方案→代码实现→验证的治理链路 |
| [`Equation_And_Derivation_Spec.md`](../03_SPEC/Equation_And_Derivation_Spec.md) | 公式、符号、单位、维度检查和推导记录 |
| [`Numerical_Scheme_Spec.md`](../03_SPEC/Numerical_Scheme_Spec.md) | 离散化、状态变量、通量/源汇项、边界条件、守恒/稳定性预期 |
| [`Implementation_Mapping_Spec.md`](../03_SPEC/Implementation_Mapping_Spec.md) | equation_id/symbol_id 到代码文件、函数、变量和输出语义的映射 |
| [`Verification_Case_Spec.md`](../03_SPEC/Verification_Case_Spec.md) | verification/validation/calibration 边界与验证用例 |
| [`Scientific_Change_Gating_Spec.md`](../03_SPEC/Scientific_Change_Gating_Spec.md) | 科学语义变更分级与 PI gate |
| [`Controlled_Search_Boundary_Spec.md`](../03_SPEC/Controlled_Search_Boundary_Spec.md) | 搜索/校准作为后置工具的边界 |
| [`Preflight_And_Mutation_Boundary_Spec.md`](../03_SPEC/Preflight_And_Mutation_Boundary_Spec.md) | RunJob/Search/ChangeRequest preflight 与修改边界 |
| [`Theory_To_Code_Report_Lineage_Spec.md`](../03_SPEC/Theory_To_Code_Report_Lineage_Spec.md) | EvidenceReport 中理论到代码证据链 |
```

`04_IMPLEMENTATION/` 增加：

```markdown
| [`Theory_To_Code_API_Contracts.md`](../04_IMPLEMENTATION/Theory_To_Code_API_Contracts.md) | TheoryToCodeBundle / VerificationCase API |
| [`Theory_To_Code_Test_Plan.md`](../04_IMPLEMENTATION/Theory_To_Code_Test_Plan.md) | Theory-to-Code 测试计划 |
| [`Theory_To_Code_Phase_Activation.md`](../04_IMPLEMENTATION/Theory_To_Code_Phase_Activation.md) | 阶段激活补充 |
| [`Scientific_Change_Playbooks.md`](../04_IMPLEMENTATION/Scientific_Change_Playbooks.md) | 科学语义变更 Playbook |
| [`Theory_To_Code_Traceability_Addendum.md`](../04_IMPLEMENTATION/Theory_To_Code_Traceability_Addendum.md) | equation→code→verification→report 追踪补充 |
```


## 验收标准补充

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。
