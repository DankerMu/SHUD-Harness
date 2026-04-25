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

TaskCard.status 使用粗粒度状态机（权威定义见 `03_SPEC/Minimal_Schemas.md`）：

```text
created
  → planned
  → running          ← runtime_phase: running_local | submitted_job | collecting
  → parked           ← runtime_phase: waiting_for_job
  → reporting
  → awaiting_pi
  → done | cancelled | blocked
```

`runtime_phase` 是辅助字段，用于前端展示和调试，不是状态机转换条件。
PI 要求修订时，TaskCard 回到 `planned`（不使用 `revised` 状态）。

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

### running

任务正在执行。通过 `runtime_phase` 区分细节：

- `running_local`：短命令在 sandbox 同步执行
- `submitted_job`：已提交 RunJob，LLM loop 仍活跃
- `collecting`：Job 完成后正在收集日志、指标和 artifacts

### parked

Agent 已暂停，不继续消耗 LLM token。`runtime_phase = waiting_for_job`。

### reporting

生成 Markdown 报告和下一步建议。

### awaiting_pi

等待 PI 决策。

### blocked

硬限制触发（max_retries、no_progress）或 workspace 损坏。需要人工检查。

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
