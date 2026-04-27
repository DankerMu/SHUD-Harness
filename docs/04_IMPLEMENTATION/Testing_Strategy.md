# 测试策略

**状态：** P2 实施规范  
**适用范围：** schema、API、WebSocket、executor、SHUD fixture、report、UI  
**目标：** 用分层测试保证 v0.8 端到端闭环可复盘。

## 1. 测试分层

| 层级 | 测试对象 |
|---|---|
| unit | Zod schema、reducers、path policy、metric functions |
| integration | API + filesystem、WebSocket、Sandbox Executor |
| fixture | ccw tiny 或 dummy SHUD run |
| report | EvidenceReport 生成和 language guard |
| e2e | Web UI 创建 task、运行 job、生成 report |

### 阶段测试矩阵

| Week | 必须新增的自动化测试 | Fixture | CI 级别 |
|---:|---|---|---|
| W0 | gitmodules parse, docs link, readiness YAML | none | PR |
| W1 | core schema, API task, snapshot reload, UI shell smoke | schema-only | PR |
| W2 | submodule discovery, data sha256, artifact manifest | schema-only | PR |
| W3 | dummy job submit/log/collect, WebSocket reconnect, recovery smoke | dummy-runner | PR |
| W4 | SHUD build/run tiny, RunRecord, hydrograph, WB residual | ccw tiny | nightly/manual |
| W5 | rSHUD roundtrip, old-output fixture, patch bundle | old-output | PR/nightly |
| W6 | batch progress, failed cell, heatmap aggregation | dummy-batch | PR |
| W7 | report guard, PI decision, export, notification mock | report fixture | PR |
| W8 | Zero adapter, LLM stream, natural language e2e | dummy-runner | PR/nightly |

详细阶段测试见 [Phase_By_Phase_Test_Plan.md](Phase_By_Phase_Test_Plan.md)。Fixture 与命令矩阵见 [Test_Fixtures_And_Command_Matrix.md](Test_Fixtures_And_Command_Matrix.md)。CI 映射见 [CICD_Release.md](CICD_Release.md)。

## 2. Schema 测试

必须测试：

- TaskCard；
- StackLock；
- DataProvenance；
- RunJob；
- RunRecord；
- AnalysisPlan；
- EvidenceReport；
- ChangeRequest；
- WebSocket event envelope。

## 3. WebSocket 测试

测试场景：

- seq 单调递增；
- event 去重；
- reconnect with `since_seq`；
- snapshot fallback；
- job.log streaming；
- PI gate action 权限失败。

## 4. Sandbox 测试

测试：

- workspace 内命令成功；
- workspace 外写入被拒绝；
- timeout；
- stdout/stderr 分片；
- high risk command 被 gate；
- env secrets redaction。

## 5. Fixture 测试

MVP 推荐两个 fixture：

| fixture | 作用 |
|---|---|
| dummy runner | 快速测试 job/collect/report，不依赖 SHUD |
| ccw tiny | 测试真实 SHUD/rSHUD 闭环 |

ccw tiny 验收：

- SHUD 编译成功；
- 30 天运行 exit_code=0；
- 生成 RunRecord；
- water_balance_residual 达阈值；
- HydrographChart 可加载 `rivqdown`。

## 6. Report 测试

应包含 language guard：

- 禁止“模型机制已验证”；
- 禁止“普遍改进”；
- 必须包含 limitations；
- 必须包含 PI questions；
- artifact 引用存在。

## 7. UI 测试

E2E 流程：

```text
打开 workspace
→ 创建 task
→ 提交 dummy job
→ 查看日志流
→ collect RunRecord
→ 打开 ResultsPanel
→ 生成 report
→ PI approve/revision
```

## 7.1 Operational UX tests

### Notification tests

- [ ] RunRecord/report/analysis completed 后创建 NotificationRecord。
- [ ] SMTP mock 成功后状态为 `sent`。
- [ ] SMTP mock 失败后状态为 `failed`，不回滚任务主流程。
- [ ] 同一 dedupe_key 不重复发送。
- [ ] 无收件人时状态为 `skipped`。
- [ ] 邮件正文不包含 secrets、完整日志或 raw output。

### Report export tests

- [ ] `GET /api/reports/:id/export?format=html` 返回 standalone HTML。
- [ ] draft report HTML 有可见 watermark。
- [ ] accepted report HTML 不显示 draft watermark。
- [ ] export manifest 记录 included/excluded artifacts。
- [ ] 缺失图表时导出仍成功，并标注 missing artifact。

### Batch progress tests

- [ ] AnalysisPlan 创建后 progress total 等于 parameter_sets 数量。
- [ ] job.status 更新能更新对应 cell。
- [ ] failed cell 不从 grid/table/report 中消失。
- [ ] `GET /api/analysis/:id/progress` 聚合计数正确。
- [ ] RuntimeTerminal 不把完整日志塞入 React state。

### PI decision comment tests

- [ ] 普通 approve report 可无 comment。
- [ ] reject 无 comment 返回 400。
- [ ] request_revision 无 comment 返回 400。
- [ ] high-risk approve 无 comment 返回 400。
- [ ] agent 身份调用 PI decision endpoint 返回 403。
- [ ] 成功 decision 写 audit log、MemoryNote 和 report decision history。
- [ ] MemoryNote(type=pi_decision) 的 `generalization_allowed=false`。

### 补充测试类别

- **Support schema 测试**：Artifact、PiGate、NotificationRecord、ReportExport、AnalysisProgressPayload、ErrorRecord、AuditEvent 的 Zod 校验。
- **Artifact registry 测试**：evidence_usable 判定、retention_class 约束、manifest integrity 校验。
- **Idempotency 测试**：collect / export / notification / PI decision 重复请求不产生冲突对象。
- **Snapshot recovery 测试**：since_seq 过期时走 snapshot_required 流程、service restart 后 parked job 恢复。
- **Runner adapter 测试**：local_direct / local_job 的 status mapping 和 collect result 格式。
- **API error 测试**：400 / 403 / 409 / 422 统一 envelope 返回。

## 8. Observability tests

- `OBS-HEALTH-001`: live endpoint returns 200。
- `OBS-HEALTH-002`: ready detects workspace not writable。
- `OBS-HEALTH-003`: disk critical triggers alert and blocks new jobs。
- `OBS-LOG-001`: API request writes structured NDJSON。
- `OBS-LOG-002`: secret values redacted。
- `OBS-ALERT-001`: alert dedupe works。
- `OBS-DASH-001`: ops dashboard returns health/jobs/storage/errors/dependencies。

## 9. Performance tests

- `PERF-API-001`: metadata API P95 <= 300ms in mock workspace。
- `PERF-WS-001`: reconnect + replay/snapshot <= 5s。
- `PERF-REPORT-001`: tiny report generation <= 30s。
- `PERF-BATCH-001`: batch progress update <= 2s。
- `PERF-CONC-001`: MVP concurrency smoke。

## 10. Dependency tests

- lockfile exists；
- frozen install；
- packageManager fixed；
- dependency status endpoint；
- DuckDB client smoke；
- submodule status captured。

## 11. Requirements tests

- requirement IDs unique；
- P0/P1 requirements have acceptance criteria；
- P0 requirements have test_ids before release；
- Traceability matrix references valid requirement IDs。

## 12. Theory-to-Code Tests

并入 [Theory_To_Code_Test_Plan.md](Theory_To_Code_Test_Plan.md) 的 Test IDs。

### Test Categories

| 类别 | 测试对象 | CI 级别 |
|---|---|---|
| schema | TheoryToCodeBundle 等 Zod schema | PR |
| state machine | bundle transition | PR |
| governance | high-risk gate / role permission | PR |
| equation | symbol/unit/dimension check | PR |
| mapping | equation_id → code_target | PR |
| verification | VerificationCase run/collect/status | PR/nightly |
| report | Theory-to-Code Evidence + language guard | PR |
| search boundary | accepted_for_search 前禁止 search | PR |
| artifact retention | failed verification evidence retained | PR |

### Test IDs

| Test ID | 场景 | Pass criterion |
|---|---|---|
| TC-SCHEMA-001 | valid TheoryToCodeBundle | Zod parse pass |
| TC-SCHEMA-002 | missing scientific_question | Zod parse fail |
| TC-EQ-001 | symbol missing unit | cannot enter reviewed |
| TC-EQ-002 | dimension_check fail | bundle cannot enter implementation_review |
| TC-GATE-001 | physical_equation CR without bundle | API 422 |
| TC-GATE-002 | agent attempts accept bundle | API 403 |
| TC-GATE-003 | high-risk approve without comment | API 400 |
| TC-MAP-001 | high-risk code target without equation_id | API 422 |
| TC-VER-001 | passed verification missing artifact | cannot enter reviewed |
| TC-VER-002 | failed verification retains logs/artifacts | artifact query pass |
| TC-REPORT-001 | high-risk report missing Theory-to-Code Evidence | cannot enter reviewed |
| TC-REPORT-002 | calibration-as-validation phrase | language guard fail |
| TC-SEARCH-001 | search before accepted_for_search | API 409 |
| TC-SEARCH-002 | improvement claim without baseline | report guard fail |
| TC-TRACE-001 | equation_id → code_target → verification_case → run_record → report | traceability check pass |

### Fixture Strategy

- **schema-only fixture**: 用于 W1/W2，不依赖 SHUD。
- **dummy verification fixture**: 模拟 VerificationCase run/collect（VC-DUMMY-001）。
- **ccw tiny verification fixture**: 真实 SHUD tiny case，case_type=tiny_basin。

### Negative Tests

必须覆盖：

- Agent 自行 accepted；
- 没有 bundle 的 physical equation change；
- 没有 baseline 的 improvement claim；
- passed verification 缺 artifact；
- calibration report 写"结构验证"；
- output semantics change 没有 PI gate；
- failed verification 被隐藏。

### Theory-to-Code 测试验收标准

- [ ] TC-GATE-001/002/003 进入 PR CI。
- [ ] TC-REPORT-002 进入 language guard 负例。
- [ ] TC-SEARCH-001 阻止未审查 search。
- [ ] TC-TRACE-001 进入 release check。

## 13. 验收标准

- [ ] CI 跑 schema/unit/integration 测试。
- [ ] 本地可手动跑 ccw tiny fixture。
- [ ] WebSocket reconnect 有自动测试。
- [ ] 报告 language guard 有负例测试。
- [ ] Sandbox path policy 有越界测试。
