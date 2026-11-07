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
