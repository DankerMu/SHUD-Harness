---
status: frozen
canonical_for: [alerting-thresholds]
---

# Alerting Thresholds Spec

**状态**：v0.8.2 新增规范  
**目标**：定义告警阈值、严重性、触发动作和 dedupe 规则。

---

## 1. 严重性定义

| Severity | 含义 | 默认动作 |
|---|---|---|
| `info` | 仅供观察，不影响流程 | dashboard only |
| `warning` | 可能影响用户体验或后续运行 | dashboard + optional notification |
| `error` | 当前功能或部分任务失败 | dashboard + notification to maintainer/PI if task-scoped |
| `critical` | 可能导致数据损坏、科研治理失效或服务不可用 | dashboard + immediate notification + may block new jobs |

---

## 2. 默认阈值表

| Rule ID | 指标/条件 | 阈值 | Severity | 动作 |
|---|---|---:|---|---|
| ALERT-DISK-001 | workspace free percent | `< 10%` | warning | dashboard + notify admin |
| ALERT-DISK-002 | workspace free percent | `< 5%` | critical | block new jobs + notify |
| ALERT-DISK-003 | workspace free bytes | `< 5GB` | critical | block new jobs + notify |
| ALERT-JOB-001 | running job no log update | `> 5min` | warning | mark stale_candidate |
| ALERT-JOB-002 | running job no log update | `> 20min` | error | stale job alert |
| ALERT-JOB-003 | job runtime exceeds expected_max | `> configured` | warning/error | dashboard |
| ALERT-COLLECT-001 | collect failures for same job | `>= 2` | error | notify engineer |
| ALERT-DUCKDB-001 | DuckDB open/query failure | first failure | error | dashboard + runbook |
| ALERT-DUCKDB-002 | DuckDB corruption suspected | detected | critical | stop warehouse writes |
| ALERT-API-001 | metadata API P95 | `> 300ms for 5min` | warning | dashboard |
| ALERT-API-002 | metadata API P95 | `> 1000ms for 5min` | error | dashboard + notify admin |
| ALERT-WS-001 | reconnect failure rate | `> 10% for 5min` | warning | dashboard |
| ALERT-WS-002 | heartbeat missed | `> 3 consecutive` | warning | client reconnect |
| ALERT-SMTP-001 | notification failure rate | `> 20% for 15min` | warning | dashboard |
| ALERT-SMTP-002 | provider auth failed | first failure | error | notify admin via fallback if available |
| ALERT-OOM-001 | process RSS above soft limit | `> 80%` | warning | dashboard |
| ALERT-OOM-002 | process killed/restarted by OOM | detected | critical | incident |
| ALERT-SEC-001 | secret pattern in generated artifact | detected | critical | quarantine artifact + incident |
| ALERT-REPORT-001 | report guard failure | `>= 1` | warning | retry once |
| ALERT-REPORT-002 | export generation failure | `>= 2` | error | runbook |
| ALERT-BATCH-001 | batch failed cells | 按 stop_condition 分支：`first_failure` → 首个 failed cell 即触发；`failure_rate_exceeds_threshold` → `failed/total > failure_rate_threshold`；`all_terminal` → 不告警（等 batch summary） | error | notify PI, await decision |
| ALERT-LLM-001 | LLM API error rate | `> 20% for 10min` | error | dashboard + runbook（LLM provider 故障） |
| ALERT-LLM-002 | LLM 单轮延迟 P95 | `> 60s for 15min` | warning | dashboard |
| ALERT-LLM-003 | quota/余额耗尽或 auth 失效 | first failure | critical | 全部活跃 task 标注 + notify admin（走邮件，WebSocket 可能无人在看） |
| ALERT-LLM-004 | 单 task LLM 成本 | `> 3 × advisory_usd` | warning | StatusBar 标黄 + dashboard（不中断，Cost_Inference_Budget 原则） |
| ALERT-LLM-005 | 全局日 LLM 成本 | `> configured daily cap` | error | 暂停接受新 LLM 任务 + notify admin（运行中不杀） |
| ALERT-AGENT-001 | agent no-progress block 触发 | per occurrence | warning | Feed + dashboard，附失败签名 |
| ALERT-AGENT-002 | 同一 task llm_output_error | `>= 3` | error | 提示 prompt/schema 可能漂移，runbook |

> ALERT-BATCH-001 注（对抗审查 A09-5）：原判据 `failed cells > stop_condition` 把整数与枚举比较、不可计算；
> stop_condition 枚举与 failure_rate_threshold 数值字段见 [Parameter_Set_And_Analysis_Run_Mapping §2](Parameter_Set_And_Analysis_Run_Mapping.md)。
>
> ALERT-LLM-004 注（对抗审查 A09-3）：与 Cost_Inference_Budget 的 2× 不是双写，是**有意两级**——
> 2× 时 CostMonitor 置 `exceeded`（仅 UI 着色，不产生 alert 记录）；3× 才生成 alert（降噪）。
> 两档均可配置，约束：alert 档 ≥ UI 档。
>
> ALERT-OOM-001 注（对抗审查 A09-6）：`soft limit` 分母按进程类型解析——job 进程：docker_job →
> 容器 memory limit；local_job/local_direct → `RunJob.resources.max_memory_mb`；harness 服务自身 →
> 配置项 `limits.service_rss_soft_mb`；SLURM（未实现）→ cgroup limit。解析不到上限 → 该进程该规则
> `not_applicable`（在 health deep 标注），禁止拿"物理内存的 80%"充当分母。

---

## 3. Dedupe 规则

Alert dedupe key：

```text
alert:<rule_id>:<scope_id>:<severity>
```

`scope_id` 优先级：

```text
run_id → job_id → task_id → analysis_plan_id → service
```

默认 suppression window：

| Severity | Suppression |
|---|---|
| info | 30 min |
| warning | 15 min |
| error | 10 min |
| critical | 5 min，但状态变化必须推送 |

---

## 4. Alert 与 Task 状态关系

Alert 默认不直接修改 TaskCard 状态。只有以下情况允许影响业务状态：

| Alert | 允许动作 |
|---|---|
| disk critical | block new jobs，不修改已有 RunRecord |
| secret leak | quarantine artifact，相关 task blocked until review |
| DuckDB corruption | stop warehouse writes，但保留 filesystem records |
| repeated collect failure | task 可进入 `blocked`，需要工程师处理 |
| batch stop condition reached | task 进入 `awaiting_pi`，等待 PI 决策 |

---

## 5. Notification escalation

Critical alert 可以触发 notification，但必须：

- 使用 NotificationRecord；
- 使用 dedupe_key；
- body redaction；
- 不包含完整日志、raw output、secret；
- 关联 runbook_ref 和 evidence_refs。

---

## 6. 验收标准

- [ ] 每条 alert rule 有 rule_id、severity、threshold、action。
- [ ] threshold 可配置，但默认值在配置缺失时可用。
- [ ] dedupe 生效，不重复轰炸 PI。
- [ ] disk critical 能阻止新 job 提交。
- [ ] secret leak alert 能 quarantine artifact。
- [ ] alert resolution 被记录。
