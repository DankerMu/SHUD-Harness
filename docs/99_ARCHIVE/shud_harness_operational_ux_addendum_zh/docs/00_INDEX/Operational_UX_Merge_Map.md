# Operational UX 补充合并地图

**状态：** v0.8.1 设计补充合并说明  
**适用范围：** 通知、报告导出、批运行进度视图、PI 审批批注  
**目标：** 明确每个补充点应新增哪些文档、补充到哪些现有文档的哪些章节。

## 1. 新增文档

建议新增以下文档到仓库：

| 新增文档 | 位置 | 作用 |
|---|---|---|
| `Operational_UX_Addendum.md` | `docs/03_SPEC/` | 四个 operational UX 补充的总览和统一边界。 |
| `Notification_Design.md` | `docs/03_SPEC/` | out-of-band notification 触发、收件人解析、去重、审计、失败策略。 |
| `Report_Export_Spec.md` | `docs/03_SPEC/` | EvidenceReport standalone HTML / Markdown export。 |
| `Batch_Progress_View_Spec.md` | `docs/03_SPEC/` | batch progress grid、progress payload、cell detail panel。 |
| `PI_Decision_Comments_Spec.md` | `docs/03_SPEC/` | PI gate decision comment、必填规则、MemoryNote、审计。 |
| `Operational_UX_API_Contracts.md` | `docs/04_IMPLEMENTATION/` | REST/WebSocket/schema implementation contracts。 |
| `Operational_UX_Testing_Addendum.md` | `docs/04_IMPLEMENTATION/` | 测试矩阵和验收标准。 |

## 2. 现有文档合并表

| 补充点 | 目标文档 | 目标章节/插入位置 | 合并动作 |
|---|---|---|---|
| operational UX 总览 | `docs/00_INDEX/MASTER_INDEX.md` | `03_SPEC/` 文档清单、`04_IMPLEMENTATION/` 文档清单 | 增加新增文档条目。 |
| 支撑 schema | `docs/03_SPEC/Minimal_Schemas.md` | 9 个对象之后；或新增“Support Schemas”章节 | 增加 `NotificationRecord`、`ReportExport`、`AnalysisProgressPayload`、`PiGateDecision`、`MemoryNote(type=pi_decision)`。 |
| 通知触发 | `docs/03_SPEC/Park_Resume_Design.md` | `Watch Job → Collect RunRecord → Resume Coordinator → Report` 流程之后 | 增加 collect/report/analysis 完成后的通知触发，不按 batch 单 job 逐条打扰 PI。 |
| 报告导出 | `docs/03_SPEC/Report_Generation_Spec.md` | `## 7. Artifact 引用` 之后，`## 9. 报告状态` 之前 | 增加 standalone HTML export、draft watermark、export manifest。 |
| 前端组件 | `docs/03_SPEC/Frontend_State_Design.md` | 四栏 layout / ResultsPanel / Report panel 相关章节 | 增加 `BatchProgressGrid`、`ReportExportButton`、`PIDecisionPanel`。 |
| WS 事件 | `docs/03_SPEC/WebSocket_Protocol.md` | `## 3. 主要消息类型` 和 `## 6. PI gate 消息` | 增加 `analysis.progress.updated`、`report.export_ready`、`pi_gate.decision_recorded`、`notification.status`。 |
| 权限和通知 | `docs/03_SPEC/Auth_Permission_Design.md` | `## 4. PI gate`、`## 6. API key 管理`、`## 8. 审计日志` | 增加 PI comment 必填规则、通知收件人解析、SMTP/SendGrid secret 策略。 |
| batch progress | `docs/03_SPEC/Sensitivity_Calibration_Benchmark_Addendum.md` | `## 6. Batch 运行` 之后 | 增加 BatchProgressGrid 输出要求和失败项可见规则。 |
| 可视化数据 | `docs/03_SPEC/Visualization_Data_Spec.md` | Heatmap / Metrics / artifact data 章节之后 | 增加 batch progress JSON 和 exportable static figure requirements。 |
| 错误处理 | `docs/03_SPEC/Error_Handling_Spec.md` | notification / failure / retry 相关章节；若无则新增 | 增加 critical failure notification、notification failure 非阻塞策略。 |
| 对象模型 | `docs/03_SPEC/Research_Object_Model.md` | 核心对象之后的“support objects”或 MemoryNote 章节 | 说明这四个补充不新增核心对象，只新增支撑对象和 MemoryNote 类型。 |
| workspace 路径 | `docs/03_SPEC/Workspace_Conventions.md` | artifact 命名 / 目录结构章节 | 增加 reports export、notifications、analysis progress artifact 路径。 |
| API | `docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md` | `## 1. API 端点`、`## 2. WebSocket 端点`、`## 5. Schema Validation` | 增加 report export、PI gate decision、analysis progress、notification record API。 |
| 测试 | `docs/04_IMPLEMENTATION/Testing_Strategy.md` | report / WebSocket / UI / integration 测试章节 | 增加导出、通知、批进度、PI comment 测试。 |
| 实施计划 | `docs/04_IMPLEMENTATION/Phased_Plan.md` | W5–W8 或新增 v0.8.1 Operational UX 小节 | 增加轻量实现优先级。 |

## 3. 推荐优先级

| 优先级 | 功能 | 原因 |
|---|---|---|
| P0 | PI decision comments | 最小改动，直接提升科研治理可复盘性。 |
| P0 | Report HTML export | EvidenceReport 是核心产物，应可离线阅读和分享。 |
| P1 | Batch progress grid | sensitivity / calibration 进入 MVP 前必须有中间状态。 |
| P1 | Email notification | 等 Park/Resume watcher 和 collect/report 语义稳定后接入。 |

## 4. 合并后验收清单

- [ ] `MASTER_INDEX.md` 能导航到新增文档。
- [ ] `Minimal_Schemas.md` 包含新增 support schema 或明确由 Zod 生成。
- [ ] `POST /api/pi-gates/:id/decision` 支持 `comment`。
- [ ] `GET /api/reports/:id/export?format=html` 返回 standalone HTML artifact。
- [ ] batch 运行中失败参数集仍在进度网格和最终表中可见。
- [ ] 邮件通知使用去重 key，服务重启后不会重复发送。
- [ ] 邮件正文不包含 secrets、大型日志、raw output 或完整 timeseries。
- [ ] PI decision comment 被写入 audit log 和 `MemoryNote(type=pi_decision)`，且 `generalization_allowed=false`。
