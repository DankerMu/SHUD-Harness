# Config、Secrets 与 Environment 规范

**状态：** v0.8.1 P1 补充规范  
**适用范围：** LLM API、SMTP/SendGrid、workspace path、SHUD runtime、R env、HPC credentials、Docker runner。  
**目标：** 统一配置来源、secret 引用、redaction、StackLock 记录和 CI 检查。

## 1. 配置层级

优先级从高到低：

```text
process env
.env.local
workspace/config.local.yaml
workspace/config.yaml
built-in defaults
```

`config.local.yaml` 和 `.env.local` 不进入 Git。

## 2. ConfigRecord

```ts
interface ConfigRecord {
  key: string;
  value_type: "string" | "number" | "boolean" | "path" | "secret_ref";
  source: "env" | "env_file" | "workspace_config" | "default";
  value_redacted: string;
  effective: boolean;
  loaded_at: string;
}
```

## 3. SecretRef

```ts
interface SecretRef {
  ref: string; // env:OPENAI_API_KEY, keyring:..., workspace_secret:...
  provider: "env" | "keyring" | "workspace_secret" | "vault";
  purpose: "llm" | "smtp" | "hpc" | "database" | "auth";
}
```

对象、report、artifact、audit 中只能保存 `SecretRef.ref`，不得保存 secret value。

## 4. 推荐环境变量

```text
HARNESS_WORKSPACE_DIR
HARNESS_AUTH_MODE
HARNESS_DEFAULT_NOTIFY_EMAIL
HARNESS_PUBLIC_BASE_URL
OPENAI_API_KEY
ANTHROPIC_API_KEY
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASSWORD
SENDGRID_API_KEY
SLURM_SSH_HOST
SLURM_SSH_USER
```

## 5. Redaction policy

必须脱敏：

- API keys；
- bearer tokens；
- passwords；
- private SSH key path/content；
- SMTP password；
- signed URLs；
- configured sensitive absolute paths。

## 6. StackLock 与环境

StackLock 记录版本，不记录 secret：

```yaml
runtime:
  os: ...
  r_version: ...
  r_packages_lock: renv.lock
  sundials_version: ...
harness:
  version: ...
  config_profile: local_dev
  secrets_policy_version: 0.8.1
```

## 7. Observability / Operations 环境变量

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

## 8. Dependency config

```yaml
dependency_policy:
  package_manager: bun
  required_lockfile: true
  frozen_install_in_ci: true
  allow_floating_latest: false
  duckdb_client_decision_required: true
```

## 9. Secret leak response

- secret scan 命中时生成 `OpsIncident(category=secret_leak)`；
- 相关 artifact/export 标记 `quarantined`；
- 轮换 secret 后才能关闭 incident；
- redaction pattern 更新后必须重新跑 affected tests。

## 10. 验收标准

- [ ] secrets 不进入 RunRecord、EvidenceReport、ArtifactManifest、NotificationRecord body。
- [ ] toolcall env 写入前 redacted。
- [ ] CI secret scan 覆盖 docs、artifacts sample、schema generated docs。
- [ ] SMTP/LLM/HPC 配置缺失时错误信息不泄露 secret。
