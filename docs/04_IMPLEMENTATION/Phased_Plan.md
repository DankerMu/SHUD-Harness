# 8 周实施计划

### Readiness Gate

进入 Week 1 前，必须完成 [MVP_Implementation_Readiness_Checklist.md](MVP_Implementation_Readiness_Checklist.md) 的 P0 项。

## Week 0：Readiness closeout

在写代码前完成 P0 签核，确保 Week 1 不再做架构判断。

交付：

```text
- .gitmodules parser 检查
- CANONICAL_CONTRACTS.md 与索引检查
- P0 docs 入库确认
- docs link check 脚本占位
- schema generation 脚本占位
- readiness gate YAML 记录
```

非目标：不实现 runtime；不启动 React/Hono；不接 LLM。

验收：P0 Gate 全部 pass 或 pass_with_notes，readiness YAML 已生成。

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

### 后端任务

- `packages/core` 建立 Zod schema：TaskCard、Artifact、ErrorRecord、IdempotencyRecord、LockRecord
- `packages/backend` 建立 Hono server
- `POST /api/workspace/init`
- `POST /api/tasks`、`GET /api/tasks`、`GET /api/tasks/:id`
- task snapshot read/write
- API error envelope
- basic idempotency service skeleton

### 前端任务

- Dashboard 页面
- Workbench 四栏 layout
- SideNav 任务列表
- ExperimentHeader 读取 task snapshot
- StatusBar 初始状态

### 测试任务

- schema unit test
- API create/get task integration test
- snapshot read/write test
- API error envelope negative test
- docs link check smoke
- typecheck + build web app

验收：浏览器打开四栏布局，可创建任务，SideNav 展示会话历史。

### Test Gate

- schema TaskCard/Artifact/ErrorRecord valid+invalid
- API POST/GET task
- snapshot write/read/reload
- UI Dashboard → Workbench smoke
- CI typecheck + docs link

出口标准：浏览器能打开 dashboard，创建 task，进入四栏 workbench，并从 snapshot 恢复当前 task。

## Week 2：StackLock + DataProvenance + Research Context

交付：

```text
- POST /api/stacks/lock (自动采集 repo commits + runtime versions)
- POST /api/data/register (校验 + sha256 计算)
- renv.lock 集成
- 前端 ResearchContext 组件 (SideNav 内: StackLock + DataProvenance 摘要)
- 前端 ExperimentHeader 组件 (显示 EXP-ID, basin, event, status)
```

### 后端任务

- `POST /api/stacks/lock` 读取 submodule commit
- 记录 runtime versions 占位
- `POST /api/data/register` 校验 path + sha256
- Artifact registry service
- ArtifactManifest read/write
- `GET /api/artifacts/:artifactId/data` skeleton

### 前端任务

- ResearchContext 组件
- ArtifactRef 组件
- DataProvenance summary card
- StackLock summary card

### 测试任务

- submodule commit discovery test
- data sha256 validation test
- artifact manifest integrity test
- artifact evidence_usable 判定测试
- artifact redaction_status negative test

验收：任务绑定 stack_id + data_id，SideNav Research Context 展示完整版本链。

### Test Gate

- submodule commit discovery
- DataProvenance sha256
- ArtifactManifest integrity
- evidence_usable rules
- ResearchContext UI smoke

出口标准：一个 task 可以绑定 stack_id/data_id；Artifact registry 可记录 evidence_usable artifact。

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

### 后端任务

- Sandbox path policy
- local_direct runner
- local_job runner
- `POST /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/collect`
- command trace
- stdout/stderr log artifact
- WebSocket envelope：event_id、seq、type、payload、created_at
- session event log
- service startup recovery smoke

### 前端任务

- AgentActivityFeed
- RuntimeTerminal
- WebSocket reconnect
- job status badge
- error banner

### 测试任务

- workspace 越界写入拒绝
- stdout/stderr 分片测试
- WebSocket seq 单调递增
- reconnect with since_seq
- collect idempotency
- service restart 后 uncollected terminal job 可恢复
- secret redaction

验收：提交 dummy job, Agent 活动流实时展示多角色消息, RuntimeTerminal 实时展示日志。

### Test Gate

- dummy local_job submit/status/collect
- collect idempotency
- WebSocket seq/reconnect/snapshot_required
- RuntimeTerminal log chunks
- service restart recovery
- sandbox path escape negative

出口标准：dummy job 能提交、实时输出日志、结束后 collect 成 RunRecord，并在页面显示。

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

### 后端任务

- `run-shud-tiny-case` deterministic script
- SHUD build wrapper
- 30 天 ccw input patch
- run wrapper
- output scan
- metrics artifact
- hydrograph series artifact
- RunRecord numerical_health
- `GET /api/runs/:runId/variables`
- `GET /api/runs/:runId/series`

### 前端任务

- HydrographChart
- ResultsOverview
- variable selector
- run artifact links

### 测试任务

- build command exits 0
- run exits 0
- RunRecord includes stack_id/data_id/job_id
- water_balance_residual threshold
- `rivqdown` series loads
- missing output variable produces ErrorRecord not crash

验收：tiny case 运行完成, 前端展示水文过程线 + 指标卡片。

### Test Gate

- SHUD build exit_code=0
- ccw END=30 patch in task workspace only
- run exits 0
- RunRecord + metrics + hydrograph artifacts
- water_balance threshold
- missing output → ErrorRecord

出口标准：ccw tiny 真实运行完成，并能在浏览器显示过程线和指标卡。

## Week 5：rSHUD Roundtrip + Diff + 对比图

交付：

```text
- rshud-roundtrip-test skill
- old-output fixture check
- ChangeRequest Zod schema + PATCH /api/patches/:id/diff
- 前端 DiffViewer 组件 (代码 diff 预览)
- 前端 HydrographComparison 组件 (baseline vs experiment 差异带)
```

### 后端任务

- rSHUD read_output wrapper
- old-output fixture
- roundtrip test
- ChangeRequest schema
- diff artifact
- patch bundle artifact
- compatibility check summary

### 前端任务

- DiffViewer
- HydrographComparison
- compatibility status card
- patch bundle link

### 测试任务

- old-output fixture pass/fail case
- optional output missing 不破坏 reader
- patch bundle sha256
- high-risk change creates PiGate
- additive compatible change does not require PI gate unless rule says so

验收：发现 old-output reader 失败, 前端展示 diff + 对比过程线。

### Test Gate

- rSHUD current output read
- old-output fixture
- ChangeRequest risk rules
- patch bundle sha256
- DiffViewer smoke

出口标准：能发现 reader 兼容性问题，能显示 diff，对变更生成可审查 patch bundle。

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

### 后端任务

- AnalysisPlan parameter_sets
- ParameterSet ↔ RunJob ↔ RunRecord mapping
- batch runner
- analysis progress aggregate
- progress artifact
- sensitivity table artifact
- DuckDB/Parquet 写入
- `GET /api/analysis/:id/progress`
- `GET /api/analysis/:id/heatmap`

### 前端任务

- ParameterSetTable
- BatchProgressGrid
- BatchCellDetailPanel
- SensitivityHeatmap
- failed cell 保留展示

### 测试任务

- progress total 等于 parameter_sets 数量
- job status 更新映射到 grid cell
- failed cell 不消失
- partial batch 仍能出 report limitation
- heatmap metric aggregation 正确
- retry failed parameter_set 创建新 attempt，不覆盖旧 FailureRecord

验收：PI 指定参数后, 前端展示参数表 + 热力图 + 过程线。

### Test Gate

- 3x3 parameter set generation
- PSET ↔ job ↔ run mapping
- failed cell visible
- progress counts
- heatmap shape

出口标准：PI 可看到哪些参数集 queued/running/failed/succeeded，并在完成后查看热力图和参数表。

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

### 后端任务

- EvidenceReport deterministic template
- language guard
- PiGate/PiGateDecision
- `POST /api/pi-gates/:gateId/decision`
- `MemoryNote(type=pi_decision)`
- audit log
- standalone HTML/Markdown export
- `GET /api/reports/:id/export`
- cost tracker skeleton
- notification provider mock

### 前端任务

- MarkdownRenderer
- PIDecisionPanel textarea
- ReportExportButton
- CostMonitor
- NextSuggestedAction

### 测试任务

- report language guard negative cases
- missing artifact report marks limitation
- reject/request_revision without comment returns 400
- Agent cannot approve PI gate
- PI decision writes AuditEvent + MemoryNote + report decision history
- draft HTML has watermark
- accepted HTML has no draft watermark
- export manifest records included/excluded artifacts
- notification mock dedupe

验收：Dashboard 显示成本, PI 可在 Next Action 面板选择方案并执行。

### Test Gate

- report language guard
- missing artifact limitation
- PI decision comment rules
- agent forbidden on PI decision
- HTML export watermark
- notification mock dedupe

出口标准：PI 可读报告、导出 HTML、带批注意见做 approve/reject/revision，决策被审计并写入 scoped memory。

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

### 后端任务

- Zero event → Harness WebSocket envelope adapter
- Zero tool call → Harness sandbox/runner wrapper
- Zero memory create → MemoryNote draft override
- Closure classifier override
- Coordinator prompt 与 TaskCard/RunRecord/EvidenceReport context 注入
- LLM streaming

### 前端任务

- PIInput
- StreamingText
- agent role message rendering
- toolcall expand/collapse

### 测试任务

- deterministic tool adapter 不泄露 workspace 外路径
- LLM streaming delta 可以重放/终止
- Zero memory 不默认 verified
- no-progress classifier blocks after threshold
- e2e natural language → task → dummy job → report
- engineering demo + science_assist demo

验收：PI 在浏览器中用自然语言对话驱动全流程，四栏工作台实时联动。

### Test Gate

- Zero event adapter
- tool call through sandbox
- memory not default verified
- LLM streaming
- natural language e2e

出口标准：PI 能在浏览器里用自然语言触发一个 engineering task 或 science_assist task，并完成报告审阅。

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

建议在 Week 7 前后插入，不必独立占满一周。推荐实施顺序：

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
