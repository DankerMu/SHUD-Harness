# MVP Implementation Readiness Checklist

**状态：** v0.8.1 开工前检查  
**目标：** 在进入 Week 1 deterministic skeleton 前，确认规格已足够稳定。

## P0 — 必须完成

- [ ] `.gitmodules` 可被 `git config --file .gitmodules --get-regexp` 正确解析。
- [ ] `MASTER_INDEX.md` 中核心文件路径正确。
- [ ] `SPEC_v0.8_Final.md` 与 `Minimal_Schemas.md` 的 TaskCard、EvidenceReport、RunJob、AnalysisPlan 状态一致。
- [ ] `Support_Schema_Contracts.md` 入库。
- [ ] `Artifact_Registry_Spec.md` 入库。
- [ ] `Idempotency_Concurrency_Locking_Spec.md` 入库。
- [ ] `Schemas_APIs_CLIs.md` 明确 canonical/convenience API 关系。
- [ ] `API_Error_And_Idempotency_Contracts.md` 入库。

## P1 — Week 1/2 同步完成

- [ ] Workspace snapshot/recovery 规则入库。
- [ ] User/Session/Audit schema 入库。
- [ ] Config/secrets/redaction 规则入库。
- [ ] Runner adapter contract 入库。
- [ ] ParameterSet ↔ RunJob ↔ RunRecord mapping 入库。
- [ ] Schema generation/drift check 脚本计划明确。

## Week 1 skeleton 验收

- [ ] Bun workspace 初始化。
- [ ] `packages/core` 有 Zod schema。
- [ ] Hono API 能创建 TaskCard。
- [ ] React 四栏壳能读取 task snapshot。
- [ ] dummy job 可 submit、stream log、collect。
- [ ] RunRecord / Artifact / ErrorRecord 可落盘。
- [ ] WebSocket event 有 seq 和 event_id。
- [ ] CI 跑 schema + link + basic unit tests。

## Week 1 不做

- [ ] 不接真实 LLM AgentLoop。
- [ ] 不跑真实长 SHUD batch。
- [ ] 不实现完整 SLURM。
- [ ] 不实现复杂通知偏好系统。
- [ ] 不实现 PDF 生成。

## Readiness 结论定义

SHUD-Harness 的 readiness 不等于"所有功能已经设计完"。本项目的开发前 readiness 定义为：

```text
可以开始 Week 1 deterministic skeleton，且 Week 1 实现过程中不需要重新做架构决策。
```

因此，以下内容必须已经固定：

- canonical schema source
- core/support schema 边界
- root repo、runtime workspace、task worktree 路径关系
- canonical/convenience API 关系
- WebSocket event envelope
- Artifact registry 和 evidence usability
- idempotency、lock、snapshot、runner adapter 的最小契约
- Week 1 不接 LLM、不跑真实长 SHUD batch、不做 SLURM 的边界

## P0 Gate 验证方法

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

## 签核记录模板

建议在进入 Week 1 前生成并保存至 `workspace/readiness/readiness_gate_v0_8_1.yaml`：

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

## Readiness 最终判断规则

```text
若 P0 全 pass：允许进入 Week 1 deterministic skeleton。
若 P0 中只有文档格式问题：允许 pass_with_notes，但必须在 W1 CI 中修复。
若 P0 中 schema/API/path/lock 仍冲突：block，不进入编码。
```

以下不应阻塞 Week 1：完整 SLURM、完整多用户并发、PDF 导出、完整通知偏好系统、真实 LLM AgentLoop、完整 SHUD sensitivity batch、optimizer / autonomous loop。
