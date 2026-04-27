# SHUD-Harness Requirements Catalog

**状态**：v0.8.3 PRD 补充（含 Theory-to-Code addendum）  
**目标**：提供统一 FR/NFR/US/GR/DR/IR 需求目录，并与文档、实现和测试形成追踪链。  
**编号规则**：见 `Requirements_Numbering_Conventions.md`。

---

## 1. User Stories

| ID | 角色 | 用户故事 | 优先级 | 验收标准 |
|---|---|---|---:|---|
| US-001 | PI | 作为 PI，我希望通过 Web workbench 创建 SHUD 建模任务，并查看执行进度与结果报告。 | P0 | 能创建 TaskCard；能看到 RunJob 状态；能打开 EvidenceReport |
| US-002 | PI | 作为 PI，我希望长时间任务完成后即使浏览器关闭也能收到通知。 | P1 | collect/report/analysis 完成后产生 NotificationRecord；邮件失败不影响主流程 |
| US-003 | PI | 作为 PI，我希望报告可以导出为 standalone HTML/Markdown，便于分享和离线阅读。 | P0 | `GET /api/reports/:id/export` 可返回导出文件；draft 有 watermark |
| US-004 | PI | 作为 PI，我希望敏感性分析运行中能看到每个参数集的状态。 | P1 | BatchProgressGrid 显示 queued/running/succeeded/failed 等状态 |
| US-005 | PI | 作为 PI，我希望审批时能留下科学判断批注，并纳入审计和 MemoryNote。 | P0 | PI decision 可带 comment；reject/revision/high-risk approve 必填 |
| US-006 | 工程师 | 作为工程师，我希望系统有健康检查和结构化日志，便于诊断服务是否可用。 | P0 | `/api/health/live` 和 `/api/health/ready` 可用；日志有 request_id/task_id |
| US-007 | 系统管理员 | 作为管理员，我希望有运维 dashboard 查看磁盘、任务、错误、通知和版本状态。 | P1 | Ops dashboard 至少包含 System、Jobs、Storage、Errors、Notifications、Dependencies |
| US-008 | 系统管理员 | 作为管理员，我希望依赖版本被锁定并可审计，避免环境漂移。 | P0 | package manager 版本、lockfile、dependency audit、StackLock dependency summary 可用 |

---

## 2. Functional Requirements

| ID | 标题 | 需求陈述 | 优先级 | 来源文档 | 验收标准 |
|---|---|---|---:|---|---|
| FR-001 | TaskCard 创建 | 系统必须允许通过 Web/API 创建 TaskCard，并持久化到 workspace。 | P0 | Minimal_Schemas / Schemas_APIs_CLIs | `POST /api/tasks` 成功；Zod 校验；task 可重新加载 |
| FR-002 | RunJob 提交与收集 | 系统必须支持提交 RunJob、查询状态、收集结果并生成 RunRecord。 | P0 | Execution_Jobs_Runs | dummy runner 完整闭环通过 |
| FR-003 | WebSocket 实时事件 | 系统必须通过统一 WebSocket session 推送 job、log、report、PI gate、cost 等事件。 | P0 | WebSocket_Protocol | seq 单调；reconnect 可恢复 |
| FR-004 | EvidenceReport 生成 | 系统必须基于 RunRecord/artifact 生成 EvidenceReport，并保留 limitations 和 PI questions。 | P0 | Report_Generation_Spec | report guard 测试通过 |
| FR-005 | Report export | 系统必须支持导出 EvidenceReport 为 standalone HTML 和 Markdown。 | P0 | Report_Export_Spec | HTML standalone；draft watermark；manifest 完整 |
| FR-006 | PI gate decision | 系统必须提供 PI gate decision API，禁止 Agent 代替 PI 批准高风险决策。 | P0 | Auth_Permission_Design | agent 调用返回 403；audit log 写入 |
| FR-007 | Batch progress | 系统必须在 batch analysis 中展示每个 parameter set 的运行状态。 | P1 | Batch_Progress_View_Spec | failed cell 不消失；聚合计数正确 |
| FR-008 | Out-of-band notification | 系统必须能在 collect/report/analysis 完成或 critical failure 时创建通知记录。 | P1 | Notification_Design | dedupe 生效；SMTP mock 成功/失败均可追踪 |
| FR-009 | Health checks | 系统必须提供 live、ready、deep 三类健康检查端点。 | P0 | Observability_Monitoring_Spec | live/ready 无需外部服务；deep 需要认证 |
| FR-010 | Ops dashboard | 系统必须提供运维 dashboard 所需的数据 API。 | P1 | Observability_Monitoring_Spec | `/api/ops/dashboard` 返回聚合状态 |
| FR-011 | Requirements API | 系统应能读取需求目录并输出 coverage summary。 | P2 | Requirements_Catalog | `GET /api/requirements` 可返回编号列表 |
| FR-012 | RepoContextBrief | 系统应支持只读 Repo Explorer 为 code_change/debugging/cross-repo 任务生成仓库上下文简报。 | P1 | Agent_Architecture / Roles_and_Boundaries | Explorer 写操作被拒绝；Brief 包含 inspected refs、entrypoints、impact surface、tests、risks、unknowns |

---

## 3. Non-Functional Requirements

### Performance

| ID | 标题 | 目标 | 优先级 | 验收标准 |
|---|---|---|---:|---|
| NFR-PERF-001 | REST metadata P95 | metadata 类 REST API 在 local dev / lab server 中 P95 ≤ 300ms。 | P0 | PR CI 中可用 mock workspace 测量 |
| NFR-PERF-002 | Heavy API async | 真实 SHUD run、batch、report regeneration 等重操作必须异步提交，HTTP accept P95 ≤ 1000ms。 | P0 | `POST /api/jobs` 不阻塞进程运行 |
| NFR-PERF-003 | WebSocket reconnect SLA | 正常网络恢复后，WebSocket reconnect + snapshot 恢复 P95 ≤ 5s。 | P0 | 自动化 reconnect 测试 |
| NFR-PERF-004 | Event delivery latency | job/status/log/progress 事件从后端产生到前端 reducer 可见 P95 ≤ 1s。 | P1 | dummy runner event latency test |
| NFR-PERF-005 | Report generation latency | tiny report deterministic generation P95 ≤ 30s；cached export download P95 ≤ 1s。 | P1 | report fixture benchmark |
| NFR-PERF-006 | Batch progress latency | RunJob 状态变化后 progress grid P95 ≤ 2s 更新。 | P1 | dummy batch e2e |
| NFR-PERF-007 | MVP concurrency | MVP 应支持 1-3 个活跃用户、10 个活跃任务、20 个 parked jobs、50 个 RunRecords。 | P1 | integration load smoke |
| NFR-PERF-008 | Lab server concurrency | lab server 目标支持 10 用户、50 活跃任务、200 parked jobs。 | P2 | release 前压力测试 |

### Observability / Reliability / Operations

| ID | 标题 | 目标 | 优先级 | 验收标准 |
|---|---|---|---:|---|
| NFR-OBS-001 | Structured logs | 服务端日志必须为可聚合结构化日志，包含 request_id/session_id/task_id/job_id/run_id。 | P0 | log schema test |
| NFR-OBS-002 | Health readiness | ready endpoint 必须检查 workspace、DuckDB、artifact dir、event store 和 watcher 状态。 | P0 | readiness test |
| NFR-OBS-003 | Alert thresholds | 磁盘、job stale、DuckDB、SMTP、WS reconnect、API latency 必须有告警阈值。 | P1 | alert rule tests |
| NFR-OBS-004 | Error evidence refs | 关键错误必须关联 evidence_refs，不允许只显示自然语言错误。 | P0 | negative tests |
| NFR-OPS-001 | Runbook coverage | 关键运维事故必须有诊断、恢复、升级和事后记录步骤。 | P1 | runbook drill |
| NFR-OPS-002 | Recovery idempotency | collect/export/notification/PI decision 的重复调用必须幂等。 | P0 | idempotency tests |
| NFR-SEC-001 | Secret redaction | 日志、artifact、report、email、audit 中不得出现 secret value。 | P0 | secret scan + redaction tests |
| NFR-REL-001 | Dependency lock | Bun/npm 依赖必须使用 lockfile 固定，并在 CI 检查 drift。 | P0 | lockfile check |
| NFR-REL-002 | Dependency update cadence | 依赖更新必须分 security patch、minor update、major upgrade 三类处理。 | P1 | update checklist |

---

## 4. Data / Governance / Integration Requirements

| ID | 类型 | 标题 | 需求陈述 | 优先级 |
|---|---|---|---|---:|
| DR-001 | Data | Artifact registry | 所有 report、visualization、log、metrics 引用的 artifact 必须有 manifest entry。 | P0 |
| DR-002 | Data | Retention policy | 大型输出、日志、exports、warehouse 数据必须有 retention_class。 | P1 |
| GR-001 | Governance | PI-only scientific approval | Agent/Worker/Reviewer 不得替代 PI 做科学结论批准。 | P0 |
| GR-002 | Governance | Scientific language guard | EvidenceReport 禁止使用“模型机制已验证”“普遍改进”等越权表述。 | P0 |
| GR-003 | Governance | PI decision comments | revision/reject/high-risk approve 必须有 comment。 | P0 |
| IR-001 | Integration | SHUD/rSHUD/AutoSHUD/Zero submodule lock | StackLock 必须记录四个 submodule commit 与 dirty state。 | P0 |
| IR-002 | Integration | SMTP optional integration | Notification 可以通过 SMTP/SendGrid，但失败不能回滚主流程。 | P1 |
| IR-003 | Integration | DuckDB warehouse | DuckDB 用作指标索引和运维聚合时必须可备份、恢复、重建。 | P1 |

---

## 5. Test Requirements

| ID | 覆盖内容 | 对应需求 | 优先级 |
|---|---|---|---:|
| TR-001 | Schema validation tests | FR-001, FR-002, DR-001 | P0 |
| TR-002 | WebSocket reconnect tests | FR-003, NFR-PERF-003 | P0 |
| TR-003 | Report guard tests | FR-004, GR-002 | P0 |
| TR-004 | PI decision negative tests | FR-006, GR-001, GR-003 | P0 |
| TR-005 | Health endpoint tests | FR-009, NFR-OBS-002 | P0 |
| TR-006 | Performance budget tests | NFR-PERF-001..006 | P1 |
| TR-007 | Runbook drill tests | NFR-OPS-001 | P1 |
| TR-008 | Dependency lock tests | NFR-REL-001 | P0 |
| TR-009 | Secret redaction tests | NFR-SEC-001 | P0 |
| TR-010 | Requirements coverage tests | GAP-REQ-001 | P1 |

---

## 6. Theory-to-Code Requirements (v0.8.3 补充)

> 编号策略：`FR-TC-*`、`GR-TC-*`、`TR-TC-*`、`NFR-TC-*`。详细内容见 `Theory_To_Code_Requirements_Addendum.md`。

### 6.1 User Stories

| ID | 角色 | 用户故事 | 优先级 | 验收标准 |
|---|---|---|---:|---|
| US-TC-001 | PI | 作为 PI，我希望任何物理方程或模型假设变更都有理论说明、公式、推导和代码映射。 | P0 | 高风险 ChangeRequest 必须引用 TheoryToCodeBundle |
| US-TC-002 | PI | 作为 PI，我希望能区分 verification、validation 和 calibration，避免校准结果被误写成结构验证。 | P0 | 报告包含三者定义；language guard 有负例 |
| US-TC-003 | 研究工程师 | 作为工程师，我希望公式项能追踪到代码文件、函数和变量，便于审查实现是否忠实。 | P0 | ImplementationMapping 包含 equation_id/symbol_id/code_target |
| US-TC-004 | Reviewer | 作为 Reviewer，我希望在 report reviewed 前检查推导、单位、实现映射和验证用例。 | P1 | Reviewer checklist 包含 theory-to-code lineage |
| US-TC-005 | PI | 作为 PI，我希望参数搜索只在理论/实现链路已审查后启动。 | P0 | AnalysisPlan search 前置检查 bundle status |

### 6.2 Functional Requirements

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---:|---|
| FR-TC-001 | 系统应支持 `TheoryToCodeBundle`，用于聚合 TheoryNote、EquationSpec、DerivationRecord、NumericalSchemeSpec、ImplementationMapping 和 VerificationCase。 | P0 | Zod schema + create/read API 可用 |
| FR-TC-002 | 系统应支持 `EquationSpec`，要求每个符号有 meaning、unit、dimension、可选 code_variable。 | P0 | 缺 unit 的关键符号不能进入 reviewed |
| FR-TC-003 | 系统应支持 `DerivationRecord`，记录推导步骤、使用的假设、未决问题和 PI 决策点。 | P0 | unresolved PI question 可触发 PI gate |
| FR-TC-004 | 系统应支持 `NumericalSchemeSpec`，记录离散化类型、state variables、flux/source terms、边界/初始条件和守恒期望。 | P0 | 至少可用于 SHUD finite-volume/ODE scheme |
| FR-TC-005 | 系统应支持 `ImplementationMapping`，把 equation_id/symbol_id 映射到 repo/file/function/block。 | P0 | Report lineage 可引用 mapping_id |
| FR-TC-006 | 系统应支持 `VerificationCase`，并能把其结果绑定到 RunRecord 和 artifact。 | P0 | verification passed/failed/inconclusive 可查询 |
| FR-TC-007 | 系统应阻止未通过 gate 的 `physical_equation` / `model_assumption` 变更进入 search/calibration。 | P0 | 负例测试返回 403/409/422 |
| FR-TC-008 | EvidenceReport 应包含 `Theory-to-Code Evidence` 章节，用于科学变更任务。 | P1 | report template 能渲染该章节 |
| FR-TC-009 | 系统应保存失败 verification 和失败 patch artifact，不能因为失败而丢弃证据。 | P0 | failed VerificationCase 仍有 artifacts/ref |
| FR-TC-010 | Controlled Search Loop 只能在 `accepted_for_search` 或更高状态的 bundle 上启动。 | P1 | AnalysisPlan preflight 校验 bundle status |

### 6.3 Governance Requirements

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---:|---|
| GR-TC-001 | Agent 不得把自己生成的 TheoryToCodeBundle 标记为 accepted。 | P0 | agent actor 调用 accept endpoint 返回 403 |
| GR-TC-002 | calibration improvement 不得作为 theory validation。 | P0 | language guard 负例测试 |
| GR-TC-003 | 修改物理方程、模型假设、默认参数物理意义必须 PI approval。 | P0 | high-risk ChangeRequest 自动生成 PiGate |
| GR-TC-004 | PI comment 可作为 hypothesis 或 decision evidence，但不得自动泛化成科学事实。 | P0 | MemoryNote generalization_allowed=false |
| GR-TC-005 | 验证通过只能证明实现满足指定验证用例，不证明模型结构普遍真实。 | P0 | report limitation 必须出现 |

### 6.4 Test Requirements

| ID | 测试需求 | 优先级 | 验收标准 |
|---|---|---:|---|
| TR-TC-001 | 缺少 EquationSpec 的 physical_equation ChangeRequest 不能进入 reviewed。 | P0 | API 返回 422 |
| TR-TC-002 | 缺少 ImplementationMapping 的 numerical_implementation ChangeRequest 不能进入 implementation_reviewed。 | P0 | API 返回 422 |
| TR-TC-003 | failed VerificationCase 仍然保留 RunRecord、logs、patch artifact。 | P0 | artifact registry 可查询 |
| TR-TC-004 | 未 accepted_for_search 的 bundle 不能创建 calibration/search AnalysisPlan。 | P0 | API 返回 409 |
| TR-TC-005 | Report line guard 拒绝"校准证明结构正确"。 | P0 | report cannot enter reviewed |
| TR-TC-006 | equation_id → code_target → test_id → RunRecord → report_id traceability 可生成。 | P1 | Traceability check 通过 |

### 6.5 Non-Functional Requirements

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---:|---|
| NFR-TC-001 | Theory-to-code schema 校验应在 P95 <= 300ms 内完成。 | P1 | performance test |
| NFR-TC-002 | Report lineage guard 对 tiny report P95 <= 5s。 | P1 | report test |
| NFR-TC-003 | Theory-to-code artifacts 应遵守现有 retention / immutability / cleanup guard。 | P0 | artifact registry test |
