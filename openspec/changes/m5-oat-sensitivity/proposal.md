# Proposal

## Why

M5 的用户可见步骤是"一次批量运行与汇总表"（`docs/04_IMPLEMENTATION/Phased_Plan.md` §0 M5 行），验收门为"批次内 StackLock 一致；汇总表可复算"。ADR-0002 D5 把敏感性压缩为最小 OAT（3–5 run，保留 AnalysisPlan 对象与 batch 汇总）。M4 已于 2026-11-05 通过 PI 阶段验收（ADR-0014），但 M5 依赖的能力在代码里一个都不存在：没有 AnalysisPlan schema 与 `PLAN-` 品牌 id；`shud_run` 不能覆盖任何参数；TaskType 没有 `sensitivity`；TS 中没有 `.dat` 解析器，也没有指标代码；`RunRecord.numerical_health` 四项在采集时硬编码为 null（`packages/dsh-shud-jobs/src/shud-collect.ts:351-356`）；`artifacts.metrics_summary` 被 strictObject 拒绝。#422（水量平衡 / 指标生产者，M3 grill 归 M5）一直挂着。M4→M5 边界的 dsh 升级评估已完成（#631），PI 选择继续钉 `0.2.1-rc.2`。

Stage 1 压测结论（`.workplans/m5-oat-sensitivity/grill-gate.json`：30 个用户拍板分支、4 条事实核查、4 个开放项，用户已确认）是本 change 的输入。两条事实约束了方案：钉版 SHUD 的 `checkRange` 只告警、不退出（`SHUD/src/Equations/functions.cpp:53-60`），越界参数会静默照跑，所以范围校验必须由 harness 做；`PrintFinalStats` 定义了却从未被调用，CVODE 步数与步长无法观测，所以 `max_solver_dt` 保持 null，M4 遗留的 O2 自然不再成立。

## What Changes

- `@shud-harness/dsh-shud-core`：
  - 新增 AnalysisPlan Zod schema（第 10 个导出的核心记录 schema），品牌 id 为 `PLAN-<UTC>-xxxx`。plan 创建后不可变，字段有 `task_id`、`mode: sensitivity`、`strategy: one_at_a_time`、`input_dir`、`project`、`end_days`、`threads`（缺省 1）、`parameter_sets`（3–5 个，恰好一个 baseline，每个扰动 pset 只改一个键）和 `parameter_space_rationale`（`proposed_by: agent`，`confirmed_by: null`）。
  - 新增 calib 白名单常量：`GEOL_KSATH`、`GEOL_KSATV`、`LC_ROUGH`、`RIV_ROUGH`，倍率区间 [0.5, 2.0]；同时登记各键对应类别表列在 SHUD `checkRange` 中的区间。
  - 新增 numerical_health / 水量平衡的阈值常量（`SHUD_Output_Variables.md` §13）和 metrics 方法版本常量。
  - TaskType 增加 `sensitivity`；TaskCard 增加 `linked_analyses`。
  - RunJob/RunRecord 增加 nullable 的 `analysis_plan_id`、`parameter_set_id`；RunRecord 启用 `artifacts.metrics_summary`（`{path, sha256}`，指向 `metrics.json`）。
  - EvidenceReport 增加 `analysis_ids` 与 `sensitivity_summary`（`{path, sha256}` 或 null）；`CODE_CHANGE_SECTION5_WORDING` 删去"本里程碑无指标 artifact"分句。
  - `role-tool-map` 中 coordinator 增加 `analysis_create`。
  - 执行 `pnpm run schema:generate`。
- `@shud-harness/dsh-shud-records`：
  - SHUD 二进制 `.dat` 读取器（TS 原生）。
  - 逐 run 指标：出口 rivqdown 峰值、峰现日、窗口总径流量。
  - 水量平衡残差：rSHUD `wb.all`/`wb.DS` 公式，另计积雪与冠层截留储量，用窗口累计 P 归一化。
  - numerical_health 四项生产者：`cvode_failures` 数 stderr 里的 `SUNDIALS_ERROR`；`negative_state_count` 数严格负值；`max_solver_dt` 恒为 null 并注明原因。
  - 阈值判定。
  - `metrics.json` 的确定性序列化。
  - 用本机 rSHUD 生成的对照夹具。
  - sensitivity closure 谓词。
  - 从 plan 和各 run 的 metrics 派生汇总表，写入 `reports/<report_id>.sensitivity.json`。
  - §5 对所有任务类型渲染逐 run 指标；sensitivity 另渲染相对 baseline 的 Δ% 表。
  - 确定性生成覆盖范围 limitation 与"agent 建议值"标注，并以阈值派生的 limitation 取代原来的"无指标 artifact"自动说明。
- `@shud-harness/dsh-shud-jobs`：
  - 提交时总在运行副本的 `<project>.cfg.para` 中确保 `DT_YE_IC 1440`（字节保真）。
  - 绑定 plan 时，按 plan 以字节保真的方式重写副本 `<project>.cfg.calib` 中的单个键；两种重写都发生在 DataProvenance 生成之前。
  - 同一 parameter_set 已有非失败 run 时拒绝提交。
  - 自动 collect 内为每个成功 run 计算 metrics，写 `runs/<run_id>/metrics.json` 并填入 RunRecord。指标计算失败只记 null 和原因，不改变运行状态，也不消耗 collect 重试预算。
- `@shud-harness/dsh-shud-tools`：
  - 新增 `analysis_create`（coordinator 专用）：确定性校验后写 `analyses/<plan_id>.json`，并回写 TaskCard `linked_analyses`。
  - `shud_run` 增加成对可选参数 `analysis_plan_id` + `parameter_set_id`；覆盖值只从 plan 解析，模型不能自由传入 calib 值。
  - `task_create` 接受 `sensitivity`；`report_generate` 接受 sensitivity 卡。
- `@shud-harness/dsh-shud-raw-guard`：固定输出根保护增加 `analyses/`；治理根写保护集增加 `analyses`。
- `@shud-harness/dsh-shud-policy-gate`：不新增 ask。`analysis_create` 与绑定 plan 的 `shud_run` 均不发起审批（Gating §1.2：已登记 calib 键的 floor 为 none）；角色面 deny 沿用 role-tool-map。
- `@shud-harness/dsh-shud-presets`：更新 coordinator/worker prompt（sensitivity 编排：建 plan → worker 逐个提交 → 显式 wait/collect → 报告）和精确工具面测试夹具。不新增 preset，也不新增委派工具。
- 本机阻断闸 `pnpm run shud:sensitivity <scratch-workspace>`：走真实 Web/LLM 单提示主链。固定验收 plan 为 4 个 pset：baseline、`GEOL_KSATH`×0.5、`GEOL_KSATH`×2、`LC_ROUGH`×2，窗口 90 天，`threads: 1`。判据包括：批次全部 `stack_id` 相同；从保留的 `.dat` 独立重算汇总表，结果逐字节相同；批外重跑一次 baseline，rivqdown sha256 必须相等，否则 FAIL；报告 accepted；恰好一次自动 Allow once。CI 不运行，也不代替 PI 验收。`shud:first-task` 与 `shud:replay` 的 oracle 在改变行为的同一切片中更新为新行为，并附本机重跑证据。
- 规范对齐（实现组之前）：
  - `Minimal_Schemas.md` §6 AnalysisPlan（品牌 id、最小字段）与 §5 RunRecord `metrics_summary`。
  - `SHUD_Output_Variables.md` 写入水量平衡公式与 numerical_health 来源。
  - `Sensitivity_Calibration_Benchmark(_Addendum).md`、`Parameter_Set_And_Analysis_Run_Mapping.md` 登记 M5 落地与偏离。
  - `Scientific_Change_Gating_Spec.md` §1.2 以白名单常量落地，不建 yaml。
  - `Agent_Architecture.md` §7 sensitivity 谓词。
  - `Report_Generation_Spec.md`。
  - `Phased_Plan.md` 新增 M5 节。
  - `CONTEXT.md` 与 `project-profile.md` 的核心对象计数。
  - glossary。
  - #422 范围改写。

## Capabilities

### New Capabilities

- `analysis-plans`: AnalysisPlan 的品牌 id、字段与不可变性；calib 白名单与类别表乘积校验；`analysis_create` 工具契约、`analyses/` 持久化与 TaskCard `linked_analyses` 回写；生成投影。
- `run-metrics`: `.dat` 读取契约；逐 run 指标与水量平衡公式；numerical_health 四项的来源与诚实声明；阈值判定；`metrics.json` 的形状、确定性与 sha256；collect 内计算与失败隔离；rSHUD 对照夹具。
- `oat-sensitivity`: 本机阻断闸 `shud:sensitivity` 的工作区准备、驱动与判据（固定 plan、StackLock 一致、独立重算、批外 baseline 重复）；控制面登记；Epic 收口 PI 验收。

### Modified Capabilities

- `run-records`: RunJob/RunRecord 增加 `analysis_plan_id`、`parameter_set_id`（缺键按 null 解析）；RunRecord 启用 `artifacts.metrics_summary`；`numerical_health` 由 run-metrics 填写。
- `shud-run-tools`: `shud_run` 增加 plan 绑定参数及其校验顺序；"无 `end_days` 时副本 cfg 字节不变"的场景改为"仅 `DT_YE_IC` 行不同"；由 `dsh-shud-tools` 挂载 `analysis_create`。
- `shud-run-jobs`: 提交时的 `DT_YE_IC` 与 calib 重写及其在 provenance 之前的顺序；pset 重复提交拒绝；自动 collect 计算 metrics 且失败隔离。
- `task-cards`: `type` 增加 `sensitivity`；`linked_analyses`；`task_create` 接受 `sensitivity`；sensitivity closure 谓词；science_assist 谓词去掉"无指标 artifact"自动说明，改为阈值派生的 limitation。
- `evidence-reports`: `analysis_ids`；sensitivity 汇总表派生与 `.sensitivity.json`；§5 对所有类型渲染指标；覆盖范围 limitation 与"agent 建议值"标注的生成和校验；失败 cell 可见。
- `raw-data-guard`: `analysis_create` 固定输出根保护；治理根增加 `analyses`。
- `policy-gate`: `analysis_create` 与绑定 plan 的 `shud_run` 不发起审批；角色面规则覆盖新工具。
- `agent-presets`: role-tool-map 中 coordinator 增加 `analysis_create`；sensitivity 编排 prompt；首任务脚本 oracle 随 #422 行为更新。
- `known-answer-replay`: 回放脚本 oracle 随 `DT_YE_IC` 写入与 metrics 行为更新（判据本身不放宽）。
- `engineering-gates`: `shud:sensitivity` 登记为本机阻断闸；AnalysisPlan 纳入 schema drift 闸。

## Impact

- 代码：
  - `packages/dsh-shud-core/src/schemas/`、`src/governance/`（Critical Path #1/#7）。
  - `packages/dsh-shud-records`（新增 metrics 与 dat 模块；closure、报告与语言护栏属 Critical Path #6）。
  - `packages/dsh-shud-jobs`：提交重写与 collect 内 metrics，属 Critical Path #4。
  - `packages/dsh-shud-tools`。
  - `packages/dsh-shud-raw-guard`（Critical Path #2）。
  - `packages/dsh-shud-policy-gate`（Critical Path #3，仅回归）。
  - `packages/dsh-shud-presets`。
  - `scripts/runtime/`：新增 sensitivity 脚本，更新 first-task/replay oracle。
  - `constraints.yaml`、`knip.json`。
- 文档：见 What Changes 的规范对齐列表；`docs/generated/`；`instructions/agents/*`（经 `instructions:render`）；一份 M5 Epic 验收决策记录（`docs/adr/proposed/`）。
- 依赖：不引入第三方新依赖，不引入 R 运行时依赖（rSHUD 只在本机生成一次对照夹具，夹具入库后 CI 不需要 R）；dsh 保持钉 `0.2.1-rc.2`。
- 运行时：
  - 所有 run 的副本 `.cfg.para` 多一行或改写一行 `DT_YE_IC`（只是输出开关），每个 run 多一个 `.eleyic.dat` 输出。
  - 每次成功 collect 多一次 `.dat` 读取与 `metrics.json` 写入；ccw 全长运行约 268MB 输出，读取成本见 design 风险。
  - M3/M4 报告的 §5 与 limitations 文本改变，黄金文件随之更新。
  - 新增模型工具 1 个（`analysis_create`）；`data/raw` 不变；根 submodule 不变。
- 科学边界不变：OAT 汇总只陈述单流域、单窗口、相对 baseline 的变化，不做敏感性指数或排名，不写机制解释；参数范围始终标注为 agent 建议值；`water_balance_residual` 是数值守恒诊断，不代表水文真实性；单流域结果不构成模型改进，也不是校准结论。

## Issue #646 execution fixture

- Issue type: feature; fixture level: expanded; upstream expanded agreed (shared governance API, wording and generated projection).
- Blast radius: all later plan, metrics and report consumers share these constants; incorrect units, boundary judgments or mutable registration corrupt downstream evidence.
- Selected risk packs: Public API; Schema/units; Auth/governance; Compatibility; Error handling; Release/exports; Documentation/generated projection.
- Evidence floor: issue #646 boundary cases, frozen nested registration, literal wording/scan checks, generator drift negative control, built-core smoke, full `pnpm run check`, Critical Path #1/#6/#7 white-box review.
- Must preserve: existing wording and phrase-scan bytes/behavior, semantic-level floors and projection, nine current core record schemas; no profile overrides, solver/input writes or downstream consumers.
- Source authority: requirements unchanged; pinned SHUD read semantics prevail over derived prose. `RIV_ROUGH` reads `x / 60` (`River.cpp:29`) before calib (`:40`), documented by #680 / PR #681.
- Workflow-only scope: this fixture metadata and task completion accompany #646; product changes remain core governance, minimal core root exports, schema generator/self-test and generated whitelist documentation.

## Issue #642 execution fixture

- Feature; expanded fixture, matching upstream classification: new authoritative core record, branded identifier and generated projections (Critical Path #7).
- Scope: AnalysisPlan's thirteen fields, nested strict objects and seven refinements; PLAN branding through the existing identifier module; shared ParameterSet id schema; generator registration; current-core-count statements in exactly five source files and rendered instructions. Both project-profile entry and Contracts counts must become 10; its negative AnalysisPlan export-status assertion must be updated.
- Selected packs: Public API, Schema/units/field names, Auth/governance, Compatibility, Error handling, Release/exports, Documentation/generated projection. Pure schema parsing introduces no runtime IO, concurrency, process or credential surface.
- Must preserve: existing identifier formats and brands, nine existing record schemas/projections, calib constants and mapping as the sole source, existing project-component acceptance domain, historical/v0.8 eight-object terminology, runtime consumers and PI gates.
- Required evidence: every issue acceptance rejection with the named issue path/key; valid ccw plan and PLAN UTC generation; built-core parsing smoke; generated CHG/VC/BUILD/PLAN patterns and field constraints; actual isolated stale-schema drift rejection; complete count-search output with per-hit classification; instructions budget and full default gate.
- Workflow-only scope: issue-specific fixture metadata accompanies the bounded implementation. Shared M5 change remains unarchived; no filesystem plan writer, tool, job/report fields, or consumer integration is claimed.

## Issue #643 execution fixture

- Expanded schema-compatibility slice (Critical Path #7): nullable/default-null AnalysisPlanId and ParameterSetId on RunJob/RunRecord, paired after-default validation, strict nullable metrics_summary on RunRecord, generated projections. Reuse #642 brands/patterns.
- Selected packs: Public API, Schema/field names, Compatibility, Error handling, Release/types, Documentation/projection. No new runtime IO, state machine, concurrency, config or credential behavior.
- Must preserve existing build/digest pairing, running pid checks, exit-code/status rules, nullable legacy references, all old fixture input bytes, closed artifacts and absence of plots. Do not add failed-status metrics-null schema policy; collection owns that later.
- PI clarification: https://github.com/DankerMu/SHUD-Harness/issues/643#issuecomment-6715096049 explicitly permits migrating conflicting legacy whole-object assertions while preserving original fixture inputs, all original-field/state checks and separate assertions of new null defaults. The former literal “do not change expectations” contradicted additive defaulted output; no production acceptance was weakened.
- Product scope: core run schemas/tests and generator projections; jobs only null literals if typechecking requires them. No submission/collection behavior, tools or production records changes. PI-authorized test-only exception (https://github.com/DankerMu/SHUD-Harness/issues/643#issuecomment-6715523002): makeRunRecord override parameter in records task-lifecycle-test-harness.ts may use the schema input type with necessary type-only import, preserving fixture values and runtime behavior. Shared change metadata and completion are workflow-only; change remains unarchived.

## Issue #644 execution fixture

- Expanded, Critical Path #7: add sensitivity to TaskType and default-empty branded linked_analyses to TaskCard; non-sensitivity links must be empty. Existing source_base_commit iff continues to require null for sensitivity.
- Selected packs: Public API/tool boundary, Schema/fields, Auth/fail-closed, Compatibility, Error handling, Release/types, Documentation/projection. No new filesystem workflow, configuration, concurrency, resource acquisition or metrics behavior.
- Must preserve unknown-key stripping and optional fields of the existing TaskCard schema, all old status/reference/base-commit rules, old fixture inputs, and task_create/closure rejection of sensitivity until later slices. Do not add sorting, uniqueness or one-plan cardinality to the schema; writers/closure own those policies.
- PI-authorized type-only exception: https://github.com/DankerMu/SHUD-Harness/issues/644#issuecomment-6716087784 permits TaskCardInput and createTaskCard's input parameter correction, not a parser/writer body change or tool enum expansion. Existing consumer regression tests are explicitly required acceptance.
- Scope: TaskCard schema/tests, generated projections/registration, specified fail-closed regressions, PI-authorized legacy default-output test migrations, and the precise type-only exception. Batch test authorization: https://github.com/DankerMu/SHUD-Harness/issues/644#issuecomment-6716702659 preserves raw inputs and all old behavior checks while adding explicit new-default expectations; it authorizes no production or tool-entry changes. No sensitivity creation, linking or closure implementation; shared fixture metadata remains workflow-only.

## Issue #645 execution fixture

- Expanded, Critical Path #7: default-empty unique branded analysis_ids and default-null strict sensitivity_summary on EvidenceReport, with after-default iff and report-id path binding.
- Selected packs: Public API, Schema/fields, Compatibility, Error handling, Release/types, Documentation/projection. No new runtime IO, authority, concurrency, configuration or metrics computation.
- Preserve all existing report fields, status/decision rules, strictness, reference order and golden report bytes/semantics. Parsing old M3/M4 files adds defaults only in memory.
- PI batch authorization (issue #644 comment6716702659) permits additive-default test expectation migrations only: unchanged raw inputs and exact prior-field/behavior checks, explicit new defaults. It does not authorize report rendering, validation, closure, or tool admission changes.
- Product scope: EvidenceReport schema/tests, generator registration and its two projections; existing tools/records writers may receive only []/null literals if typechecking requires them. No broader input-type refactor is authorized. Shared fixture metadata is workflow-only and remains unarchived.

## Issue #647 execution fixture

- Expanded, Critical Path #2: one records-owned safe SHUD text-input reader and pure parsers for eight file kinds. Upstream expanded level retained; no scientific formula or new core schema.
- Selected packs: Public API, File IO/path safety, Schema/columns, Auth/read-only diagnostics, Resource/descriptor ownership, Compatibility, Error handling, Release/exports, Documentation. Parent-directory and final-file replacement are observable safety risks; no concurrent atomic snapshot is claimed.
- Product scope: records modules, exports and tests, including the minimum extraction from compareRivqdown/hashDescriptor needed to reuse the existing descriptor discipline. Preserve comparator semantics and every existing consumer; no consolidation of unrelated readers in jobs/tools or report validation.
- Must preserve raw input bytes, existing physical-root routing, single-close error handling and bounded comparator hashing. Parse/hash/size share one byte read; missing is distinguishable from unsafe/read failure. No metrics, products, units conversion, file writing, configuration or dependency additions.
- Primary-source compatibility: real ccw river input includes an optional third geometry table; IC accepts an optional time header and optional lake table. Parse present tables explicitly rather than rejecting legitimate writer output or silently truncating. Names required by the issue are checked against actual registered headers, including ThetaS(m3_m3); do not invent aliases for other watersheds.

## Issue #648 execution fixture

- Expanded, Critical Path #2: records-native little-endian SHUD .dat reader, same-read byte identity and controlled layout/safety failures. No new core schema, metrics computation or scientific interpretation.
- Selected packs: Public API/release, File IO/path safety, Binary layout/units, Resource/descriptor ownership, Compatibility, Error handling, Platform configuration, Documentation. Reuse #647's descriptor lifecycle and path/ancestor checks; do not introduce a second safe-file implementation.
- Scope: records .dat reader, one canonical synthetic test-byte builder, tests/exports, and minimum internal extraction of #647's generic safe byte-read/error/path logic. All old text parser APIs/errors/results and comparator behavior remain unchanged; no jobs/tools/core or SHUD/output access.
- Must preserve opaque 1024-byte header, row/column order and original numeric values; nonfinite data remains located in returned fields rather than being discarded or classified scientifically. Shared M5 fixture remains unarchived.

## Issue #649 execution fixture

- Expanded, Critical Path #2: deterministic records-internal flow/health calculation, canonical metrics bytes and digest-bound safe metrics reading. Dependencies #646/#647/#648 are merged. Selected packs: numeric correctness/units, file IO/path safety, evidence identity, error isolation/status, deterministic serialization, API ownership/compatibility, resource use, documentation/scientific boundaries.
- Scope is task3.2a only. computeRunMetrics remains internal (not records index, no production caller). The explicitly planned water-balance intermediate has null values and cannot be published by a tool; #651/#652 supply its producers before #662 integrates collection. Serializer and safe reader are complete reusable boundaries now, not fake producers.
- Reuse existing shared file/descriptor readers, .dat builder, project-component predicate, core method version and classifier. No filesystem discovery, duplicate safe reader, new dependency/core schema, jobs/tools integration, thresholds, default parameters, scientific formula or baseline change.
- Preserve every existing text/binary/comparator consumer and all source bytes. Only successfully observed file bytes contribute digest/size evidence; missing files never receive fabricated inputs entries. Invalid present data fails closed without claiming a partial metric.

## Issue #650 execution fixture

- Expanded, Critical Path #7 and scientific provenance: four immutable storage-conversion registrations plus their supporting validator and O1 source-fact documentation. Upstream classification retained; no new core record or metric producer.
- Selected packs: units/source evidence, schema/conditional fields, public exports, immutable governance/config boundary, compatibility/generated projection, documentation/scientific wording. No new IO, processes, concurrency, credentials or profile configuration.
- Source pin is SHUD 3aec65755926c478e13ca7d4fea80715e4e90345. Register scale1 and no additional vegetation weighting for snow.output, snow.ic, ic.output and ic.ic; omit veg_frac_source. This describes stored units, not validation or repair of SHUD's physical equations.
- Scope is task3.2b only: governance registration/schema/tests, core root exports, SHUD_Output_Variables O1 facts and this workflow fixture. Preserve all existing constants, core-record count10, schemas/projections, run-metrics spec wording and water-balance formula. No records/jobs/tools/submodule edit or runtime consumption.

## Issue #651 execution fixture

- Expanded, Critical Paths #2/#6/#7 and scientific provenance: populate the seven rSHUD-shared water-balance terms through the existing records-internal producer. Preserve the upstream classification and PI-defined D7 formulas.
- Selected packs: numeric units/joins, safe single-read file evidence, deterministic serialization/compatibility, independent oracle integrity, local-only R tooling, documentation/scientific boundaries. No auth, concurrency, release configuration or new runtime dependency.
- Scope is task3.2c: records calculation/tests/wb-mini fixture and the local R cross-check script, plus minimum behavior documentation. No core/jobs/tools/CI/root-script/submodule changes. Snow/interception, aggregate/residual and final null reasons remain #652; collect remains #662.
- Verification includes a semantic RED against the current null-valued producer, committed R-generated expectations, a rejected missing-GEOL_THETAS mutant, unchanged-reader regressions, built-module and real ccw comparison, no-R test execution, and unchanged citation-checker rejection. Only task3.2c may close; no shared-change archive or scientific/PI acceptance.

## Issue #652 execution fixture

- Expanded, Critical Paths #2/#6/#7: complete the single metrics producer with registered snow/interception conversions, total storage, residual, causal null reasons and the records public export. Preserve the PI D7 formula and #650 coefficient values.
- Selected packs: public API/cutover (including Release/exports), numeric units/dependency errors, file IO/path safety/single-read resource ownership, deterministic evidence/compatibility, scientific wording and immutable oracle. No new auth/concurrency/configuration/packaging/dependency surface.
- Scope is task3.2d, records source/tests plus existing behavior documentation. No core/jobs/tools/collect/persistence, R-generator/corpus changes, threshold changes, profile overrides or new scientific VegFrac recipe. Actual O1 registrations have no veg_frac_source, so the issue's explicit no-extra-read acceptance alternative applies.
- Required evidence: semantic closed-budget RED/GREEN, positive/zero snow/interception contrast, all specified null reasons and unavailable boundaries, code-point missing-variable precedence, unchanged seven-term rSHUD oracle, public built API/digest round-trip/read-only relocation and three-seat source review. No shared-change archive or PI acceptance.

## Issue #653 execution fixture

- Issue type: feature. Fixture level: expanded; agree with upstream. Critical Paths #1/#2 apply to fail-closed product governance and read-only/path-safe persistence; schema consumption does not modify core.
- Blast radius: unsafe plan publication could overwrite evidence; wrong transforms or byte digests could authorize invalid or different run inputs.
- Selected packs: Public API, File IO/path safety/overwrite, Schema/columns/units, Concurrency/publication ownership, Resource/single-read limits, Legacy compatibility, Error/rollback, Release/exports, Documentation.
- Scope: task3.3, records source/tests only plus this execution fixture. Extend canonical workspace publication and shared SHUD readers; no tools/jobs/core/policy/raw-guard changes, scan/repair, input rewrite, or scientific baseline change.
- Evidence floor: semantic workspace RED/GREEN, ccw-copy and discriminating product boundaries, exact same-read digest set, exclusive collision/unsafe-path/read-only proofs, existing sibling publication regressions, built root-API smoke, full check and exact-head CI. Shared change stays open for #675 PI acceptance.

## Issue #654 execution fixture

- Issue type: feature. Fixture level: expanded; agree with upstream for public closure dispatch, injected readers, evidence identity and deterministic selection.
- Blast radius: selecting the wrong effective run or accepting mismatched plan/metrics evidence could permit an invalid sensitivity report.
- Selected packs: Public API, File IO/path safety, Schema/identity/status, shared-state ordering, Resource/discovery, Legacy compatibility, Error handling, Release/exports, Documentation. No new auth/config/dependency surface.
- Scope is task3.4 in records source/tests plus this fixture. Add the sensitivity predicate and readonly adapters, not report/tool wiring, summary derivation, core schema changes or job collection.
- Evidence floor: semantic unsupported-to-success RED/GREEN at the existing facade, all clauses0–5, failed/retried/two-successful cells, deterministic selection, real safe plan/metrics files and digest failures, unchanged legacy closure behavior, built public smoke, full check and exact-head CI. Shared change remains open.

## Issue #655 execution fixture

- Issue type: feature. Fixture level: expanded; agree with upstream for deterministic numeric evidence, companion publication and rendering input integrity. Critical Paths #2/#6/#7 apply, including records-owned JSON format/provenance; core schemas/projections remain unchanged.
- Blast radius: wrong relative deltas, lost failed/superseded evidence, orphan overwrite, or rendering from altered summary bytes.
- Selected packs: Public API, File IO/overwrite, Schema/units/identity, Concurrency/publication ordering, Resource/discovery, Legacy compatibility, Error/partial output, Release/exports, Documentation. No auth/config/dependency changes.
- Scope is task3.5: records summary derivation/serialization/reading, report allocation and rendering input checks, plus this fixture. No #657 per-run rendering, #658 delta Markdown/validator16–17, or #667 tool creation wiring.
- Evidence floor: semantic report-render/allocation RED, independent arithmetic oracle, byte determinism, exclusive summary-before-JSON and orphan faults, every-render digest checks including repair(b), state-transition summary immutability, unchanged legacy report tests/goldens, built smoke, full check and exact-head CI.

## Issue #656 execution fixture

- Feature, fixture expanded as upstream suggested: authenticated tool preflight observes immutable workspace evidence before any reconciliation/publication. The issue's final Critical Path classification is authoritative: no core schema, report wording or policy change; expanded review still covers identity and path boundaries.
- Scope: task3.6a, tools citation scanner and tests plus this fixture. Reuse core AnalysisPlanIdSchema and records readonly analysis parser; no records/core/jobs changes, sensitivity tool support, plan ownership requirement, rendering or analysis_ids population.
- Selected packs: tool entry, file IO, schema/identity, preflight ordering, resource/deduplication, legacy compatibility, controlled errors and documentation. No configuration, dependency, authorization or scientific behavior changes.
- Evidence: real ToolRuntime semantic missing-plan RED/GREEN; science/code-change valid and invalid plans; four authored fields, standalone boundaries, once-per-invocation reads; no-write/no-reconcile snapshots; unchanged nine-namespace tests; actual built scanner smoke, full check and exact-head CI.

## Issue #657 execution fixture

- Feature, expanded fixture, Critical Path #6. One atomic cross-package report cutover: records closure/render input/projection, core's one code-change wording constant, tools limitation append point, and first-task/replay text oracles. Splitting these commits across main would contradict the report or leave a mandatory runtime gate red.
- Invariant: displayed metric facts and derived limitations come from the same identity/digest-bound per-run evidence, never model prose or recomputation; unavailable metrics do not block otherwise-valid non-sensitivity closure.
- Selected packs: public/type contracts, file IO and digest identity, numerical display, ordering/partial publication, resource/read-set, legacy compatibility, runtime evidence/packaging, wording governance and documentation. No dependency/config/auth/scientific threshold change.
- Scope is task3.6b only. Do not implement collect-time metrics/#662, sensitivity generation/#667, delta/superseded rendering or validator16/17/#658. Existing records and consumed evidence are not migrated or rewritten.
- Required delivery includes full local check, actual built report smoke, immutable pre-cutover section5-excluded byte oracle, real shud:first-task and shud:replay exit0 with canonical logs/workspaces, three-seat review and exact-head CI. Automated script approvals remain engineering-only.

## Issue #658 execution fixture

- Issue type: feature. Fixture level: expanded; agree with upstream (persisted companion-file reader, report wording guardrail, validator contract; Critical Path #6, consumes #7 records without schema change).
- Blast radius: a sensitivity report that hides a failed cell or superseded run, rounds/reinterprets a delta, omits the coverage or agent-range statement, or passes validation after `.sensitivity.json` was altered; or a byte change in existing science_assist/code_change reports.
- Selected packs: Public API/type contracts, File IO/path safety, Schema/units/numeric display, Ordering, Legacy compatibility, Error handling/partial output, Documentation, Scientific governance/evidence lineage. Deviation from issue acceptance: the full 1→5 composition with tools-built kind 3/4 entries is tested at #667 (tools generation is outside this PR boundary); here the deriver's leading/trailing contract is composed in records. Not selected: config, auth/secrets beyond existing scan, concurrency (inherited single-process boundary), dependencies, resource limits (bounded by existing summary reader).
- Scope is task3.6c only: records §5 delta segment, §7 sensitivity entries, sensitivity limitation derivation (kinds 1/2/5), validator 17 checks, sensitivity golden, tools `report_validate` description + count assertions, `Report_Generation_Spec.md` count/16/17/(4)(10)(11) wording. No `report_generate` sensitivity wiring (#667), no scripts/runtime, core, jobs, schema or summary derivation changes.
- Evidence floor: semantic RED for delta segment/§7/16/17; exact-numeric and null-reason cases; tamper/delete/symlink negatives with byte preservation; unchanged science_assist/code_change goldens; built smoke; `pnpm run check`; `shud:first-task` and `shud:replay` live reruns with session-log evidence of 17 checks; three-seat review; exact-head CI.

## Issue #659 execution fixture

- Issue type: feature (+ in-place module rename). Fixture level: expanded; agree with upstream (submission transaction, rollback, persisted provenance; Critical Path #4).
- Blast radius: provenance hash not matching the actual run copy; a failed rewrite leaving a run directory/index entry/provenance file or a launched wrapper; corrupted cfg bytes (line endings, comments, key case); replay oracle red or loosened; dangling `shud-end` references breaking `shud:tiny`/knip.
- Selected packs: Public API/CLI entry (module rename + CLI), File IO/byte fidelity, Schema/field semantics (cfg key), Error handling/rollback, Concurrency/shared state (stateDir lock + id occupation retained on failure), Legacy compatibility (M2–M4 copy assertions, replay oracle), Documentation. Domain: Hydrology runtime selected (real tiny + replay). Not selected: auth/secrets, dependencies, profile/seam, scientific governance (output switch only, not a physics/default-parameter change).
- Recorded scope deviation: three further live docs (`Repository_Layout.md:84`, `Park_Resume_Design.md:342`, `Minimal_Schemas.md:197`) plus `Runtime_Lifecycle.md:26` and `SHUD_IO_Facts.md:148` become false with this change and are updated in the same PR; replay snapshot module joins the oracle surface.
- Scope is task4.1a only: `ensureOutputInterval`, registry call for all submissions, rename, reference surfaces, copy-assertion updates, replay copy-provenance oracle. No NUM_OPENMP/calib (#660), pset duplicate (#661), metrics (#662), tool params (#666).
- Evidence floor: unit RED→GREEN for the rewrite matrix; `submitShud` integration (append/in-place/CRLF/no-EOL/multiline/comment/build_id+threads; provenance sha256 = rewritten bytes; injected failure rollback); oracle negative fixture (one extra changed line → exit 1 naming file); `pnpm run check`; `pnpm run shud:tiny`; `pnpm run shud:replay <scratch>` (VC passed, rivqdown bitwise unchanged); `pnpm run shud:first-task <scratch>` and `pnpm run shud:restart` as submission-path regression evidence; three-seat review; exact-head CI.

## Issue #660 execution fixture

- Issue type: feature. Fixture level: expanded; agree with upstream (submission transaction, rollback, persisted run-job fields, Critical Path #4).
- Blast radius: a plan-bound run whose copy is not the digest-checked baseline input, a calib value that SHUD reads back differently, `NUM_OPENMP` not matching plan `threads` (silently breaking the threads:1 repeatability premise), a failure leaving partial run state, or unbound submissions changing behavior.
- Selected packs: Public API (internal request type exported from jobs), File IO/path safety (digest-check reads, relative path containment), Schema/numeric (calib shortest round-trip, branded ids), Error handling/rollback, Concurrency/shared state (shared stack_id/lock, run-job first write), Legacy compatibility (unbound submissions identical to post-#659), Documentation (four live docs). Domain: Hydrology runtime selected (calib/NUM_OPENMP semantics against pinned SHUD source); scientific governance selected only as "whitelist/range enforced at registry, no new keys" — no default-parameter change.
- Recorded boundary deviations: records `index.ts` exports `readShudInputFile` and `shudTextNumber` (reuse, no logic change); four live docs whose rewrite description becomes incomplete are updated; `shud-collect.ts` RunRecord construction copies the ids.
- Scope is task4.1b only. No duplicate pset check (#661), no `shud_run` plan parsing (#666), no metrics (#662), no schema/core changes; jobs never reads `analyses/`.
- Evidence floor: preflight rejection matrix with no FS access; digest mismatch/missing/directory rollback (symlink via reader tests); calib/NUM_OPENMP rewrite unit + integration; provenance = rewritten bytes; run-job `created` fields; collect inheritance; four-pset shared stack_id; `pnpm run check`; `pnpm run shud:tiny` and `shud:restart` as unbound-path regression; three-seat review; exact-head CI.

## Issue #661 execution fixture

- Issue type: feature. Fixture level: expanded; agree with upstream (id occupation, in-flight table, persisted-state reads, concurrency; Critical Path #4).
- Blast radius: two non-failed jobs for one `(plan, pset)` (closure's effective run becomes ambiguous); a legitimate resubmission after failure blocked forever; a corrupt `collect-error.json` silently treated as failure; side effects (run dir, index entry, provenance, input read) on a rejected submission; failed-job evidence mutated.
- Selected packs: Concurrency/shared state/ordering, Persisted state semantics, File IO (check before input walk; sync reads of registry-owned state files via factored validators), Error handling (corrupt ledger fail-loud), Legacy compatibility (unbound and different-pset submissions unchanged). Domain: Scientific governance/evidence lineage (single effective run, failed-job immutability) and Hydrology runtime (Park/Resume durability, `shud:restart`). Not selected: schema, auth, docs (no doc statement becomes false), dependencies.
- Decision recorded: collected `succeeded` + exhausted ledger counts as failed (literal spec AND, consistent with closure admissibility); consequence in design Risks.
- Scope is task4.1c only; no tool error mapping or card links (#666), no closure change (#654).
- Evidence floor: concurrent same-pset submissions (exactly one accepted, the other zero side effects); running / collected-succeeded rejection with byte-identical existing files; failed / cancelled / collect-exhausted / rolled-back in-flight resubmission accepted with failed-job files byte-identical; different pset / unbound unaffected; corrupt ledger explicit error; `pnpm run check`; `pnpm run shud:restart`; three-seat review; exact-head CI.

## Issue #663 execution fixture

- Issue type: feature. Fixture level: expanded; agree with upstream (raw data protection, model-visible governance denial, new tool's pre-execute admission; Critical Path #2/#3).
- Blast radius: a model file/shell write that silently rewrites an AnalysisPlan after creation (closure and run binding trust plan bytes); `analysis_create` creating `analyses/` or rewriting a TaskCard inside a configured raw root; a raw `input_dir` read without the provenance approval `shud_run` already requires; a write-protected target downgraded to an approval card when another rawDir covers `input_dir`; existing nine-root and `shud_run` decisions regressing.
- Selected packs: Raw data / path safety (realpath, nearest existing ancestor, symlink and case aliases, sibling prefixes), Approval seam (ask only for raw input, write denial never ask, decision precedence independent of rawDirs order), Model-visible contract (deny code/reason text naming `analysis_create`), Legacy compatibility (nine roots and every existing tool decision unchanged), Docs (five statements of "nine governance roots" become false). Domain: Scientific governance (plan immutability after creation). Not selected: schema, jobs/persistence, dependencies, tools/core/policy-gate/presets (out of PR boundary).
- Scope is task 5.1 only. The tool body, mount and ToolRuntime-level regression are #664; role surface/policy-gate are #665; `shud_run` is unchanged.
- Out-of-boundary finding recorded, not fixed here: `packages/dsh-shud-presets/prompts/coder.md:21` lists nine governance directories; presets are outside this PR boundary (follow-up comment on #665).
- Evidence floor: real pre-execute waterfall tests (apply + registered test tool named `analysis_create`, pattern `change-create-pre-execute.test.ts`) covering every spec scenario with execute/approval observation; governance matrix for `analyses`; all existing raw-guard suites unchanged and green; `git grep -n "九个治理根\|九根\|verifications.*builds"` (excluding `docs/99_ARCHIVE`, `docs/adr/implemented`, `openspec/changes`) leaves only the expected leftovers listed in tasks.md Docs row; `pnpm run check`; three-seat review; exact-head CI.

## Issue #664 execution fixture

- Issue type: feature. Fixture level: expanded; agree with upstream (new model-visible tool contract, workspace writes of an immutable governance object and a TaskCard, raw-guard integration through the real ToolRuntime; Critical Path #2, with #3 only via raw-guard's existing ask path).
- Blast radius: a second plan for one sensitivity card (closure ambiguity); a plan whose `input_digests` do not match the bytes the product check read; a plan written but the card silently unlinked with no recovery path; an orphan plan rewritten or deleted (immutability); a corrupt/symlinked `analyses/` entry skipped; card `status`/`runtime_phase` changed by linking; writes into `input_dir`, `runs/`, `stacks/`, `provenance/`, `reports/`; tool visible to a role before #665.
- Selected packs: Model-visible contract (strict schema, unknown keys incl. plan-owned fields, root type, delegation exactly once), File IO / path safety (records exclusive publication, `analyses/` lstat/symlink fail-closed, input realpath and regular-file checks), Persisted state semantics (card sync read-validate-write boundary, plan immutability, orphan repair), Error handling / partial outputs (plan kept on write-back failure with id-bearing error), Raw data protection (raw-guard tool-side regression through real ToolRuntime), Role exposure (mounted but in no role surface), Docs (`Repository_Layout.md` mounted-tool list). Domain: Scientific governance (one immutable plan per card, provenance digests). Not selected: schema changes (consumes #642 schema), core role map, policy-gate, presets, profile (#665), concurrency beyond the existing records exclusive-publish id collision handling.
- Scope is task 5.2a only. Exposure to coordinator, preset fixtures, policy-gate regressions and Web header evidence are #665; `shud_run` binding is #666; sensitivity `task_create`/`report_generate` are #667.
- Evidence floor: real ToolRuntime tests with constructed workspaces for every analysis-plans「analysis_create」scenario, the shud-run-tools mount/unknown-key scenario and task-cards write-back scenarios; tool-side raw-guard regression; role-surface check via core `isRoleToolIdAllowed` for the four canonical roles; `pnpm run check`; `pnpm run profile:smoke` (plugin still mounts, preset surfaces unchanged; tool list proven by the tools-package test); three-seat review; exact-head CI.

## Issue #665 execution fixture

- Issue type: feature. Fixture level: expanded; agree with upstream (policy-gate allow/deny source, approval seam non-regression, model-visible tool surface; Critical Path #1/#3).
- Blast radius: `analysis_create` visible or executable for worker/coder/reviewer (plan creation outside the coordinator); a new approval card in the sensitivity flow (PI asked for plan creation or plan-bound runs); coordinator able to call `shud_run`; restrict and policy-gate diverging from the single `ROLE_TOOL_MAP` entry; restrict failing loudly because an inherited name is not mounted; M4 rows drifting.
- Selected packs: Auth / permission (role surface allow/deny), Approval seam (no new ask), Model-visible contract (real Web `request/header.data.header.tools`), Legacy compatibility (M4 rows, legacy ids, `profile:smoke` assertions unchanged), Docs (`Runtime_Lifecycle.md:14` coordinator inherited list). Domain: Scientific governance (PI's only approval point stays `report_submit`/`report_decide`). Not selected: schema, persistence, file IO, raw-guard (unchanged), product code of presets/policy-gate (no change; only their tests/fixtures).
- Scope is task 5.2b only. Out of boundary and deferred: `packages/dsh-shud-presets/prompts/coder.md:21` nine-directory list (presets product prompt; belongs with the prompt slice #668 — comment moved there); end-to-end "exactly one PI card" is #672.
- Evidence floor: core role-map tests; presets restrict tests; policy-gate deny/no-ask regressions; `pnpm run check`; `pnpm run build && pnpm run profile:smoke` with unchanged assertions; real local Web session evidence (exact `request/header.data.header.tools` sets: coordinator 13 names including `analysis_create`, worker child 5 names without it) taken from a `pnpm run shud:first-task <scratch>` run's retained session logs; three-seat review; exact-head CI.

## Issue #666 execution fixture

- Issue type: feature. Fixture level: expanded; agree with upstream (model-visible tool contract, calib override provenance, approval non-regression, submission transaction inputs; Critical Path #1/#3/#4). The issue's suggested-level line cites #2/#3; #2 (raw data) does not apply as new risk here: nothing is written to raw, `analyses/` is a workspace record root that is only read, and raw-guard's `shud_run` decision is unchanged (re-asserted in the Approval seam row).
- Blast radius: a run on a sensitivity card with values not from its plan (model-supplied calib, wrong pset, other card's plan, unlinked orphan plan); a bound run whose input dir/project/window/threads differ from the plan (batch runs no longer differ only in parameters); plan validation after reconciliation publish or after a run directory exists (partial effects on rejection); the unbound path starting to read `analyses/` (a broken link there breaking science_assist runs); registry rejection messages collapsed so a corrupt state looks like a duplicate pset; a new approval card for plan-bound runs.
- Selected packs: Model-visible contract (paired params, unknown internal keys), Persisted state semantics (no card/run-dir effects on rejection; `linked_jobs` on duplicate and retry), Error handling (registry rejection mapping incl. distinguishing corrupt-state from duplicate), File IO / path safety (plan read by branded id only, physical `input_dir` resolution consistent with jobs/raw-guard/analysis_create), Approval seam (worker plan-bound `shud_run` no ask), Legacy compatibility (unbound and science_assist paths byte-identical, never read `analyses/`). Domain: Scientific governance (overrides only from the immutable plan; digest-checked baseline). Not selected: schema (consumes core), jobs/records/core changes (out of boundary), docs (no doc states the old parameter list beyond the specs — re-verify with grep).
- Scope is task 5.3 only. Issue comments fold in: forward the plan's full `input_digests` verbatim (integration test asserts key-by-key equality with the plan file), and keep the registry's corrupt-state error distinct from DUPLICATE in the tool error.
- Evidence floor: real ToolRuntime tests with constructed workspaces (plan files, card states, `input/ccw` copies, seeded indexed jobs) for every「shud_run arguments」plan scenario; registry request capture for internal fields; the worker no-ask regression at the pre-execute level; `pnpm run check`; `pnpm run build && pnpm run shud:tiny` (unbound path unchanged); three-seat review; exact-head CI.

## Issue #667 execution fixture

- Issue type: feature. Fixture level: expanded; agree with upstream (model-visible tool contracts, workspace writes in the report commit order, report-language guardrail via deterministic limitations; Critical Path #6, plus #2/#3 only as non-regression: no raw write, no new ask). Raw-guard and policy-gate are unchanged; `task_create(sensitivity)` and `report_generate(sensitivity)` read only workspace roots.
- Blast radius: a sensitivity card created with a pinned/observed checkout or with a plan; `linked_analyses` repaired or rewritten by reconcile (a plan the PI never linked silently entering closure); a failed perturbation run pre-judged as "uncollected" so a legitimate failed cell blocks the report, or an implicit collect during report generation; a `.sensitivity.json` written on closure failure, overwritten on id collision, or hashed from re-serialized plan JSON instead of the file bytes; limitations missing the coverage statement or "agent 建议值" marker (or with a duplicate `max_solver_dt` entry) so a report over-claims coverage; `linked_runs` dropping superseded failed runs; science_assist/code_change report bytes changing.
- Selected packs: Model-visible contract (task_create enum and description; report_generate type gate), Persisted state semantics (summary → JSON → card → Markdown order; closure failure writes nothing; reconcile never touches `linked_analyses`), File IO / path safety (plan bytes via descriptor-bound no-follow read; no `repos/`/`analyses/` access from task_create), Error handling (controlled errors for summary/plan-byte failures, corrupt ledger before closure), Report language guardrail (deterministic limitations order and counts), Legacy compatibility (science_assist/code_change paths and goldens unchanged). Domain: Scientific governance (`analysis_create` sole writer of `linked_analyses`; the coverage statement and the "参数范围为 agent 建议值，未经 PI 确认" marker always present). Not selected: schema (consumed), records/jobs/core/raw-guard/policy-gate/presets product code (consumed only), prompts (#668).
- Scope is task 5.4 only. Issue comments fold in (#658 / PR #702 follow-ups): the generated `linked_runs` contains every superseded run that has a RunRecord (`exit_class !== null`), and one real-ToolRuntime 4-run sensitivity report shows limitation kinds 1→5 with `max_solver_dt` exactly once.
- Evidence floor: real ToolRuntime tests with constructed workspaces (sensitivity card, plan file, collected/uncollected indexed jobs, `metrics.json` with matching digests) for every acceptance row; FS-spy or broken-link proofs for no-access claims; directory listings before/after for "writes nothing"; `pnpm run check`; `pnpm run build && pnpm run shud:tiny` (unchanged science path); three-seat review with whitebox record (Critical Path #6); exact-head CI.
