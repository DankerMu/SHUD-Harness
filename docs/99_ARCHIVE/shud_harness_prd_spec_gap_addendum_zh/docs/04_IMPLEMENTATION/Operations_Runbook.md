# Operations Runbook

**状态**：v0.8.2 HIGH 新增实施手册  
**适用范围**：local PI workstation、lab server、Docker、HPC bridge。  
**目标**：为常见运维事故提供诊断、恢复、升级和事后记录步骤。

---

## 0. 总则

1. **先保留证据，后恢复服务**：不要删除日志、RunRecord、artifact、audit。
2. **不要伪造成功状态**：失败 RunJob 也应保留 FailureRecord 或最小 RunRecord。
3. **不要让运维恢复改变科学结论**：修复系统状态不等于接受报告结论。
4. **任何 secret 泄露按最高优先级处理**。
5. **所有 incident 必须写入 OpsIncident**。

---

## 1. 磁盘满 / workspace 空间不足

### 症状

- `/api/health/ready` 返回 `not_ready` 或 `degraded`；
- artifact 写入失败；
- RunJob collect 失败；
- dashboard 出现 `ALERT-DISK-002`；
- Docker volume 或 workspace 分区满。

### 诊断

```bash
df -h
du -sh workspace/*
du -sh workspace/artifacts/*
du -sh workspace/runs/*
```

检查：

```text
large SHUD outputs
old report exports
old job stdout/stderr
temporary worktrees
DuckDB/Parquet warehouse
```

### 恢复步骤

1. 停止提交新 job：设置 maintenance flag 或由 disk critical alert 自动 block new jobs。
2. 不删除 raw data、RunRecord metadata、EvidenceReport。
3. 根据 retention_class 清理可清理 artifact：
   - `temporary`
   - `derived_cache`
   - old standalone HTML exports
   - old log tail cache
4. 如果需要移动大数据，先更新 artifact manifest 或 workspace config。
5. 重新运行 ready check。
6. 写 OpsIncident resolved note。

### 不能做

- 不要直接删除 `workspace/tasks/*.yaml`；
- 不要删除 accepted report；
- 不要删除 raw data；
- 不要手工把 failed run 改成 succeeded。

---

## 2. Job 卡死 / Stale RunJob

### 症状

- RunJob 长时间 `running`；
- stdout/stderr 无更新；
- runner process 仍存在但无 CPU/IO；
- WebSocket job.log 停止；
- `ALERT-JOB-001/002` 触发。

### 诊断

```bash
ps -ef | grep shud
tail -n 200 workspace/artifacts/logs/JOB-*.stderr
tail -n 200 workspace/artifacts/logs/JOB-*.stdout
```

检查：

```text
last_log_at
started_at
expected_max_runtime
runner backend
process pid
workspace lock
```

### 恢复步骤

1. 标记 job 为 `stale_candidate`，不要立即 kill。
2. 如果是 HPC/SLURM，先查询外部 scheduler 状态。
3. 如果超过 hard runtime 且无日志，按 runner adapter 执行 cancel。
4. collect 已有日志，生成 FailureRecord。
5. TaskCard 可进入 `awaiting_pi` 或 `blocked`，由 PI/工程师决定重试。
6. 如果重试，必须创建新 RunJob，不覆盖旧 job。

---

## 3. DuckDB 损坏或 warehouse 无法打开

### 症状

- ready check 中 `duckdb_open` fail；
- ops dashboard 无法加载；
- metrics query 报错；
- RunRecord filesystem 仍存在。

### 诊断

```bash
ls -lh workspace/warehouse/
```

检查错误对象：

```text
category = workspace_error 或 duckdb_error
severity = error/critical
```

### 恢复步骤

1. 停止 warehouse 写入，但不停止 RunJob 主流程。
2. 备份损坏文件：
   ```bash
   cp workspace/warehouse/harness.duckdb workspace/warehouse/harness.duckdb.corrupt.$(date +%s)
   ```
3. 从 RunRecord、ArtifactManifest、NDJSON logs 重建 warehouse：
   ```bash
   bun run warehouse:rebuild
   ```
4. 重新运行 ready/deep health。
5. 如果重建失败，保持 degraded 模式，前端从 filesystem fallback 读取。

### 不能做

- 不要删除 RunRecord；
- 不要把 DuckDB 中缺失数据视为科学结果缺失；
- 不要让 report 使用损坏 warehouse 的未验证数据。

---

## 4. SMTP / SendGrid 故障

### 症状

- NotificationRecord `failed`；
- `notification.provider_auth_failed`；
- PI 没有收到邮件；
- SMTP timeout。

### 诊断

检查配置：

```text
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASSWORD 或 SENDGRID_API_KEY
HARNESS_PUBLIC_BASE_URL
HARNESS_DEFAULT_NOTIFY_EMAIL
```

检查：

```text
notification dedupe_key
recipient resolution
provider error category
redaction
```

### 恢复步骤

1. 确认主流程未受影响：RunRecord、EvidenceReport、Analysis summary 状态不回滚。
2. 修复 SMTP/SendGrid secret。
3. 重新发送时使用相同 NotificationRecord 或明确 retry record，不创建重复 PI 噪音。
4. 如果无法恢复，dashboard 显示 notification degraded。
5. 必要时人工通知 PI，并在 OpsIncident 记录。

---

## 5. OOM / 内存压力

### 症状

- server 被系统 kill；
- Docker OOMKilled；
- 前端打开大日志卡死；
- report export 内联过多大图/JSON；
- DuckDB query 占用过高。

### 诊断

```bash
dmesg | grep -i oom
docker inspect <container> | grep OOMKilled
```

检查：

```text
large log in React state
large artifact inline export
DuckDB query
too many WS buffered events
```

### 降级策略

1. 禁用大型 report inline assets，只输出 artifact links。
2. RuntimeTerminal 只显示 tail。
3. 大型 series API 强制分页/降采样。
4. 降低 concurrent runner jobs。
5. 清理 WebSocket event buffer 到配置上限。
6. 如果服务重启，运行 snapshot/recovery。

---

## 6. 密钥泄露应急

### 症状

- secret scan 命中；
- artifact/report/log/email 中出现 token；
- Git commit 中出现 API key；
- alert `ALERT-SEC-001` 触发。

### 立即动作

1. **停止相关服务写入**，防止继续扩散。
2. **隔离 artifact/log/export**：
   ```text
   status = quarantined
   evidence_usable = false
   ```
3. **撤销并轮换泄露 secret**：
   - OpenAI/Anthropic key；
   - SMTP/SendGrid key；
   - SSH/HPC credentials；
   - auth secret。
4. 检查 Git 历史，如果已推送，按 secret provider 指南轮换，不只依赖删除 commit。
5. 记录 OpsIncident，severity=`critical`。
6. 运行 redaction tests 和 secret scan。
7. 重新生成受影响 report/export/log summary。

### 后续

- 对受影响 RunRecord/Report 增加 limitation；
- 如果 report 已分享给合作者，应通知对方废弃旧 export；
- 更新 redaction pattern。

---

## 7. WebSocket 故障

### 症状

- UI 不再收到事件；
- reconnect 失败；
- job 仍在运行但 ActivityFeed 不更新。

### 诊断

检查：

```text
ws_connections_current
ws_heartbeat_missed_total
event_store append/read
since_seq gap
snapshot_required_total
```

### 恢复步骤

1. 前端触发 reconnect；
2. 如果 since_seq 过期，使用 snapshot fallback；
3. 如果 event store 损坏，dashboard 标记 degraded；
4. 对已完成 job 手动 collect；
5. 不依赖 WS 判断 job 最终状态，最终以 RunJob/RunRecord 文件为准。

---

## 8. Artifact manifest 损坏

### 症状

- report 打不开图；
- export missing artifact；
- artifact registry integrity fail。

### 恢复步骤

1. 不删除原始 artifact 文件；
2. 从 workspace artifact files 重新扫描；
3. 对无法确认的 artifact 标记 `evidence_usable=false`；
4. 重新生成 manifest；
5. Reviewer 检查 report evidence refs。

---

## 9. 依赖或 submodule 不一致

### 症状

- StackLock 与当前 submodule commit 不一致；
- bun install 后 lockfile drift；
- Zod schema generation 输出变化；
- rSHUD reader behavior 变化。

### 恢复步骤

1. 运行 dependency/status 检查；
2. 如果是未批准更新，回退 lockfile/submodule；
3. 如果是批准更新，创建 ChangeRequest；
4. 重新跑 schema drift、dummy runner、必要 fixture；
5. Release manifest 记录 dependency summary。

---

## 10. 事故记录模板

```yaml
incident_id: INC-001
category: disk_full
severity: critical
status: resolved
started_at: ...
detected_by: alert|user|ci
affected_tasks:
  - TASK-001
affected_jobs:
  - JOB-001
evidence_refs:
  - workspace/logs/service/2026-04-25.ndjson
  - artifacts/logs/JOB-001.stderr
actions_taken:
  - "blocked new jobs"
  - "cleaned temporary artifacts"
resolution:
  - "free space restored to 32GB"
postmortem_required: true
```

---

## 11. 验收标准

- [ ] 每个 HIGH 运维场景有症状、诊断、恢复、不能做、事后记录。
- [ ] Runbook 引用 AlertRule 和 OpsIncident。
- [ ] 密钥泄露应急包含 revoke/rotate/quarantine。
- [ ] DuckDB 损坏可从 filesystem records 重建。
- [ ] Job 卡死恢复不覆盖旧 RunJob。
- [ ] Disk full 恢复遵守 retention policy。
