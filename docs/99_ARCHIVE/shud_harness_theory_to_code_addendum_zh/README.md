# SHUD-Harness Theory-to-Code Addendum（中文正文，英文路径）

**版本**：v0.8.3-theory-to-code-addendum  
**日期**：2026-04-27  
**目的**：将 SHUD-Harness 的核心治理从“实验搜索优先”明确为“理论分析 → 公式推导 → 数值离散 → 代码实现 → 验证用例 → benchmark / validation → search”的证据链。

## 为什么需要这套补充

SHUD 与机器学习 benchmark 的主要差异在于：机器学习实验经常可以把模型结构、训练策略、超参数改动放进同一个 trial loop 中，通过指标搜索筛选；而 SHUD 这类物理/水文模型的核心风险在更前面：

```text
科学假设是否合理
控制方程是否写对
符号、单位、边界条件是否一致
离散化是否守恒、稳定、可解释
代码实现是否忠实对应公式
验证用例是否能证明“实现正确表达公式”
```

如果这条链路没有显式证据，后续参数搜索、敏感性分析或校准会把理论错误、单位错误、边界条件错误、代码语义错误隐藏起来。因此本补充包的核心原则是：

```text
Search is downstream of scientific correctness.
```

也就是：**搜索是下游工具，不是上游科学正确性的替代品。**

## 包内内容

本 ZIP 包含三类文件：

1. `docs/00_INDEX/`：补充理由、合并地图、需求补充。
2. `docs/03_SPEC/`：理论到代码治理、公式/推导、数值方案、实现映射、验证用例、科学变更 gate、搜索边界等正式规范。
3. `docs/04_IMPLEMENTATION/`：API、测试、阶段激活、playbook、traceability 补充。
4. `patches/`：逐个说明应该补到现有仓库哪个文档、哪个章节、为什么补、如何验收。

## 建议给 Claude 的处理方式

1. 先读 `docs/00_INDEX/Theory_To_Code_Rationale.md`。
2. 再读 `docs/00_INDEX/Theory_To_Code_Merge_Map.md`，按里面的顺序处理。
3. 新增 `docs/03_SPEC/*` 与 `docs/04_IMPLEMENTATION/*` 中的正式文档。
4. 再按 `patches/` 中的目标文档逐项合并。
5. 合并完成后更新 `MASTER_INDEX.md`、`CANONICAL_CONTRACTS.md`、`Requirements_Catalog.md`、`Traceability_Matrix.md`。

## 合并优先级

```text
P0:
  Theory_To_Code_Governance_Spec.md
  Scientific_Change_Gating_Spec.md
  Equation_And_Derivation_Spec.md
  Implementation_Mapping_Spec.md
  Verification_Case_Spec.md

P1:
  Controlled_Search_Boundary_Spec.md
  Preflight_And_Mutation_Boundary_Spec.md
  Theory_To_Code_Report_Lineage_Spec.md
  Theory_To_Code_Test_Plan.md

P2:
  API contracts、frontend panel、playbooks、phase activation refinements
```
