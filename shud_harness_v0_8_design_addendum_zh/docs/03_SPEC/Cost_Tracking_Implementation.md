# 成本跟踪实现

**状态：** P2 设计规范  
**适用范围：** LLM token、tool call、RunJob runtime、Web CostMonitor  
**目标：** 提供软预算监控，帮助 PI 了解任务成本，但不自动替 PI 中断科研判断。

## 1. 跟踪对象

```yaml
cost_record:
  task_id: TASK-001
  session_id: SESSION-001
  llm:
    provider: openai
    model: gpt-5.5-pro
    input_tokens: 12000
    output_tokens: 3400
  tools:
    call_count: 8
  jobs:
    runtime_seconds: 92
    cpu_seconds: null
  budget_status: ok | warn | exceeded
```

## 2. 软预算原则

成本预算用于提醒，不默认中断任务。原因：

- 科研任务的价值由 PI 判断；
- 长运行可能低 token 但高 runtime；
- 自动中断可能破坏复盘链。

若团队希望硬限制，可作为 deployment policy 单独开启。

## 3. CostMonitor UI

SideNav 或顶部状态栏显示：

- 当前 session token；
- 当前 task token；
- tool call 次数；
- job runtime；
- 预算状态；
- 最近触发成本提醒的原因。

## 4. WebSocket 事件

成本变化通过 `cost.updated` 推送。不要每个 token 都推送；建议按阶段或时间窗口聚合。

## 5. 成本归因

Token 应归因到：

```text
session_id
task_id
agent_role
phase: brief | plan | execute | collect | report | review
```

这样可以看出 token 主要消耗在计划、报告还是失败恢复。

## 6. 报告记录

EvidenceReport 可记录成本摘要：

```yaml
cost_summary:
  llm_tokens_in: 12000
  llm_tokens_out: 3400
  tool_calls: 8
  job_runtime_seconds: 92
```

但成本不应作为科学证据。

## 7. 验收标准

- [ ] token/tool/job runtime 可按 task 汇总。
- [ ] CostMonitor 显示 warn/exceeded 状态。
- [ ] 预算超过默认不自动停止任务。
- [ ] EvidenceReport 可包含成本摘要但不将其作为科学结论。
