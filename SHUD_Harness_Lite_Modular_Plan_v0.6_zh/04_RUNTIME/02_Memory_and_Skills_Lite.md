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

但不要求复杂 contract.yaml、promotion proposal、Critic review。

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
