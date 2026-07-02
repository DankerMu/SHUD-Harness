# 轻量 Memory 与 Skills

## 1. Memory 不再走重审批

v0.6 将 memory 分为三类：

```text
note：普通经验，直接写 draft；
evidence_note：与运行和报告绑定，需 PI review；
playbook：稳定流程，可转成 skill。
```

## 2. MemoryNote schema

```yaml
note_id: NOTE-0001
type: failure_note | data_note | compatibility_note | pi_decision | playbook_candidate
status: draft | accepted | retired
task_id: TASK-0001
title: rSHUD old output fails when optional diagnostics assumed
body: >
  The rSHUD reader failed because it assumed event_flux.csv exists.
evidence:
  - RUN-0007
  - REPORT-0003
created_by: agent
reviewed_by: null
```

### PI Decision 类型约束

`pi_decision` 类型 MemoryNote 的详细 schema 见 [Support_Schema_Contracts.md](Support_Schema_Contracts.md) 和 [PI_Decision_Comments_Spec.md](PI_Decision_Comments_Spec.md)。其 `generalization_allowed` 必须为 false，不得自动升级为跨流域科学事实。

### 2.1 Zero 上游状态机映射（zero@13e25c1）

上游 memory 已原生 `draft | verified | archived | conflict` 状态机与 governance/lifecycle 端点。映射与收窄：

- note `draft` ↔ 上游 `draft`；`accepted` ↔ `verified`——**提升动作仅 PI principal**
  （adapter 收窄上游 authority 允许的 actor 集合，agent 不可自提）；`retired` ↔ `archived`；
- 上游 `conflict` 态在 SHUD 侧按"待人工裁决的 draft"处理，不进 context 组装白名单；
- 复用决策由此从"改上游默认行为"收窄为"收权限 + 状态映射"，见 Zero_Reuse_Matrix §3 / §9.1。

## 3. 什么时候需要 PI review

需要 PI review：

```text
- 科学结论；
- benchmark baseline 替换；
- 数据质量判断；
- 参数校准结果是否可接受；
- 高风险工程变更。
```

不需要 PI review：

```text
- 某脚本路径；
- 某错误日志的工程原因；
- 某次命令失败的修复方式；
- rSHUD reader 的兼容性经验。
```

## 4. Skill 生命周期简化

从：

```text
scaffold → candidate → tested → promoted → canonical → deprecated
```

简化为：

```text
draft → active → retired
```

## 5. MVP 初始 Skills

只做 5 个：

```text
1. run-shud-tiny-case
2. diagnose-shud-run-failure
3. rshud-roundtrip-test
4. summarize-sensitivity-results
5. build-task-report
```

## 6. Skill 格式

继续采用 SKILL.md 目录格式：

```text
skills/run-shud-tiny-case/
  SKILL.md
  scripts/
  examples/
```

但不要求复杂 contract.yaml、promotion proposal、Reviewer review。

**skill 激活的最低审查（AGA-P1-6）**：skill 含可执行脚本且正文会进入 LLM context（信任级 T1，见
[Context_Trust_And_Injection_Spec](Context_Trust_And_Injection_Spec.md)），因此 `draft → active` 必须留下工程师审查记录——
一行即可（`activated_by` + `reviewed_at` 写入 SKILL.md frontmatter），但不能没有。draft skill 不注入 context、不可被 agent 执行。

## 7. 何时把 note 提升成 skill

满足两个条件即可：

```text
- 同类任务至少出现 2 次；
- 工程师认为值得脚本化。
```

不需要 LLM 自我晋升制度。

## 8. Retrieval 策略

MVP 先用 keyword + tags，不强依赖 embeddings：

```text
- task type；
- repo name；
- error class；
- basin/event；
- skill name；
- metric name。
```

需要时再加 embedding，以控制成本。

### 8.1 检索结果的信任标记（AGA-P1-6）

检索命中的 note 注入 context 时必须携带 status，且 draft 与 accepted 在 prompt 中显式区分：

```text
[NOTE-0007 | accepted | pi_decision] 暂不修改物理方程……
[NOTE-0012 | draft | 未经 PI 确认] rSHUD roundtrip 失败可能因为……
```

规则：

- draft note 是 T3 信任级内容——可作诊断线索，不得作为报告结论或 ChangeRequest 的直接依据；
- 单次注入 note 数量有上限（accepted ≤ 5、draft ≤ 3，见 Context_Trust_And_Injection_Spec §5），按相关度截断；
- 错误/恶意 draft note 的影响半径由此受限：它带着"未确认"标记进入 context，且进不了证据链（lineage guard 拒绝 draft note 作为 evidence_refs 唯一来源）；
- session digest（Context_Trust §5.1）注入时同规则：`[DIGEST-0001 | draft | 未经 PI 确认]`，`pi_confirmed` 后按 accepted 待遇。

## 9. 验收标准

- [ ] MemoryTool 不自动把 evidence_note 标记为 accepted（Zero 默认 verified 行为必须改掉）。
- [ ] pi_decision note 只能由 PI decision flow 产生。
- [ ] 检索注入的 note 均带 status 标记；draft note 带"未经 PI 确认"前缀（单测）。
- [ ] draft skill 不被加载进 skill catalog；active skill 的 SKILL.md 有 activated_by 记录。
