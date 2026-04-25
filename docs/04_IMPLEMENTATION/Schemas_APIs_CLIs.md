# REST API、WebSocket 与 Schemas

## 1. API 端点 (Hono 后端)

```text
# 工作区
POST   /api/workspace/init              # 初始化工作区

# 任务
POST   /api/tasks                       # 创建任务
GET    /api/tasks                       # 任务列表
GET    /api/tasks/:id                    # 任务详情
POST   /api/tasks/:id/plan               # 生成执行计划
DELETE /api/tasks/:id/artifacts          # 清理临时文件

# 版本与数据
POST   /api/stacks/lock                  # 锁版本
POST   /api/data/register                # 注册数据源

# 执行
POST   /api/tasks/:id/run-tiny           # 运行 tiny benchmark
POST   /api/jobs                         # 提交长任务
GET    /api/jobs/:id                      # 查询 job 状态
POST   /api/jobs/:id/collect              # 收集结果

# 分析
POST   /api/analysis/sensitivity         # 敏感性分析
POST   /api/analysis/calibration         # 校准

# 报告与变更
POST   /api/tasks/:id/report              # 生成报告
GET    /api/reports/:taskId               # 获取报告 (Markdown)
GET    /api/patches/:id/diff              # 查看 patch diff
POST   /api/patches/:id/bundle            # 打包 patch

# 结果与可视化 — Canonical data API
GET    /api/artifacts/:artifactId/data    # 通用 artifact 数据读取 (canonical)
GET    /api/runs/:runId/variables         # 该 run 可用变量列表 (canonical)
GET    /api/runs/:runId/series            # 时间序列数据 ?variable_id=&aggregation= (canonical)
GET    /api/analysis/:planId/heatmap      # 敏感性热力图 ?metric_id= (canonical)

# 结果与可视化 — Convenience API (MVP 快捷接口，内部代理到 canonical)
GET    /api/runs/:id/metrics              # → artifacts/:metricsArtifactId/data
GET    /api/runs/:id/hydrograph           # → runs/:id/series?variable_id=rivqdown&aggregation=outlet
GET    /api/analysis/:id/parameters       # → 聚合 parameter_set_table artifact

# 报告导出
GET    /api/reports/:reportId/export       # ?format=html|markdown，返回 standalone export
POST   /api/reports/:reportId/export       # 可选：按 body 参数重新生成 export

# 分析进度
GET    /api/analysis/:analysisPlanId/progress  # BatchProgressGrid 数据

# 审批 — Canonical
POST   /api/pi-gates/:gateId/decision      # PI gate decision: approved/rejected/request_revision + comment + evidence_refs

# 审批 — Convenience
POST   /api/tasks/:id/approve             # MVP 快捷接口，内部委托到 /api/pi-gates/:gateId/decision

# 通知
GET    /api/tasks/:taskId/notifications   # 最近 notification records，用于 UI 状态显示

# 笔记
POST   /api/notes                        # 添加笔记
GET    /api/notes                        # 笔记列表
```

## 1.1 API 分层规则

数据读取 API 分为两层：

| 层级 | 前缀/模式 | 语义 | 实现要求 |
|------|----------|------|---------|
| **Canonical** | `/api/artifacts/:id/data`, `/api/runs/:id/series`, `/api/runs/:id/variables`, `/api/analysis/:id/heatmap` | 通用数据接口，前端图表组件直接调用 | 必须实现，数据契约见 `Visualization_Data_Spec.md` |
| **Convenience** | `/api/runs/:id/metrics`, `/api/runs/:id/hydrograph`, `/api/analysis/:id/parameters` | MVP 快捷接口，简化前端初期开发 | 内部代理到 canonical API，不维护独立数据层 |

**规则**:
- 前端组件新代码应优先使用 canonical API
- Convenience API 内部必须委托给 canonical 实现，禁止维护独立的数据查询逻辑
- 后续扩展新的可视化类型时，只扩展 canonical API

## 2. WebSocket 端点

```text
WS     /ws/session/:sessionId            # 统一 session 通道:
                                         #   - agent 活动流 (多角色消息)
                                         #   - LLM streaming (打字机效果)
                                         #   - job 日志流 (实时终端)
                                         #   - 事件推送 (job 完成/审批请求/成本告警)
                                         #   - analysis.progress.updated
                                         #   - report.export_ready
                                         #   - pi_gate.decision_recorded
                                         #   - notification.status
```

## 3. 任务创建示例 (Web 界面)

PI 在对话框输入: "添加 event_flux 诊断输出，不能破坏旧 rSHUD reader"

→ Coordinator 解析后调用:
```json
POST /api/tasks
{
  "type": "engineering",
  "title": "Add optional event diagnostics",
  "question_or_goal": "Add event_flux output without breaking old rSHUD readers",
  "inference_budget": { "mode": "normal" }
}
```

## 4. Sensitivity 分析示例 (Web 界面)

PI 在对话中说: "对 ccw 暴雨做 ksat 和 roughness 的敏感性分析"

→ Coordinator 调用:
```json
POST /api/analysis/sensitivity
{
  "task_id": "TASK-0002",
  "parameters": {
    "ksat_multiplier": [0.5, 1.0, 2.0],
    "mannings_n_multiplier": [0.7, 1.0, 1.3]
  },
  "metrics": ["peak_flow_error", "water_balance_residual"]
}
```

## 5. Schema Validation (Zod)

每个 YAML/JSON 对象读写时用 Zod 验证，前后端共享 schema 定义：

```text
TaskCard        → packages/core/src/domain/schemas/task.ts
StackLock       → packages/core/src/domain/schemas/stacklock.ts
DataProvenance  → packages/core/src/domain/schemas/provenance.ts
RunJob          → packages/core/src/domain/schemas/job.ts
RunRecord       → packages/core/src/domain/schemas/run-record.ts
AnalysisPlan    → packages/core/src/domain/schemas/analysis.ts
EvidenceReport  → packages/core/src/domain/schemas/report.ts
ChangeRequest   → packages/core/src/domain/schemas/change.ts
MemoryNote      → packages/core/src/domain/schemas/note.ts
NotificationRecord → packages/core/src/domain/schemas/notification.ts
ReportExport       → packages/core/src/domain/schemas/report-export.ts
AnalysisProgressPayload → packages/core/src/domain/schemas/analysis-progress.ts
PiGateDecision     → packages/core/src/domain/schemas/pi-gate-decision.ts
MemoryNote(pi_decision) → packages/core/src/domain/schemas/note.ts
```

## 6. Report Generation

Report 由确定性模板 + 可选 LLM polish 组成：

```text
metrics summary:    脚本生成 → 前端图表组件渲染
logs summary:       脚本生成 → 前端 LogViewer 展示
interpretive text:  LLM 草拟，标记为 draft
PI decision:        前端 ApprovalButtons → POST /api/tasks/:id/approve
```

## 7. Operational UX API rules

- Report export endpoint 不改变 report status。
- PI gate decision endpoint 必须服务端校验权限，Agent 不能批准 PI gate。
- reject/request_revision/high-risk approve 必须带 comment。
- Analysis progress endpoint 可以从 RunJob/RunRecord 实时派生，也可以读取 progress artifact。
- Notification API 不返回完整邮件正文或 secrets。
