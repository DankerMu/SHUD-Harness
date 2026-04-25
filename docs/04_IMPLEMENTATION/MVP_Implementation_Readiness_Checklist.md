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
