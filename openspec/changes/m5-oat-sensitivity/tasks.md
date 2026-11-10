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
- [x] 3.2a 逐 run 流量指标、numerical_health 中非水量平衡的三项、判定与 `metrics.json` 确定性序列化：
  - 出口集合；`peak_flow_m3d`/`peak_day`/`total_runoff_m3`；Δ 由时间列推导；`cvode_failures`；`negative_state_count`（任一文件缺失则整项 null）；`max_solver_dt` 恒为 null 且不进 verdicts。
  - status `ok|unavailable` 语义；两次计算逐字节相同。
  - `metrics.json` 的安全读与 sha256 绑定读取器（唯一实现；3.4 closure 与 3.6b 渲染都 import 它）。
  - 满足 run-metrics「Per-run flow metrics」「Numerical health producers」「Numerical health verdicts」「Metrics file shape and determinism」（依赖 3.0、3.1、2.5）。
- [x] 3.2b O1 事实核查与系数常量：对照 SHUD 源码核实 `eleysnow`/`eleyic` 的单位，以及 `.cfg.ic` Canopy/Snow 的口径；把两项系数登记为 core 常量（附 file:line），并写入 `SHUD_Output_Variables.md`。满足 run-metrics「Water balance residual」中的系数常量部分（依赖 2.5）。
- [x] 3.2c 水量平衡 rSHUD 共有项：P、Qd、AET、ΔS_surf/us/gw/riv 的分项计算（面积、孔隙率、河道面积、IC 读取）；合成迷你项目夹具与小 `.dat` 写出器；本机一次性生成脚本 `scripts/metrics/rshud-crosscheck.R` 与入库的 `expected-rshud.json`。满足 run-metrics「rSHUD cross-check fixture」与 engineering-gates「rSHUD cross-check generator is local-only」（依赖 3.0、3.2a）。
- [x] 3.2d 积雪/截留扩展项与残差汇总：ΔS_snow/ΔS_ic（使用 3.2b 的常量）；`water_balance_residual`；`zero_precipitation`/`missing_variable`/`ic_shape_mismatch`/`missing_calib`/`interval_undetermined` 等 null 原因；积雪与截留用手算夹具覆盖。满足 run-metrics「Water balance residual」（依赖 3.2b、3.2c）。
- [x] 3.3 AnalysisPlan 工作区文件层（`analyses/<id>.json` 排他创建、只读解析、id 绑定）；calib 类别表乘积校验（键缺失或重复即拒绝，越界时点名行 index）；`input_digests` 与乘积校验取自同一次读取。满足 analysis-plans「AnalysisPlan workspace file」与「Calib whitelist and category product check」的校验部分（依赖 2.1、2.5、3.0）。
- [x] 3.4 sensitivity closure 谓词：恰好一个 plan；作业全部绑定该 plan 且全部终态；有效 run 规则；baseline 必须 succeeded；同一 `stack_id`；metrics `status: ok` 且 sha256 匹配。本刀只新增 sensitivity 谓词，不改 science_assist/code_change。满足 task-cards「sensitivity closure predicate」与「TaskCard workspace file」（依赖 2.2、2.3、3.2a、3.3）。
- [x] 3.5 汇总表派生与报告文件层：
  - `SensitivitySummary` 构造：`_pct` 以 baseline 为分母，分母为 0 时给 null；`delta_peak_day` 为差值。
  - 在报告 JSON 提交之前写 `reports/<report_id>.sensitivity.json`；孤立 summary 保留；三类报告文件任一已存在即重分配 report_id。
  - 满足 evidence-reports「Sensitivity summary derivation」「Report write order and repair」与「Report workspace files」的 `.sensitivity.json` 部分（依赖 2.4、3.2a、3.4）。
- [x] 3.6a Citation existence check 识别 `PLAN-` 令牌，并按安全读解析 `analyses/<id>.json`。满足 evidence-reports「Citation existence check」（依赖 2.1、3.3）。
- [x] 3.6b 非 sensitivity 报告切换为指标渲染（一刀完成，不留中间态）：
  - science_assist/code_change 的"无指标 artifact"自动 limitation 与 `metric_fact` 恒真特例删除。
  - §5 渲染逐 run 指标表（值原样输出最短往返串，null 用固定记号）。
  - `report_generate` 追加阈值派生 limitation 与 `max_solver_dt` 固定 limitation（`report-generate.ts` 的追加点）。
  - `CODE_CHANGE_SECTION5_WORDING` 删去"本里程碑无指标 artifact；"分句。
  - science_assist/code_change 黄金文件。
  - 同一切片中更新 `shud:first-task` 与 `shud:replay` 的 §5 文本 oracle，并附本机重跑证据。
  - 「Report workspace files」的 `metrics.json` 渲染输入部分（经 3.2a 的读取器安全读、sha256 核对、缺失时 `not_available`）归本刀。
  - 本刀早于 4.2：真实 run 的 `metrics_summary` 仍为 null，§5 指标单元格按 spec 渲染为 `not_available`；只有已引用 `metrics.json` 内的 null 值才渲染 `null` 加原因。本刀 oracle 只断言表结构与旧固定句消失，指标非 null 的断言由 4.2 加入。
  - 满足 task-cards「science_assist closure predicate」，evidence-reports「Deterministic facts table」「Report template」「code_change report wording constant」「Deterministic report limitations」的非 sensitivity 部分，以及 agent-presets「Local first-task acceptance script」与 known-answer-replay「Replay acceptance criteria」的报告文本部分（依赖 2.5、3.2a）。
- [x] 3.6c（#658 / PR #702）sensitivity 报告渲染与校验：Δ 汇总表；失败 cell 行；被取代 run 按 `linked_jobs` 顺序列出；覆盖声明与"agent 建议值"；`report_validate` 第 16/17 项（含工具描述中的检查项计数）；sensitivity 黄金文件；`docs/03_SPEC/Report_Generation_Spec.md` 中检查项计数 15 → 17 及 (4)(10)(11) 的 M3 恒真表述随代码刷新。满足 evidence-reports「report_validate」与「Deterministic report limitations」「Report template」的 sensitivity 部分（依赖 3.5、3.6a、3.6b）。
- Suggested fixture level: expanded - 文件格式读取器、持久化文件、closure 谓词与报告措辞护栏（Critical Path #6/#7）
- Minimal mergeable slice: 3.0 首刀（共享读取器没有消费者，可独立保绿）；3.1 独立；3.2a 依赖 3.0/3.1；3.2b 只依赖 2.5；3.2c 依赖 3.2a；3.2d 依赖 3.2b/3.2c；3.3 依赖 3.0；3.4 依赖 3.2a 与 3.3；3.5 依赖 3.4；3.6a 依赖 3.3；3.6b 依赖 3.2a；3.6c 依赖 3.5、3.6a 与 3.6b

## 4. jobs：提交重写与 collect 内 metrics（Critical Path #4）

- [x] 4.1a（#659 / PR #703）所有提交都在副本 `.cfg.para` 中确保 `DT_YE_IC 1440`（字节保真，多行全部改写，末行无行尾时先补行尾），在 provenance 之前完成，失败按既有回滚。
  - `shud-end.ts` 原地重构为 `shud-cfg-rewrite.ts`，不保留旧文件；同一刀更新全部引用：`packages/dsh-shud-jobs/src/shud-submissions.ts:17` 的 import、`shud-end.test.ts` 随之改名为 `shud-cfg-rewrite.test.ts`、`shud-end.ts:27` 的 Usage 字符串、`scripts/runtime/shud-tiny.sh:19`、`knip.json` entry、`docs/01_CODEBASE/SHUD_IO_Facts.md:68`、`docs/04_IMPLEMENTATION/Runtime_Lifecycle.md:63`。
  - 同一切片中更新 `shud:replay` 的副本 provenance oracle（运行副本与准备后输入只差 `DT_YE_IC` 一行）。
  - 验证：`pnpm run check`、`pnpm run shud:tiny`、本机 `shud:replay` 重跑（rivqdown bitwise 不变）。
  - 满足 shud-run-jobs「Shud job submission」的 DT_YE_IC 部分、shud-run-tools「shud_run arguments」的回放副本场景、known-answer-replay「Replay acceptance criteria」的副本部分。
- [x] 4.1b（#660 / PR #705）绑定 plan 的提交事务：
  - 内部请求接收已解析的 calib 覆盖、plan/pset id、threads 与 `input_digests`。
  - 复制之后、任何重写之前核对副本摘要，不等即回滚。
  - 副本 `NUM_OPENMP` 改写为 plan `threads`。
  - 副本 `.cfg.calib` 单键重写（恰好一行，数值为最短往返表示），在 provenance 之前完成。
  - `run-job.json` 首次写入即带 plan/pset id 与 threads；后续状态写入与 collect 原样继承，RunRecord 带同样的两个 id（run-records「RunRecord record」的继承场景）。
  - 满足 shud-run-jobs「Shud job submission」的重写与摘要部分（依赖 2.2、2.5、4.1a；2.5 提供注册表预检用的 calib 白名单）。
- [x] 4.1c（#661 / PR #706）pset 重复提交检查：注册表在同步 id 占用点检查在途提交与已登记作业；并发时至多一个被接受；失败、取消、收集耗尽或回滚之后可以重提。满足 shud-run-jobs「Shud job submission」的重复检查部分（依赖 4.1b）。
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

- [x] 5.1（#663 / PR #708）raw-guard：治理根写保护集加入 `analyses`；`analysis_create` 固定输出根（`analyses/` 与卡片回写目标）的保护；`analysis_create` 读 raw 内 `input_dir` 时按 `shud_run` raw 输入的判定发起 ask。满足 raw-data-guard「Governance roots are write-protected from model file and shell tools」「Analysis plan creation protects its fixed output root」。
- [x] 5.2a（#664 / PR #709）`analysis_create` 工具本体并挂载，暂不对任何角色暴露：
  - strict 参数（含 `threads`）；卡片校验；防重扫描与孤立 plan 修复；乘积校验与 `input_digests`；排他写入；卡片回写与失败错误；返回 plan id 与 pset 列表。
  - 挂载到 `dsh-shud-tools`，不列入任何角色的 inherited，所以 restrict 隐藏、policy-gate deny，可独立保绿。
  - 满足 analysis-plans「analysis_create」、task-cards「TaskCard links」的 `analysis_create` 回写部分（含回写失败场景）与 shud-run-tools「Report and task tools are mounted by dsh-shud-tools」（依赖 2.3、3.3、5.1）。
- [x] 5.2b（#665 / PR #711）暴露给 coordinator：
  - role-tool-map 中 coordinator 增加 `analysis_create`；presets 精确工具面测试夹具；policy-gate 角色面 deny 与"不发起审批"回归。
  - Web 工具面证据：本机 Web 会话 header 的 `tools` 列表含该工具（仅 coordinator），session log 路径写进 PR。
  - 必须在 5.2a 之后：inherited 含未挂载名时会 fail-loud。
  - 满足 policy-gate「Role tool surface rule」「Sensitivity tools do not ask」与 agent-presets「Role tool map uses mounted names」「Role tool surface restriction」（依赖 5.2a）。
- [x] 5.3（#666 / PR #714）`shud_run` 的 plan 绑定：
  - 成对参数且必须带 `task_id`；只按 id 解析 plan；`linked_analyses` 检查放在卡片读取的同步边界内；sensitivity 卡不带 plan 参数即拒绝。
  - `task_id`/`input_dir` realpath/`project`/`end_days` 必须相等，`end_days` 缺省取 plan 值。
  - `threads` 取 plan 值（省略时用 plan 值，不等即拒绝）。
  - 向注册表传递覆盖、threads 与 `input_digests`；不接受模型传入的 calib 值。
  - 满足 shud-run-tools「shud_run arguments」的 plan 绑定部分（依赖 4.1c、5.2b）。
- [x] 5.4（#667 / PR #716）sensitivity 卡入口：`task_create` 接受 `sensitivity`（不访问 `repos/`）；卡片链接写入方包含 `analysis_create`；`report_generate` 接受 sensitivity 卡，写入 `analysis_ids`/`sensitivity_summary`。满足 task-cards「task_create」、「TaskCard links」的唯一写入方与 reconcile 不补链部分，以及 evidence-reports「report_generate」（含 sensitivity 入口接线与确定性 limitation 追加；依赖 3.6c、5.2b）。
- Suggested fixture level: expanded - 模型可见工具契约、原始数据保护、角色权限与工作区写入（Critical Path #2/#3）
- Minimal mergeable slice: 5.1 首刀（raw-guard 是独立包，没有工具依赖，必须先于 `analysis_create` 挂载）；5.2a 依赖 5.1；5.2b 依赖 5.2a；5.3 依赖 5.2b 与 4.1c；5.4 依赖 5.2b 与 3.6c，与 5.3 互不依赖

## 6. presets：sensitivity 编排 prompt

- [x] 6.1（#668 / PR #717）coordinator 与 worker 的 prompt 增加 sensitivity 流程：建卡 → `analysis_create` → 委派 worker → sensitivity 卡上一律带 `analysis_plan_id`+`parameter_set_id` 提交 → 显式 `job_output(wait)` + `shud_collect` → 失败如实汇报、不自行重提 → 报告三步。M3 的无 plan 路径只用于 science_assist。更新 `prompts.test.ts`。不新增 preset 或委派工具，`profile:smoke` 断言不变。满足 agent-presets「Preset system prompts」「sensitivity orchestration」（依赖 5.3、5.4）。
- Suggested fixture level: compact - prompt 资产与其测试，不新增工具面或 profile 行
- Minimal mergeable slice: atomic - 两份 prompt 同属一个编排流程，分开合并会出现 coordinator 委派了 worker 却不认识的步骤

## 7. 验收脚本与控制面登记

- [x] 7.1a（#669 / PR #719）工作区准备：复制 `SHUD/input/ccw`，前置缺失时明确失败，并记录源输入 md5 与 `input_digests` 基线；附单测。满足 oat-sensitivity「Sensitivity workspace preparation」（依赖 3.0）。
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

## Issue #649 risk packs and executable evidence

| Pack | Required evidence |
|---|---|
| Numeric correctness / units | Independent synthetic outlet sums and 0/1440/2880→10/20/30 total60; multi-outlet reordered IDs; tie at1440/4320 selects day1; single/unequal interval preserves peaks; no DT_* inference |
| IO / path safety | Existing safe readers for all text/dat/log/metrics bytes; final and ancestor links, directory, writerless FIFO, escape/project invalidity, no outside writes; missing versus unsafe/parse/read |
| Evidence identity | inputs actual full-byte SHA256/length with relative paths, sorted and unique; nonfinite tally includes retained dat fields; digest checked on metrics bytes before parse; mismatch/missing/malformed controlled |
| Errors / status | Empty outlets/core input missing or unsafe and present malformed dat→unavailable/all numeric cells null; optional state absence/nonfinite→only dependent null; later bad present state cannot hide behind earlier missing state; stderr failure remains item-null |
| Determinism / wire | Fixed complete nested order, finite numeric cells, exact null reasons, shortest-roundtrip JSON+LF, copied/sorted inputs/outlets without argument mutation; strict reader rejects malformed shape; repeated and relocated runs byte-identical |
| API / compatibility | compute stays internal/no production consumer; root serializer/reader built smoke; existing text/dat/comparator suites unchanged; canonical dat builder reused |
| Resource / concurrency | One safe pass per target; process state files serially; descriptor fault cleanup shared and exercised; no atomic snapshot or same-inode immutability claim |
| Governance / docs | Core classifier/method constant reused; tolerance remains -1e-10; max_solver_dt not in verdicts; lower-bound and final-interval approximation explicit; no scientific verdict, thresholds or formula changes |

Core fixtures: ccw-like sole outlet1 and multi-outlet unordered reach/column IDs; negative -1e-6×3 plus -1e-12→3, exact -1e-10 excluded; two exact line-start SUNDIALS_ERROR: lines→2 with prefixed nonmatches ignored; max_solver_dt always null. Missing rivystage with other negative values gives null, never partial count; keliya-like missing states keeps all flow values and status ok. Unavailable tests include missing cfg.ic, symlink mesh and malformed eleygw. Check method_version/verdict keys and core threshold boundary transitions without changing status.

Boundary fixtures: no rows, missing/duplicate outlet column, nonfinite outlet versus unrelated column, nonfinite time/date, finite-sum overflow, equal zero/negative intervals under the literal formula, reordered tie rows; successful-read manifests remain deterministic on controlled failure. Reader checks wrong digest, same digest malformed JSON/shape, symlink/ancestor/FIFO and unchanged bytes. Reject invalid serializer input rather than NaN/Infinity implicit JSON null. Water-balance constructed-value round-trip fixes every field/order; its producers remain task3.2c/d, and this internal intermediate is never written by production.

Commands/evidence: focused new metrics suites plus shud-text-*/shud-dat*/compare-rivqdown regressions; pnpm run build; built internal compute + public serializer/reader smoke; openspec validate m5-oat-sensitivity --strict --no-interactive; full pnpm run check. Publish all commands and independent input recipes/results. Completion is task3.2a only.

Peak-time explicit oracles (all Q finite): rows [4320,20],[1440,20] select peak_day1 regardless of order; [1440,20],[NaN,20] preserve peak_flow20 but peak_day null/nonfinite:rivqdown and total null/interval_undetermined:rivqdown; [1440,20],[NaN,10] preserve peak_flow20 and peak_day1, with only total null/interval_undetermined:rivqdown. Reverse each nonfinite row order to prove no first-row shortcut.

## Issue #650 risk packs and executable evidence

| Pack | Required evidence |
|---|---|
| Units / source lineage | Four-row O1 table with full pinned SHUD/src file:line refs; reviewer independently traces forcing units, ET assignment, actual output overload, IC read/write and initialization modes |
| Schema / conditional fields | All four entries required; finite positive scale, boolean flag, nonempty valid source refs; missing entry/bad scale/empty or malformed ref names the exact entry; strict unknown keys rejected |
| Conditional source | Each individual flag true requires veg_frac_source; valid source accepted; any false-only registration rejects a present source or explicit undefined; malformed source fields/refs rejected at their paths |
| Immutability / config | Reflect mutation attempts cannot change coefficients, flags or provenance arrays; no profile/runtime setter or new configuration |
| Public API / compatibility | Built core root imports constant/schema; independent raw values0.012/0.023/0.034/0.045 and VegFrac0.25 remain those same element-depth values under the registered formula; no existing export/schema/threshold behavior changes |
| Generated projection / docs | Governance-local supporting schema leaves10core records and existing projections unchanged; schema:check and docs:check; no manual generated edit; source table distinguishes interval means from IC text precision |
| Scientific boundary | No water-balance producer, coefficient inference from desired residual, physical equation change, or claim of model correctness; original run-metrics spec/D7 unchanged |

Test oracle includes the actual all-false registration plus synthetic true-flag registrations to exercise all four conditional branches. Reject scale0/negative/NaN/Infinity, missing entries, string flags, empty refs, missing/zero line numbers and escaping/non-SHUD source refs. Test error paths rather than pinning incidental Zod wording or parsing C++ source text. No runtime filesystem access in the schema.

Commands: focused storage-conversion tests and existing core governance regressions; pnpm run build; built-core API smoke; openspec validate m5-oat-sensitivity --strict --no-interactive; pnpm run check (which includes schema/docs). Publish actual source table, commands, complete smoke inputs/results and any observed gate failures without reinterpretation. Completion is task3.2b only; no shared-change archive or PI-gate closure.

## Issue #651 risk packs and executable evidence

| Pack | Required evidence |
|---|---|
| Numeric units / scientific joins | Seven named terms match actual rSHUD2.5.0 results at relative error <=1e-12 or exact equality; unequal areas, nonunit GEOL_THETAS, multiple geology/river types, nonzero IC and signed deltas discriminate wrong weighting/indexing |
| Independent oracle | R generator and committed JSON; header versions/command; semantic pre-source RED; disposable omitted-GEOL_THETAS mutant fails the same comparison and names delta_s_us; oracle bytes unchanged after tests |
| File IO / evidence identity / resources | Existing readers only, fixed run-root safety, each successful file observed once; no duplicate state buffers/reads or redundant hash pass; present unsafe/malformed new inputs fail closed; missing optional inputs do not erase old flow/health; readonly and exact manifest/hash/nonfinite checks |
| Output coverage / intervals | Reordered complete state/element-flux columns preserve results; missing/duplicate required entity coverage cannot produce partial totals; outlet-only rivqdown still yields the same Qd as existing flow/A; own-variable interval governs flux; incomplete/irregular/nonfinite dependencies remain null, no zero/default factor |
| Binary fixture integrity | Canonical buildShudDat remains the only writer; committed .dat including independent elevetp equals declarative dataset output; old binary oracle remains unchanged; real ccw reference uses actual elevetp, never a synthesized PET series |
| Compatibility / deferred scope | Existing flow/health/wire/reader/comparator regressions; seven computable terms become finite, snow/ic/aggregate/residual stay pending; no production caller, public API/core record/schema or formula change |
| R isolation / environment | Run the default pnpm run check with Rscript absent from PATH, recording exact command/PATH, actual exit status and absence of R invocation (preserve any failures); inspect workflows/root scripts/runtime imports for no R coupling; no install dependency; actual local R generation and ccw comparison documented separately |
| Documentation / source gate | Update existing producer-status documentation; unchanged path checker accepts rSHUD/R/WaterBalance.R and rejects nonexistent rSHUD/R/WaterBalance-does-not-exist.R with initialized submodule |

Commands: focused water-balance and existing metrics/reader suites, pnpm run build, actual built compute/serialize smoke, local Rscript scripts/metrics/rshud-crosscheck.R invocation, default pnpm run check under the recorded no-R PATH, openspec validate m5-oat-sensitivity --strict --no-interactive. Publish complete generator/test/smoke inputs, expected-file identity, mutation failure and restoration, seven-term real ccw comparison, and observed local/CI results. R is not added to default commands.

Auth/concurrency/release/config packs are non-selected because this slice adds no permissions, shared-state transitions, release/configuration surface or dependencies; resource/performance is selected within single-read File IO evidence above. Complete only task3.2c; no #652 residual/null-reason producer, #662 collect, shared-change archive or PI gate closure. The scoped PI code-review plus same-head-CI completion substitution is recorded in the #651 design plan; local timing failures remain failures, not rewritten green evidence.

## Issue #652 risk packs and executable evidence

| Pack | Required evidence |
|---|---|
| Numeric formula / registered units | Hand budget P0.100/Qd0.030/AET0.060/delta_s0.009 gives residual approximately0.01; positive snow/ic match four actual registrations; zeroing both changes residual; no coefficient/threshold edits |
| Dependency reasons / status | zero/negative P, missing eleyic, all stores absent with flow intact, multiple missing names code-point ordered, missing/duplicate calibration, IC shape, NaN/overflow, interval/empty data and semantic input/column failures have final causal outcomes |
| Safe IO / resources | Additional dat targets use existing safe readers once; bad present extension dat remains unavailable despite earlier absence; unsafe additional metadata becomes item-level unreadable_input with no content/receipt/write; fixed run root, exact unique manifest and raw nonfinite totals |
| Actual governance configuration | All-false/no-source registration means no extra vegetation file read; unreadable LC/PET decoys remain untouched; no invented true-flag source or profile override |
| Determinism / public API / Release-exports | Root-export compute plus serializer and digest-bound reader smoke; repeated/relocated bytes equal; water/health residual value+reason identical; classifier is authoritative; no production writer/caller |
| Compatibility / oracle integrity | Existing seven-term wb-mini/R JSON and binary bytes unchanged; flow/health/core/dat security maintained; explicitly named intermediate-test migrations preserve original non-water assertions |
| Scientific docs / evidence | Existing producer-status docs describe the complete numerical diagnostic but not hydrologic validity/model improvement; actual built ok/unavailable formula-source and interval-average semantics checked outside permanent wording tests |

Release/exports is selected within the public API pack above. Auth/concurrency/configuration/packaging/dependency packs are non-selected because those surfaces are unchanged. Commands: focused new residual and existing metrics/reader suites, pnpm run build, root-export built smoke and retained-real-ccw missing-extension check, pnpm run check, openspec validate m5-oat-sensitivity --strict --no-interactive. Publish exact hand inputs, outputs, reason precedence, RED/GREEN and safety/determinism evidence. Complete only task3.2d; #662 persistence and PI gates remain open.

## Issue #653 risk packs and executable evidence

| Pack | Selection and evidence |
|---|---|
| Public API / entry | Selected: built root createAnalysisPlan/checkCalibProducts/readWorkspaceRecord round trip and type contract |
| Config / setup | Not selected: no project/runtime configuration or defaults change |
| File IO / path / overwrite | Selected: real unsafe roots/targets, malformed id before IO, readonly absence, physical-cwd decoy, same-byte input hashes and unchanged mtime |
| Schema / columns / units | Selected: consume core schema/whitelist; all four transforms, per-row bounds, malformed/missing/duplicate calibration and tables; no core projection edits |
| Auth / permissions / secrets | Not selected: no tool/auth surface; controlled diagnostics must not echo arbitrary input contents, raw approval remains #663/#664 |
| Concurrency / shared state | Selected: exclusive publish collision, four allocations maximum, no overwrite and ownership/cleanup fault regressions; no new lock/transaction |
| Resource limits / discovery | Selected: one read per distinct required file, exact digest set, no directory scans or unrelated reads; preserve shared reader limits |
| Legacy compatibility / examples | Selected: existing workspace/readonly/physical/publication/text-reader suites and ccw copied inputs |
| Errors / rollback / partial outputs | Selected: schema/path/product rejection before relevant writes, collision exhaustion unchanged files, no leaked owned temporary file; existing committed-cleanup error semantics preserved |
| Release / packaging | Selected: exported runtime API plus package typecheck/built smoke; no dependency or package manifest change |
| Documentation / migration | Selected: API comments and this fixture describe new immutable object, arithmetic/source/digest boundaries and non-goals; no migration of existing objects |

Commands: focused AnalysisPlan/product tests plus workspace allocation/publication/physical/readonly and SHUD text suites; pnpm run build; parent built root-API ccw-copy smoke; pnpm run check; openspec validate m5-oat-sensitivity --strict --no-interactive. Publish reproducible inputs, positive/negative outputs, RED/GREEN, read counts, before/after fingerprints and review reports. Only task3.3 closes; shared change and PI gates remain open.

## Issue #654 risk packs and executable evidence

| Pack | Selection and evidence |
|---|---|
| Public API / entry | Selected: existing evaluateClosure dispatch and typed sensitivity result/loaders, built root positive/negative smoke |
| Config / setup | Not selected: no config/default/dependency change |
| File IO / path safety | Selected: readonly linked plan and digest-bound metrics, unsafe roots/targets/FIFO, physical cwd, no mkdir/write/readdir |
| Schema / columns / identity | Selected: core plan validation; branded task/plan/job/run/pset bindings; malformed loaded evidence rejected without token leakage |
| Auth / secrets | Not selected: no permission or model-tool surface; exception/model-payload privacy is covered by controlled error tests |
| Concurrency / shared state / ordering | Selected for snapshot identity and deterministic selection only: shuffled arrays, repeated failures, two successes, terminal/exhausted state matrix; no new lock or live transaction |
| Resource / discovery | Selected: only linked plan and effective-success metrics reads; superseded/failed cells trigger no metric reads; existing descriptor safety regression |
| Legacy compatibility | Selected: unchanged science_assist/code_change suites and facade callers; only the sensitivity unsupported intermediate test migrates |
| Error / partial output | Selected: explicit clauses0–5, no success with partial pset coverage or ambiguous evidence; no writes/state transitions on failure |
| Release / packaging | Selected: root exports/type contracts and built adapter smoke; no package/dependency edits |
| Documentation / migration | Selected: API comments and scoped fixture explain selection, failed-cell rules, readonly evidence and downstream non-goals |

Commands: focused new sensitivity closure/purity/files suites plus unchanged task/code-change closure, workspace readonly and metrics-wire suites; pnpm run build; parent actual built four-cell temporary-workspace smoke and discriminating negative cases; pnpm run check; openspec validate m5-oat-sensitivity --strict --no-interactive. Publish complete inputs, outputs, RED/GREEN, snapshot/hash preservation, original failures and review evidence. Only task3.4 closes; #655/#657/#667 and PI acceptance remain separate.

## Issue #655 risk packs and executable evidence

| Pack | Selection and evidence |
|---|---|
| Public API / entry | Selected: builder/serializer/reader and canonical report creation, built root smoke and registered type contracts |
| Config / setup | Not selected: no config, dependency, profile or runtime host changes |
| File IO / overwrite | Selected: summary no-clobber publication, all three sibling collisions, unsafe roots/targets, digest reads, no orphan rewrite/delete |
| Schema / units / identity | Selected: exact plan-byte hash, bound plan/task/run/pset/metrics facts, numeric/reason shape, -25%/+2day oracle and zero-day distinction |
| Auth / secrets | Not selected: no approval/permission change; controlled errors and no raw payload/absolute metadata leakage covered within IO/wire tests |
| Concurrency / ordering | Selected: summary visible before JSON commit, failure injection and ownership, no new multi-process atomicity claim |
| Resource / discovery | Selected: shared safe reader and descriptor cleanup, linked-only rendering, no scan/rederive/recompute at repair |
| Legacy compatibility | Selected: unchanged science/code-change tests/goldens plus fixed-ID/time raw creation bytes, validation/repair byte and mtime preservation, and null-summary no-content-IO evidence below |
| Error / partial outputs | Selected: no JSON on summary failure, orphan retained on JSON failure, render/repair refusal on missing/tampered summary, nonfinite delta rejection |
| Release / packaging | Selected: built public API plus existing tools repair smoke; no manifest/dependency changes |
| Documentation / migration | Selected: scoped fixture/API comments explain immutable companion, arithmetic/reasons, error boundaries and deferred rendering; no core object count change |

Required arithmetic/data cases: baseline200/day44 vs150/day46 -> -25/+2; zero runoff denominator -> null/zero_baseline; baseline day0 vs3 ->3; null operand ->metric_null; baseline_row and failed run_failed; preserved cvode19; superseded jobs with/without records and exhausted fallback; two relocations/report ids from identical plan/metrics bytes give identical summary bytes. Commands: focused new summary/publication/render tests plus legacy report/closure/reader suites, pnpm run build, actual built records + existing repair(b) smoke, pnpm run check, openspec validate m5-oat-sensitivity --strict --no-interactive. Only task3.5 closes; no #657/#658/#667 work or shared-change archive.

### Issue #655 executable oracle details

The selected packs above map to this matrix; structural wire assertions and actual built output establish no ranking/elasticity/mechanism fields or computations, not new permanent prose-wording tests.

| Oracle | Required observation |
|---|---|
| Legacy JSON bytes | Against base3340294f2fd75bb1f50e708de0970c23443443dd, fixed Date/id entropy creates science/code-change raw JSON with identical bytes, including analysis_ids:[] and sensitivity_summary:null; parsed equality is insufficient |
| Legacy render/repair | Existing 4035-byte science golden SHA2564620ac33c381c2ece739b5bb7f863aead720bd54ef505680857224a33bf54827 and 8880-byte code-change golden SHA2565929fd0762c514fa9631c0454e5b1fcef2eeeb28cfbd879b2fa4040a12ce8a02 remain unchanged; legacy validation and repair preserve prior byte/mtime semantics and do no summary-content IO |
| Single selection source | Builder receives one successful closure result and exact plan bytes, no independent job/record collection or callback; #654 selection tests stay unchanged; failed-then-success selection yields success row and only superseded failure |
| Superseded metadata | Preserve closure/card order rather than sorting; cover collected/failed/cancelled/collect_exhausted, absent-record null exit_class and present-record class, using retained validated closure evidence |
| Relative arithmetic | Independent 200/44 to150/46 yields -25/+2; include non-integral shortest-roundtrip output; separately zero each percentage baseline and preserve other computable deltas |
| Day/null precedence | Baseline day0 to3 gives3 with no zero_baseline day reason; null on either side of each delta yields metric_null, including null-over-zero; baseline_row wins even for null/zero baseline metrics |
| Metric versus delta reasons | Successful metric nulls preserve their loaded reasons and residual verdict; metric_reasons never substitutes for the exactly three delta_reasons fields |
| Failed row | All four metric slots, residual verdict and three deltas null; run_failed reasons, cvode exit19 and identities retained; no succeeded inputs entry; never metric_null for failed-row deltas |
| Nonfinite arithmetic | Valid finite operands whose percentage/day result overflows reject before publication with controlled error; no silently serialized null and no new fallback reason |
| Independent wire oracle | Author exact expected JSON bytes/key order/digest independently of serializer; include all top-level, row, superseded and input fields and core method version, without index/ranking/elasticity/interpretation fields |
| Non-first baseline | Plan order still owns rows/inputs, flagged baseline owns arithmetic; no first-row assumption |
| Byte identity | Different report ids/workspace paths with identical plan/metrics bytes produce identical summary; no generated report id/time/host/input_dir/workspace metadata; whitespace-only plan variant changes exact plan_sha256 and summary, changed bound metrics changes inputs digest |
| Wire/identity negatives | Exact plan bytes versus closure mismatch, malformed shape/version, task/analysis/run/pset mismatch and invalid null/reason pairs reject with controlled stage/file, no raw payload echo or writes |
| Publication order | Observe exclusive summary before JSON commit; report reference has exact reports/<id>.sensitivity.json and independently hashed bytes |
| Failure/orphan ownership | Injected summary-publication fault leaves no report JSON and yields a controlled sensitivity_summary-step error, with no fallback publication/overwrite; pre-commit JSON fault after summary leaves JSON and Markdown absent (no committed report references the orphan), preserves orphan bytes/mtimeNs, and next allocation uses a fresh id without reuse/overwrite |
| Three-sibling collisions | Existing JSON/Markdown cases plus summary-only collision for sensitivity and legacy allocations; every old sibling keeps bytes/mtimeNs |
| Renderer freshness | Intact render, tamper/delete/symlink rejection naming file, then exact-byte restoration succeeds; report JSON unchanged, absent stays absent, tampered bytes/targets preserved, no cache/rederive |
| Canonical validator | Unreadable summary yields existing 15-check render_unavailable result, not new16/17 checks and not renderer-style thrown root error; report JSON bytes/mtimeNs remain unchanged and the exact missing/tampered/unsafe summary state is not repaired |
| Repair(b) | Delete/stale Markdown to actually trigger existing repairReportEntry: intact summary publishes canonical Markdown; missing/digest-mismatch/unsafe summary returns render+report_id with no Markdown publication, plan/metrics discovery, rederive or summary rewrite; both success/failure preserve report JSON bytes/mtimeNs, and failure preserves the exact missing/tampered/unsafe summary state |
| State transitions | Existing reviewed/accepted publication paths leave summary bytes/mtimeNs unchanged; no tool implementation changes |

Before implementation, the parent captured raw legacy creation bytes with the built base and fixed time/entropy in local issue-655 evidence; those consumed oracle bytes are immutable and will be published with the program/results. Report-only tooling proof uses existing built repair functions from a throwaway program, not new tools source/tests or model/PI calls.

## Issue #656 risk packs and executable evidence

| Pack | Decision and evidence |
|---|---|
| Tool entry / packaging | Selected: real strict-tool ToolRuntime report_generate on science_assist and code_change; built scanner smoke |
| File IO / schema / identity | Selected: valid analysis, missing root/file, invalid JSON/schema/id, unsafe root/target, read failure; reuse #653 parser and preserve bytes/mtime |
| Ordering / errors | Selected: stale-card negative case before list/reconcile/collect; token-only controlled error, no native payload/absolute path, workspace tree unchanged |
| Resource / deduplication | Selected: same PLAN across all four fields reads once before registry query; independent later invocation rereads; no discovery/creation |
| Legacy compatibility | Selected: existing nine-namespace citation suites and report-generate tests without assertion changes; DEC/embedded/malformed remain literal |
| Documentation | Selected: scoped fixture and scanner comment; no new architecture/threshold decision |
| Config / dependency / auth / science | Not selected: unchanged |

Required cases: successful real report generation for both existing card types with legal PLAN in observations; plan belongs to a different task and is still accepted; generated analysis_ids stays empty and sensitivity_summary null. Missing standalone PLAN in each authored field rejects before writes, and the stale-card case observes zero job-query/collection calls plus exact tree/card bytes/mtime. Missing analyses stays missing. Target/root symlink and special files, malformed JSON/schema, foreign embedded id and injected read failure preserve link/target/plan bytes/mtime and return token without payload or absolute paths. Literal cases include PLAN-0001, uppercase suffix, XPLAN-20261108T093000-5c1e, PLAN-20261108T093000-5c1e_x and DEC; none creates analyses or reads a plan. Duplicate valid PLAN across summary/observations/limitations/pi_questions reads exactly once, while a later invocation observes changed/missing bytes.

Verification: parent semantic tracer RED, focused tools citation suites + report-generation compatibility GREEN, pnpm run build, actual built checkReportCitations filesystem smoke, pnpm run check, openspec validate m5-oat-sensitivity --strict --no-interactive, expanded three-seat review, exact-head all-jobs-success CI. Only task3.6a closes; no #657/#658/#667 or shared-change archive.

## Issue #657 risk packs and executable evidence

| Pack | Required executable evidence |
|---|---|
| Public API / type cutover | All ClosureResult consumers and five pure-render callsites migrated; no obsolete field aliases; meaningful failure tuple/type checks remain |
| File IO / identity / resources | Canonical readRunMetrics reused; referenced-only reads; null artifact no read; missing/tamper/bad JSON/schema/root/run/target links/special files fail with file identity; renderer, validator and generation share boundary; bytes/mtime preserved |
| Numerical display | Stored 0.0008 and123456.789 exactly, fractions/exponent boundaries via JSON.stringify; null+reason versus absent not_available; three verdicts only, max_solver_dt value without verdict; source_ref id/path/SHA and run order |
| Ordering / partial output | Generation metric failures before report publication; initial reconcile retained; later render/repair preserve existing commit semantics; source metric changes observed on next render |
| Limitations / governance | Authored items first; one fixed max_solver_dt entry; run then residual/cvode/negative order; warn/fail/not_available only, values11fail/10warn, no pass/per-run-max/coverage/agent-range/failed-cell entries; empty authored limitations still fail |
| Legacy compatibility | Frozen M3 input files/output and both old goldens: all non-section5 bytes identical; ten headings, four invariants, empty M3 section7; persisted JSON unchanged; existing code-change closure/wording-scan rules retained |
| Runtime / packaging | Built APIs and both pure-render oracles; exact captured metric bytes bind expected SHA; valid and old-sentence/missing-section negatives for first-task/replay; real commands both exit0 with canonical log/workspace evidence |
| Documentation / decisions | Scoped proposal/design/task plan and API comments; target domain docs already aligned; no new architecture/threshold decision |
| Config / dependency / auth / science | Not selected; unchanged, automated existing approvals are engineering-only |

Acceptance matrix: science and code-change generate with null/unavailable metrics and non-pass verdicts without changing closure run clauses; residual0.03warn yields one health entry plus fixed entry, other pass values add none; negative10warn/11fail preserve numeric value; two-run report still one fixed entry. Code-change first paragraph is new constant and not persisted in JSON; adversarial model prose cannot alter it. No-change reports with verification references still omit it. All seven metric values, three verdicts, reasons and source references come only from bound metrics; unavailable files render their stored null/reasons, null artifacts render not_available. Tamper/delete/unsafe metrics reject without report/source mutation. Validator remains15checks, check14 logic and4/10 comments unchanged; #658 owns their later change.

Review-qualified boundaries: an exact authored max_solver_dt fixed-entry collision (fresh call or regeneration reusing prior generated limitations) rejects before query/reconcile/writes, with controlled field/entry diagnostic and no report/link changes. Non-exact quotations and other authored fields remain allowed; no forbidden-phrase expansion. Two actual ToolRuntime ordering tests must show (a) a stale card's independent reconciliation survives a later metrics digest failure without report publication and (b) committed report/card state, including an earlier entry-repair card commit when applicable, survives metrics-caused Markdown repair failure; preserve relevant bytes/mtime and fault evidence.

Runtime proof is required separately for each first-task and replay oracle: round-trip synthetic non-null metrics.json through its real collector -> snapshot adapter -> pure-render call, bind SHA256 to original captured bytes, and include a whitespace-preservation case. For each oracle a digest-mismatch/tamper counterfactual must fail and identify runs/<run_id>/metrics.json. Shared-adapter-only coverage or empty-metrics placeholders cannot satisfy either path. Keep real #657 runs on current null-artifact collection behavior; do not add #662 non-null collection assertions. Both oracle paths must also reject old sentence and missing per-run segment with other evidence valid, retaining exact rerender equality and all approvals/identity/preservation predicates. No full real baseline rerun is needed to reproduce already-specified obsolete wording; semantic RED uses focused old renderer/tool/oracle paths.

Commands: focused records/tools/core/runtime suites; pnpm run build; parent built smoke and frozen byte comparison; pnpm run check; pnpm run shud:first-task <scratch>; pnpm run shud:replay <scratch>; strict OpenSpec validation; expanded three-seat review and exact-head all-success CI. Only task3.6b closes. Full runtime evidence is required, shared M5 change is not archived, and no PI gate is closed.

## Issue #658 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Public API / type contracts | Selected: validator result type 17 entries (typecheck file updated, negative @ts-expect-error retained for wrong length); exported limitation deriver used by tests with plan and summary inputs; tools description no "fifteen", tool result passes 17 checks through |
| File IO / path safety | Selected: (17) delete / symlink replacement / one-byte rewrite of `.sensitivity.json` each fail naming the path, report stays draft, JSON/MD/summary bytes unchanged; renderer reuses #655 reader only |
| Schema / numeric display | Selected: `-33.33333333333333` rendered exactly (never `-33.33`); null cell = `null` + `zero_baseline`; failed row null metrics/deltas + exit_code/exit_class; path + sha256 shown; no ranking/explanation text |
| Ordering | Selected: rows in file order; §7 merged by `job_id` code-point order with a no-RunRecord superseded job sorting between two failed RunRecord runs; superseded run with RunRecord listed once; deriver leading/trailing contract composed in records with literal kind 3/4 entries (1→5, one max_solver_dt); real ToolRuntime composition deferred to #667 |
| Legacy compatibility | Selected: science_assist and code_change goldens byte-identical; science_assist validation lists 17 with (4)/(10) by construction, (11) always true, (14)–(17) not applicable; TMPDIR workspace passes 17; scripts/runtime unchanged |
| Error handling / partial output | Selected: (16) missing coverage or agent-range sentence (via altered limitations) fails with `sensitivity_statement_missing` naming the sentence and keeps draft; schema/parse-invalid summary → (16) `render_unavailable`; non-null `sensitivity_summary` rendered without summary argument throws `ReportRenderError` (negative test) |
| Documentation | Selected: `Report_Generation_Spec.md` 17 checks incl. 16/17, (4)(10)(11) wording updated; `Migration_Plan_dsh.md` and `docs/adr/implemented/0014-*` byte-identical; `pnpm run docs:check` green |
| Scientific governance / evidence lineage | Selected: Δ segment contains no ranking, index, elasticity or explanatory text (asserted by negative string checks on the golden); coverage and agent-range sentences verbatim from core templates; every displayed value traced to `.sensitivity.json` sha256; label residual risk recorded |
| Hydrology runtime | Not selected: no SHUD/rSHUD invocation, input or physics change; real sessions only re-exercise report_validate |
| dsh seam / profile / outbound | Not selected: tool description text is model-visible but no tool id, parameter schema, seam, profile or policy row changes; `profile:smoke` unaffected (run by check-equivalent CI) |
| Config / auth / concurrency / dependency / resource | Not selected: no profile, permission, lock, dependency or new unbounded read |

Acceptance matrix: the issue's 13 acceptance bullets map to tests above (the 1→5 tools-side composition bullet partially, remainder recorded for #667) plus a new sensitivity golden (4 psets, PSET-3 effective run failed cvode, PSET-2 superseded failed run) with its 17-check validation result checked in.

Commands: focused records/tools suites; semantic RED before implementation for delta segment, §7 superseded entry and checks 16/17; `pnpm run build`; parent built smoke rendering/validating the sensitivity fixture from `lib/`; `pnpm run check`; `pnpm run shud:first-task <fresh scratch>` and `pnpm run shud:replay <fresh scratch>` (both exit 0; evidence = session-log `report_validate` tool/result with `checks.length === 17` and ok, for the science_assist and code_change reports respectively — the oracles themselves only assert ok/status); strict OpenSpec validation; expanded three-seat review; exact-head CI all success. Only task3.6c closes; shared change not archived.

## Issue #659 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Public API / CLI entry | Selected: `shud-cfg-rewrite.ts` CLI updates only END (unit test on CLI path + real `shud:tiny` exit 0 with `.dat` < 2 min); Usage string renamed; `git grep -n "shud-end" -- ':!openspec/changes'` → 0 |
| File IO / byte fidelity | Selected: unit matrix — present (`dt_ye_ic  0\r\n` → `dt_ye_ic  1440\r\n`), commented `# DT_YE_IC 60` untouched, multiple effective lines all rewritten, absent+CRLF+no trailing EOL → bytes+`\r\n`+`DT_YE_IC\t1440`+`\r\n`, no EOL at all → `\n`, empty file, latin-1 high bytes preserved |
| Ordering / provenance | Selected: integration — ccw `end_days: 30` copy END 30 + appended line, source bytes unchanged, run-job `running`; provenance `cfg.para` sha256 == rewritten copy sha256 |
| Error handling / rollback | Selected: new `rewrite` phase in the existing phase table `submit-shud-faults.test.ts:102-141` (mock `node:fs/promises` readFile and/or the write path only for the run-copy `cfg.para`) → no `runs/<run_id>/`, no active/completed index entry, pre-seeded `stacks/` and `provenance/` byte-for-byte unchanged, no wrapper launched, source unchanged; `verifyRun` after rewrite |
| Concurrency / shared state | Selected: rollback path reuses existing stateDir lock/index handling; existing concurrency tests unchanged and green |
| Legacy compatibility | Selected: build_id+threads submission also gets DT_YE_IC with NUM_OPENMP/START/END bytes unchanged; `input_bytes` = pre-rewrite copied bytes; every listed jobs/tools copy assertion converted to exact `pureTransform(source)` (tree-level helper for snapshotTree sites), none removed; mixed-version VC pair fail-closed documented as non-goal |
| Replay oracle | Selected: snapshot captures prepared cfg raw bytes; evidence requires run-copy sha == sha256(pureTransform(prepared)); forged fixtures (one extra changed line; NUM_OPENMP changed) → exit 1 naming `keliya.cfg.para`; other files provenance == prepared; records join unchanged |
| Hydrology runtime | Selected: real `shud:replay` exit 0, VC passed, rivqdown bitwise unchanged; `shud:first-task` and `shud:restart` PASS as submission-path regression |
| Documentation | Selected: `SHUD_IO_Facts.md:68,148`, `Runtime_Lifecycle.md:26,63`, `Repository_Layout.md:84`, `Park_Resume_Design.md:342`, `Minimal_Schemas.md:197` updated (three beyond the issue = recorded deviation); `Migration_Plan_dsh.md` untouched; `pnpm run docs:check` green |
| Auth / dependency / profile / science | Not selected: no credentials, packages, profile rows; DT_YE_IC is an output switch, not a physics/default-parameter change |

Commands: unit + integration RED before implementation; focused jobs/tools/runtime suites; `pnpm run build`; `pnpm run check`; `pnpm run shud:tiny`; `pnpm run shud:first-task <scratch>`; `pnpm run shud:restart`; `pnpm run shud:replay <scratch>`; strict OpenSpec validation; expanded three-seat review; exact-head CI. Only task4.1a closes.

## Issue #660 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Public API (internal request) | Selected: exported `SubmitShudRequest` gains four optional snake_case fields; tools compile unchanged; typecheck tests for field types |
| Preflight validation | Selected: each issue-listed illegal request (two overrides, `SOIL_BETA`, multiplier 1 or 3, overrides with null ids, bound with null threads, bound with null/`{}`/`../ccw.cfg.calib` digests, unbound with non-null digests, unpaired ids, bad brand) rejects with a reason and no run directory and no input read |
| File IO / path safety | Selected: digest check reuses `readShudInputFile`; integration: mismatch on `ccw.cfg.calib`, missing `ccw.para.lc`, key naming a directory → error names relative path, full rollback; all-equal → success; symlink/special rejection covered by the reader's existing tests |
| Schema / numeric | Selected: `GEOL_KSATH\t1\n`×2 → `GEOL_KSATH\t2\n`; `LC_ROUGH` 0.3×0.5 → `0.15` with separator/EOL kept; round-trip property `Number(String(b*m)) === b*m`; 0/2 effective calib lines or `#`-only → fail naming key; non-finite value → fail |
| NUM_OPENMP | Selected: ccw `NUM_OPENMP\t8\n` bound threads 1 → `NUM_OPENMP\t1\n`; comment-only `# NUM_OPENMP 4` with threads 2 → appends `DT_YE_IC\t1440\n` then `NUM_OPENMP\t2\n`; unbound threads 2 → unchanged, no append, wrapper env both vars 2 |
| Error handling / rollback | Selected: every new failure point (digest, NUM_OPENMP write, calib count/value, read/write injection) → no run dir, no index entry, no provenance, no wrapper, source unchanged; a lock pre-seeded by an earlier successful submission in `stacks/` stays present and byte-identical |
| Persisted state / ordering | Selected: provenance sha of `ccw.cfg.calib` and `ccw.cfg.para` == rewritten copy; `run-job.json` first `created` write contains ids + threads; `shud-collect.ts` copies ids so collected RunRecord ids equal RunJob ids (RED today: null); unbound run-job `toEqual` at submit-shud.test.ts:56 unchanged |
| Concurrency / shared state | Selected: baseline + three perturbed psets in one env → four equal `stack_id`, one lock in `stacks/`, perturbed calib hashes differ from baseline |
| Legacy compatibility | Selected: baseline pset `.cfg.calib` byte-identical, `.cfg.para` differs only at END/DT_YE_IC/NUM_OPENMP; existing unbound jobs/tools suites unchanged and green; `pnpm run shud:tiny`, `pnpm run shud:restart` PASS |
| Hydrology runtime | Selected: calib/NUM_OPENMP semantics cited to pinned SHUD source (`%lf` read-back, `omp_set_num_threads` from cfg) in tests/comments |
| Documentation | Selected: `Runtime_Lifecycle.md:26`, `Park_Resume_Design.md:342`, `Minimal_Schemas.md:197`, `SHUD_IO_Facts.md:68` (rewrite list + source line refs) updated; recorded boundary deviation; `pnpm run docs:check` green |
| Auth / dependency / profile | Not selected: no credentials, packages or profile rows |

Commands: RED before implementation; focused jobs suites; `pnpm run build`; `pnpm run check` (incl. docs:check); `pnpm run shud:tiny`; `pnpm run shud:restart`; strict OpenSpec validation; expanded three-seat review; exact-head CI. Only task4.1b closes.

## Issue #661 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Concurrency / ordering | Selected: two concurrent same-task/plan/`PSET-2` submissions → exactly one fulfilled, the other rejects naming the pset; no run dir, index entry or provenance for the rejected one; claim is synchronous and once; plan-bound EEXIST redraw (pattern submit-shud-collisions.test.ts:70-100) succeeds without self-rejection; AggregateError rollback (injected cleanup failure) keeps the pair so a same-pset resubmission is still rejected |
| Persisted state semantics | Selected: existing `running` job, terminal-uncollected `succeeded` job (ledger below limit), and collected job with RunRecord `succeeded` → rejection, `runs/` unchanged, existing files byte-identical; RunJob `failed`, `cancelled`, collect-exhausted ledger, collected `succeeded` + exhausted ledger (documented decision), RunRecord `failed`, rolled-back in-flight (injected failure) → resubmission accepted with new `run-job.json`, failed-job `run-job.json`/`run-record.json`/`collect-error.json` byte-identical |
| Error handling | Selected: corrupt `collect-error.json` (and unparsable RunJob) → explicit canonical error, not allowed as failed; ledger validation shared with `readLedger` (single implementation) |
| Legacy compatibility | Selected: different pset and unbound submissions accepted unchanged; existing collision/submission suites green; `pnpm run shud:restart` PASS |
| File IO | Selected: rejection happens before `prepareInput`'s input walk — a nonexistent `input_dir` with a duplicate pair yields the duplicate error (not ENOENT), and the rejected submission never calls `io.copyFile`/`io.mkdir` (mock pattern submit-shud-collisions.test.ts:26-29); sync readers reuse the factored RunJob/RunRecord/ledger validators |
| Scientific governance / evidence lineage | Selected: closure's single effective run depends on this check; failed-job files byte-identical after accepted resubmission (lineage); exhausted+succeeded decision recorded in design Risks |
| Hydrology runtime (Park/Resume durability) | Selected: `pnpm run shud:restart` PASS; restart loses only the in-memory table, persisted non-failed jobs still reject |
| Test construction note | Use `ccwPlanFixture`/`planRequest` for bound submissions, `queryRecord`/`writeQueryRecord`/`indexed` for seeded jobs, `makeRunRecord`, ledger literals from collect-error-attempts.test.ts, `failNthWrite`, copyFile barrier; set a large `pumpPollMs` (or snapshot after seeding settles) so polling does not auto-collect seeded jobs |
| Schema / auth / docs / dependency | Not selected: no schema, permission, documentation or package change |

Commands: RED before implementation; focused jobs suites; `pnpm run build`; `pnpm run check`; `pnpm run shud:restart`; strict OpenSpec validation; expanded three-seat review; exact-head CI. Only task4.1c closes.

## Issue #663 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Raw data / path safety | Selected: rawDirs `analyses` (exists / absent) → `raw-immutable` deny, test tool execute and approval not called, `analyses/`, `tasks/` and raw snapshots unchanged; rawDirs `tasks`, `tasks/<id>`, `tasks/<id>/task.json` (exists / absent) → deny; session cwd or `analyses` reached through a symlink into raw, or an existing case alias → deny `raw-immutable`; an absent case-alias target that cannot be proven → `raw-path-unavailable` (pattern decide-verification-target.test.ts:253-257); rawDir sibling `analyses-input` → `next()` exactly once; rawDirs `analyses/<other_plan>.json` or `tasks/<other_task_id>` with a valid different `task_id` → `next()` exactly once, no approval |
| Approval seam | Selected: rawDirs `prot`, `input_dir` `prot/ccw` or a workspace symlink to it → `ask` with reason `=== RAW_READ_PROVENANCE_REASON` (imported constant, same object as `shud_run`); approval denied → tool not executed, `analyses/` and card unchanged; one rawDir covering `input_dir` and another covering `analyses`, in both rawDirs orders → deny without approval; `input_dir` missing or a number → write-target decision, no throw |
| Error handling / partial outputs | Selected: injected EACCES or a symlink loop on the `analyses`/`tasks` target, on a rawDir, or on `input_dir` (and an `input_dir` containing a NUL byte) → deny `raw-target-unavailable`, `next()` and approval not called, reason and logger line contain no error text or path, no directory created (pattern change-create-pre-execute.test.ts:290-311, decide-verification-target.test.ts:243-251) |
| Argument robustness | Selected: an arguments object whose `task_id` getter throws → fixed `tasks` root, no throw; `task_id: "TASK-0001"` and `arguments: null` with rawDirs `tasks` → deny via fixed root, no throw; with rawDirs `data/raw` → `next()`; `rationale_basis`/`parameter_sets` containing `data/raw/x` with disjoint rawDirs → `next()` exactly once, no approval |
| Governance matrix (model-visible contract) | Selected: extend the literal root list in `decide-governance.test.ts:30-39` (kept literal, not imported from production) from nine to ten, and add `analysis_create` to the reason-text tool list at `decide-governance.test.ts:249-266` keeping all ten existing tools; coordinator `write` `analyses/PLAN-20261108T093000-5c1e.json` (exists) and `analyses/new.json` (absent); worker `bash` `sed -i 's/2/3/' analyses/PLAN-...json` and `echo {} > analyses/x.json` → four `deny` `governance-immutable`, reason contains `immutable` and `analysis_create`, plan bytes unchanged, no approval, logger line without path; coder `bash` `cat analyses/...`, `ls analyses`, `read` → `next()` exactly once; `alias→analyses` symlink and `ANALYSES/x.json` (case-insensitive FS, `analyses` exists) → deny `governance-immutable`; `ANALYSES/x.json` while `analyses` is absent → `raw-path-unavailable` (same as the existing `CHANGES` case, governance-path-identity.test.ts:179-209); `analyses-old/x.json` → `next()` |
| Legacy compatibility | Selected: every existing raw-guard suite passes without weakening (nine roots, `shud_run`, task/change/build/verification/report targets); `shud_run` with `input_dir` reading under `analyses` unchanged |
| Docs | Selected: `Workspace_Conventions.md:79` governance-records row gains `analyses` (`runs` keeps its own row at :78, so the two rows together list ten roots), `Workspace_Conventions.md:210`, `Roles_and_Boundaries.md:165`, `Repository_Layout.md:225`, `Runtime_Lifecycle.md:14`, `openspec/glossary.md:76` list ten roots including `analyses`; `git grep -n "九个治理根\|九根\|verifications.*builds"` reviewed (excluding `docs/99_ARCHIVE`, `docs/adr/implemented`, `openspec/changes`) no remaining statement of nine roots or a governance-root list without `analyses`, except expected leftovers outside this PR: `openspec/specs/raw-data-guard/spec.md:713` and `openspec/specs/task-cards/spec.md:92` (main specs update from the delta at archive), `packages/dsh-shud-presets/prompts/coder.md:21` (presets boundary, reported to #665), and unrelated matches such as report citation kinds; no other wording changes |
| Concurrency / ordering | Selected only as rawDirs-order independence (see Approval seam, both orders); no shared mutable state — decision is a pure function of path metadata |
| Config / project setup | Not selected as new config: the ten roots are a fixed constant (no profile key); rawDirs config semantics unchanged |
| Schema / jobs / dependency / prompts / resource limits / public API | Not selected: no schema, persistence, package, resource or CLI change; presets prompt drift reported to #665 |

Commands: RED before implementation (new tests fail for semantic reasons); focused raw-guard suites; `pnpm run check`; strict OpenSpec validation; expanded three-seat review with whitebox record (Critical Path #2/#3); exact-head CI. Closes task 5.1; also ticks 4.1c (merged #661). Task 4.2 stays open until #662 merges.

## Issue #664 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Model-visible contract | Selected: acceptance call (sensitivity/planned card, workspace `input/ccw` copy, `end_days: 90`, baseline + `{GEOL_KSATH: 0.5}` + `{GEOL_KSATH: 2}` + `{LC_ROUGH: 2}`) → `PLAN-…` id and `PSET-1..PSET-4` with labels/baseline/changes; plan `threads: 1`, `input_dir` realpath, `project: ccw`, `created_by: coordinator`, `confirmed_by: null`, `proposed_by: agent`, `input_digests` keys exactly `ccw.cfg.calib`, `ccw.para.geol`, `ccw.para.lc` equal to file sha256; `threads: 2` recorded; `threads: 0`/`1.5`/`"1"` names `threads` with no FS access; unknown keys `confirmed_by`/`proposed_by`/`parameter_set_id`/`analysis_plan_id`/`input_digests` and root `[]` → error naming key/root, backend not called, `analyses/` and `tasks/` bytes and listings unchanged; missing session cwd → workspace error before FS access; an unknown key inside a `parameter_sets` element (e.g. `parameter_set_id`) → error naming it through the real `defineTool` validator, backend not called, nothing touched; omitted `project` with `input_dir: "input/ccw"` → plan `project: ccw`; `input_dir: "."` without `project` → error naming `project`, no write; existing `shud_run` project-default tests unchanged |
| Persisted state semantics | Selected: card `linked_analyses: [id]`, `updated_at` refreshed, `status` still `planned` (and `running` stays `running`), `runtime_phase` still null, other fields byte-equal; `science_assist` card, `reporting` sensitivity card, missing `task_id`, already-linked card → named errors, `analyses/` unchanged, card bytes unchanged; for the missing `task_id` the `tasks/` listing is unchanged (no `tasks/<id>/` created) and an absent `analyses/` stays absent; plan file passes AnalysisPlanSchema and no temp file remains |
| Error handling / partial outputs | Selected: injected card write failure after plan publication → error contains the plan id and "plan 已落盘、任务卡回写失败", plan kept, `linked_analyses` still `[]`; card changed to `reporting` (or linked) between step (2) and (7) via injected hook → same id-bearing error; same-argument retry → same id returned, card linked, plan bytes and mtime unchanged, `analyses/` file count unchanged; one id collision → the reallocated id is written and returned, the card links that id (not the first drawn), the pre-existing file's bytes and mtime unchanged; 4 consecutive id collisions → id-conflict error, nothing written, card unchanged (stub id allocation or pre-seeded files per records pattern) |
| Orphan repair | Selected: orphan + different multiplier (2 → 1.5), different order, different `end_days`, `threads: 2`, or modified `ccw.cfg.calib` → error naming the orphan id, plan and card bytes unchanged; two orphans → error naming both; `<AnalysisPlanId>.json` with invalid JSON or as a symlink → error naming the entry, not skipped, bytes unchanged; another card's valid plan in `analyses/` does not block |
| File IO / path safety | Selected: `analyses` as a symlink → error naming `analyses`, link target gains no file, card bytes unchanged; `input_dir` absent, a file, missing `.cfg.calib`, missing category table → error naming it, no write; `input/ccw` bytes unchanged after success; tool writes nothing under `runs/`, `stacks/`, `provenance/`, `reports/` |
| Plan content validation | Selected: two baselines, a two-key perturbation, multiplier `2.5`, non-whitelisted `SOIL_BETA` → error naming `parameter_sets`, no write, `input_dir` bytes unchanged |
| Raw data protection | Selected: real ToolRuntime + raw-guard: rawDirs `analyses` (exists/absent) and `tasks/<id>/task.json` (exists/absent) → `raw-immutable`, execute not called, snapshots unchanged; rawDirs covering `input/ccw` → approval asked with `RAW_READ_PROVENANCE_REASON`, denied approval → tool not executed |
| Mount / delegation / role exposure | Selected: registered tool list (real runtime) equals the full ordered 12-name list (`shud_run`, `shud_collect`, `task_create`, `change_create`, `change_submit`, `shud_build`, `verification_run`, `report_generate`, `report_validate`, `report_submit`, `report_decide`, `analysis_create`); valid call with injected backend failure → called exactly once, error returned, no retry; `isRoleToolIdAllowed(role, "analysis_create") === false` for coordinator/worker/coder/reviewer (core decision, so policy-gate denies `role-tool-surface`); `pnpm run profile:smoke` green — proves only that the `shud-tools` plugin still mounts and preset surfaces are unchanged; the tool list is proven by the tools-package test |
| Docs | Selected: `Repository_Layout.md:25` mounted list includes `analysis_create`; no other wording change |
| Resource limits / discovery | Not selected: the `analyses/` scan is the single bounded directory listing per call at OAT batch scale (one plan per card), and input reads are the existing records safe readers with their existing limits |
| Release / packaging / dependency | Not selected: no new package or dependency; tools already depend on core and records |
| Schema / core / policy-gate / presets / concurrency | Not selected: no schema or role-map change; exposure and policy-gate regressions are #665; concurrency limited to records' exclusive publication (covered by the collision row) |

Commands: RED before implementation; focused tools suites; `pnpm run check`; `pnpm run build` + `pnpm run profile:smoke`; strict OpenSpec validation; expanded three-seat review with whitebox record (Critical Path #2); exact-head CI. Closes task 5.2a; ticks 5.1 (merged #663).

## Issue #665 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Auth / permission | Selected: `getRoleToolIds("coordinator")` inherited exactly the ten names in spec order and local exactly the three delegation tools; `isRoleToolIdAllowed(·, "analysis_create")` true only for coordinator (false for worker, coder, reviewer, repo_explorer); policy-gate worker/coder/reviewer `analysis_create` → three `deny` with role and tool id in reason, `next()` not called, no approval; coordinator `shud_run` with `analysis_plan_id`/`parameter_set_id` → deny naming `coordinator` and `shud_run` |
| Approval seam | Selected: coordinator `analysis_create` with valid args and with `arguments: null` → no throw, `next()` exactly once, no ask/approval; unknown role → `next()`, no ask; worker plan-bound `shud_run` → `next()`, no ask; gate reads no `analyses/`, `tasks/` or input files — mechanism: `vi.spyOn` on `node:fs` sync readers (`readFileSync`, `statSync`, `lstatSync`, `readdirSync`, `openSync`) and `node:fs/promises` (`readFile`, `stat`, `lstat`, `readdir`, `open`) asserting zero calls during the coordinator `analysis_create` and worker plan-bound `shud_run` decisions; alternatively (or additionally) a workspace with corrupt/unreadable `analyses/` and `tasks/` and a missing `input_dir` still yields `next()` exactly once, no throw, no ask |
| Single source (restrict ↔ policy-gate) | Selected: for each of the four roles, restrict allow passed via `agent.ctx` equals `inherited`, policy-gate allowed set equals `inherited ∪ local`, both from the same entry; worker/coder/reviewer visible surfaces exclude `analysis_create`; presets `test-harness.ts` adds `analysis_create` to the registered pool `GLOBAL_TOOLS` (:51-64) — required so the coordinator restrict does not fail loud on an unmounted name and so the off-role exclusion assertions are non-vacuous — and updates the coordinator expected set; no existing assertion weakened. Set equality across all roles is carried by core `role-tool-map.test.ts` enumerating `isRoleToolIdAllowed` over the union (:138-155) plus the new policy-gate `analysis_create` cases; the gate layer is not claimed to compare whole sets per role |
| Model-visible contract (real Web) | Selected: local `pnpm run shud:first-task <scratch>` (needs `DMXAPI_KEY`, `SHUD_BIN`) PASS; then a separate extraction step (the first-task oracle does not check `header.tools`): for every `request/header` event in the retained root (coordinator) and worker child canonical logs, take sorted `data.header.tools[].name` and compare by exact set equality — coordinator = the ten inherited names plus the three delegation tools (13), worker = `shud_run`, `shud_collect`, `job_output`, `job_list`, `job_kill` (5); a missing `tools` array is FAIL, never skipped; script, session log paths and extracted lists recorded in the PR |
| Legacy compatibility | Selected: worker/coder/reviewer/repo_explorer rows unchanged (M4 rows scenario); legacy ids rejected; `ROLE_TOOL_IDS` contains `analysis_create` and no legacy id; `pnpm run build && pnpm run profile:smoke` PASS with no assertion change; all existing presets/policy-gate tests pass without weakened assertions |
| Docs | Selected: `Runtime_Lifecycle.md:14` coordinator inherited list names ten tools including `analysis_create`; no other wording change |
| Schema / persistence / file IO / raw-guard / prompts | Not selected: no schema or file behavior change; raw-guard unchanged; coder.md prompt drift deferred to #668 (presets product prompt is outside this boundary) |

Commands: RED before implementation; focused core/presets/policy-gate suites; `pnpm run check`; `pnpm run build && pnpm run profile:smoke`; `pnpm run shud:first-task <scratch>` for header evidence; strict OpenSpec validation; expanded three-seat review with whitebox record (Critical Path #1/#3); exact-head CI. Closes task 5.2b; ticks 5.2a (merged #664).

## Issue #666 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Model-visible contract | Selected: only one of the two ids, ids without `task_id`, `PSET-0` or malformed plan id → error naming the parameter with zero FS access (no job query, no `analyses/`/`tasks/` read, no run dir); `calib_overrides`, `changes` or `input_digests` → unknown-parameter error, no run dir |
| Plan-bound submission | Selected: card linked to a plan (`input_dir` = realpath of workspace `input/ccw`, `end_days: 90`, `threads: 1`), call `input_dir: "input/ccw"`, `PSET-3` (`{GEOL_KSATH: 2}`), no `end_days` → `running`; `run-job.json` has both ids, `end_days: 90`, `threads: 1`; wrapper thread env vars 1; copy `END` 90 and `NUM_OPENMP\t1`; original input and `analyses/` bytes unchanged; captured registry request has `calib_overrides: [{key: "GEOL_KSATH", multiplier: 2}]` and `input_digests` deep-equal to the plan file's (every key); baseline pset → `calib_overrides: []` |
| Threads / window | Selected: plan `threads: 1` + call `threads: 1` succeeds; plan `threads: 2` + omitted → RunJob 2, env and copy `NUM_OPENMP` 2; plan 1 + call 2 or 8 → names `threads`, no job query, no `tasks/` read, no run dir; `end_days: 30` vs plan 90 → names `end_days` |
| Plan validation precedes effects | Selected: plan missing, schema-invalid, other card's plan, pset not in plan, `input_dir` or `project` mismatch, `end_days` mismatch → names the item, `listRunJobsByTask` not called, card bytes and mtime unchanged, no run dir; plan of this card but not in `linked_analyses` → names "not linked", no run dir; input path given as `link/../ccw` with a symlink resolves physically (same rule as jobs) |
| Sensitivity / science_assist cards | Selected: sensitivity card without plan ids → error that it requires plan binding, no reconciliation publish, card bytes and mtime unchanged; science_assist card without plan ids → unchanged behavior, RunJob ids null, `analyses/` never accessed (FS spy or `analyses` as a broken symlink still succeeds); no-card unbound submit unchanged |
| Registry rejection mapping | Selected: `ccw.cfg.calib` edited after plan link → error naming `ccw.cfg.calib`, no run dir, no new index entry or provenance for this call, `linked_jobs` and plan bytes unchanged; same pset with a `running` or succeeded job → error naming the pset, no run dir, `linked_jobs` unchanged; only job failed/cancelled/exhausted → resubmission accepted, `linked_jobs` contains both, failed job files byte-identical; corrupt registry state at the duplicate check → tool error contains `SHUD parameter set check RUN-` and does not contain `already has a non-failed run` — construct it either with the real registry (a collected same-`(plan, pset)` job whose `run-record.json` is corrupt or missing, which `queryRunJobs` does not read but `readRunEvidenceSync` does) or by `vi.spyOn(h.registry, "submitShud").mockRejectedValueOnce(...)` with the exact registry message (pattern `shud-run-task.test.ts:118`); a corrupt `run-job.json` instead fails earlier in `listRunJobsByTask` (`SHUD task query RUN-…`) — if tested, label it as a task-query failure before submit |
| Approval seam | Selected: worker plan-bound `shud_run` with input outside raw → policy-gate/raw-guard pre-execute returns `next()`, no `approval/asked` (tool-layer regression; real chain where the existing harness allows); plan-bound `shud_run` with input inside raw still gets raw-guard's provenance ASK unchanged — raw-guard's `shud_run` decision (`decide.ts:618-638`) reads only `input_dir`/`task_id`, so add one plan-bound ASK case (or cite `decide-shud-run.test.ts` plus a plan-bound argument row) |
| Concurrency / ordering | Not selected as new work: the registry's `claimSet` claims the same pset synchronously before its first await (#661), and plan files are exclusively created and immutable, so reading the plan before the task-job await cannot go stale; residual: the tool's realpath check and the registry's own resolution are separate (a symlink swap in between is caught for content by the digest check) |
| Legacy compatibility | Selected: all existing `shud_run*` suites pass unchanged; `pnpm run build && pnpm run shud:tiny` PASS |
| Docs | Selected only as a check: grep docs for the `shud_run` parameter list (`Repository_Layout.md` "已挂载的 `shud_run`" section and similar) and update any statement that becomes false; otherwise none |
| Schema / jobs / records / core / prompts | Not selected: consumed only; prompts are #668 |

Commands: RED before implementation; focused tools suites; `pnpm run check`; `pnpm run build && pnpm run shud:tiny`; strict OpenSpec validation; expanded three-seat review with whitebox record (Critical Path #1/#3/#4); exact-head CI. Closes task 5.3; ticks 5.2b (merged #665).

## Issue #667 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Model-visible contract (task_create) | Selected: `repos/SHUD` absent (and, separately, a broken `repos/SHUD` symlink) → `task_create(type: sensitivity, title: "ccw OAT 敏感性", question_or_goal: …)` returns `TASK-…` + `planned`; `task.json` file has `type: sensitivity`, `source_base_commit: null`, `linked_analyses: []`, all other initial fields equal to the science_assist card; `repos/` and `analyses/` neither accessed nor created (FS spy on `node:fs`/`node:fs/promises` path arguments, pattern of `sensitivity-approval.test.ts`, or absence + broken-link proof); `type: engineering`, `ops`, omitted → tool error, `tasks/` absent or unchanged. The existing `task-create.test.ts:249` row that rejects `sensitivity` is the RED and flips to acceptance; `engineering`/`ops` rows stay |
| Sole writer of `linked_analyses` | Selected: sensitivity card with `linked_analyses: []` and a plan file `analyses/PLAN-….json` of this `task_id` on disk (the state left by an `analysis_create` write-back failure); (a) `report_generate` → error (closure clause 0) and the card's `linked_analyses` still `[]`, plan bytes/mtime unchanged; (b) `shud_run` with that plan's ids → "not linked" error and `linked_analyses` still `[]`; (c) a reconcile that does publish (stale `linked_jobs` repaired) leaves `linked_analyses` exactly as before and refreshes `updated_at` |
| Sensitivity draft (happy path) | Selected: `running` sensitivity card, one plan with 4 psets (baseline + `GEOL_KSATH`×0.5, ×2, `LC_ROUGH`×2), each with one collected succeeded run whose `metrics.json` is `ok` with matching sha256 → result `report_id` + `draft`; `reports/` gains exactly `<id>.sensitivity.json`, `<id>.json`, `<id>.md`; report `analysis_ids` equals card `linked_analyses`; the plan file is written with non-canonical bytes (different indentation/inter-key whitespace, no trailing newline) and summary `plan_sha256` equals sha256 of those raw bytes and differs from sha256 of `JSON.stringify(plan)`; `sensitivity_summary` = `{path: "reports/<id>.sensitivity.json", sha256: sha256(file bytes)}`; `limitations` = authored entries, then the coverage statement `仅在 ccw 单流域、90 天窗口、相对 baseline 测试了 GEOL_KSATH×0.5, GEOL_KSATH×2, LC_ROUGH×2；未覆盖其它参数、取值与窗口`, then `参数范围为 agent 建议值，未经 PI 确认`, then the `max_solver_dt` constant exactly once, and nothing else (all four metrics `ok` with every threshold verdict `pass`, no failed cell); card `reporting` with `report_id` appended; `report_validate` on the generated id passes |
| Failed cells and superseded runs | Selected: non-baseline `PSET-3` effective run collected with `status: failed`, `exit_class: cvode`, and one succeeded run with `water_balance_residual` verdict `warn` (or `negative_state_count: 11` → `fail`) → report generated (threshold verdicts do not block closure); `limitations` asserted by whole-array equality `[authored…, coverage, parameter_range, max_solver_dt, kind-4 (that run_id/metric/verdict/value), kind-5 (PSET-3, run_id, exit_code, cvode)]` with `max_solver_dt` count 1 and no kind-4 entry for the failed run (closes the #658 limitation 1→5 follow-up). `PSET-2` failed-then-succeeded (both collected) → `linked_runs` contains both runs in `linked_jobs` order (assert every superseded run with a RunRecord / `exit_class !== null` is in `linked_runs`, #702 follow-up) and only the succeeded run appears in summary `rows` |
| Uncollected superseded run (ordered-record filter) | Selected: `PSET-2` first job RunJob `failed` with no `run-record.json` (variant: RunJob `succeeded` but never collected, with its ledger exhausted at `MAX_COLLECT_ATTEMPTS` — a `failed` RunJob is classified `failed` regardless of the ledger, `sensitivity-summary.ts:144-153`), later job collected succeeded → report generated (old code throws `missing record for <job_id>`: RED); `linked_runs` excludes the uncollected job's run; summary `superseded_runs` contains it with `terminal_state` `failed` (resp. `collect_exhausted`) and `exit_class: null`; `collectShud` never called for it; its run directory gains no `run-record.json`/`collect-error.json` and ledger bytes unchanged. Together with the previous row, superseded runs with a RunRecord are in `linked_runs` and those without are not |
| Readonly collect exception | Selected: non-baseline pset whose only job is RunJob `failed` uncollected, or one whose collect ledger is exhausted → the predicate decides (clause 3 names that pset/job), not a pre-closure "uncollected" error; the job's run directory gains no `run-record.json` or `collect-error.json` and existing ledger bytes are unchanged; `collectShud` called only with `{readonly: true}` and only for `collected` jobs (spy). A `running` job → clause 1 `job_not_terminal`. Corrupt `collect-error.json` → existing `collect evidence failed for <job_id>` error before closure, no report files |
| Closure failure writes nothing | Selected: baseline effective run collected `failed`/`cvode` → error names sensitivity clause 3 and the baseline `parameter_set_id`; `reports/` directory listing identical before/after (no `.sensitivity.json`), card bytes unchanged when reconcile had nothing to publish, and only the reconcile change when it did |
| Report id allocation | Selected: mock `node:crypto` `randomBytes` (pattern `report-allocation-siblings.test.ts:15`) so the first drawn id has only `reports/<id>.sensitivity.json` pre-seeded → the report is published under a reallocated id, pre-existing file bytes/mtime unchanged, the card links the new id; same for a pre-seeded lone `.md` on a science_assist report (regression) |
| Plan bytes / summary errors | Selected: plan bytes read by descriptor-bound no-follow read of `analyses/<id>.json` (not reserialized); a plan file whose bytes are replaced between closure and the byte read (inject via spy on the records byte reader or on `readShudInputFile`) → error naming `sensitivity_summary`, no `reports/` files, card unchanged |
| Type gate | Selected: `type: engineering` (and `ops`) `running` card → error naming the card `type`, no job query, `reports/` absent/unchanged, `task.json` bytes and mtime unchanged (existing rows kept); sensitivity accepted at the same gate |
| Legacy compatibility | Selected: science_assist success → `limitations` = authored + deterministic entries with no `无指标 artifact` text, `analysis_ids: []`, `sensitivity_summary: null`, no `.sensitivity.json`; all existing `report-*.test.ts` and `task-create*.test.ts` pass with no weakened assertion; `pnpm run build && pnpm run shud:tiny` PASS |
| Docs | Selected: `Report_Generation_Spec.md:36` ("sensitivity 报告的工具生成路径仍待 #667") and `:57` (sensitivity now has a predicate), `Repository_Layout.md:118` (task_create accepts sensitivity), `Task_Playbooks.md:20` (stale "M3 task_create 仅接受 science_assist"); no other wording change; PR body declares these doc files as a boundary deviation |
| Schema / records / jobs / core / raw-guard / policy-gate / prompts | Not selected: consumed only; prompts are #668 |

Commands: RED before implementation; focused tools suites; `pnpm run check`; `pnpm run build && pnpm run shud:tiny`; strict OpenSpec validation; expanded three-seat review with whitebox record (Critical Path #6); exact-head CI. Closes task 5.4; ticks 5.3 (merged #666).

## Issue #668 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Model-visible contract (coordinator) | Selected: all lookups scoped to the new `## sensitivity workflow` section (not whole file), using the cursor-sequential paragraph-bound style of the code_change test (`prompts.test.ts:187-203`); asserts the section exists and orders `task_create` (with `type: sensitivity`) < `analysis_create` < `subagent` < `report_generate` < `report_validate` < `report_submit` by index within that section; the `analysis_create` step says exactly one plan (`exactly once|exactly one`); the delegation sentence names `task_id`, `analysis_plan_id`, `parameter_set_id` and `input_dir`; the waiting step says the report arrives as the subagent-settled message, the immediate `started subagent` result is not the report, and `report_generate` is not called before it; the `shud_collect` fallback sentence in the section is conditioned on the settled report lacking collected terminal evidence; contains "only whitelisted-key multipliers"/"never absolute calib values", "do not call `analysis_create` again" for a linked card, and the no-indices/rankings/mechanism + agent-suggested-range sentence |
| Model-visible contract (worker) | Selected: lookups scoped to the new `## Plan-bound sensitivity runs` section (build-bound text already mentions `end_days`/`build_id`/`threads`); asserts the exact call form `shud_run(task_id, input_dir, analysis_plan_id, parameter_set_id)`, "both" plan params every time, the four never-pass items (calib values, `end_days`, `build_id`, `threads`) in the same sentence as that call form, the rejection-no-retry sentence (omitting plan params or `task_id`), submit-all-then-`job_output(wait: true)`+`shud_collect`, failed pset not resubmitted with `parameter_set_id`/`run_id`/terminal status reported, and the no-plan path restricted to `science_assist` with both `build_id` and `analysis_plan_id` absent |
| Wording guard | Selected: in the new sections every match of `sensitivity ind|rank|mechanism` sits in a sentence that also contains a negation (`no|not|never|不`); no sentence pairs `report_validate|guard|lint` + `pass` with `complian|sufficient` without a negation; no `FORBIDDEN_REPORT_PHRASES` entry appears in `worker.md` at all or in `coordinator.md` outside its canonical list block; existing guard-boundary test still passes; drift test (`FORBIDDEN_REPORT_PHRASES`/`GOVERNANCE_INVARIANTS` verbatim in coordinator/coder/reviewer) unchanged and green |
| Legacy compatibility | Selected: all existing `prompts.test.ts` cases pass; only the worker no-build assertion is updated to the spec's "neither `build_id` nor `analysis_plan_id` (`science_assist`)" condition and also asserts the paragraph omits plan parameters (strengthened, not removed); `git diff` shows the first-task and code_change sections of `coordinator.md` byte-unchanged; `pnpm run build && pnpm run profile:smoke` PASS with no assertion change; one `pnpm run shud:first-task <scratch>` PASS (ORDER flake per #712 may be rerun; both runs recorded) |
| coder.md governance roots (declared deviation) | Selected: `coder.md` governance-directory sentence lists ten roots including `analyses/`; the coder test asserts all ten |
| Auth / tools / profile / schema | Not selected: unchanged |

Commands: tests first (RED on prompt assertions), `pnpm run check`, `pnpm run build && pnpm run profile:smoke`, `pnpm run shud:first-task <scratch>`, strict OpenSpec validation, compact review (correctness + test-evidence seats), exact-head CI. Closes task 6.1; ticks 5.4 (merged #667).

## Issue #669 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Prerequisites (CLI, spawn) | Selected: spawn the CLI with missing workspace arg, missing record arg, unset `SHUD_BIN`, relative `SHUD_BIN`, non-executable and non-regular `SHUD_BIN`, empty/unset `DMXAPI_KEY`, missing `SHUD/input/ccw` (constructed harness root) → each `status === 1`, stderr names the item; a previously absent workspace still does not exist, an existing workspace's listing is unchanged, no record file; a `DSH_HOME` directory in env has an unchanged listing |
| Paths | Selected: workspace final component a symlink; workspace an existing regular file; `<ws>/input` a symlink to an outside dir; `<ws>/input` a regular file (ENOTDIR) → failure naming the path, nothing written (outside target dir unchanged); workspace under `os.tmpdir()` (macOS alias path) accepted; record path already existing, under `<ws>/input/`, under `<ws>/analyses` (or another managed root), or with a missing parent → failure naming it, workspace has no `input/ccw` |
| Occupancy | Selected: each of the seven paths (`tasks`, `runs`, `reports`, `stacks`, `provenance`, `analyses`, `input/ccw`) pre-existing (directory; one as a symlink) → nonzero failure naming that path; workspace tree snapshot (names, bytes, mtimes) unchanged; no record |
| Successful preparation | Selected: empty workspace and absent workspace path, constructed source with nested files → copy per-file sha256 equals source; record maps keyed by POSIX relative path and sorted; md5/sha256 equal values computed independently in the test with `node:crypto`; submodule revisions from constructed git repos equal HEAD before = after = record (git/PATH/HOME required, failing rather than skipping when absent); `raw` shape with `exists: true` and md5 when `data/raw` exists, `exists: false` when absent; record outside `input/ccw`; source tree bytes/mtimes unchanged; CLI success `status === 0` |
| Safety / partial copy | Selected: symlink and FIFO in the source tree → failure naming the entry with no `<ws>/input/ccw` created (inventory precedes writes); injected write hook corrupting one copy file → failure naming that file, no record written, already-written copies left in place; byte budget exceeded (test-injected small budget) → failure naming the file before any write |
| Reuse | Selected: source and copy hashing go through records `readShudInputFile` (spy count: one call per source file, one per copy file); replay tree helpers extracted to a shared module, all existing replay tests pass unchanged; jscpd ≤3% |
| Sessions / evaluator / registration | Not selected: #670/#671/#673 |

Commands: tests first (RED), `pnpm run check`, strict OpenSpec validation, compact review (correctness + test-evidence), exact-head CI. Closes task 7.1a; ticks 6.1 (merged #668).

## Issue #712 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Model-visible contract | Selected: within the first-task section, step 3 paragraph matches `started subagent`, "not the worker's return" (or equivalent), "subagent-settled", and "do not call `report_generate` before"; the fallback paragraph matches a precondition on the settled message arriving without collected terminal evidence (negative: the old unconditioned "If the worker returns without collected terminal evidence" form no longer matches); the code_change section states every delegation (`subagent_coder`, `subagent`, `subagent_reviewer`) returns via its settled message and step 8's `report_generate` requires the reviewer's settled message; assertions scoped by section/paragraph (the sensitivity section already contains a settled sentence, so whole-file matches would be vacuous), cursor-ordered as in the existing tests |
| Legacy compatibility | Selected: all existing `prompts.test.ts` cases pass, including `:337` (`/(?:not|without|missing|未).*(?:collected|已收集)/i` on the first `shud_collect` paragraph), except where the old fallback wording is intentionally replaced (strengthened, not removed); first-task step order assertions still pass; sensitivity section untouched (`git diff` shows no hunk after `## sensitivity workflow`); `pnpm run build && pnpm run profile:smoke` PASS with no assertion change |
| Live evidence | Selected: 5 consecutive local `pnpm run shud:first-task <scratch>` runs on the PR head, all counted; record exit status and, from each retained root session log, the seqs of the `subagent` delegated result, every `report_generate` call, the worker `subagent-settled` user/message, and every root `job_list`/`job_output`/`shud_collect` call with its position relative to settled (diagnostic only; the oracle is unchanged and is the pass criterion). Any non-PASS run (ORDER or otherwise) means the live criterion is not met: reported verbatim, no rerun-to-green, escalated. `shud:replay` is not rerun (needs keliya toolchain); its code_change ordering is covered by the prompt assertions only — recorded as a gap |
| Oracle / tools / profile | Not selected: unchanged by design |

Commands: tests first (RED), `pnpm run check`, `pnpm run build && pnpm run profile:smoke`, 5× `pnpm run shud:first-task`, strict OpenSpec validation, compact review, exact-head CI.

## Issue #662 risk packs and executable evidence

| Pack | Selection and required evidence |
|---|---|
| Ordering / persisted state | Selected: genuine ok fixture → `metrics.json` exists with `serializeRunMetrics` bytes, RunRecord `succeeded`, `metrics_summary.sha256` == file sha, `numerical_health` == file values, `artifacts.files` excludes `metrics.json`, no `collect-error.json`, wake has no `metrics=` token; existing exit-0 tests tightened to assert summary and reason |
| Error isolation (a) | Selected: truncated existing `.dat` or missing `<project>.rivqdown.dat` → `metrics.json` `unavailable` with reason naming the file (`missing_variable:rivqdown`), RunRecord `succeeded`/`ok`, summary → file, health null, no ledger, job `collected`, wake delivered |
| Partial residual | Selected: missing `<project>.eleyic.dat` or unreadable copy `.cfg.calib` → `metrics.json` `ok`, residual null with `missing_variable:eleyic` / `unreadable_input:input/<project>/<project>.cfg.calib`, other three equal file |
| Error isolation (b) | Selected: `metrics.json` path occupied by a directory → RunRecord published `succeeded`, summary/health null, no ledger, attempts unchanged, wake text contains `metrics=write_failed`, no leftover temp file; a serializer/compute throw is also (b) |
| Error isolation (c) | Selected: exit 19 and cancelled → no `metrics.json`, both null, `status: failed` |
| Idempotence | Selected: committed run-record + metrics, `.dat` rewritten, recollect (automatic and `collectShud`) → both files byte+mtime unchanged; first attempt writes metrics then run-record write fails, retry succeeds → attempts 1 in ledger before retry, ledger bytes unchanged by the successful retry, metrics bytes identical to first |
| Readonly / legacy | Selected: `collectShud(id, {readonly: true})` computes nothing, writes nothing; pre-M5 committed RunRecord not backfilled |
| Read-only metrics | Selected: `.dat`, `stdout.log`, `stderr.log`, input copy byte+mtime unchanged across a metrics computation |
| Runtime oracles | Selected: first-task oracle positive + negative (residual null fixture → non-zero naming criterion); replay oracle positive + negatives (summary null, digest mismatch, reason not `missing_variable:`); rivqdown unchanged |
| Hydrology runtime / resource | Selected: real `shud:first-task`, `shud:replay` exit 0; `shud:restart` SIGTERM/SIGKILL PASS with `delivered`, retained RunRecords have non-null `metrics_summary`; full-length ccw collect duration (incl. metrics) measured and reported |
| Scientific governance / lineage | Selected: no invented values; nulls carry reasons; metrics producer for #422 |
| Documentation | Selected: `Runtime_Lifecycle.md:57` (metrics exemption from collect-error and write position), `:61` (wake token), `Testing_Strategy.md:114`, `Test_Fixtures_And_Command_Matrix.md:163` (producer now known); `Migration_Plan_dsh.md` untouched; `pnpm run docs:check` green |
| Resource / event loop | Selected: PR reports measured full-length collect duration and the synchronous-stall risk (design Risk) |
| Auth / dependency / profile | Not selected |

Commands: RED before implementation; focused jobs + runtime suites; `pnpm run build`; `pnpm run check`; `pnpm run shud:first-task <scratch>`; `pnpm run shud:replay <scratch>`; `pnpm run shud:restart`; strict OpenSpec validation; expanded three-seat review; exact-head CI. Only task4.2 closes.
