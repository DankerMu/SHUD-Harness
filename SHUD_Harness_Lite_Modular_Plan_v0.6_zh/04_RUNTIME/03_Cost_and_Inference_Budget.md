# LLM 成本与 Inference Budget

## 1. 为什么必须显式治理成本

一个完整闭环可能包含：

```text
Coordinator planning
Worker execution assistance
Reviewer check
Report drafting
Trace summarization
Memory extraction
```

如果不设预算，小任务可能被多轮 LLM 调用放大到不可控成本。

## 2. 任务级预算

TaskCard 中必须有：

```yaml
inference_budget:
  mode: cheap | normal | deep
  max_usd: 1.00
  max_model_calls: 12
  max_context_tokens_per_call: 24000
  reviewer_enabled: false
```

## 3. 模式定义

### cheap

```text
- 仅 planning + report；
- 不调用 Reviewer；
- 不做 embedding；
- 适合运维/简单工程。
```

### normal

```text
- Coordinator + Worker；
- 允许一次 Reviewer；
- 使用日志摘要；
- 适合小型工程改动和 tiny benchmark。
```

### deep

```text
- PI 显式开启；
- 可做多轮分析、多个 reports；
- 适合敏感性分析总结或跨仓库改动。
```

## 4. 成本防护

硬规则：

```text
- 达到 max_usd：停止并生成 partial report；
- job waiting 期间不调用 LLM；
- raw logs 不进上下文；
- report generator 优先使用模板 + SQL summary；
- Reviewer 默认关闭。
```

## 5. 低成本实现策略

```text
- 使用 deterministic scripts 生成指标摘要；
- LLM 只读摘要，不读全量输出；
- report sections 先模板化；
- memory extraction 周期性人工触发，不每轮自动；
- embedding 可选，先用 tags/grep。
```

## 6. 成本报告

每个任务报告包含：

```text
LLM calls: 7
Estimated LLM cost: $0.83
Compute time: 2.4 CPU-hours
Storage added: 1.2 GB
```

这让 PI 能判断自动化是否划算。
