# PRD / Spec Merge Map

**目标**：标明本补充包每个部分应补充到哪个现有文档、哪个章节附近，以及合并动作。

---

## 1. 新增文档合并位置

| 新增文档 | 放置路径 | 应在 MASTER_INDEX 中加入的位置 | 目的 |
|---|---|---|---|
| `Requirements_Catalog.md` | `docs/00_INDEX/` | 00_INDEX / 索引与导航 | FR/NFR/US 统一需求目录 |
| `Requirements_Numbering_Conventions.md` | `docs/00_INDEX/` | 00_INDEX / 索引与导航 | 需求编号规则 |
| `Observability_Monitoring_Spec.md` | `docs/03_SPEC/` | 03_SPEC / 运行时 或 新增“监控与运维”小节 | 健康检查、指标、ops dashboard |
| `Alerting_Thresholds_Spec.md` | `docs/03_SPEC/` | 03_SPEC / 运行时 或 监控与运维 | 告警阈值和通知升级 |
| `Log_Aggregation_Spec.md` | `docs/03_SPEC/` | 03_SPEC / 运行时 或 数据与存储 | 结构化日志、聚合、保留 |
| `Performance_NFR_Spec.md` | `docs/03_SPEC/` | 03_SPEC / 运行时 或 NFR | REST/WS/报告/并发性能目标 |
| `Operations_Runbook.md` | `docs/04_IMPLEMENTATION/` | 04_IMPLEMENTATION / 实施 | 运维故障处理手册 |
| `Dependency_Versioning_Policy.md` | `docs/04_IMPLEMENTATION/` | 04_IMPLEMENTATION / 实施 | Bun/npm/TS/Zod/React/DuckDB 版本治理 |
| `Performance_Test_Plan.md` | `docs/04_IMPLEMENTATION/` | 04_IMPLEMENTATION / 测试 | 性能测试矩阵 |
| `Observability_Test_Plan.md` | `docs/04_IMPLEMENTATION/` | 04_IMPLEMENTATION / 测试 | 健康检查、日志、告警测试 |

---

## 2. 现有文档补丁地图

| 补丁 | 目标文档 | 插入位置 | 动作 |
|---|---|---|---|
| `MASTER_INDEX__additions.md` | `docs/00_INDEX/MASTER_INDEX.md` | 00_INDEX、03_SPEC、04_IMPLEMENTATION 文件表 | 增加新增文档链接 |
| `CANONICAL_CONTRACTS__additions.md` | `docs/00_INDEX/CANONICAL_CONTRACTS.md` | support schema、API registry、NFR source 后 | 增加需求/NFR/observability/dependency canonical source |
| `Support_Schema_Contracts__additions.md` | `docs/03_SPEC/Support_Schema_Contracts.md` | support schema 列表后 | 增加 HealthStatus、MetricSample、AlertRule、OpsIncident、DependencyLock、Requirement |
| `WebSocket_Protocol__additions.md` | `docs/03_SPEC/WebSocket_Protocol.md` | event registry / system events 后 | 增加 health.status、alert.raised、ops.metric.updated |
| `Config_Secrets_And_Environment_Spec__additions.md` | `docs/03_SPEC/Config_Secrets_And_Environment_Spec.md` | 推荐环境变量、redaction、验收标准后 | 增加 ops、dependency、secret leak env/config |
| `Error_Handling_Spec__additions.md` | `docs/03_SPEC/Error_Handling_Spec.md` | 错误分类、critical notification 后 | 增加 ops incident 分类和 runbook 引用 |
| `Cost_Inference_Budget__additions.md` | `docs/03_SPEC/Cost_Inference_Budget.md` | cost_record / WebSocket 成本事件后 | 明确成本监控是 observability 子集，不承担系统健康告警 |
| `Schemas_APIs_CLIs__additions.md` | `docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md` | API endpoint 列表后 | 增加 `/api/health/*`、`/api/ops/*`、`/api/requirements` |
| `Deployment_Architecture__additions.md` | `docs/04_IMPLEMENTATION/Deployment_Architecture.md` | 服务组成、单机部署、验收标准后 | 增加 health/ops dashboard/log aggregation |
| `Testing_Strategy__additions.md` | `docs/04_IMPLEMENTATION/Testing_Strategy.md` | 阶段测试矩阵、验收标准后 | 增加 observability/performance/ops/dependency/requirements 测试 |
| `CICD_Release__additions.md` | `docs/04_IMPLEMENTATION/CICD_Release.md` | PR CI、Nightly CI、Release CI 后 | 增加 perf budget、dependency audit、requirements coverage |
| `DOD_and_Risks__additions.md` | `docs/04_IMPLEMENTATION/DOD_and_Risks.md` | DoD / risk table 后 | 增加 PRD/NFR/ops readiness gate |
| `Traceability_Matrix__additions.md` | `docs/04_IMPLEMENTATION/Traceability_Matrix.md` | matrix 表头或附录后 | 增加 FR/NFR/US 编号字段 |
| `Phased_Plan__additions.md` | `docs/04_IMPLEMENTATION/Phased_Plan.md` | W0-W3 和 W7/W8 后 | 加入 observability、dependency lock、runbook drill |

---

## 3. 合并校验

合并完成后应满足：

- `MASTER_INDEX.md` 能链接到所有新增文档；
- `CANONICAL_CONTRACTS.md` 包含 Requirements、Performance NFR、Observability、Dependency 事实源；
- `Schemas_APIs_CLIs.md` 出现健康检查和 ops API；
- `Testing_Strategy.md` 出现 observability/performance/dependency/requirements 测试；
- `Traceability_Matrix.md` 能引用 `FR-*`、`NFR-*`、`US-*`；
- CI 至少能检查 requirements catalog 的编号唯一性。
