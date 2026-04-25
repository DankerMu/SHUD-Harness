# Readiness Gate Closeout Checklist

**状态：** v0.8.1 开发前签核补充  
**目标：** 将 `MVP_Implementation_Readiness_Checklist.md` 中的开工前 P0/P1 项转化为可验证、可签核的 gate。  
**适用时点：** 进入 Week 1 deterministic skeleton 之前。

---

## 1. Readiness 结论定义

SHUD-Harness 的 readiness 不等于“所有功能已经设计完”。本项目的开发前 readiness 定义为：

```text
可以开始 Week 1 deterministic skeleton，且 Week 1 实现过程中不需要重新做架构决策。
```

因此，以下内容必须已经固定：

- canonical schema source；
- core/support schema 边界；
- root repo、runtime workspace、task worktree 路径关系；
- canonical/convenience API 关系；
- WebSocket event envelope；
- Artifact registry 和 evidence usability；
- idempotency、lock、snapshot、runner adapter 的最小契约；
- Week 1 不接 LLM、不跑真实长 SHUD batch、不做 SLURM 的边界。

---

## 2. P0 Gate

| Gate | 检查方式 | 通过标准 | 阻塞级别 |
|---|---|---|---|
| `.gitmodules` 可解析 | `git config --file .gitmodules --get-regexp` | 4 个 submodule 都返回 path/url | block |
| submodule checkout | `git submodule update --init --recursive` | SHUD/rSHUD/AutoSHUD/zero 目录存在且有 commit | block |
| canonical index | 读 `CANONICAL_CONTRACTS.md` | 每类事实都有唯一来源 | block |
| core schema | 读 `Minimal_Schemas.md` | TaskCard/RunJob/RunRecord/EvidenceReport/AnalysisPlan 状态无冲突 | block |
| support schema | 读 `Support_Schema_Contracts.md` | Artifact/ErrorRecord/PiGate/Notification/ReportExport/Audit/Lock/RunnerResult 均有定义 | block |
| API registry | 读 `Schemas_APIs_CLIs.md` | canonical/convenience API 明确分层 | block |
| error/idempotency | 读 `API_Error_And_Idempotency_Contracts.md` | 非 2xx envelope、Idempotency-Key、retry policy 明确 | block |
| artifact registry | 读 `Artifact_Registry_Spec.md` | artifact type、retention、redaction、evidence_usable 明确 | block |
| lock/recovery | 读 `Idempotency_Concurrency_Locking_Spec.md` 和 `Workspace_Snapshot_And_Recovery_Spec.md` | collect/export/notification/PI decision 等重复执行不产生冲突对象 | block |

---

## 3. P1 Gate

P1 不阻塞 Week 1 开始，但必须在 Week 1/2 内转成实现或脚本。

| Gate | Week | 通过标准 |
|---|---:|---|
| schema generation script plan | W1 | `schema:generate` / `schema:check` 命令占位存在 |
| docs link check | W1 | `docs:links` 能检查 `MASTER_INDEX.md` 所有路径 |
| runner adapter skeleton | W3 前 | `RunnerAdapter` interface 与 local_job 实现框架存在 |
| snapshot service skeleton | W1 | task snapshot 可写可读 |
| audit service skeleton | W7 前 | PI decision 和 high-risk action 可写 AuditEvent |
| config/secrets redaction | W3 前 | env secret 不进入 artifact/log/report |

---

## 4. 签核记录模板

建议在进入 Week 1 前生成：

```yaml
readiness_gate:
  version: v0.8.1
  checked_at: 2026-04-25T00:00:00Z
  checked_by: engineer
  decision: pass | pass_with_notes | block
  p0:
    gitmodules_parse: pass
    submodules_checkout: pass
    canonical_index: pass
    core_schema: pass
    support_schema: pass
    api_registry: pass
    error_idempotency: pass
    artifact_registry: pass
    lock_recovery: pass
  notes:
    - "Week 1 starts deterministic skeleton only; LLM AgentLoop deferred."
```

建议保存路径：

```text
workspace/readiness/readiness_gate_v0_8_1.yaml
```

---

## 5. 开发前不需要补的内容

以下不应阻塞 Week 1：

- 完整 SLURM；
- 完整多用户并发；
- PDF 导出；
- 完整通知偏好系统；
- 真实 LLM AgentLoop；
- 完整 SHUD sensitivity batch；
- optimizer / autonomous loop。

---

## 6. Readiness 最终判断规则

```text
若 P0 全 pass：允许进入 Week 1 deterministic skeleton。
若 P0 中只有文档格式问题：允许 pass_with_notes，但必须在 W1 CI 中修复。
若 P0 中 schema/API/path/lock 仍冲突：block，不进入编码。
```
