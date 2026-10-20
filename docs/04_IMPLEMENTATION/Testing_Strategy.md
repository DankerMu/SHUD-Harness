---
status: frozen
---

# 测试策略

**状态：** P2 实施规范  
**适用范围：** schema、dsh 插件（策略门 / 作业后端 / 工具）、sandbox、SHUD fixture、report  
**目标：** 用分层测试保证 v0.8 端到端闭环可复盘。

> **排期语义（2026-10-20）**：测试按 [Phased_Plan v2](Phased_Plan.md) 的里程碑 M1–M6 分层，无日历周（ADR-0004）。
> **测试工具**：单元与集成测试用 vitest，类型检查用 `tsc`（各 `dsh-shud-*` 包，见 [Repository_Layout v2](Repository_Layout.md)）；SHUD/rSHUD fixture 用 bash/R 确定性脚本。

## 1. 测试分层

| 层级 | 测试对象 |
|---|---|
| unit | Zod schema、策略门纯函数、path policy、metric functions |
| integration | 插件 + filesystem、`ctx.jobs` 作业后端、Sandbox |
| fixture | ccw tiny 或 dummy SHUD run |
| report | EvidenceReport 生成和 language guard |
| e2e | 在 `dsh --profile shud` 对话中创建 task、运行 job、生成 report |

### 里程碑测试矩阵

| 里程碑 | 必须新增的自动化测试 | Fixture | CI 级别 |
|---|---|---|---|
| M1 | core schema 正反例、policy-gate 决策表、raw-guard 单测 + 5 探针、profile `--dump-config` 自检、docs link | schema-only | PR |
| M2 | `shud_run`/`shud_collect`、durable JobRegistry 落盘与对账、SIGTERM/SIGKILL 重启用例、RunRecord 产出 | dummy-runner + ccw tiny | PR（dummy）/ nightly·manual（ccw） |
| M3 | TaskCard 状态机、StackLock 三仓库 + llm 三字段、EvidenceReport 语言护栏与水印、PI decision 负例 | report fixture | PR |
| M4 | ChangeRequest/VerificationCase、openMP RHS 回放与 serial baseline 一致性、故意注入错误 patch 被拦截 | old-output | PR/nightly |
| M5 | AnalysisPlan OAT 批次、失败参数集可见、汇总表可复算 | dummy-batch | PR |
| M6 | 各项评估的一页文档链接检查 | none | PR |

Fixture 与命令矩阵见 [Test_Fixtures_And_Command_Matrix.md](Test_Fixtures_And_Command_Matrix.md)。原阶段测试计划 Phase_By_Phase_Test_Plan 与 CI 映射 CICD_Release 已删（见 tag archive/zero-v0.8.3）；CI 内容以 Phased_Plan v2 M1 为准。

## 2. Schema 测试

必须测试：

- TaskCard；
- StackLock；
- DataProvenance；
- RunJob；
- RunRecord；
- AnalysisPlan；
- EvidenceReport；
- ChangeRequest。

## 3. 传输层测试

（已删：自建实时传输层退场，ADR-0004 K2；dsh 会话流由基座测试。）

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
- `rivqdown` 序列进入 metrics/figure artifact。

## 6. Report 测试

应包含 language guard：

- 禁止“模型机制已验证”；
- 禁止“普遍改进”；
- 必须包含 limitations；
- 必须包含 PI questions；
- artifact 引用存在。

## 7. UI 测试

（已删：MVP 零自定义 UI，ADR-0004 K7。）

## 7.1 治理与支撑测试

（原 Notification / Report export / Batch progress 三组 UI 与 REST 用例已删，ADR-0004 K2/K7；通知随 ADR-0002 D7 转开放项。失败参数集可见性见 Sensitivity_Calibration_Benchmark_Addendum §10。）

### PI decision comment tests

- [ ] 普通 approve report 可无 comment。
- [ ] reject 无 comment 被拒绝。
- [ ] request_revision 无 comment 被拒绝。
- [ ] high-risk approve 无 comment 被拒绝。
- [ ] agent 身份无法提交 PI decision。
- [ ] 成功 decision 写 audit log 和 report decision history。

（MemoryNote 相关用例随 ADR-0004 K11 后移到记忆评估之后。）

### 补充测试类别

- **Support schema 测试**：Artifact、PiGate、NotificationRecord、ReportExport、AnalysisProgressPayload、ErrorRecord、AuditEvent 的 Zod 校验。
- **Artifact registry 测试**：evidence_usable 判定、retention_class 约束、manifest integrity 校验。
- **Idempotency 测试**：collect / export / notification / PI decision 重复请求不产生冲突对象。
- **重启恢复测试**：dsh 重启（SIGTERM / SIGKILL）后 parked job 经 durable JobRegistry 对账恢复（Phased_Plan M2）。
- **Runner adapter 测试**：local_direct / local_job 的 status mapping 和 collect result 格式。

> §8–10（Observability / Performance / Dependency 测试）已删（运维与性能 spec 退场，ADR-0004；原文见 tag archive/zero-v0.8.3）。后续章节编号不变。

## 11. Requirements tests

- requirement IDs unique；
- P0/P1 requirements have acceptance criteria；
- P0 requirements have test_ids before release；
- 文档内引用的 requirement ID 均存在于 Requirements_Catalog（Traceability_Matrix 已删，矩阵在 dsh 实现期按新模块重建）。

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
| TC-GATE-001 | physical_equation CR without bundle | 策略门 deny，remediation=open_gate |
| TC-GATE-002 | agent attempts accept bundle | 策略门 deny（agent 身份不得持 pi 角色） |
| TC-GATE-003 | high-risk approve without comment | PiGateDecision 校验拒绝（GR-003） |
| TC-MAP-001 | high-risk code target without equation_id | 策略门 deny |
| TC-VER-001 | passed verification missing artifact | cannot enter reviewed |
| TC-VER-002 | failed verification retains logs/artifacts | artifact query pass |
| TC-REPORT-001 | high-risk report missing Theory-to-Code Evidence | cannot enter reviewed |
| TC-REPORT-002 | calibration-as-validation phrase | language guard fail |
| TC-SEARCH-001 | search before accepted_for_search | 策略门 deny（bundle 状态不满足） |
| TC-SEARCH-002 | improvement claim without baseline | report guard fail |
| TC-TRACE-001 | equation_id → code_target → verification_case → run_record → report | traceability check pass |

### Fixture Strategy

- **schema-only fixture**: 用于 M1，不依赖 SHUD。
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
- [ ] dsh 重启后作业对账有自动测试（SIGTERM / SIGKILL 各一次）。
- [ ] 报告 language guard 有负例测试。
- [ ] Sandbox path policy 有越界测试。
