# 8 周实施计划

### Readiness Gate

进入 Week 1 前，必须完成 [MVP_Implementation_Readiness_Checklist.md](MVP_Implementation_Readiness_Checklist.md) 的 P0 项。

## Week 1：Monorepo + 四栏壳 + 基础 API

交付：

```text
- Bun workspace monorepo 初始化 (packages/core + backend + frontend)
- Hono 后端: POST /api/workspace/init, POST/GET /api/tasks
- React 四栏布局骨架: WorkbenchLayout (SideNav + AgentFeed + Experiment + Results)
- Dashboard 页面 (任务列表)
- TaskCard Zod schema
- workspace 文件树自动生成
- Artifact schema + artifact registry skeleton
- ErrorRecord schema + API error envelope
- Idempotency/lock service skeleton
- Task snapshot skeleton
```

验收：浏览器打开四栏布局，可创建任务，SideNav 展示会话历史。

## Week 2：StackLock + DataProvenance + Research Context

交付：

```text
- POST /api/stacks/lock (自动采集 repo commits + runtime versions)
- POST /api/data/register (校验 + sha256 计算)
- renv.lock 集成
- 前端 ResearchContext 组件 (SideNav 内: StackLock + DataProvenance 摘要)
- 前端 ExperimentHeader 组件 (显示 EXP-ID, basin, event, status)
```

验收：任务绑定 stack_id + data_id，SideNav Research Context 展示完整版本链。

## Week 3：Sandbox + RunJob + WebSocket Agent 活动流

交付：

```text
- task workspace + git worktree support
- command trace 记录
- POST /api/jobs, GET /api/jobs/:id, POST /api/jobs/:id/collect
- WS /ws/session/:sessionId (统一 WebSocket 通道)
- 前端 AgentActivityFeed + AgentMessage 组件 (多角色消息流)
- 前端 RuntimeTerminal 组件 (嵌入式实时日志, 语法高亮)
- 前端 StatusBar 组件
- local_job runner adapter
- Collect idempotency 测试
- Service restart recovery smoke test
```

验收：提交 dummy job, Agent 活动流实时展示多角色消息, RuntimeTerminal 实时展示日志。

## Week 4：Tiny SHUD Loop + 水文过程线

交付：

```text
- run-shud-tiny-case skill
- SHUD build/run 脚本
- RunRecord 生成 + GET /api/runs/:id/metrics
- GET /api/runs/:id/hydrograph (时间序列数据)
- 前端 HydrographChart 组件 (交互式: 缩放, tooltips, 多变量切换)
- 前端 ResultsOverview 组件 (关键指标卡: NSE, Peak Error, WB)
```

验收：tiny case 运行完成, 前端展示水文过程线 + 指标卡片。

## Week 5：rSHUD Roundtrip + Diff + 对比图

交付：

```text
- rshud-roundtrip-test skill
- old-output fixture check
- ChangeRequest Zod schema + PATCH /api/patches/:id/diff
- 前端 DiffViewer 组件 (代码 diff 预览)
- 前端 HydrographComparison 组件 (baseline vs experiment 差异带)
```

验收：发现 old-output reader 失败, 前端展示 diff + 对比过程线。

## Week 6：敏感性分析 + 热力图 + 参数表

交付：

```text
- AnalysisPlan mode=sensitivity
- batch parameter runner
- sensitivity_results.parquet → DuckDB
- GET /api/analysis/:id/heatmap, GET /api/analysis/:id/parameters
- 前端 ParameterSetTable 组件 (可排序, 高亮最优)
- 前端 SensitivityHeatmap 组件 (参数×指标热力矩阵)
```

验收：PI 指定参数后, 前端展示参数表 + 热力图 + 过程线。

## Week 7：Memory/Skills + Cost + 审批 + 下一步建议

交付：

```text
- MemoryNote (note + evidence_note) + POST/GET /api/notes
- skill loader
- inference budget 实时追踪
- POST /api/tasks/:id/approve
- 前端 CostMonitor 组件 (SideNav 底部悬浮)
- 前端 NextSuggestedAction 组件 (Coordinator 建议 + PI 选择)
- 前端 CostAdmin 页面 (按任务/天/Agent 汇总)
```

验收：Dashboard 显示成本, PI 可在 Next Action 面板选择方案并执行。

## Week 8：端到端 Demo + 对话 + LLM Streaming

交付：

```text
- Agent streaming (打字机效果) + StreamingText 组件
- PIInput 组件 (自然语言输入 → Coordinator 解析 → 自动执行)
- engineering task 全流程 demo: PI 对话驱动 event diagnostics
- science-assist task 全流程 demo: PI 对话驱动敏感性分析
- rollback test + job failure recovery test
- 部署文档
```

验收：PI 在浏览器中用自然语言对话驱动全流程，四栏工作台实时联动。

## v0.8.1 Operational UX Sprint

在 deterministic skeleton、RunJob/RunRecord、EvidenceReport 基本闭环之后，增加以下轻量能力。

### P0: PI decision comments

交付：

- `POST /api/pi-gates/:gateId/decision`
- comment 必填规则
- audit log
- `MemoryNote(type=pi_decision)`
- report decision history
- PIDecisionPanel textarea

### P0: Report HTML export

交付：

- standalone HTML template
- draft watermark
- export manifest
- `GET /api/reports/:id/export?format=html`
- ReportExportButton

### P1: Batch progress grid

交付：

- `AnalysisProgressPayload`
- `GET /api/analysis/:id/progress`
- optional `analysis.progress.updated` event
- BatchProgressGrid
- cell detail panel
- failed parameter set remains visible

### P1: Email notification

交付：

- NotificationRecord
- recipient resolver
- SMTP/SendGrid provider interface
- dedupe key
- notification after report/analysis ready
- notification.status UI

### Recommended order

```text
1. PI decision comments
2. Report HTML export
3. Batch progress grid
4. Email notification
```

通知建议在 Park/Resume watcher 和 collect/report 语义稳定后接入，避免过早绑定到 job_completed。

## 不在 8 周内做

```text
- Harness Optimizer
- multi-agent autonomous loop
- full HPC scheduler integration (slurm)
- release gate platform
- complex memory review workflow
- 多用户并发 session 管理
- 3D 流域可视化
- notebook 式交互分析
```
