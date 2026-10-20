---
status: frozen
canonical_for: [requirements-catalog]
---

# SHUD-Harness Requirements Catalog

**状态**：v0.8.3 PRD 补充（含 Theory-to-Code addendum）  
**目标**：提供统一 FR/NFR/US/GR/DR/IR 需求目录，并与文档、实现和测试形成追踪链。  
**编号规则**：见 `Requirements_Numbering_Conventions.md`。

---

## 1. User Stories

| ID | 角色 | 用户故事 | 优先级 | 验收标准 |
|---|---|---|---:|---|
| US-001 | PI | 作为 PI，我希望在 dsh 对话中创建 SHUD 建模任务，并查看执行进度与结果报告。 | P0 | 能创建 TaskCard；能看到 RunJob 状态；能打开 EvidenceReport |
| US-002 | PI | 作为 PI，我希望长时间任务完成后即使浏览器关闭也能收到通知。 | P1 | collect/report/analysis 完成后产生 NotificationRecord；邮件失败不影响主流程 |
| US-005 | PI | 作为 PI，我希望审批时能留下科学判断批注，并纳入审计。 | P0 | PI decision 可带 comment；reject/revision/high-risk approve 必填 |
| US-008 | 系统管理员 | 作为管理员，我希望依赖版本被锁定并可审计，避免环境漂移。 | P0 | package manager 版本、lockfile、dependency audit、StackLock dependency summary 可用 |

> 已废弃（2026-10-20，ADR-0004 K2/K7）：US-003（HTML 导出——Markdown 报告文件是唯一产出，水印规则见 Report_Generation_Spec）、US-004（批进度 UI——由 dsh 作业卡 + AnalysisProgressPayload 承载）、US-006（健康端点——无自建服务）、US-007（运维 dashboard）。编号不复用；原文见 tag archive/zero-v0.8.3。

---

## 2. Functional Requirements

| ID | 标题 | 需求陈述 | 优先级 | 来源文档 | 验收标准 |
|---|---|---|---:|---|---|
| FR-001 | TaskCard 创建 | 系统必须允许在 dsh 对话中创建 TaskCard，并持久化到 workspace。 | P0 | Minimal_Schemas | 创建成功；Zod 校验；task 可重新加载 |
| FR-002 | RunJob 提交与收集 | 系统必须支持提交 RunJob、查询状态、收集结果并生成 RunRecord。 | P0 | Execution_Jobs_Runs | dummy runner 完整闭环通过 |
| FR-004 | EvidenceReport 生成 | 系统必须基于 RunRecord/artifact 生成 EvidenceReport，并保留 limitations 和 PI questions。 | P0 | Report_Generation_Spec | report guard 测试通过 |
| FR-006 | PI gate decision | 系统必须提供 PI gate decision 通道（dsh `ctx.approval`，ADR-0004），禁止 Agent 代替 PI 批准高风险决策。 | P0 | Auth_Permission_Design | agent 调用被拒；audit log 写入 |
| FR-008 | Out-of-band notification | 系统必须能在 collect/report/analysis 完成或 critical failure 时创建通知记录。 | P1 | Notification_Design | dedupe 生效；SMTP mock 成功/失败均可追踪 |
| FR-012 | RepoContextBrief | 系统应支持只读 Repo Explorer 为 code_change/debugging/cross-repo 任务生成仓库上下文简报。 | P1 | Agent_Architecture / Roles_and_Boundaries | Explorer 写操作被拒绝；Brief 包含 inspected refs、entrypoints、impact surface、tests、risks、unknowns |

> 已废弃（2026-10-20，ADR-0004 K2/K7，自建 Web/API/WS 与运维面退场）：FR-003、FR-005、FR-007、FR-009、FR-010、FR-011、NFR-PERF-001..008、NFR-OBS-001..004 及仅覆盖它们的 TR-002、TR-005、TR-006。编号不复用；原文见 tag archive/zero-v0.8.3。

---

## 3. Non-Functional Requirements

### Observability / Reliability / Operations

| ID | 标题 | 目标 | 优先级 | 验收标准 |
|---|---|---|---:|---|
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
| IR-001 | Integration | SHUD/rSHUD/AutoSHUD submodule lock | StackLock 必须记录三个 submodule commit 与 dirty state。 | P0 |

> 已废弃（2026-10-20）：IR-002（SMTP 通知，ADR-0002 D7 转开放项，M6 评估）、IR-003（DuckDB warehouse，运维聚合面退场，K2）。编号不复用。

---

## 5. Test Requirements

| ID | 覆盖内容 | 对应需求 | 优先级 |
|---|---|---|---:|
| TR-001 | Schema validation tests | FR-001, FR-002, DR-001 | P0 |
| TR-003 | Report guard tests | FR-004, GR-002 | P0 |
| TR-004 | PI decision negative tests | FR-006, GR-001, GR-003 | P0 |
| TR-008 | Dependency lock tests | NFR-REL-001 | P0 |
| TR-009 | Secret redaction tests | NFR-SEC-001 | P0 |

> 已废弃（2026-10-20）：TR-007（Runbook 演练，Operations_Runbook 已删）、TR-010（覆盖对象 GAP_ANALYSIS 已删；需求覆盖改由 Testing_Strategy §11 承担）。编号不复用。

---

## 6. Theory-to-Code Requirements (v0.8.3 补充)

> 编号策略：`FR-TC-*`、`GR-TC-*`、`TR-TC-*`、`NFR-TC-*`。原 `Theory_To_Code_Requirements_Addendum.md` 已并入本节（已删，见 tag archive/zero-v0.8.3）。

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
