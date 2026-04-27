# Theory-to-Code 补充理由

**状态**：v0.8.3 建议补充  
**目标**：解释为什么 SHUD-Harness 需要一条显式的“理论 → 公式 → 推导 → 数值方案 → 实现映射 → 验证”证据链，以及为什么参数搜索必须后置。

## 1. 背景

当前 SHUD-Harness 已经具备较完整的工程规格：TaskCard、RunJob、RunRecord、Artifact、EvidenceReport、PI gate、WebSocket、Park/Resume、BatchProgress、ReportExport、Observability、NFR、Runbook、Traceability 等。

这些设计已经能支持“运行—记录—报告—审批”的科研工程闭环。但对于 SHUD 这样的物理模型，仍缺一个更上游的 PRD/spec 层：

```text
科学假设和公式推导是否已经被审查？
公式中的符号、单位、边界条件是否完整？
连续方程如何离散？
代码中哪一段实现了哪一个公式项？
验证用例是否能证明实现忠实表达公式？
```

## 2. 为什么不能直接采用搜索式实验 loop

机器学习项目中，很多改动可以被视为实验候选：修改网络结构、训练技巧或超参数，然后用固定指标筛选。SHUD 的核心风险不同：

| 风险 | 搜索能否发现 | 为什么危险 |
|---|---:|---|
| 符号单位混乱 | 不可靠 | 校准可能掩盖单位错误 |
| 边界条件实现错误 | 不可靠 | 某些 basin/event 上仍可能拟合 |
| 公式项符号或方向错误 | 不可靠 | 指标改善可能来自补偿效应 |
| 离散化不守恒 | 部分可发现 | 需要专门 mass balance / limiting case |
| 代码变量语义错位 | 不可靠 | diff 看起来像普通工程改动 |
| calibration 被误当 theory validation | 不能 | 这是科学解释越权 |

因此，SHUD-Harness 应把搜索限定在已经通过理论/实现审查的模型结构和参数空间中。

## 3. 核心原则

```text
Search is downstream of scientific correctness.
```

展开为 5 条规则：

1. **理论链路优先**：涉及物理方程、模型假设、数值离散、默认参数语义的变更，必须先生成 Theory-to-Code Bundle。
2. **公式可追踪**：每个关键公式项必须有符号、单位、假设和来源说明。
3. **代码可映射**：每个高风险实现变更必须映射到 equation_id、symbol_id、file_path、function/block。
4. **验证区别于校准**：Verification 检查实现是否忠实表达公式；validation/calibration 不得替代 verification。
5. **搜索后置**：敏感性、校准和 trial search 只能在相关理论/实现 bundle 至少达到 `implementation_reviewed` 或 `accepted_for_search` 后启动。

## 4. 需要补充的规格层

| 层 | 新文档 | 补充理由 |
|---|---|---|
| 治理层 | Theory_To_Code_Governance_Spec.md | 定义整体链路、状态和 gate |
| 公式层 | Equation_And_Derivation_Spec.md | 管理符号、单位、公式和推导步骤 |
| 数值层 | Numerical_Scheme_Spec.md | 管理离散化、守恒性、边界/初始条件 |
| 实现层 | Implementation_Mapping_Spec.md | 让公式项追踪到代码位置和变量 |
| 验证层 | Verification_Case_Spec.md | 区分 verification / validation / calibration |
| 搜索边界 | Controlled_Search_Boundary_Spec.md | 将 autoresearch 式 trial loop 限定为后置工具 |
| 沙箱/执行 | Preflight_And_Mutation_Boundary_Spec.md | 防止 Agent 越界修改理论或评价基准 |
| 报告证据 | Theory_To_Code_Report_Lineage_Spec.md | 让 EvidenceReport 能呈现理论到代码证据链 |

## 5. 对现有 v0.8.2 的影响

这套补充不推翻现有架构，而是插入一个更上游的治理层：

```text
现有：TaskCard → RunJob → RunRecord → Artifact → EvidenceReport → PI gate
补充：TaskCard → TheoryToCodeBundle → VerificationCase → RunRecord/Artifact → EvidenceReport → PI gate
```

对纯 ops、纯 UI、纯 report export、纯 dependency update 任务，没有必要启动 Theory-to-Code Bundle。它只对科学语义变更和高风险数值实现变更强制。

## 6. Claude 审核时应重点检查

- 是否把 TheoryToCodeBundle 设计成“支持对象”，而不是膨胀 8 个核心对象。
- 是否把 calibration/search 明确放在后置层。
- 是否把 `physical_equation`、`model_assumption`、`numerical_implementation` 变更纳入 PI gate。
- 是否禁止 Agent 自行接受自己生成的推导。
- 是否在报告中明确“verification 通过不等于模型结构真实”。
