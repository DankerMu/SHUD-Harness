# Patch: Config_Secrets_And_Environment_Spec additions

**目标文档**：`docs/03_SPEC/Config_Secrets_And_Environment_Spec.md`  
**插入位置**：推荐环境变量、redaction policy、验收标准之后。

## 新增环境变量

```text
HARNESS_OPS_DASHBOARD_ENABLED
HARNESS_HEALTH_DEEP_ENABLED
HARNESS_LOG_DIR
HARNESS_LOG_RETENTION_DAYS
HARNESS_ALERT_DISK_WARN_PERCENT
HARNESS_ALERT_DISK_CRITICAL_PERCENT
HARNESS_ALERT_DISK_CRITICAL_GB
HARNESS_MAX_CONCURRENT_LOCAL_JOBS
HARNESS_MAX_WS_CONNECTIONS
HARNESS_DUCKDB_PATH
HARNESS_DUCKDB_BACKUP_DIR
HARNESS_PACKAGE_MANAGER_VERSION
```

## Dependency config

```yaml
dependency_policy:
  package_manager: bun
  required_lockfile: true
  frozen_install_in_ci: true
  allow_floating_latest: false
  duckdb_client_decision_required: true
```

## Secret leak response

补充：

- secret scan 命中时生成 `OpsIncident(category=secret_leak)`；
- 相关 artifact/export 标记 `quarantined`；
- 轮换 secret 后才能关闭 incident；
- redaction pattern 更新后必须重新跑 affected tests。
