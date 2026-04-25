# Observability Test Plan

**状态**：v0.8.2 新增实施测试计划  
**目标**：验证健康检查、指标、日志聚合、告警和 ops dashboard。

---

## 1. 测试矩阵

| Test ID | 场景 | 覆盖需求 |
|---|---|---|
| OBS-HEALTH-001 | live endpoint | FR-009 |
| OBS-HEALTH-002 | ready workspace writable | NFR-OBS-002 |
| OBS-HEALTH-003 | ready disk critical | ALERT-DISK-002 |
| OBS-HEALTH-004 | deep health auth required | NFR-SEC-001 |
| OBS-LOG-001 | structured API logs | NFR-OBS-001 |
| OBS-LOG-002 | secret redaction | NFR-SEC-001 |
| OBS-METRIC-001 | API metrics emitted | NFR-OBS-001 |
| OBS-METRIC-002 | job metrics emitted | NFR-OBS-001 |
| OBS-ALERT-001 | disk warning/critical alert | NFR-OBS-003 |
| OBS-ALERT-002 | stale job alert | ALERT-JOB-001/002 |
| OBS-ALERT-003 | alert dedupe | Alerting_Thresholds |
| OBS-DASH-001 | ops dashboard aggregation | FR-010 |
| OBS-DUCKDB-001 | warehouse fallback | NFR-OPS-001 |
| OBS-INCIDENT-001 | OpsIncident schema | Support schema |

---

## 2. Health endpoint tests

### OBS-HEALTH-001

Pass：

```text
GET /api/health/live returns 200 when server running
response has status, version, uptime_seconds, timestamp
P95 <= 100ms in test env
```

### OBS-HEALTH-002

模拟 workspace 不可写：

```text
ready.status = not_ready
check workspace_writable = fail
```

### OBS-HEALTH-003

模拟 disk free below threshold：

```text
ready.status = not_ready
alert ALERT-DISK-002 active
new job submit returns 409 or service policy error
```

---

## 3. Log tests

### OBS-LOG-001

触发 API request，检查 NDJSON：

```text
ts
level
service
event
request_id
route
status
duration_ms
```

### OBS-LOG-002

输入包含 fake secret：

```text
OPENAI_API_KEY=sk-test-secret
SMTP_PASSWORD=...
```

Pass：

```text
logs/artifacts/report/export/email body 不出现 secret value
只出现 [REDACTED]
```

---

## 4. Alert tests

### OBS-ALERT-002 stale job

Fixture：

```text
RunJob status=running
last_log_at older than threshold
process still present or unknown
```

Pass：

```text
AlertRecord created
severity warning/error according to threshold
evidence_refs include job log or status snapshot
TaskCard not automatically marked done
```

### OBS-ALERT-003 dedupe

Repeated trigger within window：

```text
only one active alert
suppressed count increments
```

---

## 5. Dashboard tests

`GET /api/ops/dashboard` must return:

```text
health
jobs
storage
errors
reports
notifications
dependencies
cost
```

Pass：

- missing optional SMTP returns degraded, not crash；
- DuckDB failure falls back to NDJSON/filesystem summary；
- dashboard response contains no secrets。

---

## 6. Runbook drill tests

Manual/nightly drills：

```text
disk full simulation
stale dummy job
DuckDB corruption simulation
SMTP mock failure
secret leak scan hit
```

每个 drill 必须生成：

```text
OpsIncident
evidence_refs
resolution note
```

---

## 7. 验收标准

- [ ] Health endpoint tests in PR CI。
- [ ] Alert tests in PR or nightly。
- [ ] Runbook drills at least nightly/manual before release。
- [ ] Secret redaction tests block PR。
- [ ] Ops dashboard smoke passes。
