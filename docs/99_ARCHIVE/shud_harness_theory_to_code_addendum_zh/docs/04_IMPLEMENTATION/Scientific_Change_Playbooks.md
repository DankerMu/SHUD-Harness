# Scientific Change Playbooks

**状态**：v0.8.3 P2 实施补充  
**目标**：为 Claude/工程师/Reviewer 提供处理科学语义变更的操作步骤。

## Playbook 1：修改物理方程

```text
1. 创建 TaskCard(type=science_assist/code_change)。
2. 创建 ChangeRequest(semantic_level=physical_equation)。
3. 创建 TheoryToCodeBundle。
4. 填写 TheoryNote：科学问题、过程范围、假设、非目标、PI questions。
5. 填写 EquationSpec：符号、单位、公式、dimension checks。
6. 填写 DerivationRecord：推导步骤、假设、未决问题。
7. 填写 NumericalSchemeSpec：state/flux/source/boundary/conservation/stability。
8. PI/Reviewer 审查 theory/derivation/scheme。
9. 创建 ImplementationMapping，生成 patch。
10. 定义 VerificationCase。
11. 运行 verification，保留 RunRecord/artifact。
12. 生成 EvidenceReport，包含 Theory-to-Code Evidence。
13. PI gate：accepted / accepted_for_search / revision / reject。
14. 只有 accepted_for_search 后才允许 sensitivity/calibration。
```

## Playbook 2：数值实现重构但物理语义不变

```text
1. ChangeRequest semantic_level=numerical_implementation 或 pure_engineering。
2. 如果可能影响数值结果，创建 bundle。
3. ImplementationMapping 标记 refactor_same_semantics。
4. VerificationCase 使用 regression + mass_balance。
5. 比较 old/new outputs within tolerance。
6. Report 写工程等价性，不写科学机制结论。
```

## Playbook 3：修改默认参数

```text
1. ChangeRequest semantic_level=parameter_default。
2. TheoryNote 说明参数物理意义和修改动机。
3. EquationSpec 可引用该参数相关公式。
4. VerificationCase 至少包含 regression/tiny_basin。
5. Calibration result 只能作为候选证据。
6. PI gate 必须 comment。
7. accepted 后才可更新默认配置或文档。
```

## Playbook 4：输出变量语义变化

```text
1. semantic_level=output_semantics。
2. 更新 ImplementationMapping.output_semantics_changes。
3. 检查 SHUD_Output_Variables、rSHUD reader、Visualization_Data_Spec。
4. VerificationCase 使用 output_semantics + rSHUD roundtrip。
5. PI gate 审批是否接受 breaking semantic change。
```

## Playbook 5：参数搜索 / calibration

```text
1. 确认模型结构和 bundle 已 accepted_for_search，或任务是低风险参数分析。
2. 确认 baseline_run_id。
3. 确认 fixed data_id、stack_id、eval_script_hash。
4. 运行 AnalysisPlan。
5. 生成 ExperimentLedger。
6. Report 写 performance / sensitivity observation，不写 theory validation。
```

## 通用禁令

- 不允许绕过 bundle 直接搜索高风险科学变更。
- 不允许把失败 verification 删除。
- 不允许把 PI comment 自动推广为普遍事实。
- 不允许 Agent 自行 accepted。
