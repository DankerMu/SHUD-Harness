# Patch: CICD_Release additions

**目标文档**：`docs/04_IMPLEMENTATION/CICD_Release.md`  
**插入位置**：PR CI、Nightly CI、Release CI、验收标准之后。

## PR CI 新增

```text
requirements-check:
  - verify unique requirement IDs
  - verify P0/P1 acceptance criteria
  - verify Traceability refs

dependency-check:
  - bun --version
  - bun install --frozen-lockfile
  - dependency audit
  - lockfile drift check

observability:
  - health endpoint tests
  - structured log tests
  - redaction tests

perf-smoke:
  - metadata API latency smoke
  - WebSocket reconnect smoke
```

## Nightly 新增

```text
perf-nightly:
  - report generation benchmark
  - batch progress benchmark
  - MVP concurrency smoke

ops-drill:
  - disk critical simulation
  - stale dummy job
  - DuckDB corruption/rebuild simulation
  - SMTP mock failure
```

## Release 新增

- Performance budget report；
- DependencyLock；
- Requirements coverage summary；
- Ops runbook drill summary；
- secret scan summary；
- health/deep diagnostics sample。
