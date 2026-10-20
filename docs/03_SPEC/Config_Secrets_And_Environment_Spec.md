---
status: frozen
---

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
HARNESS_LOCAL_TOKEN
HARNESS_DEFAULT_NOTIFY_EMAIL
HARNESS_PUBLIC_BASE_URL
OPENAI_API_KEY
ANTHROPIC_API_KEY
DMXAPI_KEY
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASSWORD
SENDGRID_API_KEY
SLURM_SSH_HOST
SLURM_SSH_USER
```

> `DMXAPI_KEY` 为运行时模型 DeepSeek Flash 经 DMXAPI 中转的 key（`api_key_ref: env:DMXAPI_KEY`，purpose=llm；
> `llm-deepseek` 配置 `apiKeyEnv: DMXAPI_KEY`、`baseURL: https://www.dmxapi.cn`、请求别名 `deepseek-flash-guan`）——
> ADR-0004 K3（取代 ADR-0002 D9 的 `GLM_API_KEY`）。

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
  r_packages_lock:
    path: renv.lock
    sha256: "sha256:..."
  sundials_version: ...
harness:
  version: ...
  cli_version: unknown
  prompt_pack: promptpack-unset
  skills_version: skills-unset
```

`renv.lock` 缺失时 `runtime.r_packages_lock` 为 `null`；StackLock 不记录 secret value。

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
