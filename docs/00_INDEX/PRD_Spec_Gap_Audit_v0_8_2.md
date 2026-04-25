# PRD / Spec Gap Audit v0.8.2

**状态**：新增审查补充  
**目标**：从 PRD、NFR、运维和可测试性角度审查 v0.8.1 规格的剩余缺口。  
**结论**：v0.8.1 已足够进入 deterministic skeleton，但为了避免开发中期返工，应在 Week 0/Week 1 同步补齐以下 5 类规格。

---

## 1. 缺口总览

| Gap ID | 缺口 | 严重级别 | 当前已有 | 当前缺失 | 本包补充 |
|---|---|---:|---|---|---|
| GAP-OBS-001 | 监控与可观测性 | HIGH | 成本监控、错误追踪、日志推流、WebSocket 事件 | 健康检查、告警阈值、运维 dashboard、日志聚合 | Observability、Alerting、Log Aggregation、Ops API |
| GAP-NFR-001 | 性能 NFR | HIGH | tiny run < 2 分钟、心跳 15 秒、UI spinner < 3 秒 | REST P95、WS 重连 SLA、并发吞吐、报告生成延迟 | Performance NFR、Performance Test Plan |
| GAP-OPS-001 | 运维手册 | HIGH | Task Playbook、故障恢复场景 | 磁盘满、Job 卡死、DuckDB 损坏、SMTP 故障、OOM、密钥泄露 | Operations Runbook |
| GAP-DEP-001 | 依赖版本 | MEDIUM | StackLock 记录系统级版本 | npm/bun 锁定、TS/Zod/React/DuckDB 要求、更新策略 | Dependency Versioning Policy |
| GAP-REQ-001 | 需求形式化 | MEDIUM | checklist、Traceability Matrix | FR/NFR/US 编号体系和统一需求目录 | Requirements Catalog |

---

## 2. 是否阻塞开发

| 缺口 | 是否阻塞 Week 1 skeleton | 是否阻塞真实长任务 / lab server |
|---|---:|---:|
| 监控与可观测性 | 不完全阻塞，但健康检查端点应在 W1 实现 | 阻塞 |
| 性能 NFR | 不阻塞初始编码，但应进入 W1/W2 测试预算 | 阻塞 |
| 运维手册 | 不阻塞代码骨架，但阻塞真实运行推广 | 阻塞 |
| 依赖版本 | 建议 W0/W1 解决，否则后续 lock 漂移 | 阻塞中长期维护 |
| 需求形式化 | 不阻塞代码，但阻塞可追踪验收 | 阻塞 release gate |

---

## 3. 推荐优先级

### P0：合并后马上处理

```text
Requirements_Catalog.md
Requirements_Numbering_Conventions.md
Observability_Monitoring_Spec.md
Performance_NFR_Spec.md
Dependency_Versioning_Policy.md
Schemas_APIs_CLIs observability endpoint patch
Support_Schema_Contracts observability schema patch
```

### P1：Week 1-W3 实现时处理

```text
Alerting_Thresholds_Spec.md
Log_Aggregation_Spec.md
Observability_Test_Plan.md
Performance_Test_Plan.md
CICD performance budget patch
```

### P2：进入真实 SHUD run 前必须处理

```text
Operations_Runbook.md
Ops incidents / recovery tests
DuckDB backup and restore
Disk full and OOM drill
Secret leakage response drill
```

---

## 4. 审查结论

补齐本包后，SHUD-Harness 的规格体系应从：

```text
架构完整 + 开发计划基本确定
```

提升为：

```text
架构完整 + 需求编号可追踪 + NFR 可测试 + 运维可执行 + 依赖可治理
```

这时才适合作为长期开发基线。
