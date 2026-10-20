---
status: living
canonical_for: [canonical-source-index]
---

# Canonical Contracts Index

**状态：** v0.8.3 合同索引  
**目标：** 明确每类工程事实的唯一来源，避免实现时在多个 Markdown 文档中寻找字段定义。

## 1. Canonical source 顺序

当文档之间出现冲突时，按"代码 schema → 生成文档 → 手写语义"顺序判定：

1. **代码 schema**：Zod schema 源码（`packages/dsh-shud-core/src/schemas/*`，ADR-0004 K10），进入实现后为最高事实源。
2. **生成文档**：`docs/generated/schema/*`，由 Zod 自动生成。
3. **手写语义**：
   - 核心对象：`docs/03_SPEC/Minimal_Schemas.md`；
   - Support schema：`docs/03_SPEC/Support_Schema_Contracts.md`；
   - 专题规范：Artifact、Report、Runner、Auth、Workspace 等。

## 2. 核心对象字段

唯一来源：

```text
docs/03_SPEC/Minimal_Schemas.md
```

覆盖对象：

```text
TaskCard
StackLock
DataProvenance
RunJob
RunRecord
AnalysisPlan
EvidenceReport
ChangeRequest
MemoryNote
```

## 3. Support schema 字段

唯一来源：

```text
docs/03_SPEC/Support_Schema_Contracts.md
```

覆盖对象：

```text
Artifact
ArtifactManifest
ErrorRecord
FailureRecord
PiGate
PiGateDecision
NotificationRecord
ReportExport
AnalysisProgressPayload
User
Session
AuditEvent
PermissionDecision
ConfigRecord
RunnerResult
WorkspaceSnapshot
IdempotencyRecord
LockRecord
```

> **投影标注规则（2026-07-02，对抗审查 A01-5/A08-5 系统化）**：任何权威源之外的 schema 副本
> （14 个 interface 存在 ≥2 处定义）必须带"投影声明"标注，改动先落权威源再同步副本；
> `schema:generate` 上线（Week 1）后，投影副本一律转为生成物，手写副本从 CI drift check 报错。
> 专职规范持有的权威源例外：PiDecisionMemoryNote → PI_Decision_Comments_Spec，
> PreflightGuardResult/PreflightCheck → Preflight_And_Mutation_Boundary_Spec。

## 4. Artifact registry

唯一来源：

```text
docs/03_SPEC/Artifact_Registry_Spec.md
```

所有 EvidenceReport、Visualization、ReportExport、RunRecord 中引用的 artifact 都必须有 artifact metadata 或 manifest entry。

## 5. 路径体系

唯一来源：

```text
docs/03_SPEC/Workspace_Conventions.md
```

补充：

```text
docs/03_SPEC/Data_Package_And_Retention_Spec.md
docs/03_SPEC/Idempotency_Concurrency_Locking_Spec.md
```

## 6. Runner contract

唯一来源：

```text
docs/03_SPEC/Runner_Adapter_Contracts.md
```

执行模式枚举仍以 `Minimal_Schemas.md` 中 `RunJob.backend` 为准。

## 7. Schema drift policy

唯一来源：

```text
docs/04_IMPLEMENTATION/Schema_Generation_And_Drift_Control.md
```

实现阶段禁止长期维护两套手写 schema。Markdown schema 应由 Zod 生成或至少由 CI 对比。

## 8. Requirements catalog

唯一来源：

```text
docs/00_INDEX/Requirements_Catalog.md
docs/00_INDEX/Requirements_Numbering_Conventions.md
```

覆盖：

```text
US-* FR-* NFR-* DR-* GR-* IR-* TR-* 编号、状态、优先级、验收标准
```

## 9. Agent roles and runtime behavior

| Contract | Canonical source |
|---|---|
| Agent 角色枚举与权限剖面 | `docs/02_ARCHITECTURE/Roles_and_Boundaries.md` §0 |
| Closure 确定性判据（validator 主闸 + LLM advisory） | `docs/02_ARCHITECTURE/Agent_Architecture.md` §7 |
| No-progress 判定器 | `docs/02_ARCHITECTURE/Control_Kernel.md` §5.1 |
| Language guard 能力边界 | `docs/03_SPEC/Report_Generation_Spec.md` §5.2 |
| Reviewer 检查清单 D/L 分层 | `docs/03_SPEC/Report_Generation_Spec.md` §8 |
| Context 信任分级与组装预算 | `docs/03_SPEC/Context_Trust_And_Injection_Spec.md` |
| Agent 行为 eval（golden 集 + gate 规则） | `docs/04_IMPLEMENTATION/Agent_Behavior_Eval_Spec.md` |
| LLM 错误类别与降级语义 | `docs/03_SPEC/Error_Handling_Spec.md`（LLM 章节） |
| StackLock.llm（模型版本锁） | `docs/03_SPEC/Minimal_Schemas.md` §2 |
| PI 决策动词 ↔ 对象状态映射（request_revision → revision_requested） | `docs/03_SPEC/PI_Decision_Comments_Spec.md`（两个 Zod enum + 显式映射函数，禁止直接赋值） |

## 10. Theory-to-Code canonical sources

| Contract | Canonical source |
|---|---|
| TheoryToCodeBundle / EquationSpec / NumericalSchemeSpec / ImplementationMapping / VerificationCase | `Support_Schema_Contracts.md` + generated Zod schema |
| Scientific semantic level and gate rules | `Scientific_Change_Gating_Spec.md` |
| Theory-to-Code report section and assertion lineage | `Theory_To_Code_Report_Lineage_Spec.md` |
| Search preflight and mutation boundary | `Preflight_And_Mutation_Boundary_Spec.md` |
| Tests | `Theory_To_Code_Test_Plan.md` |

Implementation rule:

```text
Markdown explains semantics; Zod schema is the executable source of truth after implementation.
```

## 11. Domain CLI

唯一来源：

```text
docs/03_SPEC/Domain_CLI_Spec.md
```

覆盖：命令面（shud/metrics/wb/compare/autoshud/version）、result YAML 契约、exit code 契约、
SHUD 退出码映射、CLI↔三仓库兼容矩阵与版本治理、成果回流上游时的 CLI 适配义务。
patch 组命令（diff/bundle/revert）语义仍以 `docs/03_SPEC/Sandbox_and_Executor.md` §3 为准，二者共享同一 `shud-harness` 入口。
