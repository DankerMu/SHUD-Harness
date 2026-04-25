# SHUD-Harness v0.8.1 规格缺口审查

**状态：** 规格审查补充  
**范围：** 当前 `main` 分支文档体系、submodule 接入、v0.8.1 operational UX、UI/UX、API、测试与 CI/CD。  
**结论：** 当前设计已经足够进入 deterministic skeleton 实现，但仍需要补齐若干“机器可检查契约”，否则工程师会在 schema、artifact、锁、恢复、support object、API error、runner adapter 上做重复设计。

## 1. 当前设计成熟度判断

| 维度 | 判断 | 说明 |
|---|---:|---|
| 产品定位 | 高 | PI-led、Web-first、Report-first、RunRecord-first 已稳定。 |
| 科研治理 | 高 | PI gate、禁止语言、calibration 边界、MemoryNote 约束已清楚。 |
| 交互体验 | 高 | 四栏工作台、Operational UX、UI/UX、通知、导出、批进度、批注已覆盖。 |
| 可编码性 | 中高 | 核心对象、API、WebSocket、测试已有，但 support schema / artifact / lock / recovery 仍需统一。 |
| 机器契约完整性 | 中 | Markdown 中已有大量对象片段，但还缺少统一可生成 schema 的 support contract。 |

## 2. 已完成且不建议再推翻的部分

1. **8 个核心对象不扩张**：TaskCard、StackLock、DataProvenance、RunJob、RunRecord、AnalysisPlan、EvidenceReport、ChangeRequest 仍应保持为核心。
2. **Support object 不升级为核心对象**：NotificationRecord、ReportExport、PiGateDecision、Artifact、ErrorRecord、AuditEvent 等应作为 support schema。
3. **WebSocket 是实时主通道，但不是证据存储**：RunRecord 和 artifact 仍是 evidence source。
4. **Batch progress 从 AnalysisPlan + RunJob + RunRecord 派生**：不引入 workflow engine。
5. **PI comment 是决策记录，不是科学事实**：默认 `generalization_allowed=false`。

## 3. 剩余缺口总览

| 编号 | 缺口 | 影响 | 优先级 | 建议补充 |
|---|---|---|---:|---|
| G1 | `SPEC_v0.8_Final.md` 仍含旧状态和旧字段 | 核心文件与 canonical schema 冲突 | P0 | `SPEC_v0.8_Final__canonical_sync.md` |
| G2 | support schema 分散在多个文档 | Zod 实现会漂移 | P0 | `Support_Schema_Contracts.md` |
| G3 | Artifact 只是路径，没有统一对象、类型、manifest、生命周期 | 图表、报告导出、证据链难实现 | P0 | `Artifact_Registry_Spec.md` |
| G4 | 幂等、锁、并发、dedupe 仅局部提到 | collect/report/export/notification 可能重复执行 | P0 | `Idempotency_Concurrency_Locking_Spec.md` |
| G5 | WebSocket reconnect 有概念，但 snapshot/recovery schema 不完整 | 页面刷新、服务重启、parked recovery 易漂移 | P1 | `Workspace_Snapshot_And_Recovery_Spec.md` |
| G6 | User/Session/Audit 只有权限原则，缺 schema | small_team 和 PI gate 审计实现不稳定 | P1 | `User_Session_And_Audit_Schema.md` |
| G7 | Config/secrets/env var 没有统一命名和 redaction policy | SMTP/LLM/HPC secrets 容易泄露到 artifact | P1 | `Config_Secrets_And_Environment_Spec.md` |
| G8 | Runner backend 有枚举，但 local/docker/slurm adapter I/O 未统一 | job watcher 与 collect 难通用 | P1 | `Runner_Adapter_Contracts.md` |
| G9 | AnalysisPlan parameter_sets 与 RunJob/RunRecord 映射不在 canonical schema 中 | BatchProgressGrid 与 heatmap 汇总实现漂移 | P1 | `Parameter_Set_And_Analysis_Run_Mapping.md` |
| G10 | API error response 与 idempotency header 缺少 contract | 前端错误处理和 retry 不稳定 | P1 | `API_Error_And_Idempotency_Contracts.md` |
| G11 | Schema generation/drift check 只有原则 | Markdown 与 Zod 很快分叉 | P1 | `Schema_Generation_And_Drift_Control.md` |
| G12 | Data package / retention / export boundary 不够细 | 分享报告、清理数据、保留失败 run 时容易误删证据 | P2 | `Data_Package_And_Retention_Spec.md` |

## 4. 需要立即核查的文件问题

### 4.1 `.gitmodules` 格式

当前 raw 视图仍可能显示为单行。建议在本地执行：

```bash
git config --file .gitmodules --get-regexp '^submodule\..*\.(path|url)$'
git submodule sync --recursive
git submodule update --init --recursive
```

若上述命令失败，应将 `.gitmodules` 改为标准多行 git-config 格式。

### 4.2 `MASTER_INDEX.md` 路径与清单

`MASTER_INDEX.md` 应确保：

- 从 `docs/00_INDEX/MASTER_INDEX.md` 到根目录 `CLAUDE.md` 的路径为 `../../CLAUDE.md`。
- `SPEC_v0.8_Final.md` 应写为 `../SPEC_v0.8_Final.md`。
- `SPEC_v0.7_Final.md` 应明确标注 superseded 或 archived。
- 新增的 support schema、artifact registry、idempotency、snapshot、config、runner、schema drift 文档应加入清单。

## 5. 建议进入实现前的最低标准

进入 Week 1 代码前，建议至少完成：

1. `SPEC_v0.8_Final.md` 与 `Minimal_Schemas.md` 同步。
2. `Support_Schema_Contracts.md` 入库。
3. `Artifact_Registry_Spec.md` 入库。
4. `Idempotency_Concurrency_Locking_Spec.md` 入库。
5. API error/idempotency contract 入库。
6. CI 有 link check、schema drift check、submodule check。
7. README 或 MASTER_INDEX 标明 canonical source 顺序。
