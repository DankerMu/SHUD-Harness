---
status: frozen
---

# Theory-to-Code Governance Spec

**状态**：v0.8.3 P0 补充规范  
**适用范围**：涉及 SHUD 物理过程、控制方程、模型假设、数值实现、默认参数语义、输出变量语义的任务。  
**目标**：建立从科学假设到代码实现和验证用例的可追踪治理链路。

## 1. 核心原则

```text
Search is downstream of scientific correctness.
```

在 SHUD-Harness 中，参数搜索、敏感性分析、校准和 benchmark comparison 只能作为下游工具。对于科学语义变更，必须先记录并审查：

```text
TheoryNote
→ EquationSpec
→ DerivationRecord
→ NumericalSchemeSpec
→ ImplementationMapping
→ VerificationCase
→ EvidenceReport
→ PI gate
→ Search / calibration / benchmark
```

## 2. 何时必须创建 TheoryToCodeBundle

以下任务必须创建：

| 变更类型 | 必须创建 bundle | 说明 |
|---|---:|---|
| `physical_equation` | 是 | 控制方程、通量项、源汇项、耦合项变化 |
| `model_assumption` | 是 | 过程假设、边界条件假设、物理解释变化 |
| `numerical_implementation` | 是 | 离散化、求解器项、数值稳定性相关实现 |
| `parameter_default` | 是 | 默认参数物理意义或推荐值变化 |
| `output_semantics` | 是 | 输出变量含义、单位、时空聚合方式变化 |
| `io_format` | 视情况 | 若只改格式且语义不变，可不创建 |
| `pure_engineering` | 否 | UI、API、日志、测试框架等 |
| `ops` | 否 | 部署、监控、通知、运维 |

## 3. TheoryToCodeBundle 状态机

```text
draft
→ theory_review
→ derivation_review
→ numerical_scheme_review
→ implementation_review
→ verification_ready
→ verification_running
→ verification_review
→ awaiting_pi
→ accepted_for_search | accepted | revision_requested | rejected | archived
```

### 状态含义

| 状态 | 含义 |
|---|---|
| `draft` | Agent/工程师正在整理材料 |
| `theory_review` | 科学问题、过程范围、假设待审查 |
| `derivation_review` | 公式与推导步骤待审查 |
| `numerical_scheme_review` | 离散化、边界条件、守恒/稳定性预期待审查 |
| `implementation_review` | 公式到代码映射待审查 |
| `verification_ready` | 验证用例定义完整，可运行 |
| `verification_running` | 验证用例执行中 |
| `verification_review` | 验证结果待审查 |
| `awaiting_pi` | 需要 PI 作科学判断 |
| `accepted_for_search` | 允许进入 sensitivity/calibration/search，但不表示理论被普遍证明 |
| `accepted` | PI 接受该 bundle 作为当前任务的科学/工程依据 |
| `revision_requested` | 需要修改理论、推导、映射或验证用例 |
| `rejected` | 不接受该变更链路 |
| `archived` | 历史记录，保留证据 |

**Review 态推进的角色门（对抗审查 A05-5）**：五个 `*_review` 态到下一态的迁移只能由非 agent
principal（engineer/PI）触发——agent（含 coordinator）只能提交材料把 bundle 推**进** review 态，
不能把它推**出**，与"agent 不得 accept 自己的 bundle"同源；每次迁移记录 actor 进 AuditEvent。
`verification_ready → verification_running → verification_review` 属执行流转，agent 可触发；
`awaiting_pi → 终态`已由 PI-only ACL 覆盖。

## 4. Bundle schema

```ts
interface TheoryToCodeBundle {
  bundle_id: string;
  task_id: string;
  change_request_id?: string;

  title: string;
  semantic_level:
    | "numerical_implementation"
    | "parameter_default"
    | "physical_equation"
    | "model_assumption"
    | "output_semantics";

  scientific_question: string;
  process_scope: string;

  theory_note_id: string;
  equation_spec_id: string;
  derivation_record_id: string;
  numerical_scheme_id: string;
  implementation_mapping_id: string;

  verification_case_ids: string[];
  benchmark_case_ids?: string[];

  assumptions: string[];
  limitations: string[];
  pi_questions: string[];

  status:
    | "draft"
    | "theory_review"
    | "derivation_review"
    | "numerical_scheme_review"
    | "implementation_review"
    | "verification_ready"
    | "verification_running"
    | "verification_review"
    | "awaiting_pi"
    | "accepted_for_search"
    | "accepted"
    | "revision_requested"
    | "rejected"
    | "archived";

  created_by: string;
  reviewed_by?: string;
  pi_decision_id?: string;
  created_at: string;
  updated_at: string;
}
```

## 5. Review gates

### 5.0 Review 决策卡（交互减重，2026-07-02）

五个 `*_review` 态的人工推进不靠自由撰写，由 Coordinator 为每个 gate 生成**结构化决策卡**
（模式对齐 Claude Code 的 AskUserQuestion 工具）：

- **3 个决策选项 + 1 个推荐标记 + 自由输入通道**。选项是该 gate 的真实分支（如 theory_review：
  ① 通过，进入 derivation_review；② 要求修订假设 X；③ 升级为 PI 问题），每项附一句后果说明；
  **推荐项必须带理由与 evidence refs**（指向 bundle 材料）——无 refs 不得标推荐。
- **推荐 ≠ 预选**：选项等视觉权重、无默认选中（与 [UI_Implementation_Spec §4.4](UI_Implementation_Spec.md) 等权重规则同源），
  推荐仅以 badge 呈现；自由输入作为第 4 选项，内容进 decision comment。
- **审计**：决策卡全文（选项、推荐、理由）与最终选择一并落 AuditEvent——复盘时可见
  "当时给了什么选项、推荐了什么、人选了什么"。
- **边界**：卡片给人减负，不给 agent 授权——推进 actor 仍须非 agent principal（§3 角色门），
  Coordinator 只能生成卡片不能替人点击；连续多卡全选推荐项不构成"可自动通过"的依据。

### 5.1 Theory gate

进入 `theory_review` 前必须具备：

- scientific question；
- physical process scope；
- assumptions；
- expected behavior；
- non-goals；
- PI questions。

### 5.2 Derivation gate

进入 `derivation_review` 前必须具备：

- equation list；
- symbol table；
- units and dimensions；
- derivation steps；
- unresolved assumptions。

### 5.3 Numerical scheme gate

进入 `numerical_scheme_review` 前必须具备：

- discretization type；
- state variables；
- flux/source terms；
- boundary/initial conditions；
- conservation/stability expectations。

### 5.4 Implementation gate

进入 `implementation_review` 前必须具备：

- repo/file/function/block mapping；
- equation_id/symbol_id references；
- code variables；
- changed outputs；
- semantic risks；
- backward compatibility notes。

### 5.5 Verification gate

进入 `verification_ready` 前必须具备至少一个 verification case，并说明 pass criteria。

## 6. 与现有对象关系

| 现有对象 | 新关系 |
|---|---|
| TaskCard | scientific/numerical task 可引用 `theory_bundle_ids` |
| ChangeRequest | 增加 `semantic_level` 与 `theory_bundle_id` |
| RunJob | verification case 可以生成 RunJob |
| RunRecord | verification result 必须绑定 RunRecord |
| EvidenceReport | 新增 Theory-to-Code Evidence 章节 |
| PiGate | high-risk semantic change 自动触发 gate |
| MemoryNote | PI decision 可写入，但不得自动泛化 |
| AnalysisPlan | search/calibration 前检查 bundle status |

## 7. 禁止行为

- Agent 不得将自己生成的 bundle 标记为 `accepted` 或 `accepted_for_search`。
- Calibration improvement 不得作为 theory validation。
- Verification passed 不得写成模型结构普遍真实。
- 未通过 gate 的 physical equation / model assumption 变更不得进入 search loop。
- 失败 verification 不得删除；必须保留 artifacts、logs、patch、reason。

## 8. 验收标准

- [ ] 高风险 ChangeRequest 缺少 TheoryToCodeBundle 时不能进入 reviewed。
- [ ] Bundle 状态转换必须记录 AuditEvent。
- [ ] Agent actor 不能设置 accepted/accepted_for_search。
- [ ] `accepted_for_search` 之前不能创建 calibration/search AnalysisPlan。
- [ ] EvidenceReport 能展示 bundle summary 和 verification status。
- [ ] 失败 verification 保留 artifacts。
