# Patch: docs/Phased_Spec_Activation.md

## 目标文档

`docs/Phased_Spec_Activation.md`

## 补充目的

更新阶段激活策略，体现 Theory-to-Code 从 Phase 3 起生效、search Phase 4 后置。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

Phase 3、Phase 4、Phase 5 激活 Spec 表格。

## 建议新增内容


```markdown
Phase 3 追加激活：
- Theory_To_Code_Governance_Spec.md
- Verification_Case_Spec.md
- Preflight_And_Mutation_Boundary_Spec.md

Phase 4 追加激活：
- Controlled_Search_Boundary_Spec.md
- Equation_And_Derivation_Spec.md
- Numerical_Scheme_Spec.md
- Implementation_Mapping_Spec.md

Phase 5 追加激活：
- Scientific_Change_Gating_Spec.md
- Theory_To_Code_Report_Lineage_Spec.md
- Scientific_Change_Playbooks.md
```

并将 Phase 4 出口标准补充为：

```text
search/calibration cannot run downstream of high-risk change unless bundle is accepted_for_search.
```


## 验收标准补充

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。
