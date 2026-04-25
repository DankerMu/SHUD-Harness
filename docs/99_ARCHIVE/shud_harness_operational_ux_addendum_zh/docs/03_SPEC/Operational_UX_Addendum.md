# Operational UX 补充规范

**状态：** v0.8.1 设计补充  
**适用范围：** Park/Resume、EvidenceReport、AnalysisPlan batch、PI gate  
**目标：** 在不扩大系统复杂度的前提下，补齐 PI 实际使用 SHUD-Harness 时会遇到的四个操作性断点。

## 1. 背景

v0.8 已经确立 PI-led、Web-first、RunRecord-first、Report-first 和 Park/Resume-first 的架构。但真实科研工作中，PI 不一定一直开着浏览器；EvidenceReport 需要分享和离线阅读；批运行需要中间进度；PI 的审批也经常需要科学批注，而不是简单按钮。

因此 v0.8.1 增加四个轻量能力：

1. Out-of-band notification：浏览器关闭后，任务完成或严重失败仍能通知 PI。
2. Standalone report export：报告生成时同时产生可分享的 HTML/Markdown artifact。
3. Batch progress view：sensitivity/calibration/benchmark batch 的中间状态可见。
4. PI decision comments：PI gate 审批带自由文本批注，并进入审计和 MemoryNote。

## 2. 非目标

- 不实现复杂通知偏好系统。
- 不实现企业级 notification center。
- 不引入 PDF 渲染依赖；MVP 用 HTML，PDF 由浏览器打印实现。
- 不实现 Google Docs 式行级批注。
- 不新增 workflow engine。
- 不把 PI comment 自动泛化为科学事实。

## 3. 设计原则

### 3.1 通知不替代 WebSocket

WebSocket 仍然是 workbench 内实时状态的主通道。邮件或其他 out-of-band notification 只用于浏览器关闭、长任务完成、报告可审阅或 critical failure。

### 3.2 报告导出是静态证据包

Standalone HTML 应包含人类阅读所需的摘要、指标、静态图表、RunRecord 引用、limitations、PI questions 和 manifest。它不应内联大型日志、raw SHUD binary output 或完整 timeseries。

### 3.3 Batch progress 从现有对象派生

BatchProgressGrid 不新增核心对象。它由 `AnalysisPlan.parameter_sets`、`RunJob.status`、`RunRecord`、artifact refs 和 optional progress artifact 派生。

### 3.4 PI comment 是决策记录

PI comment 可进入 MemoryNote，但默认 `generalization_allowed=false`。Agent 后续可以引用该 comment 作为任务级决策背景，不能把它升级为跨流域或跨事件科学结论。

## 4. 新增支撑对象

以下对象是 support schema，不属于 v0.8 的 8 个核心对象：

- `NotificationRecord`
- `ReportExport`
- `AnalysisProgressPayload`
- `PiGateDecision`
- `MemoryNote(type=pi_decision)`

## 5. Workflow 摘要

### 5.1 长任务完成通知

```text
Submit RunJob
→ Park TaskCard
→ Watch Job
→ Collect RunRecord
→ Generate report or analysis summary
→ Create NotificationRecord
→ Send email once, using dedupe_key
```

Batch 模式下，不对每个 job completion 都发邮件；默认在 batch summary 或 report draft 可审阅时发一封。

### 5.2 报告导出

```text
Generate EvidenceReport markdown
→ Render static figures
→ Build standalone HTML
→ Write export manifest
→ Emit report.export_ready
```

### 5.3 批运行进度

```text
AnalysisPlan.parameter_sets
+ RunJob status updates
+ RunRecord creation
+ artifact refs
→ AnalysisProgressPayload
→ BatchProgressGrid
```

### 5.4 PI decision comments

```text
PI gate required
→ PI selects approve / reject / request_revision
→ PI writes comment where required
→ server validates role and comment policy
→ audit log
→ MemoryNote(type=pi_decision)
→ report decision history
```

## 6. 与现有文档关系

本文件只做总览。具体规范见：

- `Notification_Design.md`
- `Report_Export_Spec.md`
- `Batch_Progress_View_Spec.md`
- `PI_Decision_Comments_Spec.md`
- `Operational_UX_API_Contracts.md`
- `Operational_UX_Testing_Addendum.md`
