# Patch: Support_Schema_Contracts additions

**目标文档**：`docs/03_SPEC/Support_Schema_Contracts.md`  
**插入位置**：现有 support schema 列表后，建议新增“小节：Observability / Requirements / Dependency support schemas”。

## 新增对象

```ts
interface Requirement {
  requirement_id: string;
  type: "user_story" | "functional" | "non_functional" | "data" | "governance" | "integration" | "test";
  title: string;
  statement: string;
  priority: "P0" | "P1" | "P2" | "P3";
  status: "draft" | "approved" | "implemented" | "verified" | "deprecated" | "blocked";
  source_doc: string;
  related_docs: string[];
  acceptance_criteria: string[];
  test_ids: string[];
  release_gate?: string;
}

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

interface DependencyLock {
  lock_id: string;
  created_at: string;
  package_manager: {
    name: "bun";
    version: string;
    lockfile_path: string;
    lockfile_sha256: string;
  };
  packages: Array<{
    name: string;
    version: string;
    dependency_type: "runtime" | "dev" | "peer" | "optional";
    source: "npm" | "git" | "local";
  }>;
  native_dependencies?: Array<{
    name: string;
    version: string;
    source: string;
    platform: string;
  }>;
  submodules: Array<{
    name: "SHUD" | "rSHUD" | "AutoSHUD" | "zero";
    commit: string;
    dirty: boolean;
  }>;
}
```

## 验收标准补充

- [ ] 新对象进入 Zod schema。
- [ ] schema generation 覆盖新增对象。
- [ ] AlertRecord/OpsIncident 必须包含 evidence_refs。
- [ ] Requirement 编号唯一性有测试。
