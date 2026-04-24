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
