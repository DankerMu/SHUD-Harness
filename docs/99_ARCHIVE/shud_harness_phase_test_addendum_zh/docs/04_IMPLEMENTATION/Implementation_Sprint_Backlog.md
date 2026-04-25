# Implementation Sprint Backlog

**状态：** v0.8.1 实施计划补充  
**目标：** 将 `Phased_Plan.md` 的 8 周交付拆成可实现 backlog。  
**原则：** 先 deterministic skeleton，后真实 SHUD，最后接 Zero/LLM。

---

## Week 0 — Readiness closeout

### 目标

在写代码前完成 P0 签核，确保 Week 1 不再做架构判断。

### 交付

- `.gitmodules` parser 检查；
- `CANONICAL_CONTRACTS.md` 与索引检查；
- P0 docs 入库确认；
- docs link check 脚本占位；
- schema generation 脚本占位；
- readiness gate YAML 记录。

### 非目标

- 不实现 runtime；
- 不启动 React/Hono；
- 不接 LLM。

---

## Week 1 — Deterministic workspace skeleton

### 目标

搭建可运行的 TypeScript monorepo，完成最小 workspace + schema + API + UI shell。

### 后端任务

- `packages/core` 建立 Zod schema：TaskCard、Artifact、ErrorRecord、IdempotencyRecord、LockRecord；
- `packages/backend` 建立 Hono server；
- `POST /api/workspace/init`；
- `POST /api/tasks`、`GET /api/tasks`、`GET /api/tasks/:id`；
- task snapshot read/write；
- API error envelope；
- basic idempotency service skeleton。

### 前端任务

- Dashboard 页面；
- Workbench 四栏 layout；
- SideNav 任务列表；
- ExperimentHeader 读取 task snapshot；
- StatusBar 初始状态。

### 测试任务

- schema unit test；
- API create/get task integration test；
- snapshot read/write test；
- API error envelope negative test；
- docs link check smoke；
- typecheck + build web app。

### 出口标准

浏览器能打开 dashboard，创建 task，进入四栏 workbench，并从 snapshot 恢复当前 task。

---

## Week 2 — StackLock + DataProvenance + artifact registry

### 目标

建立可复盘上下文：版本锁、数据登记、artifact registry。

### 后端任务

- `POST /api/stacks/lock` 读取 submodule commit；
- 记录 runtime versions 占位；
- `POST /api/data/register` 校验 path + sha256；
- Artifact registry service；
- ArtifactManifest read/write；
- `GET /api/artifacts/:artifactId/data` skeleton。

### 前端任务

- ResearchContext 组件；
- ArtifactRef 组件；
- DataProvenance summary card；
- StackLock summary card。

### 测试任务

- submodule commit discovery test；
- data sha256 validation test；
- artifact manifest integrity test；
- artifact evidence_usable 判定测试；
- artifact redaction_status negative test。

### 出口标准

一个 task 可以绑定 stack_id/data_id，SideNav 展示完整版本链和数据溯源摘要。

---

## Week 3 — Sandbox + RunJob + WebSocket + recovery smoke

### 目标

建立 dummy job 的提交、日志流、collect、RunRecord 落盘闭环。

### 后端任务

- Sandbox path policy；
- local_direct runner；
- local_job runner；
- `POST /api/jobs`；
- `GET /api/jobs/:id`；
- `POST /api/jobs/:id/collect`；
- command trace；
- stdout/stderr log artifact；
- WebSocket envelope：event_id、seq、type、payload、created_at；
- session event log；
- service startup recovery smoke。

### 前端任务

- AgentActivityFeed；
- RuntimeTerminal；
- WebSocket reconnect；
- job status badge；
- error banner。

### 测试任务

- workspace 越界写入拒绝；
- stdout/stderr 分片测试；
- WebSocket seq 单调递增；
- reconnect with since_seq；
- collect idempotency；
- service restart 后 uncollected terminal job 可恢复；
- secret redaction。

### 出口标准

dummy job 能提交、实时输出日志、结束后 collect 成 RunRecord，并在页面显示。

---

## Week 4 — ccw tiny SHUD loop

### 目标

跑通真实 SHUD tiny case，形成第一条科学工程证据链。

### 后端任务

- `run-shud-tiny-case` deterministic script；
- SHUD build wrapper；
- 30 天 ccw input patch；
- run wrapper；
- output scan；
- metrics artifact；
- hydrograph series artifact；
- RunRecord numerical_health；
- `GET /api/runs/:runId/variables`；
- `GET /api/runs/:runId/series`。

### 前端任务

- HydrographChart；
- ResultsOverview；
- variable selector；
- run artifact links。

### 测试任务

- build command exits 0；
- run exits 0；
- RunRecord includes stack_id/data_id/job_id；
- water_balance_residual threshold；
- `rivqdown` series loads；
- missing output variable produces ErrorRecord not crash。

### 出口标准

ccw tiny 真实运行完成，并能在浏览器显示过程线和指标卡。

---

## Week 5 — rSHUD roundtrip + compatibility + ChangeRequest

### 目标

把工程变更验证链条接到 rSHUD reader、diff 和 patch bundle。

### 后端任务

- rSHUD read_output wrapper；
- old-output fixture；
- roundtrip test；
- ChangeRequest schema；
- diff artifact；
- patch bundle artifact；
- compatibility check summary。

### 前端任务

- DiffViewer；
- HydrographComparison；
- compatibility status card；
- patch bundle link。

### 测试任务

- old-output fixture pass/fail case；
- optional output missing 不破坏 reader；
- patch bundle sha256；
- high-risk change creates PiGate；
- additive compatible change does not require PI gate unless rule says so。

### 出口标准

能发现 reader 兼容性问题，能显示 diff，对变更生成可审查 patch bundle。

---

## Week 6 — Sensitivity batch + progress + heatmap

### 目标

跑通小型 batch analysis，提供中间进度和最终热力图。

### 后端任务

- AnalysisPlan parameter_sets；
- ParameterSet ↔ RunJob ↔ RunRecord mapping；
- batch runner；
- analysis progress aggregate；
- progress artifact；
- sensitivity table artifact；
- DuckDB/Parquet 写入；
- `GET /api/analysis/:id/progress`；
- `GET /api/analysis/:id/heatmap`。

### 前端任务

- ParameterSetTable；
- BatchProgressGrid；
- BatchCellDetailPanel；
- SensitivityHeatmap；
- failed cell 保留展示。

### 测试任务

- progress total 等于 parameter_sets 数量；
- job status 更新映射到 grid cell；
- failed cell 不消失；
- partial batch 仍能出 report limitation；
- heatmap metric aggregation 正确；
- retry failed parameter_set 创建新 attempt，不覆盖旧 FailureRecord。

### 出口标准

PI 可看到哪些参数集 queued/running/failed/succeeded，并在完成后查看热力图和参数表。

---

## Week 7 — Report, PI gate, memory, cost, operational UX P0

### 目标

把证据报告、PI decision comments、report export 和最小 memory/cost 接起来。

### 后端任务

- EvidenceReport deterministic template；
- language guard；
- PiGate/PiGateDecision；
- `POST /api/pi-gates/:gateId/decision`；
- `MemoryNote(type=pi_decision)`；
- audit log；
- standalone HTML/Markdown export；
- `GET /api/reports/:id/export`；
- cost tracker skeleton；
- notification provider mock。

### 前端任务

- MarkdownRenderer；
- PIDecisionPanel textarea；
- ReportExportButton；
- CostMonitor；
- NextSuggestedAction。

### 测试任务

- report language guard negative cases；
- missing artifact report marks limitation；
- reject/request_revision without comment returns 400；
- Agent cannot approve PI gate；
- PI decision writes AuditEvent + MemoryNote + report decision history；
- draft HTML has watermark；
- accepted HTML has no draft watermark；
- export manifest records included/excluded artifacts；
- notification mock dedupe。

### 出口标准

PI 可读报告、导出 HTML、带批注意见做 approve/reject/revision，决策被审计并写入 scoped memory。

---

## Week 8 — Zero/LLM integration demo

### 目标

在 deterministic skeleton 稳定后接入 Zero AgentLoop 和自然语言驱动。

### 后端任务

- Zero event → Harness WebSocket envelope adapter；
- Zero tool call → Harness sandbox/runner wrapper；
- Zero memory create → MemoryNote draft override；
- Closure classifier override；
- Coordinator prompt 与 TaskCard/RunRecord/EvidenceReport context 注入；
- LLM streaming。

### 前端任务

- PIInput；
- StreamingText；
- agent role message rendering；
- toolcall expand/collapse。

### 测试任务

- deterministic tool adapter 不泄露 workspace 外路径；
- LLM streaming delta 可以重放/终止；
- Zero memory 不默认 verified；
- no-progress classifier blocks after threshold；
- e2e natural language → task → dummy job → report；
- engineering demo + science_assist demo。

### 出口标准

PI 能在浏览器里用自然语言触发一个 engineering task 或 science_assist task，并完成报告审阅。

---

## Operational UX Sprint

建议在 Week 7 前后插入，不必独立占满一周。

1. PI decision comments；
2. Report HTML export；
3. Batch progress grid；
4. Email notification。

通知必须晚于 collect/report/analysis ready，不应绑定到每个 job_completed。
