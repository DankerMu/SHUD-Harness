# Performance Non-Functional Requirements Spec

**状态**：v0.8.2 HIGH 新增规范  
**适用范围**：REST API、WebSocket、frontend、report/export、batch progress、workspace storage、runner submit/collect。  
**目标**：将性能要求从零散 checklist 变成可测试 NFR。

---

## 1. 性能目标分层

| 层级 | 含义 |
|---|---|
| `P0 budget` | 不满足会阻塞相应阶段发布 |
| `P1 target` | 应在 MVP 中满足，允许有记录的例外 |
| `P2 stretch` | 小团队/lab server 扩展目标 |

---

## 2. REST API 延迟目标

### 2.1 Metadata API

适用：

```text
GET /api/tasks
GET /api/tasks/:id
GET /api/jobs/:id
GET /api/reports/:id
GET /api/analysis/:id/progress
GET /api/health/live
GET /api/health/ready
```

目标：

| 环境 | P95 | P99 |
|---|---:|---:|
| local dev / mock workspace | ≤ 300ms | ≤ 1000ms |
| lab server / small team | ≤ 500ms | ≤ 1500ms |

### 2.2 Heavy operation submit API

适用：

```text
POST /api/jobs
POST /api/tasks/:id/run-tiny
POST /api/analysis/sensitivity
POST /api/tasks/:id/report
POST /api/reports/:id/export
```

规则：

- 真正耗时操作必须异步；
- submit/accept 响应 P95 ≤ 1000ms；
- 返回 job/report/export id；
- 不允许 HTTP 请求阻塞等待 SHUD 完成。

### 2.3 Data API

适用：

```text
GET /api/artifacts/:id/data
GET /api/runs/:id/series
GET /api/analysis/:id/heatmap
```

目标：

| 数据类型 | P95 |
|---|---:|
| small JSON artifact | ≤ 500ms |
| hydrograph tiny | ≤ 2000ms |
| heatmap dummy batch | ≤ 1000ms |
| 大型 timeseries | 必须分页、降采样或异步生成 |

---

## 3. WebSocket SLA

| 项目 | 目标 |
|---|---:|
| initial WS handshake | P95 ≤ 1s |
| heartbeat interval | 15s |
| missed heartbeat detection | ≤ 45s |
| reconnect + since_seq replay | P95 ≤ 5s |
| snapshot fallback generation | P95 ≤ 5s for MVP workspace |
| event delivery latency | P95 ≤ 1s |
| log chunk interval | 250ms-1000ms 聚合推送，不逐行轰炸 |

---

## 4. Frontend performance

| 项目 | 目标 |
|---|---:|
| workbench shell first usable render | ≤ 3s |
| route transition | ≤ 500ms |
| spinner visible for async action | ≤ 3s |
| ActivityFeed append 1000 events | 不明显卡顿 |
| RuntimeTerminal tail render | 不将完整日志放入 React state |
| BatchProgressGrid 100 cells | 交互响应 ≤ 500ms |

---

## 5. Report / export performance

| 项目 | 目标 |
|---|---:|
| tiny report deterministic generation | P95 ≤ 30s |
| report language guard | P95 ≤ 5s |
| cached HTML export download | P95 ≤ 1s |
| HTML export regeneration | P95 ≤ 20s for tiny fixture |
| missing artifact handling | 不阻塞导出，标注 missing |

大型报告策略：

- report generation 作为 async job；
- export 超出 20s 时返回 export job id；
- full logs 不内联，只保留 link/tail。

---

## 6. Batch / sensitivity performance

| 项目 | 目标 |
|---|---:|
| batch progress update after job status change | P95 ≤ 2s |
| 3×3 dummy batch submit | P95 ≤ 3s |
| failed cell visibility | 立即保留，不被隐藏 |
| heatmap aggregation dummy batch | P95 ≤ 2s |
| batch notification | 只在 summary 可读后发一次，避免每个 job 邮件 |

---

## 7. Concurrency targets

### MVP local / PI workstation

```text
active users: 1-3
active tasks: 10
parked jobs: 20
stored RunRecords: 50
WebSocket connections: 10
metadata API RPS: 20
concurrent local runner jobs: configurable, default 1
```

### Lab server target

```text
active users: 10
active tasks: 50
parked jobs: 200
stored RunRecords: 1000
WebSocket connections: 50
metadata API RPS: 100
concurrent runner jobs: configurable, depends on machine/HPC
```

---

## 8. Resource targets

| 资源 | 目标 |
|---|---|
| API server idle memory | < 1 GB |
| API server active memory, excluding SHUD | < 2 GB |
| WebSocket event buffer | bounded by seq retention config |
| log tail memory | bounded; no full log in memory |
| DuckDB query memory | configured limit if supported |
| workspace disk | warn < 10%, critical < 5% or < 5GB |

---

## 9. Failure policy when NFR is violated

| NFR violation | 处理 |
|---|---|
| metadata API P95 exceeded | alert warning；不自动 block |
| ready check disk critical | block new jobs |
| WS reconnect SLA failed | dashboard warning；fallback snapshot |
| report generation exceeds target | mark report generation slow；不伪装成功 |
| batch progress delayed | dashboard warning；allow manual refresh |
| OOM risk | degrade: disable large inline exports, prefer artifact links |

---

## 10. 验收标准

- [ ] Performance budgets 写入 CI 或 nightly。
- [ ] API metadata benchmark 覆盖 `/api/tasks`、`/api/jobs/:id`、`/api/health/ready`。
- [ ] WebSocket reconnect SLA 有自动测试。
- [ ] Report/export fixture 有 benchmark。
- [ ] Batch progress latency 有 dummy batch 测试。
- [ ] 大日志不会导致 frontend memory runaway。
- [ ] NFR 违反会产生 alert 或 test failure。
