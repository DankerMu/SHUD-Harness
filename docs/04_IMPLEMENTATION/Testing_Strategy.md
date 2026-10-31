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
| M3 | TaskCard 状态机、StackLock 三仓库 + llm 三字段、EvidenceReport 语言护栏与水印、PI decision 负例 | 1 成功 + 1 失败 RunRecord，带可解析 TaskCard/StackLock/DataProvenance 引用；无 metrics/figure/AnalysisPlan 产物 | PR |
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

M2 原生进程 fixture 的清理失败由共享测试诊断入口保留嵌套 `AggregateError.errors`、`Error.cause`、message/stack 与原错误引用，并在失败边界采集已知 pid/pgid 和 `ps` 的 pid/pgid/stat；不采集命令行、环境变量或 raw 内容。摘要有界且截断明确，原始错误仍经 cause 保留；快照不可得不会覆盖原错误，成功路径不新增诊断快照。默认 Vitest reporter 即可看到原因，无需自定义 reporter。

诊断不得重排清理或改变各面的 stop/continue 语义：detached 与 fault 用例已有的早期静止失败仍停止后续释放，原本收集错误后继续的 polling/cleanupResources 保持原样。body 或已观察的 pending 拒绝与 finally 清理失败同时可见；仅 body 失败时保留同一错误对象。#349 已捕获复现的成因是测试启动身份注入范围过宽，PR #351 已将其改为一次性；更早无 trace 的失败及其与 #313 的因果关系仍未知，不将后续通过称为消除所有间歇失败。此诊断修复不改生产 abort/所有权证明或共享 fixture 默认值。

持久化屏障 oracle（#471）须先准备真实 exit evidence 与门闩，再放行注册表的 timer 工作，随后让手动 tick 与已挂起工作重叠；只控制 interval，不冻结 Date、原生执行或 timeout。同一条目依次挂起初始 metadata 与发布前 metadata 检查，两处都证明仍为 running、未完成且终态写入尝试/成功数为零，同时另一条目可完成；释放后恰好一次尝试及成功写入。失败保留清理前阶段、门闩/写入计数、持久状态与有界错误摘要，原异常经 cause 保留。受控 RED 与旧 tail 先排空的 GREEN 对照证明：手动 tick join 已读到“无 exit、进程仍活”的旧工作足以触发原屏障判定，但不代表生产发布绕过；历史全量失败无 failing trace，成因仍未分类，不据此改生产调度器或声称已重建历史原因。

ccw fixture 按入口验收（完整布局见 [matrix §4](Test_Fixtures_And_Command_Matrix.md#4-ccw-tiny)）：

- 前置条件：已有已构建、可执行的 SHUD；fixture 不执行编译，缺失二进制明确失败。

独立 `shud:tiny`，默认 30 天 END 仅在输入副本更新：

- 30 天运行 exit_code=0；
- scratch 的 `output/ccw.out/` 有 `.dat` 产出；日志默认随 scratch 清理，`SHUD_TINY_KEEP=1` 可保留。

注册表路径及后续对象：

- 注册表路径（`shud_run` → collect）：成功运行 exit_code=0、RunRecord.status=succeeded，RunJob/RunRecord 与 stateDir 索引可追溯；独立 `shud:tiny` 不生成这些记录。
- `numerical_health.water_balance_residual` 在 M2 collect 中为 `null`，不作为 M2 通过条件；后续计算的阈值沿用 [既有阈值](../03_SPEC/SHUD_Output_Variables.md#13-阈值)（pass `<=0.01`），本节不确定其计算里程碑或生产者。
- `rivqdown` 序列进入 metrics/figure artifact（后续里程碑，非 M2；具体归属未定）；
- StackLock/DataProvenance 对象接线属于 [M3](Phased_Plan.md#3-m3-mvp-1)；M2 的 `stack_id` / `data_id` 为 null，不能与 RunJob/RunRecord 的已有追溯能力混为一项。

注册表的真实跨重启运行另由 `pnpm run shud:restart` 与 #318 PI 验收覆盖，不把 tiny 的 30 天设置套到这些入口。

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

## Enforcement Index

本索引是根指令要求实施、审查、提交前必须阅读并遵守的完整规则清单；以下路径均相对仓库根目录。

生成指令由 `pnpm run instructions:render` 更新；`pnpm run instructions:check`（默认 `docs:check` / CI docs-gate 的一部分）同时核对两份生成物字节，并从 `constraints.yaml` 的 `thresholds.agents_md_max_lines` 读取 AGENTS.md 行数上限，当前为 320。按 LF 计物理行，末尾未换行的非空行也计一行；配置缺失、非正整数或重复时失败，不使用默认值。CLAUDE.md 仅核对生成一致性，不施加该上限。

边界自证：`python3 scripts/instructions/test-render-line-budget.py` 以临时根目录实际渲染后检查，覆盖 320 通过 / 321 拒绝、配置阈值、CLAUDE 独立超限、缺失/非法/重复配置、末尾未换行与两份生成物漂移；CI docs-gate 与 `pnpm run test-guardrails` 均执行，Python 标准库即可，无须安装 Node 依赖。

| 规则 | 位置 | 校验 | 级别 |
|---|---|---|---|
| 禁止并行版本后缀 | `.git-hooks/check-naming.sh`，`constraints.yaml` naming | pre-commit；CI `pnpm run naming:check` | block |
| 文件 ≤1000 行（policy-gate 拆分后无大小/类型安全豁免） | `eslint.config.mjs`，`.large-file-guard.json`，`constraints.yaml` baseline | pre-commit lint-staged / large-file-guard；CI `pnpm run lint` | block |
| type-aware lint，禁 import dsh 内部路径 | `eslint.config.mjs`，`tsconfig.eslint.json` | pre-commit；CI `pnpm run lint` | block |
| 交付文件格式；本地 `.workplans/` 不在发现范围 | `.prettierrc.json`，`.editorconfig`；`.gitignore` 的 `/.workplans/` 由 Git/Prettier 共用 | pre-commit；CI `pnpm run format:check` | block |
| 类型 | `tsconfig.base.json` | CI `pnpm run typecheck` | block |
| 测试 + 覆盖率 ≥80% | `vitest.config.ts` | CI `pnpm run test:coverage` | block |
| 重复 ≤3% | `.jscpd.json` | CI `pnpm run dup` | block |
| 死代码/未用依赖（duplicates 为 error，无重复导出豁免） | `knip.json` | CI `pnpm run deadcode` | block |
| Schema 生成物无漂移 | `scripts/schema/check.sh` | CI `pnpm run schema:check` | block |
| 文档链接 + 路径声明 + 生成指令 + 决策记录 | `scripts/docs/`，`scripts/instructions/render.sh`，`scripts/adr/verify.sh` | CI `pnpm run docs:check` | block |
| 密钥 | gitleaks | pre-commit；CI `pnpm run security:secrets` | block |
| SAST | semgrep | CI `pnpm run security:sast` | block |
| PR ≤400 行（label `size-exempt` 记录；标签增删完整 CI 重评） | `scripts/guardrails/pr-size.sh` | CI `pnpm run pr:size` | block |
| Conventional commits | `commitlint.config.mjs` | commit-msg | block |
| 锁文件干净、不拉 dsh | `pnpm-workspace.yaml` | CI lint/test jobs install with frozen lockfile | block |
| 单一必需检查（依赖 job 非 success 均失败） | `.github/workflows/ci.yml` all-checks-passed / `scripts/guardrails/aggregate-checks.sh` | GitHub rulesets；`pnpm run test-guardrails` 正反例 | block |
| 越界动作（no-verify、force-push、dsh/raw 写、生成物手编） | `scripts/guardrails/no-bypass.sh`（`.claude/settings.json` 与 `.codex/hooks.json` 共用） | pre-commit 等价：agent PreToolUse hook | block |
| 本次触碰 >1000 行文件 | `.claude/hooks/large-file-guard/large-file-guard.sh` | pre-commit 等价：agent hook on git commit | block |
| 闸自证 | `scripts/guardrails/test-guardrails.sh` | 本机 `pnpm run test-guardrails` | block |
| dsh profile 路由 / 出站关闭 | `scripts/runtime/profile-smoke.sh` | 本机 + CI `pnpm run profile:smoke` | block |
| raw-guard 五探针 / raw 字节不变 | `scripts/runtime/raw-guard-probes.sh` | 本机 `pnpm run raw-guard:probes`（需 `DMXAPI_KEY`；exit 2 = 模型偏离须重跑） | block |
| ccw tiny 闭环 | `scripts/runtime/shud-tiny.sh` | 本机 `pnpm run shud:tiny` | block |
| ccw 重启恢复 / 五条作业不变量 | `scripts/runtime/shud-restart.sh` | 本机 `pnpm run shud:restart`（需 SHUD 与 `DMXAPI_KEY`；SIGTERM / SIGKILL 两用例，通知必须 delivered） | block（本机） |
| 首任务调用链 / 报告审批与文件联合判据 | `scripts/runtime/shud-first-task.sh` | 本机 `pnpm run shud:first-task <scratch-workspace>`（需 SHUD 与 `DMXAPI_KEY`；独立 Web profile，审计与文件同时通过；CI 不运行，自动 Allow once 不代替 PI 验收） | block（本机） |
| 物理方程/默认参数/baseline 改动需 PI | policy gate `ask` | 运行时审批卡 + 决策表测试 `pnpm run test` | gate |
| PI 功能验收（Epic #210 / M3 Epic #423 在 Epic 收口，其余在 merge 前） | GitHub PR / Epic | GitHub rulesets（PR required）+ PI 亲自操作与明确验收记录；工程门禁及运行时审批权限不变 | gate |
| 不 import dsh loop 内部（seam 白名单，M1 起） | `eslint.config.mjs` | `pnpm run lint`（`no-restricted-imports` 白名单） | block |
| docs 随代码改 | PR 模板 | review-only | review-only |
| 科学措辞规则（测试常量与枚举短语 lint） | `packages/dsh-shud-core/src/governance/wording.ts` 及其测试 | `pnpm run test`（纳入默认 `check`）；报告门禁的机器边界为四句不变式逐字出现且模型撰写字段无禁止短语，完整报告校验器另行交付；guard 通过 ≠ 语义合规，仍由 PI 审阅 | block |
| 运行时不变量伴生（M2 作业持久化） | `CONTEXT.md` 第 13 条及其 `packages/dsh-shud-jobs/src/` 集成测试路径 | 本机 + CI `pnpm run test:coverage`（纳入 `pnpm run check`）；本机独立 `pnpm run shud:restart` | block |
| dsh 升级只走 issue | 流程 | review-only | review-only |
