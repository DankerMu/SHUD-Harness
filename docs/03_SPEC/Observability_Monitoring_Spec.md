# Observability and Monitoring Spec

**状态**：v0.8.2 新增 HIGH 规格  
**适用范围**：API server、WebSocket、runner、workspace、DuckDB warehouse、notification、report/export、frontend ops dashboard。  
**目标**：让 SHUD-Harness 不仅能运行，还能被诊断、监控、恢复和审计。

---

## 1. 设计原则

1. **先可诊断，再可扩展**：MVP 不要求 Prometheus/Grafana，但必须有结构化指标、健康检查和 dashboard 数据源。
2. **科研证据与运维指标分离**：运维指标不能替代 RunRecord/EvidenceReport；RunRecord 仍是科学复盘核心。
3. **所有关键事件可关联**：日志、API 请求、WebSocket 事件、RunJob、RunRecord、Report、Notification 必须能通过 ID 关联。
4. **不泄露 secrets**：日志、metrics label、alert、dashboard、email 均不得包含 secret value。
5. **长任务状态优先**：Parked job、stale job、collect failure、disk pressure 是核心监控对象。

---

## 2. Health check endpoints

### 2.1 `GET /api/health/live`

用途：判断进程是否活着，供 systemd/Docker/basic uptime 使用。

要求：

- 不依赖 DuckDB、workspace、SMTP、LLM、SHUD；
- 正常返回 200；
- server 正在 graceful shutdown 时返回 503；
- 响应时间目标：P95 ≤ 100ms。

示例：

```json
{
  "status": "ok",
  "service": "shud-harness-api",
  "version": "0.8.2",
  "uptime_seconds": 3600,
  "timestamp": "2026-04-25T12:00:00Z"
}
```

### 2.2 `GET /api/health/ready`

用途：判断服务是否可以处理工作请求。

必须检查：

| 检查项 | 失败后 ready 状态 |
|---|---|
| workspace path exists | `not_ready` |
| workspace writable | `not_ready` |
| artifact directory writable | `not_ready` |
| DuckDB / warehouse can open | `not_ready` 或 `degraded` |
| event store append/read | `not_ready` |
| background watcher running | `degraded` |
| schema version compatible | `not_ready` |
| submodule path discoverable | `degraded` |
| disk free above critical threshold | `not_ready` |
| config loaded without fatal errors | `not_ready` |

示例：

```json
{
  "status": "degraded",
  "checks": [
    {"name": "workspace_writable", "status": "ok"},
    {"name": "duckdb_open", "status": "ok"},
    {"name": "watcher_running", "status": "warn", "message": "runner watcher restarted 2 minutes ago"},
    {"name": "disk_free", "status": "warn", "free_gb": 18.2}
  ],
  "timestamp": "2026-04-25T12:00:00Z"
}
```

### 2.3 `GET /api/health/deep`

用途：人工诊断或 ops dashboard 使用。

特点：

- 需要认证；
- 可以稍慢；
- 不应在普通 liveness/readiness probe 中调用；
- 可以检查 SMTP/SendGrid config、LLM provider config、runner adapter、dummy command、DuckDB query、report export template。

返回状态：

```text
ok
degraded
not_ready
failed
```

---

## 3. 指标目录

### 3.1 API metrics

| Metric | 类型 | 说明 |
|---|---|---|
| `api_requests_total` | counter | 按 route/method/status 聚合 |
| `api_request_duration_ms` | histogram | REST API 延迟 |
| `api_errors_total` | counter | 按 category/severity 聚合 |
| `idempotency_replay_total` | counter | 幂等重复请求次数 |

禁止在 label 中放入 raw path、完整 user input、secret、长 task title。

### 3.2 WebSocket metrics

| Metric | 类型 | 说明 |
|---|---|---|
| `ws_connections_current` | gauge | 当前连接数 |
| `ws_reconnects_total` | counter | 重连次数 |
| `ws_events_sent_total` | counter | 推送事件数 |
| `ws_event_lag_ms` | histogram | 事件产生到发送延迟 |
| `ws_snapshot_required_total` | counter | since_seq 过期导致 snapshot 的次数 |
| `ws_heartbeat_missed_total` | counter | 心跳丢失次数 |

### 3.3 Job / runner metrics

| Metric | 类型 | 说明 |
|---|---|---|
| `runjobs_total` | counter | 按 backend/status 统计 |
| `runjobs_current` | gauge | queued/running/parked/collecting |
| `runjob_duration_seconds` | histogram | Job 运行时长 |
| `runjob_stale_total` | counter | stale job 检测次数 |
| `collect_duration_seconds` | histogram | collect 时长 |
| `collect_failures_total` | counter | collect 失败次数 |

### 3.4 Report/export metrics

| Metric | 类型 | 说明 |
|---|---|---|
| `reports_generated_total` | counter | 按 status/template_version |
| `report_generation_duration_seconds` | histogram | 报告生成时长 |
| `report_exports_total` | counter | 按 format/status |
| `report_export_duration_seconds` | histogram | 导出耗时 |
| `report_language_guard_failures_total` | counter | 报告语言 guard 失败次数 |

### 3.5 Storage / warehouse metrics

| Metric | 类型 | 说明 |
|---|---|---|
| `workspace_free_bytes` | gauge | workspace 剩余空间 |
| `workspace_used_bytes` | gauge | workspace 使用量 |
| `artifact_bytes_total` | gauge | artifact 总体积 |
| `artifact_count` | gauge | artifact 数量 |
| `duckdb_query_duration_ms` | histogram | DuckDB 查询耗时 |
| `duckdb_errors_total` | counter | DuckDB 错误 |
| `retention_cleanup_bytes_total` | counter | cleanup 回收空间 |

### 3.6 Notification metrics

| Metric | 类型 | 说明 |
|---|---|---|
| `notifications_total` | counter | 按 trigger/channel/status |
| `notification_send_duration_ms` | histogram | 发送耗时 |
| `notification_dedupe_suppressed_total` | counter | dedupe 抑制 |
| `smtp_failures_total` | counter | SMTP/SendGrid 失败 |

---

## 4. Ops dashboard

MVP dashboard 可以是 Web workbench 的一个 Ops/Status panel，不需要独立平台。

### 4.1 页面分区

| Section | 内容 |
|---|---|
| System Health | live/ready/deep 状态、版本、uptime、schema version |
| Jobs | queued/running/parked/collecting/stale jobs、最近失败 |
| Storage | workspace free、artifact size、retention cleanup 建议 |
| Errors | 最近 ErrorRecord、critical incident、error trend |
| Reports | report generation/export 状态、guard failures |
| Notifications | sent/failed/skipped/dedupe、provider status |
| Dependencies | Bun/TypeScript/Zod/React/DuckDB/package lock/submodule commits |
| Cost | LLM token/cost/job runtime，但只作为软监控 |

### 4.2 API

```http
GET /api/ops/dashboard
GET /api/ops/metrics
GET /api/ops/alerts
GET /api/ops/incidents
GET /api/ops/logs?task_id=&job_id=&run_id=&since=
```

---

## 5. Alert rules

AlertRule 由 `Alerting_Thresholds_Spec.md` 统一定义。这里规定基础行为：

- alert 进入 `AlertRecord` 或 `OpsIncident`；
- critical alert 可触发 Notification，但需要 dedupe；
- alert 不直接改变 TaskCard/RunRecord/EvidenceReport 的科学状态；
- alert 必须关联 evidence_refs，例如日志、health check、metric snapshot。

---

## 6. WebSocket events

新增系统事件：

```text
health.status
ops.metric.updated
alert.raised
alert.resolved
ops.incident.created
ops.incident.updated
```

事件仍使用现有 WebSocket envelope。

---

## 7. Support schema 草案

```ts
interface HealthStatus {
  status: "ok" | "degraded" | "not_ready" | "failed";
  service: string;
  version: string;
  uptime_seconds: number;
  checks: HealthCheck[];
  timestamp: string;
}

interface HealthCheck {
  name: string;
  status: "ok" | "warn" | "fail" | "skipped";
  message?: string;
  evidence_refs?: string[];
}

interface MetricSample {
  metric: string;
  value: number;
  unit?: string;
  labels: Record<string, string>;
  timestamp: string;
}

interface AlertRule {
  rule_id: string;
  metric: string;
  condition: string;
  severity: "info" | "warning" | "error" | "critical";
  threshold: number | string;
  duration?: string;
  action: "dashboard_only" | "notify" | "block_new_jobs" | "require_admin";
}

interface AlertRecord {
  alert_id: string;
  rule_id: string;
  severity: "info" | "warning" | "error" | "critical";
  status: "active" | "resolved" | "suppressed";
  message: string;
  evidence_refs: string[];
  created_at: string;
  resolved_at?: string;
}

interface OpsIncident {
  incident_id: string;
  category:
    | "disk_full"
    | "job_stuck"
    | "duckdb_corruption"
    | "smtp_failure"
    | "oom"
    | "secret_leak"
    | "websocket_failure"
    | "artifact_corruption"
    | "dependency_failure";
  severity: "warning" | "error" | "critical";
  status: "open" | "mitigated" | "resolved" | "postmortem_required";
  task_ids?: string[];
  job_ids?: string[];
  evidence_refs: string[];
  runbook_ref: string;
  created_at: string;
  updated_at: string;
}
```

---

## 8. 验收标准

- [ ] `/api/health/live`、`/api/health/ready`、`/api/health/deep` 已实现。
- [ ] ready 能识别 workspace 不可写、DuckDB 打不开、disk critical。
- [ ] API/WS/job/report/storage/notification 关键指标可采集。
- [ ] ops dashboard 能显示 System、Jobs、Storage、Errors、Notifications、Dependencies。
- [ ] alert 生成后有 evidence_refs。
- [ ] health/metric/alert 日志不含 secrets。
- [ ] 运维指标不进入 EvidenceReport 的科学结论部分。
