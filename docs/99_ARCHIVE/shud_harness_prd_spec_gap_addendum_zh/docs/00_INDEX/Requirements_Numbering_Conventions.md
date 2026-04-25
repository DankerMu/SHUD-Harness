# Requirements Numbering Conventions

**状态**：新增 PRD 规范  
**目标**：建立统一需求编号体系，避免需求散落在散文、checklist 和测试计划中。

---

## 1. 编号命名空间

| 前缀 | 类型 | 说明 |
|---|---|---|
| `US-*` | User Story | PI、工程师、Reviewer、系统管理员等用户故事 |
| `FR-*` | Functional Requirement | 功能性需求 |
| `NFR-*` | Non-Functional Requirement | 性能、可靠性、安全、运维、可用性等非功能需求 |
| `DR-*` | Data Requirement | 数据、artifact、provenance、retention 需求 |
| `GR-*` | Governance Requirement | PI gate、科研语言边界、审计需求 |
| `IR-*` | Integration Requirement | SHUD/rSHUD/AutoSHUD/Zero/SMTP/SLURM 等集成需求 |
| `TR-*` | Test Requirement | 需要在测试计划中覆盖的验收要求 |

---

## 2. 编号格式

```text
US-001
FR-001
NFR-PERF-001
NFR-OBS-001
NFR-OPS-001
NFR-SEC-001
NFR-REL-001
DR-001
GR-001
IR-001
TR-001
```

规则：

- 编号全局唯一；
- 不复用已删除编号；
- 已废弃需求标记为 `deprecated`，不删除；
- 每条需求必须有 `source_doc`；
- 每条需求必须至少有一个 `acceptance_criteria`；
- 进入实现后，每条 P0/P1 需求必须关联测试 ID。

---

## 3. 需求状态

```text
draft
approved
implemented
verified
deprecated
blocked
```

含义：

| 状态 | 含义 |
|---|---|
| `draft` | 需求仍在讨论 |
| `approved` | 已进入设计基线，可以实现 |
| `implemented` | 代码已实现，但测试或验收未完成 |
| `verified` | 测试和验收通过 |
| `deprecated` | 不再适用，但保留历史 |
| `blocked` | 受外部依赖、数据或设计冲突阻塞 |

---

## 4. 优先级

```text
P0 # 不满足则不能进入相应阶段
P1 # 阶段内必须完成
P2 # 可以延后，但应进入 backlog
P3 # 后续优化
```

---

## 5. Requirement schema 草案

```ts
interface Requirement {
  requirement_id: string;
  type: "user_story" | "functional" | "non_functional" | "data" | "governance" | "integration" | "test";
  title: string;
  statement: string;
  priority: "P0" | "P1" | "P2" | "P3";
  status: "draft" | "approved" | "implemented" | "verified" | "deprecated" | "blocked";
  source_doc: string;
  related_docs: string[];
  acceptance_criteria: string[];
  test_ids: string[];
  release_gate?: string;
}
```

---

## 6. Traceability 规则

`Traceability_Matrix.md` 中每行建议包含：

```text
requirement_id
type
title
source_doc
implementation_module
test_id
phase
release_gate
status
```

对于 P0/P1 需求：

- 缺少 `test_id` 时不能标记为 `verified`；
- 缺少 `implementation_module` 时不能标记为 `implemented`；
- 涉及科研治理的需求必须关联 Reviewer 或 PI gate 测试；
- 涉及运维和安全的需求必须关联 incident 或 negative test。

---

## 7. 需求变更流程

1. 新增需求时先加入 `Requirements_Catalog.md`，状态为 `draft`。
2. 如果影响 schema/API/event/path，则同步更新 `CANONICAL_CONTRACTS.md` 指向的对应文档。
3. 通过设计审查后改为 `approved`。
4. 实现代码后改为 `implemented`。
5. 自动化测试和人工验收通过后改为 `verified`。
