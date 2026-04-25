# Patch: Schemas_APIs_CLIs additions

**目标文档**：`docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md`  
**插入位置**：API endpoint 列表中，建议新增“健康检查与运维”小节。

## 新增 REST API

```text
# Health
GET /api/health/live       # liveness: process alive
GET /api/health/ready      # readiness: workspace/db/event/watcher/disk
GET /api/health/deep       # authenticated deep diagnostics

# Ops dashboard
GET /api/ops/dashboard     # aggregated ops status
GET /api/ops/metrics       # recent metrics samples
GET /api/ops/alerts        # active/resolved alerts
GET /api/ops/incidents     # OpsIncident list
GET /api/ops/logs          # query structured logs ?task_id=&job_id=&run_id=&since=&limit=
GET /api/ops/logs/:id/tail # tail large logs

# Dependencies
GET /api/dependencies/lock # DependencyLock summary
GET /api/dependencies/status # lock drift, audit summary, submodule status

# Requirements
GET /api/requirements      # Requirements catalog
GET /api/requirements/coverage # requirement -> tests -> release gate coverage
```

## 行为规则

- `/api/health/live` 不需要认证；
- `/api/health/ready` 可不需要认证，但不得泄露敏感路径；
- `/api/health/deep` 必须认证；
- ops logs API 必须分页/limit；
- dependencies API 不返回 secret；
- requirements API 可读 markdown/generated JSON，不作为运行时业务对象。
