# Phase-by-Phase Test Plan

**状态：** v0.8.1 测试计划补充  
**目标：** 将 `Testing_Strategy.md` 的分层测试扩展为每个实施阶段可执行的测试矩阵。  
**测试原则：** 每周结束时必须有可自动化的验收测试；真实 SHUD 运行只在指定 fixture 阶段引入。

---

## 1. 测试分级

| 级别 | 名称 | 运行频率 | 用途 |
|---|---|---|---|
| T0 | schema/unit | 每次 commit | 保证 schema、纯函数、reducers、path policy 正确 |
| T1 | API/integration | 每次 PR | 保证 API、filesystem、artifact、idempotency 协同正确 |
| T2 | WebSocket/recovery | 每次 PR | 保证日志流、event replay、snapshot 和 recovery 正确 |
| T3 | UI e2e dummy | 每次 PR 或 nightly | 保证 Web 工作台无 SHUD 依赖可用 |
| T4 | fixture real SHUD | nightly 或手动 | 保证 ccw tiny 真实运行闭环 |
| T5 | regression/release | release 前 | 保证 schema drift、submodule、docs、artifacts、report 全链路稳定 |

---

## 2. Week 0 Readiness tests

| 测试 ID | 类型 | 目标 | 通过标准 |
|---|---|---|---|
| W0-GIT-001 | shell | `.gitmodules` 可解析 | 4 个 submodule path/url 均返回 |
| W0-DOC-001 | docs | `MASTER_INDEX.md` 路径存在 | 所有列出文档能被 link checker 找到 |
| W0-SPEC-001 | docs/schema | `SPEC_v0.8_Final.md` 与 canonical schema 不冲突 | TaskCard/EvidenceReport/RunJob 状态一致 |
| W0-CANON-001 | docs | `CANONICAL_CONTRACTS.md` 完整 | core/support/API/event/path/artifact/runner 都有 source |
| W0-READY-001 | process | readiness gate YAML 生成 | decision 为 pass 或 pass_with_notes |

---

## 3. Week 1 tests — skeleton

### Unit

- TaskCard schema valid/invalid；
- Artifact schema valid/invalid；
- ErrorRecord schema valid/invalid；
- path normalization；
- idempotency request digest；
- task snapshot serialization。

### Integration

| 测试 ID | 场景 | 通过标准 |
|---|---|---|
| W1-API-001 | `POST /api/workspace/init` | 生成 workspace 目录树和 config |
| W1-API-002 | `POST /api/tasks` 正常输入 | 生成 TaskCard YAML + task snapshot |
| W1-API-003 | `POST /api/tasks` schema error | 返回统一 ApiErrorResponse 400 |
| W1-API-004 | `GET /api/tasks/:id` | 返回 schema validated TaskCard |
| W1-SNAP-001 | task snapshot reload | 重启 server 后仍可读取 task |

### UI/E2E

- 打开 Dashboard；
- 创建 task；
- 进入 Workbench；
- SideNav 显示任务；
- ExperimentHeader 显示 task status；
- 刷新页面后状态恢复。

### Exit gate

```text
W1 通过条件：T0 + T1 + UI smoke 全通过；不存在无法落盘的核心对象。
```

---

## 4. Week 2 tests — stack/data/artifact

### Unit

- StackLock schema；
- DataProvenance schema；
- ArtifactManifest schema；
- sha256 function；
- redaction_status rules。

### Integration

| 测试 ID | 场景 | 通过标准 |
|---|---|---|
| W2-SUB-001 | submodule commit discovery | SHUD/rSHUD/AutoSHUD/zero commit 均可读取 |
| W2-DATA-001 | register existing data path | DataProvenance created，sha256 recorded |
| W2-DATA-002 | register missing path | 404/422 error envelope |
| W2-ART-001 | create artifact metadata | artifact path、type、sha256、retention_class 合法 |
| W2-ART-002 | manifest integrity | manifest_sha256 可复算 |

### UI/E2E

- ResearchContext 显示 StackLock；
- ResearchContext 显示 DataProvenance；
- ArtifactRef 可点击/复制路径。

### Exit gate

```text
W2 通过条件：任一 task 均可绑定 stack_id + data_id；Artifact registry 可记录 evidence_usable artifact。
```

---

## 5. Week 3 tests — runner/websocket/recovery

### Unit

- Runner status mapping；
- Sandbox path allow/deny；
- WebSocket envelope schema；
- seq allocator；
- log chunker。

### Integration

| 测试 ID | 场景 | 通过标准 |
|---|---|---|
| W3-RUN-001 | submit dummy local_job | job.status 从 created → submitted/running |
| W3-RUN-002 | dummy job succeeds | terminal status succeeded，stdout artifact 存在 |
| W3-RUN-003 | dummy job fails | FailureRecord/ErrorRecord created |
| W3-COL-001 | collect once | RunRecord created，job.status collected |
| W3-COL-002 | collect twice same key | 返回同一 RunRecord，不创建重复对象 |
| W3-WS-001 | log stream | RuntimeTerminal 收到分片日志 |
| W3-WS-002 | reconnect with since_seq | 不重复、不丢失事件 |
| W3-REC-001 | service restart recovery | uncollected terminal job 被重新 collect |

### Security/negative

- 写入 workspace 外路径被拒绝；
- high-risk command 触发 PI gate 或拒绝；
- env secret 不出现在 stdout/stderr artifact。

### Exit gate

```text
W3 通过条件：dummy job → log stream → collect → RunRecord → UI display 全自动化通过。
```

---

## 6. Week 4 tests — ccw tiny

### Unit

- SHUD output variable registry；
- time series parser fallback；
- water_balance_residual function；
- RunRecord numerical_health schema。

### Fixture

| 测试 ID | 场景 | 通过标准 |
|---|---|---|
| W4-SHUD-001 | build SHUD | `make shud` exit_code=0 |
| W4-SHUD-002 | patch END=30 | patched config 可审计且原始 fixture 不被覆盖 |
| W4-SHUD-003 | run ccw tiny | exit_code=0，wall_seconds 在可接受范围 |
| W4-SHUD-004 | parse output | variables list 包含 `rivqdown` 或 registry fallback |
| W4-SHUD-005 | metrics | water_balance_residual 低于阈值，cvode_failures=0 |
| W4-UI-001 | HydrographChart | 可加载 outlet hydrograph |

### Negative

- 缺失 output file → ErrorRecord，不导致 report crash；
- rSHUD unavailable → fallback parser 或 blocked with clear error；
- SHUD build failed → captured stderr artifact。

### Exit gate

```text
W4 通过条件：真实 ccw tiny run 可生成 RunRecord、metrics artifact、timeseries artifact，并在 UI 展示。
```

---

## 7. Week 5 tests — rSHUD and ChangeRequest

### Unit

- ChangeRequest schema；
- interface_impact rules；
- patch bundle manifest；
- diff parser。

### Integration/fixture

| 测试 ID | 场景 | 通过标准 |
|---|---|---|
| W5-RSHUD-001 | rSHUD read_output current output | returns data or explicit parser ErrorRecord |
| W5-RSHUD-002 | old-output fixture | backward compatibility pass/fail 被正确记录 |
| W5-DIFF-001 | create diff artifact | artifact type=patch，sha256 exists |
| W5-CHG-001 | additive compatible change | risk low/medium，PI gate 按规则判定 |
| W5-CHG-002 | breaking output change | PiGate required |

### UI/E2E

- DiffViewer 渲染 patch；
- compatibility card 显示 pass/fail/skipped；
- HydrographComparison 对比 baseline/experiment。

### Exit gate

```text
W5 通过条件：reader 兼容性、diff、patch bundle、PI gate 判定形成闭环。
```

---

## 8. Week 6 tests — batch analysis

### Unit

- ParameterSet generator；
- AnalysisProgressPayload schema；
- heatmap aggregation；
- ParameterSet ↔ RunJob ↔ RunRecord mapping。

### Integration

| 测试 ID | 场景 | 通过标准 |
|---|---|---|
| W6-BATCH-001 | create 3x3 parameter sets | total=9，ID deterministic |
| W6-BATCH-002 | submit batch dummy jobs | 每个 parameter_set 对应 RunJob |
| W6-BATCH-003 | one job fails | failed cell 保留，summary 计数正确 |
| W6-BATCH-004 | progress endpoint | queued/running/collecting/succeeded/failed 计数正确 |
| W6-BATCH-005 | heatmap endpoint | metric matrix shape 与 parameter space 一致 |
| W6-BATCH-006 | retry failed parameter | 新 attempt，不覆盖旧 FailureRecord |

### UI/E2E

- BatchProgressGrid 显示所有 cell；
- 点击 cell 展开日志和 metrics；
- ParameterSetTable 可排序；
- SensitivityHeatmap 可切 metric。

### Exit gate

```text
W6 通过条件：批运行中间状态可见，失败不丢失，最终结果可聚合。
```

---

## 9. Week 7 tests — reports, PI gates, export, notification mock

### Unit

- EvidenceReport schema；
- forbidden-language guard；
- PiGateDecision required comment rules；
- ReportExport schema；
- NotificationRecord schema；
- AuditEvent schema。

### Integration

| 测试 ID | 场景 | 通过标准 |
|---|---|---|
| W7-REP-001 | generate report from RunRecord | includes observations, limitations, pi_questions |
| W7-REP-002 | missing artifact | report marks limitation, not crash |
| W7-PI-001 | approve ordinary report no comment | allowed |
| W7-PI-002 | reject no comment | 400 |
| W7-PI-003 | request_revision no comment | 400 |
| W7-PI-004 | agent tries decision | 403 |
| W7-EXP-001 | export draft HTML | watermark exists |
| W7-EXP-002 | export accepted HTML | no draft watermark |
| W7-NOTIF-001 | notification mock send | status sent |
| W7-NOTIF-002 | duplicate dedupe_key | no duplicate email record |

### UI/E2E

- ReportFullscreen 打开；
- ReportExportButton 下载 HTML；
- PIDecisionPanel 提交 comment；
- CostMonitor 显示 task-level cost；
- NotificationStatus 显示 sent/failed/skipped。

### Exit gate

```text
W7 通过条件：报告可审阅、可导出、可审批、可审计，通知 mock 不影响主流程。
```

---

## 10. Week 8 tests — Zero/LLM integration

### Unit

- Zero event adapter；
- tool call wrapper；
- streaming delta reducer；
- memory override：not verified by default；
- closure classifier。

### Integration/e2e

| 测试 ID | 场景 | 通过标准 |
|---|---|---|
| W8-ZERO-001 | Zero tool call → Harness sandbox | command trace + artifact created |
| W8-ZERO-002 | LLM stream interrupted | UI shows partial and can recover |
| W8-ZERO-003 | memory create | creates MemoryNote draft, not verified |
| W8-ZERO-004 | no-progress classifier | blocks after threshold |
| W8-E2E-001 | natural language engineering task | task → dummy job → report → PI decision |
| W8-E2E-002 | natural language science_assist task | analysis plan → batch dummy → report |

### Exit gate

```text
W8 通过条件：Zero 接入不破坏 deterministic skeleton，PI 可用自然语言驱动演示流程。
```

---

## 11. Release regression tests

每次 `0.8.x` release 前必须跑：

- typecheck；
- schema generation + drift check；
- docs link check；
- submodule checkout check；
- API error envelope tests；
- WebSocket replay tests；
- sandbox path tests；
- dummy e2e；
- report language guard；
- accepted report export snapshot；
- ccw tiny manual 或 nightly result；
- release manifest includes submodule commits。

---

## 12. 覆盖率最低标准

MVP 不要求追求高覆盖率数字，但要求关键 contract 有测试。

| 类别 | 最低要求 |
|---|---|
| schema | 每个 core/support schema 至少 1 valid + 1 invalid |
| API | 每个 write endpoint 至少 success + schema_error + permission/conflict case |
| WebSocket | envelope、seq、dedupe、reconnect、snapshot_required |
| artifact | metadata、manifest、evidence_usable、redaction |
| runner | submit/status/collect/cancel mapping |
| report | language guard positive/negative |
| UI | 每周主用户路径至少 1 e2e |
