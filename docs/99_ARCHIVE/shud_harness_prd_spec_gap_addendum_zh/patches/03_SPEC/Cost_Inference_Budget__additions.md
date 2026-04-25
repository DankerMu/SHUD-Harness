# Patch: Cost_Inference_Budget additions

**目标文档**：`docs/03_SPEC/Cost_Inference_Budget.md`  
**插入位置**：WebSocket 成本事件之后。

## 补充说明

CostMonitor 是 observability 的一个子集，但它不承担系统健康告警的全部职责：

```text
CostMonitor:
  LLM tokens
  model calls
  tool calls
  job runtime
  advisory budget status

Observability:
  health checks
  API latency
  WS reconnect
  job stale
  disk pressure
  DuckDB status
  notification status
  dependency drift
```

## 规则

- 成本超出 advisory 不自动中断任务；
- disk critical、secret leak、dependency lock drift 可以触发硬 gate；
- cost.updated 和 ops.metric.updated 是不同事件；
- EvidenceReport 可以包含 cost summary，但不能把成本当成科学证据。
