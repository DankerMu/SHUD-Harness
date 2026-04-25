# LLM 成本与 Inference Budget

## 1. 设计哲学

做到一半被强制中止比多花代价完成任务更浪费。因此：

- **Budget 是软监控指标，不是硬限制**。系统仅在状态栏实时显示当前消耗，由 PI 自行决定是否中止。
- 不存在自动中断任务的成本阈值。
- 成本追踪的目的是让 PI 知情，而非阻止工作完成。

## 2. 任务级预算（仅供参考）

TaskCard 中的 inference_budget 为建议值，仅用于状态栏展示和事后统计：

```yaml
inference_budget:
  mode: cheap | normal | deep
  advisory_usd: 1.00         # 建议预算，超出时状态栏标黄，不中断
  advisory_model_calls: 12   # 同上
  reviewer_enabled: false
```

超出 advisory 值时：状态栏变色提醒，PI 决定是否继续。

## 3. 模式定义

### cheap

```text
- 仅 planning + report；
- 不调用 Reviewer；
- 不做 embedding；
- 适合运维/简单工程。
- advisory_usd: 0.30, advisory_model_calls: 6
```

### normal

```text
- Coordinator + Worker；
- 允许一次 Reviewer；
- 使用日志摘要；
- 适合小型工程改动和 tiny benchmark。
- advisory_usd: 1.00, advisory_model_calls: 12
```

### deep

```text
- PI 显式开启；
- 可做多轮分析、多个 reports；
- 适合敏感性分析总结或跨仓库改动。
- advisory_usd: 5.00, advisory_model_calls: 30
```

## 4. 成本效率策略

```text
- job waiting 期间不调用 LLM；
- raw logs 不进上下文；
- report generator 优先使用模板 + SQL summary；
- 使用 deterministic scripts 生成指标摘要；
- LLM 只读摘要，不读全量输出；
- report sections 先模板化；
- memory extraction 周期性人工触发，不每轮自动；
- embedding 可选，先用 tags/grep。
```

## 5. 成本报告

每个任务报告包含：

```text
LLM calls: 7
Estimated LLM cost: $0.83
Compute time: 2.4 CPU-hours
Storage added: 1.2 GB
```

这让 PI 能判断自动化是否划算，并决定后续任务的 advisory 值是否需要调整。

## 6. 状态栏展示

```text
[TASK-0001] LLM: $0.72/1.00(adv) | calls: 9/12(adv) | compute: 1.2h
                                ↑ 超出 advisory 时标黄，PI 可随时 Ctrl-C
```

## 7. cost_record 数据结构

每个 session 维护一条 `cost_record`，汇总 LLM token、tool call、RunJob runtime 三类开销：

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
    cpu_seconds: null          # 可选，沙箱提供时填入
  budget_status: ok | warn | exceeded
```

字段说明：

- `budget_status`：由 CostMonitor 根据 TaskCard 的 `advisory_usd` / `advisory_model_calls` 计算，超出建议值时为 `warn`，超出 2× 时为 `exceeded`。状态仅用于 UI 着色提醒，不触发自动中断。
- `cpu_seconds`：若沙箱环境支持 cgroup 计量则填入，否则为 null。
- `cost_record` 持久化到 RunRecord，供事后统计和跨任务对比。

EvidenceReport 可内嵌成本摘要，但成本不应作为科学证据：

```yaml
cost_summary:
  llm_tokens_in: 12000
  llm_tokens_out: 3400
  tool_calls: 8
  job_runtime_seconds: 92
```

## 8. Token 阶段归因

Token 消耗按以下维度归因，便于事后分析成本瓶颈（是计划太贵、报告太长、还是失败重试吃掉了预算）：

```text
session_id
task_id
agent_role          # coordinator | worker | reviewer
phase:              # brief | plan | execute | collect | report | review
```

归因粒度为 phase 级别，不做单次 LLM call 级别拆分。典型用法：

- `plan` 阶段 token 占比过高 → 任务描述不够清晰，Coordinator 反复推理。
- `report` 阶段 token 占比过高 → 考虑增加模板化比例，减少 LLM 生成量。
- `review` 阶段 token 非零但 `cheap` 模式声称不调用 Reviewer → 配置异常。

CostMonitor UI（SideNav 或顶部状态栏）按 phase 分组展示 token 消耗，同时显示：

- 当前 session / task 累计 token
- tool call 次数
- job runtime
- budget_status 着色状态
- 最近一次成本提醒的触发原因

## 9. WebSocket 成本事件

成本变化通过 WebSocket 事件 `cost.updated` 推送至前端 CostMonitor：

```jsonc
{
  "event": "cost.updated",
  "payload": {
    "task_id": "TASK-001",
    "session_id": "SESSION-001",
    "budget_status": "warn",
    "llm_tokens_in": 12000,
    "llm_tokens_out": 3400,
    "tool_calls": 8,
    "job_runtime_seconds": 92,
    "phase": "execute"          // 当前所处阶段
  }
}
```

推送策略：

- **不逐 token 推送**。按阶段切换或固定时间窗口（建议 5 秒）聚合后推送一次。
- `budget_status` 从 `ok` 变为 `warn` 或 `exceeded` 时立即推送，不等时间窗口。
- 前端收到 `exceeded` 状态时高亮提醒，但不阻断操作——中止权始终归 PI。
