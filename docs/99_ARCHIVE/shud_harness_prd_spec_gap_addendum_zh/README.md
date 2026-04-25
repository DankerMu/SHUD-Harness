# SHUD-Harness PRD/Spec Gap Addendum

**版本**：v0.8.2-prd-spec-addendum  
**日期**：2026-04-25  
**正文语言**：中文  
**文件名/路径**：英文  
**目标**：补齐当前 v0.8.1 规格中从 PRD 与 Spec 角度仍缺失的 5 类内容：

1. 监控与可观测性（Observability & Monitoring）
2. 性能非功能需求（Performance NFR）
3. 运维手册（Operations Runbook）
4. 依赖版本与更新策略（Dependency Versioning）
5. 正式需求编号体系（FR/NFR/US Requirements Catalog）

## 使用方式

建议按以下顺序合并：

1. 先新增 `docs/00_INDEX/Requirements_Catalog.md` 和 `docs/00_INDEX/Requirements_Numbering_Conventions.md`，把需求编号体系建立起来。
2. 新增 `docs/03_SPEC/Observability_Monitoring_Spec.md`、`Performance_NFR_Spec.md`、`Alerting_Thresholds_Spec.md`、`Log_Aggregation_Spec.md`。
3. 新增 `docs/04_IMPLEMENTATION/Operations_Runbook.md`、`Dependency_Versioning_Policy.md`、`Performance_Test_Plan.md`、`Observability_Test_Plan.md`。
4. 按 `patches/` 中的文件逐项合并到现有文档。
5. 更新 `MASTER_INDEX.md` 与 `CANONICAL_CONTRACTS.md`。
6. 在实现阶段将新增 support schema 转成 Zod，并纳入 schema drift CI。

## 不改变的既有设计原则

本补充包不改变以下 v0.8/v0.8.1 决策：

- Web-first 交互；
- PI-led 科研治理；
- RunRecord / StackLock / DataProvenance 可复盘链；
- Park/Resume 长任务策略；
- EvidenceReport 作为 PI 决策核心产物；
- Budget 软监控，不自动中断任务；
- Week 1 仍先做 deterministic skeleton，不直接接完整 Zero/LLM/真实长任务。

## 重点新增内容

| 缺口 | 新增主文档 | 主要补丁 |
|---|---|---|
| 监控与可观测性 | `docs/03_SPEC/Observability_Monitoring_Spec.md` | Deployment、Schemas_APIs_CLIs、Support_Schema、Testing、CI |
| 性能 NFR | `docs/03_SPEC/Performance_NFR_Spec.md` | Testing、CI、DOD、Traceability |
| 运维手册 | `docs/04_IMPLEMENTATION/Operations_Runbook.md` | Error、Config、Deployment、Testing |
| 依赖版本 | `docs/04_IMPLEMENTATION/Dependency_Versioning_Policy.md` | Config、CI、DOD |
| 需求形式化 | `docs/00_INDEX/Requirements_Catalog.md` | MASTER_INDEX、Traceability、CANONICAL_CONTRACTS |
