# 极简 Runtime Kernel

## 1. 不再使用长自主循环

v0.5 的 loop 类似：

```text
Observe → Decide → Act → Observe Result → Evaluate → Reflect → Update Memory / Skills → Decide Next
```

v0.6 将其改成 **任务驱动 + 长任务友好** 的 kernel：

```text
Brief
→ Plan
→ Execute | Submit Job
→ Park | Collect
→ Report
→ Ask PI
```

## 2. 为什么这样改

SHUD 科学计算与 coding agent 的时间尺度不同：

```text
coding task: 几分钟到一小时；
SHUD real basin run: 几小时到几天；
batch sensitivity: 多个 jobs；
PI 使用频率: 可能每天 1–2 次。
```

因此 agent 不应在一个长 loop 中等待模型完成。它应提交作业、保存状态、退出，等结果出来再 resume。

## 3. Runtime state machine

```text
created
  → planned
  → running_local | submitted_job
  → parked_waiting_for_job
  → collecting
  → reporting
  → awaiting_pi
  → done | revised | cancelled
```

## 4. 每个状态的职责

### created

TaskCard 已创建，但未生成执行计划。

### planned

Coordinator 生成 plan，并列出：

```text
- 需要哪些 run；
- 是否需要改代码；
- 是否需要敏感性分析；
- 预计 LLM 成本；
- 预计 compute 成本；
- 风险和人工审批点。
```

### running_local

短任务，直接在 sandbox 里跑。

### submitted_job

长任务，生成 RunJob 并提交 local/docker/slurm backend。

### parked_waiting_for_job

任务暂停，不继续消耗 LLM token。

### collecting

Job 完成后收集日志、指标和 artifacts。

### reporting

生成 Markdown 报告和下一步建议。

### awaiting_pi

等待 PI 决策。

## 5. Stop conditions

硬编码（不可跳过）：

```text
- max_retry_per_failed_command: 2；
- no_progress_detection: 连续 3 步无进展 → 自动 block。
```

软监控（状态栏提醒，PI 决定是否中止）：

```text
- advisory_model_calls: 状态栏显示调用次数，超出建议值标黄；
- advisory_usd: 状态栏显示费用，超出建议值标黄；
- wall_time_without_user: 仅记录，不自动中断。
```

## 6. 核心原则

```text
Agent 不需要连续“思考”几小时。
Harness 负责保存状态、等待作业、恢复上下文。
```

这是 SHUD-Harness 与普通 coding agent 最大的差异之一。
