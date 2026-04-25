# Log Aggregation Spec

**状态**：v0.8.2 新增规范  
**目标**：定义 SHUD-Harness 服务日志、runner 日志、WebSocket 事件、错误对象和 artifact 日志的聚合策略。

---

## 1. 日志类型

| 类型 | 来源 | 目标 |
|---|---|---|
| service log | API server、WebSocket server、watcher | 诊断服务行为 |
| runner log | Sandbox、local job、docker、slurm | 诊断执行过程 |
| job stdout/stderr | SHUD/rSHUD/AutoSHUD 命令输出 | RunRecord evidence |
| event log | WebSocket/event store | replay、snapshot、审计 |
| audit log | Auth/PI decision/config/admin actions | 治理与安全 |
| notification log | SMTP/SendGrid sending status | 运维诊断 |
| report/export log | report generation/export | 报告可复盘 |

---

## 2. 结构化日志格式

MVP 推荐 NDJSON：

```json
{
  "ts": "2026-04-25T12:00:00.000Z",
  "level": "info",
  "service": "api",
  "event": "api.request.completed",
  "request_id": "REQ-001",
  "session_id": "SESSION-001",
  "task_id": "TASK-001",
  "job_id": "JOB-001",
  "run_id": "RUN-001",
  "report_id": "REPORT-001",
  "route": "GET /api/tasks/:id",
  "status": 200,
  "duration_ms": 42,
  "message": "request completed"
}
```

字段规则：

- `request_id`：每个 HTTP 请求必须有；
- `session_id`：WebSocket/session 相关事件必须有；
- `task_id`：任务上下文内尽量填写；
- `job_id/run_id/report_id`：相关对象存在时填写；
- `message`：面向人类，但不作为解析字段；
- 解析和 dashboard 使用结构字段，不解析自然语言 message。

---

## 3. 存储路径

```text
workspace/logs/service/YYYY-MM-DD.ndjson
workspace/logs/events/YYYY-MM-DD.ndjson
workspace/logs/audit/YYYY-MM-DD.ndjson
workspace/artifacts/logs/JOB-*.stdout
workspace/artifacts/logs/JOB-*.stderr
workspace/artifacts/logs/RUN-*.collect.log
```

大日志不放入 React state，也不直接放进 LLM context。前端只读取 tail、分页或 artifact link。

---

## 4. DuckDB 聚合

MVP 可通过 periodic ingest 将 NDJSON 摘要导入 DuckDB：

```text
ops_api_requests
ops_errors
ops_jobs
ops_alerts
ops_notifications
ops_storage
```

要求：

- DuckDB 损坏不影响原始 NDJSON 和 artifact 日志；
- 可通过 rebuild 命令从 NDJSON 重建 ops warehouse；
- Dashboard 优先读 DuckDB，失败时降级读最近 NDJSON。

---

## 5. Redaction

日志写入前必须脱敏：

```text
API keys
bearer tokens
passwords
SMTP credentials
private SSH key path/content
signed URLs
configured sensitive absolute paths
LLM raw prompts if marked sensitive
```

示例：

```text
OPENAI_API_KEY=sk-... → OPENAI_API_KEY=[REDACTED:secret_ref:env:OPENAI_API_KEY]
```

---

## 6. Retention

| 日志 | 默认保留 |
|---|---:|
| service NDJSON | 30 天 |
| event NDJSON | 90 天 |
| audit log | 1 年 |
| job stdout/stderr artifact | 由 artifact retention_class 决定 |
| notification logs | 90 天 |
| ops DuckDB summaries | 1 年或按 workspace 配置 |

---

## 7. Log aggregation API

```http
GET /api/ops/logs?task_id=&job_id=&run_id=&level=&since=&limit=
GET /api/ops/logs/:logId/tail?lines=200
GET /api/ops/logs/search?q=&since=&limit=
```

MVP 限制：

- 不实现任意复杂全文搜索；
- 默认 limit 不超过 1000；
- 不返回 secret；
- 对大型日志只返回 tail 或 artifact link。

---

## 8. 验收标准

- [ ] API request、WebSocket、runner、audit 均产生结构化日志。
- [ ] 日志至少包含 request_id/session_id/task_id 中相关字段。
- [ ] secret redaction 测试覆盖常见 token/password。
- [ ] DuckDB 聚合可从 NDJSON 重建。
- [ ] 大日志不会进入前端全局 state。
- [ ] report/export 不内联完整日志。
