# Performance Test Plan

**状态**：v0.8.2 新增实施测试计划  
**目标**：将 `Performance_NFR_Spec.md` 中的性能目标转化为可执行测试。

---

## 1. 测试分类

| Test ID | 类型 | 目标 |
|---|---|---|
| PERF-API-001 | REST metadata latency | 验证 metadata API P95 |
| PERF-API-002 | heavy submit latency | 验证重任务提交不阻塞 |
| PERF-WS-001 | WebSocket reconnect | 验证 reconnect + replay/snapshot SLA |
| PERF-WS-002 | event delivery lag | 验证事件产生到前端可见延迟 |
| PERF-REPORT-001 | report generation | 验证 tiny report 生成时长 |
| PERF-EXPORT-001 | cached export | 验证 standalone HTML cached download |
| PERF-BATCH-001 | batch progress latency | 验证 job status 到 grid 更新 |
| PERF-FE-001 | UI log tail memory | 验证大日志不进 React state |
| PERF-CONC-001 | MVP concurrency smoke | 验证 1-3 用户、10 task、20 parked jobs |

---

## 2. W1-W3 必测

### PERF-API-001

Fixture：mock workspace + 100 tasks。

命令草案：

```bash
bun run test:perf:api
```

Pass：

```text
GET /api/tasks P95 <= 300ms
GET /api/tasks/:id P95 <= 300ms
GET /api/health/ready P95 <= 300ms
```

### PERF-WS-001

Fixture：dummy event store。

Pass：

```text
connect <= 1s
reconnect + since_seq replay <= 5s
snapshot fallback <= 5s
```

---

## 3. W4-W6 必测

### PERF-REPORT-001

Fixture：ccw tiny RunRecord + metrics artifact。

Pass：

```text
deterministic report generation P95 <= 30s
language guard P95 <= 5s
```

### PERF-BATCH-001

Fixture：3×3 dummy batch。

Pass：

```text
job.status update → progress cell visible P95 <= 2s
failed cell remains visible
```

---

## 4. W7-W8 必测

### PERF-EXPORT-001

Pass：

```text
cached HTML export download P95 <= 1s
regeneration P95 <= 20s for tiny report
large logs excluded from inline HTML
```

### PERF-CONC-001

Fixture：

```text
3 users
10 tasks
20 parked jobs
50 RunRecords
10 WS connections
20 RPS metadata
```

Pass：

```text
metadata P95 <= 500ms
no unbounded memory growth
ready remains ok/degraded, not failed
```

---

## 5. CI 放置

| 测试 | PR CI | Nightly | Release |
|---|---:|---:|---:|
| PERF-API-001 | ✓ | ✓ | ✓ |
| PERF-WS-001 | ✓ | ✓ | ✓ |
| PERF-REPORT-001 |  | ✓ | ✓ |
| PERF-BATCH-001 |  | ✓ | ✓ |
| PERF-CONC-001 |  |  | ✓ |

---

## 6. 失败处理

- PR CI P0 失败：阻塞合并；
- Nightly 失败：创建 issue/incident，不阻塞已有 release；
- Release 失败：阻塞 release；
- 性能回归必须记录 regression source 和 rollback plan。

---

## 7. 验收标准

- [ ] 每条 NFR-PERF 至少有一个 PERF test。
- [ ] W1 前实现 API/WS baseline benchmark。
- [ ] W4 后加入 ccw tiny report benchmark。
- [ ] W6 后加入 batch progress benchmark。
- [ ] 性能测试输出进入 release notes。
