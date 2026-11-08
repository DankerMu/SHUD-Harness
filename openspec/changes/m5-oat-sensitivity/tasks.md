# Tasks

合入顺序按依赖，不按组号；与 design.md「Migration Plan」一致：1.1a → 1.1b → 1.2 → 2.5 → 2.1 → 2.2 → 2.3 → 2.4 → 3.0 → 3.1 → 3.2a → 3.2b → 3.2c → 3.2d → 3.3 → 3.4 → 3.5 → 3.6a → 3.6b → 3.6c → 4.1a → 4.1b → 4.1c → 4.2 → 5.1 → 5.2a → 5.2b → 5.3 → 5.4 → 6.1 → 7.1a → 7.1b → 7.1c → 7.1d → 7.2 → 8.1。1.2 按 PI 2026-11-07 明确决定提前（ADR-0015），不再依赖 7.2。各任务写明的"依赖"是硬前置；没写依赖的切片只受上述顺序约束。fixture level 的词表以 `subagent-workflow` 的 `issue-risk-contract.md` 为准。需求名一律引用 `specs/*/spec.md` 中 `### Requirement:` 的原文。每个切片都要求 `pnpm run check` 本机绿；触及 Zod 的切片执行 `pnpm run schema:generate`；触及 `instructions/agents/*` 的切片执行 `pnpm run instructions:render`；触及 Critical Paths 的切片附 reviewer 子代理白盒审查记录。`shud:replay` 的 oracle 会在 3.6b、4.1a、4.2 各改一次，每次都附本机重跑证据。

## 1. 规范文档对齐与决策记录（design D15）

- [x] 1.1a 数据与规格文档对齐（#640 / PR #678；RIV_ROUGH 事实纠错 #680 / PR #681）：
  - `docs/03_SPEC/Minimal_Schemas.md`：§6 AnalysisPlan 改为品牌 id `PLAN-<UTC>-xxxx` 与 D1 字段（含 `threads`、`input_digests`）；§5 RunRecord 写入 `artifacts.metrics_summary`；RunJob/RunRecord 加入 `analysis_plan_id`/`parameter_set_id`；TaskCard 加入 `linked_analyses`；EvidenceReport 加入 `analysis_ids`/`sensitivity_summary`。
  - `SHUD_Output_Variables.md`：§11–§13 写入 D7 公式（含区间平均近似与 null 原因词表）、D8 四项来源与 `max_solver_dt` 不可观测声明；§12 的 `metrics.yaml` 改为 `metrics.json`；§11 负状态列表与 §12 储量/输出行去掉 `lakystage`/湖泊项（D15(10)）。
  - `Parameter_Set_And_Analysis_Run_Mapping.md`：ParameterSet 状态不持久化；不建 batch_policy；pset id `PSET-1..5`；plan 单文件 `analyses/<id>.json`；`changes` 键为 calib 白名单键。
  - `Sensitivity_Calibration_Benchmark.md` 与 `_Addendum.md`：M5 落地范围与 Non-Goals。
  - `Scientific_Change_Gating_Spec.md` §1.2：以白名单常量落地，未登记键 fail-closed。
  - `Domain_CLI_Spec.md` §2.2：M5 不采用 Rscript CLI。
  - `Execution_Jobs_Runs.md`：numerical_health 的生产者由 Domain CLI `wb --health` 改为 collect 内计算（与 Domain_CLI §2.2 同类偏离）。
  - 每处偏离按 design D15(1)–(10) 登记。
- [x] 1.1b 架构、计划与术语文档对齐（依赖 1.1a；#641 / PR #679）：
  - `docs/02_ARCHITECTURE/Agent_Architecture.md` §7 sensitivity 谓词措辞（"每个成功的有效 run 有 metrics"取代"sensitivity_table artifact 存在"）。
  - `docs/03_SPEC/Report_Generation_Spec.md` §2/§5（含"M3 没有 metrics/图表/AnalysisPlan 生产者"一段与 §5 固定说明的刷新）。
  - `docs/04_IMPLEMENTATION/Phased_Plan.md` 新增 M5 节（验收门引用 oat-sensitivity「Sensitivity acceptance criteria」，不复制判据）。
  - `openspec/glossary.md`：AnalysisPlan / 分析计划、parameter set、有效 run、覆盖声明。
  - 用 `gh issue edit` 把 #422 正文改写为"由 M5 change `m5-oat-sensitivity` 交付"，并链接本 change（不关闭）。
  - 核心对象计数**不在本刀改**（导出发生在 2.1，在那之前改会写错事实）。
- [x] 1.2 按 PI 2026-11-07 明确选择提前起草并接受 M5 流程 ADR-0015：仅限 M5 Epic；子 PR 经完整工程门与审查后可合并；功能仍在 Epic 收口时由 PI 在 Web 亲自验收。流程 accepted 不等于功能通过，不提前关闭 #639/#422/#675 或归档 change。满足 oat-sensitivity「Epic-close PI acceptance for sensitivity」登记部分；本次 PI 决定取消原 7.2 前置，并同步控制面与 #674/#675 时序。
- Suggested fixture level: none - 只有规范、计划与决策记录文档，没有产品代码
- Minimal mergeable slice: 1.1a 首刀；1.1b 依赖 1.1a；1.2 按 PI 显式决定提前为独立流程登记切片，须先于代码子 PR 的工程合并，功能验收仍归 8.1

## 2. core：schema、品牌 id 与常量（Critical Path #1/#7）

- [x] 2.1 AnalysisPlan schema（含 `threads`、`input_digests`）与品牌 id `AnalysisPlanId`（复用 run-identifiers 生成器）。满足 analysis-plans「Analysis plan identifier」「AnalysisPlan record」「AnalysisPlan generated projection」与 engineering-gates「New core objects participate in schema drift gate」；`schema:generate` 刷新 `docs/generated/`（依赖 2.5）。同一刀把核心对象计数统一为 10 个当前导出的 schema（TaskCard、StackLock、DataProvenance、RunJob、RunRecord、EvidenceReport、ChangeRequest、VerificationCase、BuildRecord、AnalysisPlan）：
  - `CONTEXT.md:14` 的「Core objects（8 对象）」行改为「10 对象」，并按上述 10 个名字重列（现行行漏了 VerificationCase/BuildRecord，且在导出之前就列入了 AnalysisPlan）；
  - `packages/dsh-shud-core/package.json:4` 的 `description`（"9 exported core-record Zod schemas"）；
  - `docs/04_IMPLEMENTATION/Repository_Layout.md` 中 `src/schemas/` 行的"8 对象 Zod schema"注释；
  - `openspec/project-profile.md`、`instructions/agents/shared.md`，经 `instructions:render` 生成 AGENTS.md/CLAUDE.md。
  - 判定规则："当前导出的核心记录 schema 数"只在上面五处陈述，本刀把它们改为 10。其余"8 对象"措辞分两类，均不改：
    - v0.8 概念集合的术语（指 v0.8 规格定义的 8 个核心对象，不是导出计数）：`Minimal_Schemas.md` 支撑对象节、`Support_Schema_Contracts.md`、`Context_Trust_And_Injection_Spec.md`、`docs/00_INDEX/Theory_To_Code_Rationale.md`、`docs/00_INDEX/Doc_Disposition_*`；
    - 记录当时状态的历史描述：`Port_List.md` 的移植行、`Phased_Plan.md` 的 M1 交付行、`UI_Implementation_Spec.md` 的命名定案、`Migration_Plan_dsh.md`、`docs/adr/implemented/`、`docs/05_PROPOSAL/`。
    - 实现时以 `git grep -nE "8 ?(个)?(核心)?对象|9 个当前导出|9 exported"`（排除 `docs/generated`、`docs/99_ARCHIVE`、`openspec/changes`）复核：命中只能落在上述两类或已改的五处。
- [x] 2.2 RunJob/RunRecord 增加 `analysis_plan_id`、`parameter_set_id`（缺键按 null，iff refine）；RunRecord 启用 `artifacts.metrics_summary`（`plots` 仍拒绝）。满足 run-records「RunJob record」「RunRecord record」「Generated projection」；附 M2–M4 旧记录解析回归（依赖 2.1）。
- [x] 2.3 TaskCard `type: sensitivity` 与 `linked_analyses`（缺键按 `[]`，refine：非 sensitivity 卡为空）。满足 task-cards「TaskCard record」「TaskCard generated projection」（依赖 2.1）。
- [x] 2.4 EvidenceReport 增加 `analysis_ids` 与 `sensitivity_summary`（缺键默认值与 iff refine）。满足 evidence-reports「EvidenceReport record」「EvidenceReport generated projection」（依赖 2.1）。
- [x] 2.5 governance 常量：
  - calib 白名单：4 键；`read_transform`（KSATH/KSATV `/1440`，LC_ROUGH `/60`）、`check_range`、倍率区间，以及键 → 类别文件映射，逐条附 SHUD 源码 file:line（analysis-plans「Calib whitelist and category product check」的常量部分）。
  - `NUMERICAL_HEALTH_THRESHOLDS`（residual 0.01/0.05；cvode 0；negative 按 §13：0/≤10/>10）与 metrics `method_version`（run-metrics「Numerical health verdicts」的常量部分）。
  - 确定性 limitation 模板常量（evidence-reports「Deterministic report limitations」的常量部分）。
  - 每条常量配正反例与边界测试（negative 10→warn、11→fail）。
  - 不改 `CODE_CHANGE_SECTION5_WORDING`（随 3.6b 一起改）。
  - 本刀是第 2 组首刀，排在 2.1 之前。
- Suggested fixture level: expanded - 共享 schema 单源、生成投影与治理常量（Critical Path #1/#7）
- Minimal mergeable slice: 2.5 首刀（治理常量没有消费者，可独立保绿）；2.1 依赖 2.5（plan schema 的 refine 与投影要用白名单键集、倍率区间与键 → 类别文件映射）；2.2、2.3、2.4 都依赖 2.1，彼此独立

### Issue #646 risk packs and executable evidence

| Pack | Selection and evidence |
|---|---|
| Public API / CLI / script entry | Selected: built core import calls classifier and coverage instantiator with the issue's exact expected results; no new CLI |
| Config / project setup | Not selected: no profile, dependency or toolchain changes |
| File IO / path safety / overwrite | Not selected for runtime: no new runtime IO; generator reuses existing guarded publication, unchanged path-safety self-tests |
| Schema / columns / units / field names | Selected: four keys/table/column/transform/range tied to pinned SHUD source; KSAT divisor1440, both roughness divisors60; nested mutation rejected |
| Auth / permissions / secrets | Selected: whitelist remains closed/frozen, no runtime override or additional scan exemption; no credential access |
| Concurrency / shared state / ordering | Not selected for concurrency: pure functions only; coverage test preserves non-baseline pset order without mutating input |
| Resource limits / large input / discovery | Not selected: no discovery/unbounded external inputs; plan consumer's 3–5 pset validation belongs to #642 |
| Legacy compatibility / examples | Selected: existing wording and semantic-floor tests retained; CODE_CHANGE_SECTION5_WORDING and existing generated files unchanged |
| Error handling / rollback / partial outputs | Selected: null maps to not_available; max_solver_dt excluded from classifier type and unsupported runtime key rejected rather than silently classified |
| Release / packaging / dependency compatibility | Selected: minimal public core exports and built-package smoke, no deep-import convention or new dependency |
| Documentation / migration notes | Selected: generated whitelist reflects source; isolated copied repo changes multiplier without regeneration and actual schema:check rejects; restore fixture and check passes |

Required behavior evidence: residual 0.01/0.0100001/0.05/0.0500001 → pass/warn/warn/fail; negative 0/1/10/11/null → pass/warn/warn/fail/not_available; cvode 0/1/null → pass/fail/not_available. Exact ccw/90 four-pset coverage sentence and fixed templates2/3 match the requirement; six templates pass the existing forbidden-phrase scanner without becoming exemptions. Verify all cases through public functions, not copied constant snapshots. Preserve semantic red-before/green-after evidence for new behavior, then run full default gate and generator negative control once integration is complete.


## 3. records：输入读取、metrics、plan 文件层、closure 与报告（Critical Path #6/#7）

- [x] 3.0 共享 SHUD 文本输入安全读模块：`.sp.mesh/.sp.att/.sp.riv/.para.geol/.para.lc/.cfg.para/.cfg.calib/.cfg.ic` 的解析，加上普通文件/不逃逸/`O_NOFOLLOW` 读取，并在同一次读取内算 sha256。这是唯一实现，3.2/3.3/7.1 一律 import 它，不另写。满足 run-metrics「SHUD binary output read contract」中的文本输入部分（依赖无；用 ccw 真实文件做夹具）。
- [x] 3.1 SHUD 二进制 `.dat` 读取器：布局校验、截断与 NaN、安全读、同一次读取内算 sha256、只接受小端。满足 run-metrics「SHUD binary output read contract」的 `.dat` 部分。
- [ ] 3.2a 逐 run 流量指标、numerical_health 中非水量平衡的三项、判定与 `metrics.json` 确定性序列化：
  - 出口集合；`peak_flow_m3d`/`peak_day`/`total_runoff_m3`；Δ 由时间列推导；`cvode_failures`；`negative_state_count`（任一文件缺失则整项 null）；`max_solver_dt` 恒为 null 且不进 verdicts。
  - status `ok|unavailable` 语义；两次计算逐字节相同。
  - `metrics.json` 的安全读与 sha256 绑定读取器（唯一实现；3.4 closure 与 3.6b 渲染都 import 它）。
  - 满足 run-metrics「Per-run flow metrics」「Numerical health producers」「Numerical health verdicts」「Metrics file shape and determinism」（依赖 3.0、3.1、2.5）。
- [ ] 3.2b O1 事实核查与系数常量：对照 SHUD 源码核实 `eleysnow`/`eleyic` 的单位，以及 `.cfg.ic` Canopy/Snow 的口径；把两项系数登记为 core 常量（附 file:line），并写入 `SHUD_Output_Variables.md`。满足 run-metrics「Water balance residual」中的系数常量部分（依赖 2.5）。
- [ ] 3.2c 水量平衡 rSHUD 共有项：P、Qd、AET、ΔS_surf/us/gw/riv 的分项计算（面积、孔隙率、河道面积、IC 读取）；合成迷你项目夹具与小 `.dat` 写出器；本机一次性生成脚本 `scripts/metrics/rshud-crosscheck.R` 与入库的 `expected-rshud.json`。满足 run-metrics「rSHUD cross-check fixture」与 engineering-gates「rSHUD cross-check generator is local-only」（依赖 3.0、3.2a）。
- [ ] 3.2d 积雪/截留扩展项与残差汇总：ΔS_snow/ΔS_ic（使用 3.2b 的常量）；`water_balance_residual`；`zero_precipitation`/`missing_variable`/`ic_shape_mismatch`/`missing_calib`/`interval_undetermined` 等 null 原因；积雪与截留用手算夹具覆盖。满足 run-metrics「Water balance residual」（依赖 3.2b、3.2c）。
- [ ] 3.3 AnalysisPlan 工作区文件层（`analyses/<id>.json` 排他创建、只读解析、id 绑定）；calib 类别表乘积校验（键缺失或重复即拒绝，越界时点名行 index）；`input_digests` 与乘积校验取自同一次读取。满足 analysis-plans「AnalysisPlan workspace file」与「Calib whitelist and category product check」的校验部分（依赖 2.1、2.5、3.0）。
- [ ] 3.4 sensitivity closure 谓词：恰好一个 plan；作业全部绑定该 plan 且全部终态；有效 run 规则；baseline 必须 succeeded；同一 `stack_id`；metrics `status: ok` 且 sha256 匹配。本刀只新增 sensitivity 谓词，不改 science_assist/code_change。满足 task-cards「sensitivity closure predicate」与「TaskCard workspace file」（依赖 2.2、2.3、3.2a、3.3）。
- [ ] 3.5 汇总表派生与报告文件层：
  - `SensitivitySummary` 构造：`_pct` 以 baseline 为分母，分母为 0 时给 null；`delta_peak_day` 为差值。
  - 在报告 JSON 提交之前写 `reports/<report_id>.sensitivity.json`；孤立 summary 保留；三类报告文件任一已存在即重分配 report_id。
  - 满足 evidence-reports「Sensitivity summary derivation」「Report write order and repair」与「Report workspace files」的 `.sensitivity.json` 部分（依赖 2.4、3.2a、3.4）。
- [ ] 3.6a Citation existence check 识别 `PLAN-` 令牌，并按安全读解析 `analyses/<id>.json`。满足 evidence-reports「Citation existence check」（依赖 2.1、3.3）。
- [ ] 3.6b 非 sensitivity 报告切换为指标渲染（一刀完成，不留中间态）：
  - science_assist/code_change 的"无指标 artifact"自动 limitation 与 `metric_fact` 恒真特例删除。
  - §5 渲染逐 run 指标表（值原样输出最短往返串，null 用固定记号）。
  - `report_generate` 追加阈值派生 limitation 与 `max_solver_dt` 固定 limitation（`report-generate.ts` 的追加点）。
  - `CODE_CHANGE_SECTION5_WORDING` 删去"本里程碑无指标 artifact；"分句。
  - science_assist/code_change 黄金文件。
  - 同一切片中更新 `shud:first-task` 与 `shud:replay` 的 §5 文本 oracle，并附本机重跑证据。
  - 「Report workspace files」的 `metrics.json` 渲染输入部分（经 3.2a 的读取器安全读、sha256 核对、缺失时 `not_available`）归本刀。
  - 本刀早于 4.2：真实 run 还没有 `metrics.json`，§5 表各值按 null 记号加原因渲染。因此本刀 oracle 只断言表结构与旧固定句消失，指标非 null 的断言由 4.2 加入。
  - 满足 task-cards「science_assist closure predicate」，evidence-reports「Deterministic facts table」「Report template」「code_change report wording constant」「Deterministic report limitations」的非 sensitivity 部分，以及 agent-presets「Local first-task acceptance script」与 known-answer-replay「Replay acceptance criteria」的报告文本部分（依赖 2.5、3.2a）。
- [ ] 3.6c sensitivity 报告渲染与校验：Δ 汇总表；失败 cell 行；被取代 run 按 `linked_jobs` 顺序列出；覆盖声明与"agent 建议值"；`report_validate` 第 16/17 项（含工具描述中的检查项计数）；sensitivity 黄金文件；`docs/03_SPEC/Report_Generation_Spec.md` 中检查项计数 15 → 17 及 (4)(10)(11) 的 M3 恒真表述随代码刷新。满足 evidence-reports「report_validate」与「Deterministic report limitations」「Report template」的 sensitivity 部分（依赖 3.5、3.6a、3.6b）。
- Suggested fixture level: expanded - 文件格式读取器、持久化文件、closure 谓词与报告措辞护栏（Critical Path #6/#7）
- Minimal mergeable slice: 3.0 首刀（共享读取器没有消费者，可独立保绿）；3.1 独立；3.2a 依赖 3.0/3.1；3.2b 只依赖 2.5；3.2c 依赖 3.2a；3.2d 依赖 3.2b/3.2c；3.3 依赖 3.0；3.4 依赖 3.2a 与 3.3；3.5 依赖 3.4；3.6a 依赖 3.3；3.6b 依赖 3.2a；3.6c 依赖 3.5、3.6a 与 3.6b

## 4. jobs：提交重写与 collect 内 metrics（Critical Path #4）

- [ ] 4.1a 所有提交都在副本 `.cfg.para` 中确保 `DT_YE_IC 1440`（字节保真，多行全部改写，末行无行尾时先补行尾），在 provenance 之前完成，失败按既有回滚。
  - `shud-end.ts` 原地重构为 `shud-cfg-rewrite.ts`，不保留旧文件；同一刀更新全部引用：`packages/dsh-shud-jobs/src/shud-submissions.ts:17` 的 import、`shud-end.test.ts` 随之改名为 `shud-cfg-rewrite.test.ts`、`shud-end.ts:27` 的 Usage 字符串、`scripts/runtime/shud-tiny.sh:19`、`knip.json` entry、`docs/01_CODEBASE/SHUD_IO_Facts.md:68`、`docs/04_IMPLEMENTATION/Runtime_Lifecycle.md:63`。
  - 同一切片中更新 `shud:replay` 的副本 provenance oracle（运行副本与准备后输入只差 `DT_YE_IC` 一行）。
  - 验证：`pnpm run check`、`pnpm run shud:tiny`、本机 `shud:replay` 重跑（rivqdown bitwise 不变）。
  - 满足 shud-run-jobs「Shud job submission」的 DT_YE_IC 部分、shud-run-tools「shud_run arguments」的回放副本场景、known-answer-replay「Replay acceptance criteria」的副本部分。
- [ ] 4.1b 绑定 plan 的提交事务：
  - 内部请求接收已解析的 calib 覆盖、plan/pset id、threads 与 `input_digests`。
  - 复制之后、任何重写之前核对副本摘要，不等即回滚。
  - 副本 `NUM_OPENMP` 改写为 plan `threads`。
  - 副本 `.cfg.calib` 单键重写（恰好一行，数值为最短往返表示），在 provenance 之前完成。
  - `run-job.json` 首次写入即带 plan/pset id 与 threads；后续状态写入与 collect 原样继承，RunRecord 带同样的两个 id（run-records「RunRecord record」的继承场景）。
  - 满足 shud-run-jobs「Shud job submission」的重写与摘要部分（依赖 2.2、2.5、4.1a；2.5 提供注册表预检用的 calib 白名单）。
- [ ] 4.1c pset 重复提交检查：注册表在同步 id 占用点检查在途提交与已登记作业；并发时至多一个被接受；失败、取消、收集耗尽或回滚之后可以重提。满足 shud-run-jobs「Shud job submission」的重复检查部分（依赖 4.1b）。
- [ ] 4.2 自动 collect 内计算 metrics：
  - 只对 `exit_class: ok` 的 run 计算；写 `metrics.json` 并填 `metrics_summary` 与 numerical_health。
  - 失败隔离：unavailable 由 run-metrics 判定，不写 `collect-error.json`、不计次；`metrics.json` 写失败时字段为 null；非 ok run 不写；已有 RunRecord 时幂等，不改写。
  - 同一切片中：
    - 更新 `shud:first-task` oracle（ccw run 的 numerical_health 三项非 null）与 `shud:replay` oracle（keliya residual 为 null，原因 `missing_variable`）；
    - 重跑 `shud:first-task`、`shud:replay`、`shud:restart`（SIGTERM/SIGKILL 两用例全长 ccw，`delivered` 判据不放宽），附三份本机证据；
    - 全长 run 的 collect 耗时写进 PR。
  - 满足 shud-run-jobs「Automatic collect」、run-metrics「Metrics computed at collect」，以及 agent-presets「Local first-task acceptance script」与 known-answer-replay「Replay acceptance criteria」的 metrics 部分（依赖 2.2、3.2d、4.1a）。
- Suggested fixture level: expanded - 提交事务、回滚、持久化文件与并发 id 占用（Critical Path #4）
- Minimal mergeable slice: 4.1a 首刀（只改输出开关及其引用面，以 tiny 和回放证据收口）；4.1b 依赖 4.1a、2.2 与 2.5；4.1c 依赖 4.1b；4.2 依赖 4.1a、2.2 与 3.2d，不依赖 4.1b/4.1c

## 5. raw-guard、tools 与 policy-gate（Critical Path #2/#3）

- [ ] 5.1 raw-guard：治理根写保护集加入 `analyses`；`analysis_create` 固定输出根（`analyses/` 与卡片回写目标）的保护；`analysis_create` 读 raw 内 `input_dir` 时按 `shud_run` raw 输入的判定发起 ask。满足 raw-data-guard「Governance roots are write-protected from model file and shell tools」「Analysis plan creation protects its fixed output root」。
- [ ] 5.2a `analysis_create` 工具本体并挂载，暂不对任何角色暴露：
  - strict 参数（含 `threads`）；卡片校验；防重扫描与孤立 plan 修复；乘积校验与 `input_digests`；排他写入；卡片回写与失败错误；返回 plan id 与 pset 列表。
  - 挂载到 `dsh-shud-tools`，不列入任何角色的 inherited，所以 restrict 隐藏、policy-gate deny，可独立保绿。
  - 满足 analysis-plans「analysis_create」、task-cards「TaskCard links」的 `analysis_create` 回写部分（含回写失败场景）与 shud-run-tools「Report and task tools are mounted by dsh-shud-tools」（依赖 2.3、3.3、5.1）。
- [ ] 5.2b 暴露给 coordinator：
  - role-tool-map 中 coordinator 增加 `analysis_create`；presets 精确工具面测试夹具；policy-gate 角色面 deny 与"不发起审批"回归。
  - Web 工具面证据：本机 Web 会话 header 的 `tools` 列表含该工具（仅 coordinator），session log 路径写进 PR。
  - 必须在 5.2a 之后：inherited 含未挂载名时会 fail-loud。
  - 满足 policy-gate「Role tool surface rule」「Sensitivity tools do not ask」与 agent-presets「Role tool map uses mounted names」「Role tool surface restriction」（依赖 5.2a）。
- [ ] 5.3 `shud_run` 的 plan 绑定：
  - 成对参数且必须带 `task_id`；只按 id 解析 plan；`linked_analyses` 检查放在卡片读取的同步边界内；sensitivity 卡不带 plan 参数即拒绝。
  - `task_id`/`input_dir` realpath/`project`/`end_days` 必须相等，`end_days` 缺省取 plan 值。
  - `threads` 取 plan 值（省略时用 plan 值，不等即拒绝）。
  - 向注册表传递覆盖、threads 与 `input_digests`；不接受模型传入的 calib 值。
  - 满足 shud-run-tools「shud_run arguments」的 plan 绑定部分（依赖 4.1c、5.2b）。
- [ ] 5.4 sensitivity 卡入口：`task_create` 接受 `sensitivity`（不访问 `repos/`）；卡片链接写入方包含 `analysis_create`；`report_generate` 接受 sensitivity 卡，写入 `analysis_ids`/`sensitivity_summary`。满足 task-cards「task_create」、「TaskCard links」的唯一写入方与 reconcile 不补链部分，以及 evidence-reports「report_generate」（含 sensitivity 入口接线与确定性 limitation 追加；依赖 3.6c、5.2b）。
- Suggested fixture level: expanded - 模型可见工具契约、原始数据保护、角色权限与工作区写入（Critical Path #2/#3）
- Minimal mergeable slice: 5.1 首刀（raw-guard 是独立包，没有工具依赖，必须先于 `analysis_create` 挂载）；5.2a 依赖 5.1；5.2b 依赖 5.2a；5.3 依赖 5.2b 与 4.1c；5.4 依赖 5.2b 与 3.6c，与 5.3 互不依赖

## 6. presets：sensitivity 编排 prompt

- [ ] 6.1 coordinator 与 worker 的 prompt 增加 sensitivity 流程：建卡 → `analysis_create` → 委派 worker → sensitivity 卡上一律带 `analysis_plan_id`+`parameter_set_id` 提交 → 显式 `job_output(wait)` + `shud_collect` → 失败如实汇报、不自行重提 → 报告三步。M3 的无 plan 路径只用于 science_assist。更新 `prompts.test.ts`。不新增 preset 或委派工具，`profile:smoke` 断言不变。满足 agent-presets「Preset system prompts」「sensitivity orchestration」（依赖 5.3、5.4）。
- Suggested fixture level: compact - prompt 资产与其测试，不新增工具面或 profile 行
- Minimal mergeable slice: atomic - 两份 prompt 同属一个编排流程，分开合并会出现 coordinator 委派了 worker 却不认识的步骤

## 7. 验收脚本与控制面登记

- [ ] 7.1a 工作区准备：复制 `SHUD/input/ccw`，前置缺失时明确失败，并记录源输入 md5 与 `input_digests` 基线；附单测。满足 oat-sensitivity「Sensitivity workspace preparation」（依赖 3.0）。
- [ ] 7.1b 判据评估器（离线）：输入为工作区与 session log，输出退出码 0/1/2；实现全部判据（含副本 `NUM_OPENMP`/`DT_YE_IC`/END 差异、`.cfg.calib.bak` 的 `%g` 比较、`input_digests`、独立重算逐字节相同）；每类失败一个录制夹具。不启动宿主即可运行。满足 oat-sensitivity「Sensitivity acceptance criteria」的离线部分（依赖 3.6c、4.2、7.1a）。
- [ ] 7.1c 会话驱动与批外重复：`pnpm run shud:sensitivity` 入口；独立 Web profile 与单条提示（固定 plan，`threads: 1`）；只对 `report_submit` 自动 Allow once；宿主停止后批外直接执行重复运行，并清理其进程。满足 oat-sensitivity「Sensitivity local acceptance script」（依赖 7.1b）。
- [ ] 7.1d 本机真实运行 `pnpm run shud:sensitivity <scratch>`，exit 0 的证据（含 O2 实测：单 run 耗时与重复 sha256）贴进 PR；结果为 FAIL 时如实报告并升级给 PI，不放宽判据（依赖 7.1c、5.3、5.4、6.1）。
- [ ] 7.2 控制面登记：
  - `Testing_Strategy.md` 的 Verification Matrix 与 Enforcement Index、`Test_Fixtures_And_Command_Matrix.md`、`constraints.yaml` 镜像。
  - 过时描述随登记刷新：`Testing_Strategy.md` 与 `Test_Fixtures_And_Command_Matrix.md` 中"不确定 numerical_health 的计算里程碑或生产者"的句子；`Test_Fixtures_And_Command_Matrix.md` §1 dummy-batch 行与 §3 Dummy batch 节改写为 M5 实情（`analyses/<id>.json`、`runs/<run_id>/metrics.json`、`reports/<report_id>.sensitivity.json`、入口 `shud:sensitivity`），3×3/parquet/heatmap 只作为"M5 之后"的注记保留。
  - `instructions/agents/shared.md`，经 `instructions:render` 生成 AGENTS.md/CLAUDE.md。
  - 本机阻断、CI 不运行；判据只链接 oat-sensitivity，不复制。
  - 满足 oat-sensitivity「Sensitivity gate registration」与 engineering-gates「Sensitivity local gate is registered」（依赖 7.1d）。
- Suggested fixture level: compact - 本机脚本与控制面文档，运行时行为已由前面各组覆盖（与 M4 同形态组的定级一致）
- Minimal mergeable slice: 7.1a 首刀（纯准备逻辑加单测，可独立保绿）；7.1b 依赖 7.1a；7.1c 依赖 7.1b；7.1d 依赖全部工具切片；7.2 依赖 7.1d

## 8. Epic 收口：PI 功能验收

- [ ] 8.1 PI 在 Web 亲自完成一次 sensitivity 任务并审批报告；证据（session log、plan、RunRecord、汇总表路径）记入 `docs/Migration_Plan_dsh.md`；给 1.2 已 accepted 的流程 ADR 追加功能验收证据链接；#422 由 PI 关闭。结论只限单流域、单窗口、相对 baseline 的变化，不构成模型改进或校准结论。满足 oat-sensitivity「Epic-close PI acceptance for sensitivity」（依赖 1.2、7.2）。
- Suggested fixture level: none - 手工验收记录
- Minimal mergeable slice: atomic - 一次完整验收及其证据记录

## Issue #642 risk packs and executable evidence

| Pack | Selection and evidence |
|---|---|
| Public API / CLI / script entry | Selected: root-exported AnalysisPlanSchema/AnalysisPlanId/ParameterSet id schema; UTC PLAN generation, branded type checks and built-core smoke; no CLI |
| Config / project setup | Not selected: no dependency/profile/config change; package description only |
| File IO / path safety / overwrite | Not selected for runtime IO; pure digest-path validation is covered under schema; existing guarded generator publication preserved |
| Schema / columns / units / field names | Selected: exact thirteen required fields, strict nested objects, all seven refinements, issue-path assertions and generated literal/cardinality/pattern/null constraints |
| Auth / permissions / secrets | Selected: rationale agent/unconfirmed only; closed imported whitelist; reject unauthorized confirmation/keys; no approval or credential changes |
| Concurrency / shared state / ordering | No concurrency selected; ordered PSET ids, baseline uniqueness and perturbation dedup explicitly tested as schema invariants |
| Resource limits / large input / discovery | No external IO/discovery; array bounds 3 and 5 pass, 2 and 6 fail |
| Legacy compatibility / examples | Selected: prior prefix generators/brands and nine record schemas remain valid; CHG/VC/BUILD/PLAN projections reject sequence ids; historical and v0.8 counts unchanged |
| Error handling / rollback / partial outputs | Selected: malformed ids, unknown nested/root keys, invalid multipliers/rationale/threads/digests rejected with named field/key; no parse side effects |
| Release / packaging / dependency compatibility | Selected: root/type exports and built-package parse/generate smoke; no dependency |
| Documentation / migration notes | Selected: schema generation plus real isolated stale-field schema:check rejection; five count sources/rendered instructions at 10 within budget; complete search classified per task2.1 TE-10 rule |

Required tests: fixed ccw four-pset plan passes; PLAN UTC timestamp/lowercase hex and bad prefix/legacy/uppercase failures; every rejection listed in #642 Acceptance; positive multiplier bounds and same-table KSATH/KSATV digest dedup; all four whitelist mappings; project names accepted by existing component rules preserved literally; non-first baseline allowed; strict unknown fields identified.
Required commands: focused schema/branded tests, `pnpm run schema:generate`, `pnpm run instructions:render`, actual isolated `pnpm run schema:check` clean/rejected/restored control, `pnpm run check`, built-core smoke, and the complete task2.1 count-search classification posted to PR. No strengthening of old record path or identifier semantics merely to simplify this slice.
Count-audit supplement: `openspec/project-profile.md` has both the entry-surface count and a Contracts count/export-status sentence (`9 currently exported ... AnalysisPlan is not currently exported`), the latter missed by the original acceptance regex. Update both within that same allowed source file. Supplement—not replace—the original search with `git grep -nE "currently exported|AnalysisPlan is not currently exported" -- . ':!docs/generated' ':!docs/99_ARCHIVE' ':!openspec/changes'`; post its complete output and per-hit classification, with no residual `9 currently exported` or negative AnalysisPlan export-status assertion. This closes a verification blind spot without expanding the five-file boundary or changing historical classifications.
Completion is task2.1 only; keep tasks2.2–2.4 and downstream implementation unchecked. One implementer owns code/tests/count-source edits; parent owns fixture, execution evidence, review adjudication and merge.

## Issue #643 risk packs and executable evidence

| Pack | Selection and evidence |
|---|---|
| Public API / script entry | Selected: both exported run schemas, built-core legacy/bound/metrics parsing smoke; no CLI |
| Config / setup | Not selected: no dependency or configuration change |
| File IO / safety | No runtime IO implementation; scratch read-parse smoke preserves bytes/mtime, existing generator guards reused |
| Schema / fields | Selected: default-null pair, after-default iff refinement and diagnostics; strict metrics.json/lowercase64hex object; import shared PLAN/PSET definitions |
| Auth / secrets | No new authority or credentials; preserve old secret/llm and closed-artifact behavior |
| Concurrency / state / ordering | No concurrency implementation; preserve all existing state predicates and run identity, exercise pairing across valid states |
| Resource / discovery | Not selected: no new processes, traversal or external input discovery |
| Compatibility | Selected: unchanged M2–M4 raw input fixtures parse with null defaults; exact old fields/state checks retained under PI-authorized assertion migration; no on-disk backfill |
| Error handling | Selected: each partial/malformed pair points to prescribed field; bad metrics path/digest/extra keys and plots rejected at artifacts path/key |
| Release / types | Selected: core typecheck/root exports; jobs null literals only if required, no caller semantics change |
| Documentation / projection | Selected: schema:generate updates RunJob/RunRecord Markdown+JSON; patterns/defaults/strict shapes checked; actual isolated schema:check stale-field rejection |

Required tests: both-null/both-valid and all omitted/null/non-null pair combinations on both schemas; PLAN-0001/PSET-6/pset-1 rejected at owning field; succeeded metrics summary with health0.003/0/0/null passes; wrong paths, uppercase/missing/short/long/newline sha256 and extra keys rejected; plots still rejected; failed-state metrics reference not additionally forbidden by schema. Legacy omissions tested for M2/M3/M4 with exact unchanged old fields and nonmutated inputs.
Nullable input positive: explicit `artifacts.metrics_summary: null` must parse successfully and produce null independently of the omitted-key legacy default case. Both literal-null acceptance and missing-key defaulting are required; a default without nullable input does not satisfy the contract.
Required commands: focused core schema tests and prior run-build regression tests, schema generation/self-test, full default check, built-core smoke and actual isolated drift clean/rejected/restored control. If jobs code receives permitted null literals, also run profile:smoke; no runtime behavior evidence may be claimed from pure schema tests.
Completion is task2.2 only. One implementer edits source/tests, parent owns fixtures/verification/PR. PI clarification on #643 is part of the immutable review oracle; no other assertion weakening is authorized.
PI-authorized type-only exception: correct makeRunRecord override input typing in records task-lifecycle-test-harness.ts, preserving all fixture values and reports; full typecheck and report regression tests must pass. Authorization: issue #643 comment6715523002. No other records edits are in scope.

## Issue #644 risk packs and executable evidence

| Pack | Selection and evidence |
|---|---|
| Public API / tool entry | Selected: core parse and existing task_create/closure smoke; sensitivity parses but tool creation and closure reject |
| Config / setup | Not selected: no dependency/profile change |
| File IO / safety | No new IO implementation; scratch parse preserves old task.json bytes/mtime, rejected tool creates no task file |
| Schema / fields | Selected: sensitivity enum, branded array, default[], non-sensitivity empty predicate and inherited base-commit iff; malformed links at linked_analyses |
| Auth / permissions | Selected: temporary admission remains fail-closed; no tool enum expansion or successful closure route |
| Concurrency / ordering | No concurrency implementation; schema preserves link order/multiplicity and independent mutable default arrays; writer sorting remains out of scope |
| Resource / discovery | Not selected: no new process, discovery or resource behavior |
| Compatibility | Selected: unchanged M3/M4 raw inputs, exact prior fields plus new[], unchanged stripping/optional fields/status/base/reference rules |
| Error handling | Selected: wrong type-link pairing and malformed brand/base commit have owning-field errors; tool invalid argument and closure unsupported-type remain explicit |
| Release / types | Selected: root types and full typecheck, PI-authorized createTaskCard input-only annotation; no runtime body change |
| Documentation / projection | Selected: TaskCard enum/PLAN element/default projected; actual schema:check clean/rejected/restored control, other generated files unchanged |

Required positives: sensitivity with null base and one plan; sensitivity omitted/explicit empty links; unchanged M3 science_assist and M4 code_change raw inputs parse with[]; valid sensitivity link order/duplicates remain unmodified. Required negatives: science_assist/code_change nonempty analyses, sensitivity non-null40hex base, PLAN-0001 and uppercasehex links, null/nonarray links. Mutating one parse's default array must not change another.
Required commands: focused TaskCard and existing consumer regression tests, schema generation/self-test, full default check, strict OpenSpec validation, built core/tool/closure smoke and scratch byte/mtime proof, isolated actual stale-field schema drift control. Publish exact invocations and complete smoke inputs with results, not summary-only evidence.
Completion is task2.3 only; keep sensitivity task_create/closure/link writers deferred to #667/#654/#664. No expansion of tool parameters or closure implementation is authorized.
PI batch test authorization (issue #644 comment6716702659): migrate only additive-default expectations in the four existing compatibility suites identified by the full gate (record-allocation, workspace-records, workspace-readonly, task-create-raw-guard). Retain all raw fixture inputs, original exact-value/state/security/cleanup assertions, and explicitly assert linked_analyses:[]. Run those suites plus the original focused tests and full default gate. No production or golden-report semantics changes are authorized.

## Issue #645 risk packs and executable evidence

| Pack | Selection and evidence |
|---|---|
| Public API / release | Selected: exported EvidenceReport parser and existing writer typechecks; only allowed empty/null writer literals |
| Schema / fields | Selected: unique branded array, strict nullable summary, after-default iff and exact current-report path binding |
| Compatibility | Selected: unchanged M3/M4 raw fixtures and golden reports; exact old-field checks plus explicit defaults under PI batch authorization |
| Error handling | Selected: malformed/duplicate PLAN, both mismatched pair directions, wrong report/path, digest boundaries and nested extras fail at owning field |
| Documentation / projection | Selected: generated defaults, PLAN element pattern, strict nested object and digest constraints; actual isolated stale-field schema drift rejection |
| File IO / safety | No new production IO; built-core scratch read/parse proves bytes/mtime unchanged |
| Auth / state / ordering | No new authority/state machine; retain old statuses/decision guards, reference order and independent default arrays |
| Config / resource / concurrency | Not selected: no configuration, discovery, process or concurrent behavior |

Required positives: valid bound summary with multiple ordered plans; legacy M3 and M4 omissions; explicit empty/null; independent default arrays. Required negatives: PLAN-0001, uppercase/malformed brand, duplicate plans, null/nonarray analysis_ids, nonempty plans with omitted/null summary, omitted/empty plans with summary, missing or extra summary keys, wrong report id, absolute/traversal/prefix/suffix paths, uppercase/nonhex/short/long/newline digests.
Required commands: focused schema and affected report consumer regression tests; schema:generate/self-test; strict OpenSpec validation; build and built-core parsing smoke; full pnpm run check; isolated real schema:check clean/rejected/restored with full reproducible evidence published. All unrelated projections and golden-report bytes remain unchanged.
Completion is task2.4 only. No #655 summary writing, #656 citation support, #658 render/validate or #667 generation binding is claimed.

## Issue #647 risk packs and executable evidence

| Pack | Evidence |
|---|---|
| Public API / release | Built records root exports readShudTextInput/parseShudTextInput and typed results; no deep-import consumer convention or new dependency |
| File IO / path safety | Absolute-base and relative-path validation, normalized escape rejection, nested linked ancestors/final symlink/dangling link/directory/FIFO refusal; real nonblocking FIFO test and unchanged outside bytes |
| Schema / columns | Eight ccw kinds, exact declared rows/columns, required named columns, malformed values, optional river geometry/IC time/lake tables, LC zero index and negative slope preservation |
| Auth / diagnostics | No writes/renames/truncation; controlled missing versus unsafe/read errors, sanitized native faults and parser errors without input payload |
| Resource / ordering | Single descriptor open/read-pass for digest+parse+size, partial read handling, zero-length/multi-chunk input, one close attempt and cleanup fault coverage; comparator remains bounded and sequential |
| Compatibility | Existing comparator, binary verification and artifact validation tests remain valid; direct pinned submodule fixtures unchanged before/after |
| Error handling | Missing file distinct from unsafe and IO; missing column/bad number/row or column mismatch yields file+controlled column/section diagnostic, never partial data |
| Documentation | Public source contract and shared fixture record real format extras and observational race limits; no atomic-sandbox or scientific-validation claim |
| Config / concurrency | No new config, job state, processes or parallel algorithm; observed final/ancestor replacements tested, no atomic snapshot claimed |

Required real-data proof: mesh1147 elements/629nodes; att1147rows; river103reaches/4types and optional103geometryrows; geol67rows; LC17rows startingINDEX0; IC1147elements/103rivers; para29/calib38effective lines. Down<0 yields exactly river1. Digest equals independent full-file sha256 and size equals bytes read; all eight source files retain bytes.
Required synthetic proof: key comments/space/NUL skip before trimming, tab-leading keys parse, GEOL_KSATV/geol_ksatv duplicates retained; absent values/malformed numerics/missing registered columns/short and extra rows/column mismatches rejected. Optional sections may be absent, but malformed present sections fail. Cross-file count policy and unit conversions remain unimplemented.
Numeric proof for both table cells and cfg values: decimal/scientific, signed zero, 0x1.8p+2→6, hex without exponent, case-insensitive inf/infinity/nan and nan payload remain parseable; 93abc/bad/missing and malformed exponents fail at file+column/line without partial result. Verify hex double rounding near ties, normal/subnormal limits, overflow/underflow and a long significand against independent expected doubles. Parsed nonfinite values are not converted to null or classified here.
Dimension regression: reject 1.0/1e0/0x1 count spellings for row/column declarations; preserve signed decimal integer counts, leading zeros and the separate general numeric grammar for optional IC time. Evidence compares pinned %d source and actual host libc against built-parser behavior.
Safety proof: successful nested path and normalized in-base request; lexical escape rejected before target IO; final/ancestor links and special files rejected; preflight-to-open replacement and dev/ino mismatch rejected before content; failures at open/fstat/read/close and cleanup remain controlled with descriptors accounted for. No schema/golden/threshold changes.
Commands: focused new parser/safety tests plus compare-rivqdown, workspace-build-binary and report-artifact-io regressions; build and actual built records API smoke; pnpm run check; strict OpenSpec. Parent owns execution and publishes full reproducible inputs/results. Completion is task3.0 only.

## Issue #648 risk packs and executable evidence

| Pack | Evidence |
|---|---|
| Public API / release | readShudDat and typed result via records root; built-package smoke; one canonical synthetic byte builder for later #651 |
| File IO / safety | Reuse #647 normalized base/path/ancestor and descriptor primitives; final/ancestor links, directory, FIFO, escape, missing and observed replacement tests; no writes or SHUD/output reads |
| Binary layout / units | Independent 1024-header/2column/3row vector; metadata/date and interval-start t preserved; length, column extent, row alignment and integer constraints checked before allocation |
| Resource / ownership | One open/pass for bytes/hash/size, partial reads, multi-chunk input, descriptor cleanup and close errors; no subprocess reader, extra payload copies or arbitrary cap |
| Compatibility | Existing text API/error/export and comparator/hash contracts survive shared extraction; old text/numeric/IO and comparator/binary/artifact suites unchanged |
| Errors / diagnostics | Controlled missing versus unsafe/read/parse; malformed header/column/payload reports file+reason without raw data/native cause or partial rows |
| Platform / config | Actual LE decoding, mocked BE refusal before file IO; no public endian override, dependency or profile changes |
| Documentation | Public API and fixture state date-versus-minute, interval averaging, nonfinite count and observational filesystem limits; no scientific verdict |
| Concurrency | No new concurrency mechanism; preserve observed identity checks, do not claim atomic snapshot or same-inode immutability |

Required positives: exactly2columns[1,2]/3rows and independent sha256/length; opaque nonzero header; zero-variable/time-only rows, empty rows, zero/duplicate/out-of-order column ids; nonfinite start_date/t/value retained and counted individually; signed zero; caller order preserved.
Required negatives: <1040bytes, missing declared column bytes, truncated last8bytes, unaligned extra bytes, NumVar fractional/negative/NaN/Infinity or huge count exceeding file, fractional/negative/nonfinite column ids; no partial values. BE platform branch refuses without IO. Error names only file/controlled reason.
Typed-array ownership regression: use a small valid pooled-size file; each returned values.buffer must be confined to owned verified-file/payload data rather than exposing the larger shared Buffer pool. Verify exact decoded values and unchanged source bytes, not a particular allocation API.
Safety proof: missing vs unsafe/read errors, real FIFO with successful regular control, ancestor/final symlink and directory, normalized in-base path/escape rejection, inode replacement and cleanup/close faults, input/target bytes and mtime unchanged. Do not duplicate the entire #647 fault matrix; reuse the common primitive and prove the new public reader reaches its actual boundary.
Commands: focused dat tests plus unchanged shud-text-formats/numeric/IO, compare-rivqdown, workspace-build-binary and report-artifact-io; build; actual built binary/text/comparator smoke; strict OpenSpec; full pnpm run check. Parent publishes independent byte construction and complete observed output. Completion is task3.1 only.
