# Design

## Context

动机见 proposal.md「Why」。本 change 的输入是 `.workplans/m5-oat-sensitivity/grill-gate.json`（当前为 35 个用户拍板分支：grill 30 个、Stage 2 裁决 S1–S4、Stage 3 裁决 DC-1；6 条事实核查；开放项 O1、O2、O4）。下列 D 节中的用户决策，以分支名在括号内引用。决定方案的现状事实如下（均为只读核实）：

- 提交路径（`packages/dsh-shud-jobs/src/shud-submissions.ts:197-214`）依次为：复制输入 → `updateEnd`（`shud-end.ts:5-25`，以 latin-1 字节保真的方式只改 `.cfg.para` 的 END 行）→ 构建解析 → StackLock 采集 → 由副本生成 DataProvenance → 写 `run-job.json`。DataProvenance 哈希的是**重写后的副本**（data-provenance「Provenance generation at submission」）。StackLock 按指纹复用（`core/stack-lock/fingerprint.ts:15-33`），指纹不含输入内容，所以只改 calib 的批次天然只有一个 `stack_id`。
- 自动 collect（`shud-collect.ts:340-356`）生成不可变 RunRecord，`numerical_health` 四项硬编码为 null。collect 失败写 `collect-error.json` 并计次（shud-run-jobs「Automatic collect」）。
- SHUD 二进制 `.dat`（`SHUD/src/classes/Model_Control.cpp:239-259,408-457`）的布局：1024 字节 char 头，接着依次是 double 的起始日期、NumVar、NumVar 个列索引；之后每行为 `[t, v1..vN]`，原生字节序，不检查 NaN。`t` 为区间起点（分钟）。所有输出变量都是区间平均（`Print_Ctrl::PrintData` 累加每步值后乘 `tau/NumUpdate`，`Model_Control.cpp:436-457`）：通量 `tau=1440`，单位 per day；状态 `tau=1`，所以储量的"末值"实际是最后一个区间的平均值。这一布局已用 `SHUD/output/ccw.out/ccw.rivqdown.dat` 的字节数校验过。
- ccw：`ccw.cfg.para` 输出间隔全部为 1440，`NUM_OPENMP 8`，没有 `DT_YE_IC`（默认为 0，`Model_Control.cpp:14`，所以不输出 eleyic）。`ccw.cfg.ic` 是文本：元素表 `Index Canopy Snow Surface Unsat GW`，接河道表。`ccw.sp.riv` 只有一个出口（河段 1，`Down=-3`）。keliya 的 `DT_YE_SNOW/SURF/UNSAT/GW` 均为 0。
- calib 解析（`SHUD/src/classes/ModelConfigure.cpp:136-258,444-459`）：每行 `KEY<tab>value`，键不区分大小写；未知键 `myexit`；`checkRange`（`functions.cpp:53-60`）只告警，返回值被丢弃。LC 的 Rough 在读入时先除以 60（`MD_readin.cpp:349`），再乘校准值，再检查 [0, 1]；河道 Manning 没有 range 检查。
- 钉版 SHUD 定义了 `PrintFinalStats`（`cvode_config.cpp:33`），但没有调用点；CVODE 失败只体现为 exit 19 或 stderr 的 `SUNDIALS_ERROR:`。负状态在 `MD_update.cpp:7-8` 被静默钳为 0。
- 报告：`task-closure-shared.ts:74-81,100` 中 `metric_fact` 硬编码为真，自动 limitation 是常量"本里程碑无指标 artifact"；§5 为固定句（`report-render.ts:354-356`）；`renderRuns` 已有 numerical_health 表（`report-render.ts:199-202`）。
- rc.2 下 worker 的唤醒通知是 unreachable（#457），批量运行沿用 M3 的显式 `job_output(wait)` + `shud_collect`。

## Goals / Non-Goals

**Goals:**

- 在 `dsh --profile shud` 的 Web 中走通：coordinator 建 `sensitivity` 卡 → `analysis_create` 写不可变 plan → 派 worker 对每个 pset 调用绑定 plan 的 `shud_run`（覆盖值从 plan 解析）→ worker 显式等待与收集 → collect 内确定性计算 metrics 与 numerical_health → coordinator `report_generate` 派生汇总表 → `report_validate` → `report_submit` 审批卡 → accepted / done。
- 指标、汇总表、覆盖范围声明、closure 全部确定性计算，没有 LLM 裁量；汇总表能从保留的 `.dat` 逐字节重算。
- 关闭 #422：所有成功 run 的 RunRecord 都带 numerical_health 与 metrics_summary；不可观测的项诚实地写 null 并注明原因。
- 不升级 dsh，不引入第三方新依赖，不引入 R 运行时；根 submodule 与 `data/raw` 不变。

**Non-Goals:**（每条附复活条件，来源分支见括号）

- calibration、controlled search、TheoryToCodeBundle、search_scope、`semantic_level_floor.yaml` 的 `parameters` 段（复活条件：PI 启动校准课题；Non-Goals 分支）。Gating §1.2 由 D2 的白名单常量等价落地。
- heatmap / tornado 图、AnalysisProgressPayload 与批进度卡片（复活条件：K7 解除，或 M6 UI 插件评估立项）。
- 观测类指标 NSE / KGE / peak_flow_error，以及对 `ccw.tsd.obs` 的读取（复活条件：核实观测质量）。
- holdout、多流域；不绑定 plan 的 run 改写 `NUM_OPENMP`；`threads>1` 下的任何确定性或重复性判定（plan 可以指定 `threads`，但验收只覆盖 1）。
- 修改 `.para.*` 类别表、加数（`+` 后缀）calib 键、新增 calib 键、白名单外的键（复活条件：PI 扩大白名单，并逐键核对 SHUD 施加语义）。
- `max_solver_dt` 与 CVODE nst / netf / ncfn 统计，以及 M4 遗留的 O2（复活条件：SHUD pin 升级到调用 `PrintFinalStats` 的修订，或 PI 批准改 SHUD）。
- 负状态的"长零段"启发式（复活条件：PI 给出阈值）。
- `batch_policy`（`max_concurrent_jobs` / `stop_condition`）（复活条件：pset 数超过 5，或单 run 资源使并发不可行）。
- plan 确认审批卡与可填写的 `confirmed_by`（复活条件：PI 要求在运行前把关参数空间）。
- 敏感性指数、弹性系数、参数排名或任何机制解释（Sensitivity metrics 分支）。
- dsh 升级（#631 已定，M6 评估 0.2.2）；记忆（K11）。
- 一张卡上多个 plan、plan 修订或作废（D1）。
- 对历史 run 回填 metrics：已提交的 RunRecord 不可变，旧记录保持 null。

## Decisions

### D1 AnalysisPlan schema、品牌 id 与持久化（Critical Path #7；AnalysisPlan object 分支）

- core 新增 `schemas/analysis-plan.ts`，导出 strict Zod schema `AnalysisPlanSchema` 与品牌 `AnalysisPlanId`（`PLAN-YYYYMMDDTHHMMSS-xxxx`，复用 `run-identifiers.ts` 的生成器与校验）。`Minimal_Schemas.md` §6 的 `PLAN-NNNN` 随之修订，处理方式与 M3/M4 对 TASK/CHG 的修订相同。
- 字段：
  - `analysis_plan_id`、`task_id`、`mode`（字面量 `sensitivity`）、`strategy`（字面量 `one_at_a_time`）。
  - `input_dir`：`analysis_create` 时取 realpath 的绝对路径。
  - `project`：SHUD 项目名。
  - `end_days`：正整数。
  - `threads`：正整数，`analysis_create` 省略时为 1（D4）。
  - `parameter_sets`：3–5 项，每项为 `{parameter_set_id: "PSET-1".."PSET-5", label, baseline: boolean, changes: Record<WhitelistKey, number>}`。
  - `parameter_space_rationale`：`{proposed_by: "agent", basis: 非空字符串, confirmed_by: null}`。
  - `input_digests`：`{<相对 input_dir 的 POSIX 路径>: sha256}`，覆盖 `<project>.cfg.calib` 以及 plan 所用键涉及的类别文件（GEOL_* → `.para.geol`，LC_ROUGH → `.para.lc`，RIV_ROUGH → `.sp.riv`），与乘积校验取自同一次读取（Stage 3 SC-2）。注册表在复制输入之后、任何重写之前核对副本摘要（D4），保证批内各 run 的基准输入相同，并且就是乘积校验过的那份字节。
  - `created_by`、`created_at`。
- schema refine：
  - 恰好一个 `baseline: true`，且它的 `changes` 为 `{}`；
  - 每个非 baseline pset 的 `changes` 恰好一个键；
  - `parameter_set_id` 按出现顺序为 `PSET-1..PSET-n`；
  - 不存在两个 `changes` 完全相同的 pset；
  - 键 ∈ D2 白名单，值为有限数且 ∈ [0.5, 2.0]，且 ≠ 1.0（与 baseline 相同的扰动没有信息量）。
- 落点：`<cwd>/analyses/<analysis_plan_id>.json`。排他创建，id 碰撞时最多重分配 3 次；原子写、`lstat` 路径安全与"先校验 id 再拼路径"全部沿用 records 文件层（task-cards「TaskCard workspace file」）。创建后任何工具都 SHALL NOT 改写它。
- ParameterSet 的状态**不持久化**（Mapping §3）。pset↔run 的关联只写在 RunJob/RunRecord 的 `analysis_plan_id` + `parameter_set_id` 上（D4），状态由 RunJob/RunRecord 派生。
- **一张 sensitivity 卡恰好一个 plan**：`analysis_create` 在卡片 `linked_analyses` 已非空时拒绝。理由：验收与 closure 都以"恰好一个 plan"为前提（Acceptance plan 分支）；多 plan、修订与作废列为 Non-Goal。
- 备选：
  - 可变 plan 回写 job/run id（grill 否决，多一个写入点）；
  - 支持 artifact 而非核心对象（与 ADR-0002 D5 不符）；
  - `ctx.storage`（与 M2–M4 的工作区文件模式不一致）。

### D2 calib 白名单与乘积校验（Critical Path #1；Calib key policy / Whitelist contents 分支）

- core 新增 `governance/calib-whitelist.ts`（与 `wording.ts`、`semantic-level-floor.ts` 同一模式：仓库内常量，没有运行时覆写）。每个条目为 `{key, table, column, read_transform, check_range | null, source}`：
  - `GEOL_KSATH`：`.para.geol` 的 `KsatH(m_d)` 列，读入时 `/1440`（`MD_readin.cpp:324`），检查 [0, 1e3]（`ModelConfigure.cpp:110`）；
  - `GEOL_KSATV`：`KsatV(m_d)` 列，读入时 `/1440`（`MD_readin.cpp:325`），检查 [0, 1e3]（`:111`）；
  - `LC_ROUGH`：`.para.lc` 的 `ROUGH` 列，读入时 `/60`（`MD_readin.cpp:349`），检查 [0, 1]（`:130`）；
  - `RIV_ROUGH`：河道类型表的 `Manning` 列，SHUD 不做 range 检查，harness 只要求乘积为有限正数。
  - 统一倍率区间 [0.5, 2.0]。`read_transform` 与 `check_range` 逐条附 SHUD 源码 file:line，作为 Critical Path 白盒审查的对照。
- 乘积校验在 `analysis_create` 时执行（D3）：读 `input_dir` 中的 `<project>.cfg.calib` 取得该键的 baseline 值 `b`（键不存在或出现多于一行 → 拒绝：前者因为 M5 不新增键，后者因为 D5 的提交重写要求恰好一行，否则 plan 能建成、每次提交却都失败）；对类别表的每一行 `x`，按 SHUD 施加顺序算出 `read_transform(x) × b × m`，有任一行越过 `check_range` 就拒绝，错误中点名键、行 index、值与区间。校验只读。`input_dir` 位于 raw 内时，由 raw-guard 按与 `shud_run` raw 输入相同的判定发起 provenance 读审批（ask，D11）；工具本身不写 raw。
- `GEOL_THETAS/THETAR`、`SOIL_BETA`（钳到 1.1）以及加数键，都因施加语义不是简单乘法而排除（Non-Goal）。
- 备选：38 键全开（grill 否决，特例过多）；只限键和区间、不校验乘积（grill 否决，因为 SHUD 静默照跑）。

### D3 `analysis_create` 工具（coordinator；Plan creation 分支）

- 参数（strict，未知键即拒）：`task_id`、`input_dir`、`project`（可选，缺省为 `input_dir` 末级目录名，规则同 `shud_run`）、`end_days`、`threads`（可选，缺省 1）、`parameter_sets`（数组，元素为 `{label?, baseline, changes}`，pset id 由工具分配）、`rationale_basis`。
- 顺序：
  1. 校验品牌与参数形状。
  2. 同步读取并校验卡片：`type: sensitivity`、`status ∈ {planned, running}`、`linked_analyses` 为空。
  3. 解析 `input_dir` 的 realpath，并确认 `<project>.cfg.para`、`.cfg.calib` 与类别表都是普通文件。
  4. 执行 D2 的乘积校验。
  5. 组装 plan，经 schema 校验。
  6. 排他写入 `analyses/<id>.json`。
  7. 以同步边界原子回写卡片：`linked_analyses = [id]`、刷新 `updated_at`；卡片状态不变。
  第 6 步成功而第 7 步失败时，返回含 `analysis_plan_id` 和"plan 已落盘、任务卡回写失败"的错误。重试会被第 2 步拒绝吗？不会——`linked_analyses` 仍为空，于是会产生第二个孤立 plan。为此第 2 步扫描 `analyses/` 中 `task_id` 等于本卡的 plan：有已链接的 plan 即拒绝；有未链接的孤立 plan 时，若本次参数（input_dir、project、end_days、threads、parameter_sets 的键/倍率/baseline 及顺序、rationale_basis）与它等价，就把这一次调用当作修复——不新建 plan，只执行第 7 步回写链接，返回该 plan；不等价则拒绝并点名孤立 plan id。这样回写失败后用相同参数重试即可恢复，卡片不会被永久卡死。这是唯一一处目录扫描，仅用于防重与修复，closure 不依赖它（closure 只经卡片链接读取）。
- pset 的 `label` 省略时为 `null`。成功结果返回 `analysis_plan_id` 与分配后的 pset 列表（id、label、baseline、changes）。
- `proposed_by` 固定为 `agent`，`confirmed_by` 固定为 `null`，`created_by` 经 `readCallerPresetId` 取得。不调用 LLM，不发起审批（D11）。

### D4 `shud_run` 的 plan 绑定（Critical Path #4；Run binding 分支）

- 新增成对可选参数 `analysis_plan_id` + `parameter_set_id`：只给其中一个即为工具错误；两者都给时，必须同时提供 `task_id`。顺序：成对与品牌校验、读取 plan 并比对下列字段，在关联作业查询、卡片读取与任何写入之前完成；"plan 在卡片 `linked_analyses` 中"在既有卡片读取的同步边界内检查。
- 解析 plan（经品牌 id 定位，不扫描目录），以下任一不等即拒绝：plan 的 `task_id` 等于调用的 `task_id`；`realpath(input_dir)` 等于 plan 的 `input_dir`；`project` 等于 plan 的 `project`；调用若带 `end_days`，必须等于 plan 的值；调用未带时，使用 plan 的 `end_days`。plan 必须在卡片 `linked_analyses` 中。不接受模型传入的 calib 值。
- **线程由 plan 指定**（Stage 2 用户裁决 S1）：AnalysisPlan 带 `threads`（正整数；`analysis_create` 省略时写 1）。绑定 plan 的提交以 plan 的 `threads` 执行，包装进程环境 `OMP_NUM_THREADS`/`SHUD_RHS_THREADS` 沿用 M4「Build-referenced execution」的线程环境规则。调用省略 `threads` 时取 plan 值，传入与 plan 不等的值即拒绝。理由：批内各 run 的线程设置必须一致，差异只来自参数；钉版 SHUD 以 cfg 的 `NUM_OPENMP` 调用 `omp_set_num_threads`（`Model_Control.cpp:130-131`、`MD_readin.cpp:466`、`shud.cpp:55-56`），会覆盖 `OMP_NUM_THREADS`，所以单靠环境变量不能生效（Stage 3 DC-1 用户裁决）：绑定 plan 的提交同时把副本 `<project>.cfg.para` 的 `NUM_OPENMP` 改写为 plan 的 `threads`（D5），对串行和 OpenMP 构建都真实。验收固定 plan 取 `threads: 1`，这是 O2 重复性判据的前提。不绑定 plan 的提交行为不变（不碰 `NUM_OPENMP`）。
- **sensitivity 卡必须绑定 plan**（Stage 3 SC-3）：在既有卡片读取的同步边界内，卡片 `type: sensitivity` 而调用未带成对 plan 参数时拒绝，不写任何文件。否则未绑定的作业进入 `linked_jobs` 后不可删除，closure 第 1 条会永久不成立。
- **基准输入核对**（Stage 3 SC-2）：`shud_run` 把 plan 的 `input_digests` 作为内部字段传给注册表；注册表在复制之后、任何重写之前核对副本对应文件的 sha256，缺失或不等即按既有回滚失败，错误点名该文件。
- **重复提交拒绝**（权威检查在 jobs 层，避免并发竞态）：注册表在其同步的 id 占用点（`shud-submissions.ts:112`，首个 await 之前）对在途提交与已登记作业检查同一 `(plan, pset)`，存在**非失败**作业即拒绝，保证同一 pset 的并发提交至多一个被接受。"非失败"指：RunJob 未处于 `failed`/`cancelled`，没有收集耗尽，且其 RunRecord（若已 collected）的 `status` 不是 `failed`。失败后允许重提，失败的那次保留在 `linked_jobs` 中，由 D9 的 closure 处理。
- RunJob/RunRecord 新增 nullable 的 `analysis_plan_id`、`parameter_set_id`（缺键按 null 解析，读取不改写文件；iff refine：两者同时为 null 或同时非 null），collect 时原样继承。
- plan 校验与覆盖解析放在 `dsh-shud-tools`；重复检查在注册表。注册表接收的是已解析的 `calib_overrides: [{key, multiplier}]` 与 plan/pset id（仅内部请求字段，不对模型暴露），这样 jobs 层不需要读 plan，也不依赖 records 包。

### D5 提交时的副本重写（Critical Path #4；eleyic output / Calib key policy 分支）

- 在 `updateEnd` 之后、构建解析之前，注册表对副本依次执行：
  1. `ensureOutputInterval(<project>.cfg.para, "DT_YE_IC", 1440)`：以 latin-1 字节保真的方式逐行处理，跳过规则与 `updateEnd` 相同（首字节为 `#`/空格/NUL 的行跳过，键不区分大小写）。已有 `DT_YE_IC` 行（可能多行）就把每一行的值都改为 1440，保留原分隔符与行尾，与 END 改写一致；没有就在文件末尾追加 `DT_YE_IC\t1440` 和一个与该文件首个行尾相同的行尾（文件无行尾时用 `\n`）。若末行没有行尾，先补一个行尾再追加。所有提交（含无 plan 的 run）都执行。
  1b. 绑定 plan 时执行 `NUM_OPENMP` → plan `threads` 的改写，规则与 `DT_YE_IC` 相同（逐行、多行全改、缺失则追加）。不绑定 plan 的提交不执行。
  2. 有 `calib_overrides` 时执行 `applyCalibMultiplier(<project>.cfg.calib, key, m)`：定位该键的唯一一行（大小写不敏感；0 行或多于 1 行均为提交失败），把值改写为 `b × m`。数值序列化采用 JS 最短往返表示，保证 SHUD `sscanf("%lf")` 读回同一 double；保留原分隔符与行尾。
- 两次重写都在 DataProvenance 生成之前完成，所以 `files` 中的 `.cfg.para` / `.cfg.calib` 哈希就是 SHUD 实际读取的字节。任一重写失败都按既有提交回滚处理（删除运行目录与索引，不留 provenance）。原输入不变。
- 改动先例：`updateEnd`。新函数与它放在同一模块（`shud-end.ts` 重命名为 `shud-cfg-rewrite.ts`，原地重构，同一实现不保留旧文件——Code Canonicality）。
- 生效值的核对：SHUD 会写出 `output/<project>.out/<project>.cfg.calib.bak`。验收脚本据此核对该键的生效值等于 `b × m`（D14），这样不依赖模型文本。
- 改动的现有契约：shud-run-tools 场景"replay input without END override is preserved"原本要求副本 cfg 逐字节相同，改为"除 `DT_YE_IC` 行外逐字节相同"（Existing oracles 分支）。`DT_YE_IC` 只控制 eleyic 的输出（`MD_initialize.cpp:245-246` 的 PCtrl Init），不参与求解。M4 rivqdown bitwise 判据不受影响，由回放重跑证据证实（D14）。

### D6 `.dat` 读取器（Metrics implementation 分支）

- records 新增一个共享的 SHUD 文本输入安全读模块（`.sp.mesh/.sp.att/.sp.riv/.para.*/.cfg.*`，同一次读取内算 sha256），供 metrics、乘积校验与验收脚本共用，不各写一份（Stage 3 TE-04）。
- records 新增 `shud-dat.ts`：`readShudDat(fd) → {start_date, columns: number[], rows: {t_min, values: Float64Array}[]}`。按 `Model_Control.cpp:239-259` 校验：文件长度 ≥ 1040；`(len − 1024 − 16 − 8·NumVar) mod (8·(NumVar+1)) == 0`，否则报错并点名文件；NumVar 与列索引必须是有限非负整数。字节序为原生（小端；非小端平台直接拒绝运行，不猜测）。
- 打开方式沿用 `compareRivqdown` 的安全读：`O_NOFOLLOW`、fstat 身份绑定、只接受普通文件、路径相对 `shud_output` 且不得逃逸。读取时同时计算 sha256（同一次读，用于 `metrics.json` 的 inputs 与重算核对）。
- 遇 NaN/Inf 不抛错：计入 `metrics.json` 的 `nonfinite_count`，相关指标置 null 并写明原因。

### D7 逐 run 指标与水量平衡公式（Sensitivity metrics / Water-balance formula 分支）

- 出口集合 `O`：`<project>.sp.riv` 第一张表中 `Down < 0` 的河段（与 rSHUD `getOutlets` 一致）。`O` 为空即视为指标错误。ccw 中 `O = {1}`。
- 出口流量序列：`Q(t) = Σ_{o∈O} rivqdown[o](t)`，单位 m³/d，来自区间平均通量。
- 指标（窗口 = 输出的全部行）：
  - `peak_flow_m3d = max Q(t)`；并列时取最早的一个。
  - `peak_day = t_peak / 1440`，即区间起点距模型 START 的天数。
  - `total_runoff_m3 = Σ Q(t) × Δ`，其中 Δ（天）由该 `.dat` 的时间列推导：相邻行 `t` 之差必须处处相等，取该差 / 1440。不读 `.cfg.para` 的 `DT_*` 键，因为 SHUD 对缺省键有内部默认值（`Model_Control.cpp:14-65`），映射易错。行数 < 2 或间隔不等时，该变量相关项为 null，原因 `interval_undetermined:<name>`。
- 水量平衡（深度，m；移植 rSHUD `wb.all` + `wb.DS`，`rSHUD/R/WaterBalance.R:9-50,199-218`，并扩展两项）：
  - 面积 `A_i` 由 `<project>.sp.mesh` 的三角形节点坐标计算（同 rSHUD `getArea`），`A = Σ A_i`，权重 `w_i = A_i / A`。
  - `P = Σ_t Σ_i w_i · elevprcp_i(t) · Δ`；`AET = Σ_t Σ_i w_i · eleveta_i(t) · Δ`；`Qd = Σ_t Q(t) · Δ / A`。
  - `ΔS_surf = Σ_i w_i (eleysurf_i(T) − ic.Surface_i)`。
  - `ΔS_us = Σ_i w_i (eleyunsat_i(T) − ic.Unsat_i) · θs_i`，`ΔS_gw` 同理，其中 `θs_i = ThetaS[geol(i)] × GEOL_THETAS`（geol 取自 `.sp.att`，ThetaS 取自 `.para.geol`，GEOL_THETAS 取自副本 `.cfg.calib`）。
  - `ΔS_riv = Σ_r (rivystage_r(T) − ic.Stage_r) · width[type(r)] · length_r / A`。
  - 扩展项：`ΔS_snow = Σ_i w_i (eleysnow_i(T) − ic.Snow_i)`，`ΔS_ic = Σ_i w_i (eleyic_i(T) − ic.Canopy_i)`。两者的单位与是否需要植被覆盖率加权见 Open Questions O1。
  - `ΔS` 为以上各项之和。`T` 为最后一行，IC 取自副本 `<project>.cfg.ic`（文本，元素表与河道表）。末行是最后一个区间的平均值而非瞬时末态，这一近似与 rSHUD `DeltaS` 相同，在 `metrics.json` 中注明。IC 行数与元素数或河段数不符时 residual 为 null，原因 `ic_shape_mismatch`。副本 `.cfg.calib` 缺少 `GEOL_THETAS` 时 residual 为 null，原因 `missing_calib:GEOL_THETAS`，不默认取 1。
  - `water_balance_residual = |P − Qd − AET − ΔS| / P`。`P ≤ 0` 时为 null，原因 `zero_precipitation`（O3 在此定案）。
  - `metrics.json` 中同时写出 `P`、`Qd`、`AET` 和各 ΔS 分量，用于 rSHUD 对照与 PI 审阅。
  - 缺少任一必需变量文件（例如 keliya 不输出储量，或 M4 之前的 run 没有 eleyic）时，residual 为 null，原因 `missing_variable:<name>`。
- 公式是 PI 的科学定义（用户拍板）。实现 SHALL NOT 自行调整项，偏离只能经 PI。rSHUD 对照（D13）只覆盖与 rSHUD 共有的项（P、Qd、AET、ΔS_surf/us/gw/riv）。

### D8 numerical_health 与阈值判定（cvode_failures and max_solver_dt / negative_state_count / Threshold consequence 分支）

- `water_balance_residual`：见 D7。
- `cvode_failures`：`stderr.log` 中以 `SUNDIALS_ERROR:` 开头的行数（规则同 Domain_CLI_Spec 的失败签名）。读取沿用既有 stdout/stderr 普通文件读边界。
- `negative_state_count`：`eleysurf`、`eleyunsat`、`eleygw`、`rivystage` 中所有 `< -1e-10` 的有限值个数（容差常量来自 `SHUD_Output_Variables.md` §11）。`metrics.json` 中写明"SHUD 静默钳零，该值为下界"。四个文件中任一不存在时整项为 null，原因 `missing_variable:<name>`，不给部分计数。
- `max_solver_dt`：恒为 null，原因 `not_observable_in_pinned_shud`（`PrintFinalStats` 没有调用点）。
- 判定：core 常量 `NUMERICAL_HEALTH_THRESHOLDS` 取自 §13：residual 的 pass ≤0.01、warn ≤0.05、fail >0.05；cvode 的 pass 0、fail >0；negative 按 §13 原样：0 为 pass，1..10 为 warn，>10 为 fail（计数本身已排除 −1e-10 容差内的值，"within tolerance" 由此成立；Stage 3 DC-2，不放宽阈值）。值为 null 时判定为 `not_available`。判定结果写进 `metrics.json` 的 `verdicts`。只陈述，不阻断 closure；warn/fail/not_available 由报告生成派生 limitation（D10）。`max_solver_dt` 不参与判定（没有阈值，结构性不可观测），也不逐 run 生成 limitation；报告中只有一条固定 limitation 说明它在钉版 SHUD 中不可观测。

### D9 collect 内计算与失败隔离（Critical Path #4；Metrics timing and scope 分支）

- 在 collect 尝试内、RunRecord 发布之前：只有当 `exit_class === "ok"` 时调用 records 的 `computeRunMetrics(run_dir, project)`。它返回 `{metrics, health}`，或一个受控的 `MetricsUnavailable{reason}`，除此之外不抛错。注册表随后原子写 `runs/<run_id>/metrics.json`，并把其 sha256 写入 RunRecord 的 `artifacts.metrics_summary = {path: "metrics.json", sha256}`，numerical_health 取自 health。
- 隔离规则：
  - `status` 语义：`ok` 表示计算完成，单项可以各自为 null 并带原因（例如某个变量文件不存在 → 相关项 `missing_variable:<name>`；keliya 不输出储量，于是 residual 与 negative_state_count 为 null，峰值类指标照常计算，status 仍为 `ok`）。`unavailable` 只用于计算无法进行的情形：`rivqdown`、`.sp.riv`、`.sp.mesh`、`.cfg.ic`、`.cfg.para` 不可读，出口集合为空，或任一**已存在**的 `.dat` 布局校验失败、读取 IO 出错。
  - 指标计算返回 MetricsUnavailable：仍写 `metrics.json`，`status: "unavailable"`，带 `reason`，各值为 null。RunRecord 的 numerical_health 四项为 null，`metrics_summary` 指向该文件。**SHALL NOT** 写 `collect-error.json`，不计 collect 次数，也不改变 RunRecord 的 `status` 与 `exit_class`。
  - 写 `metrics.json` 本身失败（IO）：RunRecord 的 `metrics_summary` 为 null，numerical_health 为 null，collect 继续发布 RunRecord。这是唯一无法留下原因的路径，作为风险登记。
  - 非 `ok` 的 run：不写 `metrics.json`，`metrics_summary` 为 null，numerical_health 为 null。
- 幂等：`run-record.json` 已存在时照旧原样返回，不重算、不改写 `metrics.json`。之前尝试残留的 `metrics.json` 在下一次尝试中被同一确定性内容覆盖。
- 确定性：`metrics.json` 为固定键序，数值采用 JS 最短往返表示；`method_version` 取 core 常量；`inputs` 列出每个读取文件的 `{path, sha256, size_bytes}`，按 path 升序。同一组输入文件 SHALL 产生逐字节相同的 `metrics.json`。
- 依赖方向：`dsh-shud-jobs` 已依赖 `dsh-shud-records`（StackLock 采集、provenance），新增调用不形成循环。
- 成本：ccw 全长运行约需流式读取 10 个变量文件（每个 element 文件约 17MB），只解析需要的列，流式处理并限制内存。90 天窗口约为其 1/20。

### D10 TaskCard、closure 与报告（Critical Path #6；TaskCard type / Failed cells / Summary table / Report guardrails / Non-sensitivity reports 分支）

- TaskCard：
  - `type` 增加 `sensitivity`；新增 `linked_analyses`（品牌 `AnalysisPlanId` 数组，缺键按 `[]` 解析，按码点升序且无重复）；refine：非 sensitivity 卡的 `linked_analyses` 为空。
  - `task_create` 接受 `sensitivity`（`source_base_commit: null`，不访问 `repos/`）。
- **sensitivity closure 谓词**（在 reconcile 之后、写任何报告文件之前求值，只经链接读取对象）：
  0. `linked_analyses` 恰好一个，plan 可读、通过 schema 校验，且其 `task_id` 为本卡；observations / limitations / pi_questions 各至少一条（limitations 只计模型传入的条目）。
  1. `linked_jobs` 中每个作业都绑定该 plan 的某个 pset（存在未绑定或绑定其它 plan 的作业即不成立），且全部处于终态：collected，或 failed/cancelled，或收集耗尽。
  2. 每个 pset 至少有一个作业。每个 pset 的**有效 run** 定义为：存在 succeeded 的 run 时取它（D4 保证至多一个非失败作业）；否则取 `job_id` 码点最大的失败 run。
  3. baseline 的有效 run 为 succeeded；非 baseline 的有效 run 可以是 failed（RunRecord `status: failed`，`exit_class` 非 cancelled/lost）。cancelled、lost 或收集耗尽的 run 作为有效 run 时，谓词不成立。
  4. 所有 succeeded 有效 run 的 `stack_id` 相同且非 null，`data_id` 非 null。
  5. 每个 succeeded 有效 run 的 `metrics_summary` 非 null，`metrics.json` 可读、sha256 匹配，且 `status: "ok"`（指标不可用就不能做敏感性比较）。
  非有效的失败 run（已被重提取代）在报告中列出，但不进入汇总表；列出顺序沿卡片 `linked_jobs`（码点升序）。
- **science_assist / code_change 谓词**：运行子句不变；删除"无指标 artifact"自动 limitation 与 metric_fact 恒真的特例，`metric_fact` 改为"每条指标事实都有 evidence_refs"（由确定性事实表保证）。
- EvidenceReport 新增 `analysis_ids`（来自卡片 `linked_analyses`，非 sensitivity 卡为 `[]`；缺键按 `[]` 解析），以及 `sensitivity_summary: {path, sha256} | null`（缺键按 null 解析）。refine：`sensitivity_summary` 非 null 当且仅当 `analysis_ids` 非空。报告渲染与 validate 读取 `metrics.json` 和 `.sensitivity.json` 时都校验 sha256。Citation existence check 增加对 `PLAN-` 令牌的解析。
- **汇总表派生**（Summary table 分支）：`report_generate` 对 sensitivity 卡从 plan 与各有效 run 的 `metrics.json` 构造 `SensitivitySummary`。
  - 每个 pset 一行：pset id、label、键、倍率、`run_id`、状态、`exit_class`、`peak_flow_m3d`、`peak_day`、`total_runoff_m3`、`water_balance_residual` 及其判定。
  - 非 baseline 行另给 `Δpeak_flow_%`、`Δpeak_day`（天）、`Δtotal_runoff_%`，以 baseline 为分母；分母为 0 时给 null 并注明原因。
  - 失败行的指标列为空，并写出 exit_class 与原因。
  - 记录 `inputs: [{run_id, metrics_sha256}]`。
  - 写入 `reports/<report_id>.sensitivity.json`：固定键序，数值为最短往返表示，在报告 JSON 提交之前原子写入，并纳入报告的写入与修复契约：summary 写入后报告 JSON 提交失败，该 summary 作为孤立文件保留，不覆盖；报告 id 分配时，三类报告文件中任一已存在即重新分配。
- **§5 渲染**：
  - 所有类型都渲染逐 run 指标表（峰值、峰现日、总径流、四项 numerical_health 及判定），去掉"本里程碑无指标 artifact"固定句。
  - code_change 保留 `CODE_CHANGE_SECTION5_WORDING`，并在其后追加该表。该常量现以"本里程碑无指标 artifact；"开头，与追加的指标表矛盾，所以删去这一分句，其余逐字不变（Critical Path #6；回放 oracle 在同一切片中更新，见 D14）。
  - sensitivity 再追加 Δ 汇总表。
- **确定性 limitation**（report_generate 在模型 limitations 之后追加，不计入 closure 的计数）：
  - sensitivity 必有一条覆盖声明，常量模板为"仅在 <project> 单流域、<end_days> 天窗口、相对 baseline 测试了 <KEY×m, …>；未覆盖其它参数、取值与窗口"。
  - sensitivity 必有一条固定的"参数范围为 agent 建议值，未经 PI 确认"（`confirmed_by` 在 M5 恒为 null）。
  - 任一 run 的判定为 warn/fail/not_available 时，各生成一条，点名 run 与指标。
  - 每个失败 cell 生成一条。
  - 模板全部是 core `wording.ts` 常量。
- **report_validate 新增两项**：sensitivity 报告的覆盖声明与"agent 建议值"标注都必须逐字出现；`.sensitivity.json` 存在且其 sha256 与报告中的引用一致。既有 15 项与禁用短语扫描不变；其中第 (4)/(10) 项原注"无指标、无图表"，改注"由构造保证"。
- Markdown 中的指标值与 Δ 值原样输出 JSON 中的最短往返数字串，不做舍入；null 渲染为固定记号（Stage 3 TE-09）。`delta_peak_day` 是差值，分母为 0 的 null 规则只适用于两个 `_pct` 字段。
- 渲染工具不另调 LLM，不计算任何敏感性指数或排名（Sensitivity metrics 分支）。

### D11 治理面（Critical Path #1/#2/#3；PI approval point 分支）

- policy-gate：不新增 ask。`analysis_create` 与绑定 plan 的 `shud_run` 都经 role-tool-surface：`analysis_create` 只有 coordinator 能调用，worker、coder、reviewer 调用即 deny；角色合法时进入下一层，不发起审批。PI 的唯一审批点是 `report_submit`/`report_decide`（既有）。这对应 Gating §1.2"registered_calib_keys floor: none"：M5 只改运行副本，不碰默认参数文件；K12 的"改默认参数需 PI"不受影响。
- raw-guard：
  - `analysis_create` 的固定输出根 `analyses/` 沿用 task_create 与报告工具的固定输出根保护：输出根本身或其祖先为符号链接、位于 raw 内时 deny。
  - 治理根写保护集增加 `analyses`：模型的 `edit`/`write`/`bash` 写入 `analyses/` 一律 deny。
  - `analysis_create` 读取的 `input_dir` 位于 raw 内时，与 `shud_run` 的 raw 输入判定相同（ask）。
- role-tool-map：coordinator 增加 `analysis_create`；worker 的工具面不变（`shud_run` 的新参数不改变工具 id）。

### D12 编排与 prompt（Batch orchestration / Concurrency 分支）

- coordinator prompt 增加 sensitivity 流程：`task_create(type: sensitivity)` → `analysis_create` → `subagent`（worker），委派时给出 plan id、pset 列表与 input_dir → 收到 worker 汇报后 `report_generate` → `report_validate` → `report_submit`。
- worker prompt 增加：对每个 pset 调用 `shud_run(task_id, input_dir, analysis_plan_id, parameter_set_id)`；可以先全部提交再逐个 `job_output(wait: true)` + `shud_collect`；失败的 pset 不自行重提，如实汇报给 coordinator。
- 不建 batch_policy，也不加并发上限：各 run 目录本来就独立，`Agent_Architecture.md` §8.5 的规则仍然成立。
- presets 的 `test-harness.ts` 精确工具面、`role-tool-*.test.ts` 与 `prompts.test.ts` 随之更新。不新增 preset 与委派工具，`profile:smoke` 的四 preset、三委派断言不变。

### D13 rSHUD 对照夹具（Metrics implementation 分支）

- 新增合成迷你项目夹具 `packages/dsh-shud-records/test/fixtures/wb-mini/`：约 3 个三角形元素、2 个河段（1 个出口）、完整的 `.sp.mesh/.sp.att/.sp.riv/.para.geol/.cfg.calib/.cfg.ic`，以及由 TS 写出器生成的小 `.dat` 输出（几十行），总量几 KB。
- 一次性本机脚本 `scripts/metrics/rshud-crosscheck.R`（需要 Rscript + rSHUD 2.5.0）：对该夹具调用 `wb.all`/`wb.DS` 的组成项，输出 P、Q、AET 与各 ΔS 分量到 `expected-rshud.json`，与夹具一起入库。CI 只比较 TS 的结果与该 JSON（相对误差 ≤1e-12，或逐项相等），不需要 R。脚本头部记录 R/rSHUD/xts 版本与生成命令。
- 另用 ccw 的真实 `.dat` 只做本机核对，结果写进 PR 证据，不入库（体量过大）。
- 积雪与截留两项不在 rSHUD 中，用手算夹具覆盖正反例。

### D14 验收闸 `shud:sensitivity` 与既有 oracle（Acceptance gate / Recomputable / Repeat mismatch / Acceptance plan / Existing oracles 分支）

- `pnpm run shud:sensitivity <scratch-workspace>`（显式工作区，可在 TMPDIR；需要 `SHUD_BIN`、`DMXAPI_KEY`；CI 不运行）：
  - 准备：工作区复制 `SHUD/input/ccw` 为 `input/ccw`。
  - 用独立 Web profile 经 HTTP 发送单条提示，内容为固定 plan：baseline、`GEOL_KSATH`×0.5、`GEOL_KSATH`×2、`LC_ROUGH`×2，`end_days: 90`，`threads: 1`。
  - 脚本对报告审批自动 Allow once，只算工程证据。
  - 宿主停止后，脚本在批外做一次重复性对照：把批内 baseline run 的 `input/ccw` 逐字节复制到脚本自有的 scratch 目录，以同一 `SHUD_BIN`、与 plan `threads` 相同的 `OMP_NUM_THREADS`/`SHUD_RHS_THREADS`（固定 plan 中为 1）直接执行（不经模型、不经注册表，也不产生 RunJob/RunRecord 或会话事件），然后比较输出的 rivqdown sha256。这样判据 9/10 不受影响，比较对象只有求解器本身。
- 判据（全部取自工作区文件与 canonical session log，不取模型文本；唯一 oracle 为 oat-sensitivity「Sensitivity acceptance criteria」，以下是摘要，不另作清单）：
  1. `tasks/` 中恰好一个 `type: sensitivity` 的卡，`linked_analyses` 恰好一项；该 plan 的 parameter_sets 与固定 plan 等价（键、倍率、baseline 标志），否则判 INCONCLUSIVE（exit 2，模型偏离）。
  2. 每个 pset 恰好一个 collected 且 succeeded 的 RunJob，`analysis_plan_id`/`parameter_set_id` 对应。
  3. 全部 RunRecord 的 `stack_id` 相同（StackLock 一致门）。
  4. 每个 run 的 `output/ccw.out/ccw.cfg.calib.bak` 中，被扰动键的值在 `%g` 精度下数值等于 `b × m`，其余键在同一精度下数值等于源文件。`.bak` 由 `globalCal::write`（`SHUD/src/classes/ModelConfigure.cpp:376`）以 `%g` 和固定键表写出，所以不做字节比较。
  5. 每个 run 的 numerical_health 中 `water_balance_residual`、`cvode_failures`、`negative_state_count` 均非 null，`max_solver_dt` 为 null，`metrics.json` 的 `status: ok` 且 sha256 匹配。
  6. 脚本独立调用 records 的 `computeRunMetrics` 与 `buildSensitivitySummary`，对保留的 `.dat` 重算，得到的 `metrics.json` 与 `.sensitivity.json` 逐字节相同（可复算门）。
  7. 批外 baseline 的 rivqdown sha256 与批内 baseline 相等，不等即 FAIL（exit 1）。
  8. 报告 accepted、卡 done；`.md` 含汇总表、覆盖声明与"agent 建议值"标注逐字出现，四句不变式逐字出现。
  9. session log 中恰好一次 `approval/asked`（`report_submit`），其 decided 为 `allowed-once`；`analysis_create` 与 `shud_run` 没有审批记录。
  10. coordinator 与 worker 两角色的 header 各至少一个。
  11. `SHUD/input/ccw` 的 md5 清单、根 submodule 修订与 `data/raw` md5 都不变。
- 模型偏离 → exit 2，需重跑，不计回归；判据不成立 → exit 1。登记进 Verification Matrix、constraints 镜像与 instructions 源（经 `instructions:render`），沿用 M3/M4 的登记方式。
- 既有 oracle：在改变 collect / 报告行为的同一切片中，`shud:first-task` 与 `shud:replay` 的 oracle 改为断言新行为。first-task 断言 ccw run 的 numerical_health 三项非 null、§5 渲染指标表、不再有"无指标 artifact"；replay 断言 keliya run 的 residual 为 null 且原因为 `missing_variable`，rivqdown bitwise 判据不变。两者都附本机重跑证据。已消费的证据字节不重写（ADR-0009）。
- 2026-11-07 PI 明确选择提前接受 M5 流程 ADR（[决定记录](https://github.com/DankerMu/SHUD-Harness/issues/674#issuecomment-6707660269)），由 #674 登记为 [ADR-0015](../../../docs/adr/implemented/0015-m5-epic-acceptance.md)：子 PR 经完整工程门与审查可合并，功能仍待 #675 PI Web 亲验。流程 accepted 不等于功能通过；Epic/#422/#675 不提前关闭，change 不提前归档。本决定仅调整验收安排时序，不改本节工程 oracle。

### D15 规范对齐与偏离登记

- 规范对齐在实现组之前完成，作为独立的文档切片：
  - `Minimal_Schemas.md`：§6 AnalysisPlan 改为品牌 id 与最小字段；§5 RunRecord 的 `metrics_summary`；RunJob/RunRecord 的 plan 字段。
  - `SHUD_Output_Variables.md`：§11–§13 写入 D7 公式、D8 来源与"不可观测"声明。
  - `Parameter_Set_And_Analysis_Run_Mapping.md`：M5 不持久化 ParameterSet 状态，不建 batch_policy；pset id 为 `PSET-1..PSET-5`（原 `PSET-001`）；plan 单文件 `analyses/<id>.json`（原 `analysis/PLAN-001/parameter_sets/*.yaml`）；`changes` 键为 calib 白名单键（原 `*_multiplier`）。
  - `Sensitivity_Calibration_Benchmark(_Addendum).md`：M5 落地范围与 Non-Goals。
  - `Scientific_Change_Gating_Spec.md` §1.2：以白名单常量落地，未登记键 fail-closed。
  - `Agent_Architecture.md` §7：sensitivity 谓词措辞，"sensitivity_table artifact 存在"改为"每个成功有效 run 有 metrics"。
  - `Report_Generation_Spec.md`：§2、§5。
  - `Domain_CLI_Spec.md` §2.2：标注 M5 未采用 Rscript CLI。
  - `Phased_Plan.md`：新增 M5 节。
  - `CONTEXT.md`、`project-profile.md`：对象计数改为 10 个导出。
  - glossary：AnalysisPlan、parameter set、有效 run、覆盖声明。
- 偏离登记（不是放宽 baseline）：
  - (1) Domain_CLI_Spec 的 Rscript 生产者 → TS 原生；
  - (2) `max_solver_dt` 不可观测；
  - (3) negative_state_count 只是下界，不做启发式；
  - (4) ParameterSet 状态不持久化，没有 progress artifact；
  - (5) `parameter_space_rationale.confirmed_by` 恒为 null，并伴随强制标注；
  - (6) Gating §1.2 用常量替代 yaml；
  - (7) 汇总表由报告派生，不设独立 `sensitivity_table` artifact 与工具；
  - (8) Mapping 的 id 格式、目录布局与参数键名按上条改写（Stage 3 DC-3）；
  - (9) `SHUD_Output_Variables.md` §12 的 `metrics.yaml` 改为 `metrics.json`，聚合方法写入其中。
  - (10) 负状态检查与水量平衡不含 `lakystage` 与湖泊出流（`SHUD_Output_Variables.md` §11 负状态列表与 §12 储量/输出含湖泊项）：ccw 输入没有湖泊文件，M5 只按 D7/D8 的四个文件与 rSHUD 项计算；接入带湖泊的流域时再扩展。
- #422：正文在 1.1b 改写为"由 M5 change 交付"并链接本 change；Epic 收口时由 PI 关闭。

### Sketch seams under test

- `ShudJobRegistry.submitShud()`（已有，最高层的 jobs seam）：`DT_YE_IC` 的有/无/大小写/注释行、calib 单键重写（0 行与多行拒绝、往返数值、分隔符与行尾保真），以及重写先于 provenance（`files` 中的哈希等于重写后的字节）、失败回滚不留运行目录。沿用 M2–M4 的提交集成测试扩展。
- collect 路径（`ShudJobRegistry` 的自动 collect 与 `shud_collect`，已有）：构造的运行目录（合成 `.dat` 与 stderr）覆盖 ok / unavailable / 写 `metrics.json` 失败 / 非 ok run / 已有 RunRecord 幂等，并断言 `collect-error.json` 不因指标而出现。
- records 纯函数：`readShudDat`（布局校验、截断、NaN、O_NOFOLLOW）、`computeRunMetrics`（D13 rSHUD 夹具 + 积雪/截留手算夹具 + missing_variable + P=0）、`deriveSensitivityClosure` 正反例矩阵、`buildSensitivitySummary` 的确定性（两次调用逐字节相同、Δ 分母为 0）、`checkCalibProducts`（每条白名单越界与键缺失）。
- 模型工具经 `dsh-shud-tools` 既有 strict-tool 装配：`analysis_create` 与带 plan 的 `shud_run` 用真实 ToolRuntime 加构造的工作区行使（防重、卡片状态、plan 与 input_dir 不符、重复 pset、失败后重提）。
- `tools/pre-execute`（raw-guard / policy-gate，已有）：`analyses` 治理根矩阵、`analysis_create` 角色 deny 与无 ask。复用 M4 夹具。
- 报告：`report_generate` → `report_validate` 黄金文件（sensitivity 新增一份；science_assist/code_change 更新）。
- 端到端：`shud:sensitivity` 的真实 Web session log（唯一能证明编排、无额外审批、可复算与重复性的 seam）。

## Risks / Trade-offs

- [`DT_YE_IC` 写入改变所有 run 的副本字节与产物数量] → 只是输出开关（`MD_initialize.cpp:245-246`）；replay 与 first-task 的重跑证据在同一切片中证明 rivqdown bitwise 与首任务链不变；DataProvenance 如实记录重写后的哈希。
- [积雪/截留两项的单位或权重写错，导致 residual 系统性偏差] → O1 在 run-metrics 实现切片之前对照 SHUD 源码核实，并用手算夹具锁定；`metrics.json` 分项输出，供 PI 审阅；rSHUD 对照只证明共有项。
- [ccw 串行重复运行不逐字节相同（O2）] → 验收判据 7 直接判 FAIL，并升级给 PI；不预设通过，也不改为 INCONCLUSIVE。
- [`metrics.json` 写入失败导致原因丢失] → 发生概率等同于 RunRecord 写失败；记录 null，不阻断 collect，并在 collect 回执中写一条可见的错误类别（不含路径以外的内容）。
- [collect 读取全长 268MB 输出增加耗时，可能拖长唤醒] → 流式读取，只读必需变量；90 天窗口是 M5 主路径；全长 run 的成本由 4.2 切片重跑 `shud:restart`（SIGTERM/SIGKILL 两用例都跑全长 ccw，判据不放宽）实测并记录；首任务只跑 30 天，不能代替（Stage 3 SC-4）。
- [`analysis_create` 的防重扫描 `analyses/` 是 closure 之外唯一的目录扫描] → 只用于拒绝，不影响 closure 的链接只读原则；扫描只解析 `task_id`，遇到损坏文件时拒绝并点名，不跳过。
- [收集耗尽后允许重提，而旧作业日后被手动 `shud_collect` 成功，同一 pset 出现两个 succeeded，closure 第 2 条永久不成立] → 触发面窄（需要先耗尽再手动收集）；登记为残余风险，closure 错误点名两个 run_id，由 PI 处置；M5 不加收集上限检查。
- [失败的扰动 run 被放行进入报告，PI 可能误读] → 失败行保留在表中并带 exit_class，每个失败 cell 都有一条确定性 limitation；baseline 失败即拒绝 closure。
- [白名单只有 4 键、区间固定，限制了科研用途] → 这是用户拍板的 M5 最小面；扩大白名单是 Non-Goal，复活条件见上。
- [模型构造的 plan 与验收固定 plan 不一致] → 验收判 INCONCLUSIVE（exit 2）并重跑，不计回归；prompt 中给出固定 plan 文本。

## Migration Plan

1. 规范对齐文档切片（D15）先合并；随后按 PI 明确授权提前完成任务 1.2（#674）的流程 ADR 接受，不再依赖控制面任务 7.2。
2. core schema 与常量（AnalysisPlan、RunJob/RunRecord/TaskCard/EvidenceReport 字段、白名单、阈值、wording），执行 `schema:generate`。旧记录缺键按默认值解析，不改写已有文件。
3. records：dat 读取器、metrics、对照夹具；随后 closure 与报告。
4. jobs：提交重写，以及 collect 内 metrics（同一切片中更新 first-task/replay oracle 并附本机重跑证据）。
5. tools：`analysis_create`、`shud_run` 绑定；guard 与 policy 回归；presets/prompt。
6. `shud:sensitivity` 脚本与控制面登记；PI Web 功能验收，明确通过后才收口 Epic/change，并给已 accepted 的流程 ADR 追加功能证据链接。
- 回滚：每个切片都可以单独 `git revert`。collect 内 metrics 回滚后，新 run 回到 null，已写出的 `metrics.json` 与 RunRecord 字段仍可解析（字段 nullable）。不引入数据迁移。

## Not yet specified

- 全长（1827 天）run 在 collect 内计算 metrics 的实际耗时，以及是否需要对唤醒设上界：待 4.2 重跑 `shud:restart` 实测后再说，M5 主路径是 90 天。

## Open Questions

- O1（事实核查，在 run-metrics 实现切片之前）：`eleysnow` 与 `eleyic` 的单位（m 水当量？）、以及 `.cfg.ic` 的 Canopy/Snow 列是否与输出同一口径。已知线索：`MD_ET.cpp:158` 中 `yEleIS = icStg * vgFrac`，即 `eleyic` 输出已按植被覆盖率折算到元素面积。结论只影响 D7 两个扩展项的系数，不改变公式结构、spec 或任务切分。
- O2（实测）：90 天 ccw 单 run 的耗时，以及 plan `threads: 1`（D4）下重复运行是否逐字节相同。绑定 plan 的副本 `NUM_OPENMP` 已改写为 plan 的 `threads`（DC-1），串行与 OpenMP 构建都以该线程数运行。由验收闸给出答案；不相同即 FAIL 并升级给 PI。

## Issue #646 implementation fixture

Scope: task 2.5 only; no AnalysisPlan schema, product check, metrics writer, report consumer or STORAGE_DEPTH_CONVERSIONS.
Governing invariant: one immutable, source-audited registration and one deterministic decision/text implementation serve every future consumer; no profile or caller can silently change governance facts.
Must preserve: CODE_CHANGE_SECTION5_WORDING, FORBIDDEN_REPORT_PHRASES, GOVERNANCE_INVARIANTS, scanner behavior, semantic-level-floor exports/projection, all existing core records and consumers.
Sibling surfaces: calib registration → schema renderer/self-test → generated Markdown → schema:check; health constants → pure classifier → future #649; wording templates → coverage instantiator → future #657/#658.
Public boundary: core package root exports the constants and pure functions; only minimal export additions outside governance, no private-module consumer imports.
Data design: freeze registration, entries, nested ranges/source arrays; table is the single key-to-file mapping. Transform encoding must remain serializable/projectable and specify real divisors, including RIV_ROUGH /60.
Classification: domain is the three named health metrics and number/null; max_solver_dt is outside the API and fails closed on an untyped call. No new threshold or scientific policy.
Wording: templates1–3 literal per spec; templates4–6 finalized as fact-only strings naming required fields. Coverage instantiation accepts structural psets without depending on the future AnalysisPlan schema and uses JS shortest round-trip number text.
Version: use an existing metrics method-version convention if present; otherwise select stable initial string "1", opaque provenance only, and document choice in PR. No new versioned implementation filenames.
Projection: extend the existing semantic-floor generation path; generated files are never hand-edited. No threshold/wording projections or new generator abstraction.
Evidence: boundary table in tasks.md, immutable registration mutation attempts, exact coverage/wording checks, forbidden-phrase negative controls, built-core smoke and actual schema:check stale-multiplier rejection in an isolated copy.
Review focus: source transforms/ranges, nested immutability, boundary/null/type behavior, pset order/number formatting, existing wording preservation, single-source projection and no downstream scope creep.
Execution: one implementer writes code/tests; parent owns fixture, final gates/smoke, PR and adjudication. Shared M5 change remains unarchived until #675.

## Issue #642 implementation fixture

Governing invariant: a parsed AnalysisPlan represents exactly one immutable OAT declaration, with ordered distinct parameter sets and an exact input-byte identity set derived from the same whitelist used by future execution. No parse can imply PI confirmation.
Scope and ownership: core owns the record, PLAN brand and ParameterSet id schema; schema scripts own projections; the five explicitly allowed source files own present-tense inventory. In project-profile.md update both entry-surface and Contracts counts (currently lines6/16) to 10 and remove the stale claim that AnalysisPlan is not currently exported. Runtime persistence, product checks and consumers remain later slices.
Reuse: extend `schemas/run-identifiers.ts` and its existing generator/registry, preserving all existing prefix patterns and brands; use the existing timestamp/suffix grammar rather than creating a second generator or distinct PLAN grammar. Export a single ParameterSet id schema for #643. Consume CALIB_WHITELIST/CALIB_MULTIPLIER_RANGE and isProjectComponent without narrowing project names.
Parsing: thirteen required fields, strict nested objects, no coercion or new defaults. Enforce the record's absolute input_dir shape without filesystem IO; realpath resolution belongs to analysis_create. Digest keys additionally reject dot and empty segments beyond the existing relative-path predicate. Exact required filename union comes from whitelist table templates with literal project substitution, including replacement-metacharacter project names.
Refinements: validate one empty baseline; exactly one whitelisted finite nonidentity multiplier per perturbation; sequential PSET ids; no duplicate perturbations; exact deduplicated input filename union. Error issues must identify the issue-prescribed field or unknown key. Baseline position is not restricted beyond ordered ids and exactly one baseline.
Projection: register the complete fixed ccw acceptance example; preserve strictness, literals, cardinality, null-only confirmation and branded patterns in Markdown/JSON Schema. Zod-only relational refinements remain documented runtime validation, not a claim that JSON Schema expresses cross-field equality.
Sibling surfaces: all existing branded schemas and createBrandedId callers; schema root exports/type assertions; nine existing schema registry entries, generator completeness checks, CHG/VC/BUILD pattern projections; project-component consumers; whitelist projections; the five count sources plus generated AGENTS/CLAUDE and explicitly excluded historical/v0.8 mentions.
Verification sequence: tests first and parent RED; one implementer then complete schema/exports/projections/count sources; parent generation, focused GREEN, full default gate, built API smoke and isolated actual schema drift negative control. Capture complete count search and independently classify each hit; unresolved TE-10 classification blocks merge.
Containment: no new runtime writes or migrations. A failed contract blocks this atomic PR; revert through normal git history rather than retaining alternate implementations. Do not rewrite a consumed evidence oracle.

## Issue #643 implementation fixture

Invariant: each parsed run has either both plan identifiers or neither; missing pre-M5 fields become null only in the parsed value, never by rewriting persisted inputs. A metrics reference has exactly the run-relative literal metrics.json and a 64-lowercase-hex digest; other artifact fields remain closed.
Reuse AnalysisPlanIdSchema and ParameterSetIdSchema; keep schema defaults before pairing refinements. Pair violations point to parameter_set_id; malformed values point to their owning field. Both-null and both-valid pass in all otherwise-valid run states.
Preserve old build/digest pairing, thread validation, running pid/start identity, exit classification and status checks, artifact path rules, existing numeric health shape and nullable references. A failed record with a well-shaped metrics reference remains schema-valid: failed-run omission belongs to #662 collection, not this schema slice.
Test migration is explicitly PI-authorized: leave M2–M4 raw fixtures unchanged; assert new null fields separately and compare all remaining fields exactly to old expectations. Do not populate old raw fixtures with M5 fields to evade compatibility checks; do not replace exact legacy-value validation with partial matching.
Sibling surfaces: RunJob/RunRecord consumers in jobs schema parsing and typed factories, core schema/type tests, registry examples, four run projection files and generator strict checks. Jobs production edits are limited to null literals if required by inferred output types; any broader runtime change is out of scope and must be reported.
Compiler-established test boundary: records report-workspace-test-harness.ts has two legal legacy artifacts inputs rejected by the helper's Partial<RunRecord> output-type annotation. PI authorized only makeRunRecord's override parameter in task-lifecycle-test-harness.ts to use schema input typing (and necessary type-only import); values, golden reports and production code remain unchanged. Verify all affected callers through full typecheck/tests, not null insertion into old fixtures.
Evidence: staged tests-first RED/GREEN, M2/M3/M4 omissions and input nonmutation, malformed/partial identity matrix for both schemas, strict metrics shapes/path/digest boundaries, old state guards, generated defaults/patterns/closed artifact shape, actual stale-schema drift rejection and built-core parsing smoke. A scratch read-and-parse smoke compares source-file bytes and mtime before/after.
Containment: additive parse compatibility only, no migration or rewrite command. Keep original fixture evidence and generated safety guards; failed acceptance blocks this atomic PR.

## Issue #644 implementation fixture

Invariant: schema recognition is not runtime admission. A sensitivity card can be parsed and reference branded plans, but task_create must still reject that type and closure must still return unsupported_task_type. Old card bytes remain untouched by parsing.
Extend TaskTypeSchema and TaskCardSchema using AnalysisPlanIdSchema. Apply linked_analyses default([]) before the non-sensitivity-empty predicate, with errors at linked_analyses. Retain source_base_commit's existing iff rule and existing non-strict stripping behavior; no new field coercion or unrelated validation.
Source data compatibility: old M3 science_assist and M4 code_change fixtures omit linked_analyses and remain valid, output [] without input mutation. Migrate whole-object expectations only by separately asserting the new default and preserving exact prior-field checks; do not alter old raw fixtures. Explicit [] and missing-key input both pass.
Responsibility boundary: linked_analyses is a schema-validated array, not an ordered set or a unique-plan constraint. Preserve caller order/multiplicity; schema does not add sorting, deduplication or cardinality restrictions. Independently parsed default arrays must not share mutable state.
Type boundary: export TaskCardInput = z.input<typeof TaskCardSchema>; createTaskCard accepts Omit<TaskCardInput, "task_id"> while returning TaskCard. The PI exception changes only type imports/annotations; runtime parsing/publication/collision behavior stays byte-identical. task_create parameters retain the literal science_assist/code_change enum.
Sibling surfaces: TaskTypeSchema/TaskCardSchema root exports; task-card-schema tests and existing type assertions; createTaskCard and its callers; task_create's strict argument boundary and existing tests; closure dispatch and tests; registry examples and TaskCard JSON/Markdown. Existing closure unsupported branch needs no new behavior.
Verification: staged core schema RED/GREEN, consumer fail-closed regression tests (tool rejects before creating task files; closure fails for a parsed sensitivity card), full default gate, generated enum/PLAN pattern/default checks, actual stale-schema drift rejection, and built API/tool/closure smoke with scratch old-card byte/mtime preservation. Preserve other projections.
Keep generator self-test below the existing 1000-line cap; reuse existing generic projection checks plus focused schema projection assertions instead of broadening generation or relaxing the cap. No unrelated generator refactor is planned.
PI-authorized compatibility test amendment: the full gate exposed old expected TaskCard shapes in record-allocation, workspace-records, workspace-readonly and task-create-raw-guard tests. Add only the new [] output expectation while preserving old raw inputs, exact prior fields, readonly byte/mtime checks and temporary-publication rollback assertions. The rename-failure test's temporaryObserved=false is derivative of the earlier stale expectedOutput assertion inside the mock; do not suppress the flag or change production cleanup.

## Issue #645 implementation fixture

Invariant: report analysis references and the summary reference are simultaneously absent or present after defaults; a present summary belongs to this exact report id. Schema checks reference shape, not file existence or actual byte digest.
Reuse AnalysisPlanIdSchema and EvidenceReport's existing hasUniqueEntries pattern; reject duplicate ids without sorting or silently deduplicating. Preserve caller order and independent default arrays.
Use a strict nested path/sha256 object, nullable with default null. Require exactly reports/<this report_id>.sensitivity.json and a 64-lowercase-hex digest, including rejection of trailing newlines. Pair and path errors identify the relevant field. Document relational validation without claiming JSON Schema expresses cross-field equality.
Preserve all old report and PiGateDecision validation, unknown-key rejection, statuses, repeated linked_runs policy and old reference defaults. Missing new keys in old M3/M4 inputs remain valid; raw inputs and persisted bytes/mtime are unchanged.
Sibling surfaces: core schema/type exports and existing report tests, schema registry/generator, records createEvidenceReport input contract and its callers, report_generate writer, render/validate/closure regressions and golden reports. Only explicitly allowed writer literals may change production consumers; report_generate remains behaviorally pre-sensitivity.
Test compatibility follows the existing PI batch authorization: retain raw legacy fixtures and exact old-field checks, separately assert analysis_ids:[] and sensitivity_summary:null. Do not rewrite golden reports or change rendering/validation/closure semantics.
Evidence: tests-first RED/GREEN, every acceptance rejection and omitted/explicit empty/null combinations, built-core file-read parsing smoke, generator projection checks, actual isolated schema:check clean/stale/restored control and full default gate. Publish exact commands, complete smoke inputs, outputs and isolated drift setup/mutation/restoration before review.
Containment: no migration/backfill, summary writer, PLAN citation resolver, report generation binding or filesystem hash verification. Failure blocks the atomic slice; the shared M5 fixture remains open for later issues.

## Issue #647 implementation fixture

Goal/invariant: one records public reader and pure parser serve future metrics, product checks and acceptance scripts. Each successful result binds parsed data, sha256 and size_bytes to one complete read of a verified regular-file descriptor; no input bytes are modified and no partial parse escapes on failure.
Existing implementation: compare-rivqdown.ts owns open/fstat/dev+ino/single-close phase handling; hash-descriptor.ts owns the bounded 64KiB hashing loop; report-validate.ts:184-256 supplies ancestor inspection/recheck precedent. Extract the comparator scaffold internally and migrate that caller in the same commit; preserve its both-target preflight, sequential descriptors, exact flags, physical alias semantics and controlled cleanup diagnostics. Do not add a parallel open implementation or change unrelated verifyBuildBinary/report-validation contracts.
New boundary: readShudTextInput(baseDir, relativePath, kind) and parseShudTextInput(bytes, relativePath, kind), exported from records with typed results for the eight kinds. Tables preserve column names and numeric rows in file order; cfg entries preserve every effective line with its case-normalized key, value and source line number. The safe reader adds path, sha256 and observed size_bytes. Pure parsing never performs IO or applies calib factors, units, index rebasing, sorting, deduplication or cross-file scientific checks.
Paths: validate absolute base and relative POSIX input before content IO; normalize only the relative request and reject escape above its base. Resolve caller-owned base physically rather than lexically collapsing an alias/.. base. Inspect base and relative ancestors as real directories and reject linked ancestors/final targets; bind opened file to preflight dev/ino and recheck observed directory/file identity around reading. Reject missing, unsafe and IO failures with distinct controlled classifications. Never expose native error causes or input payload; diagnostics may name validated file, controlled section/column and line.
Threat boundary: preserve the repository's descriptor-bound observational model (report-validate.ts:189), not an atomic filesystem snapshot. O_NOFOLLOW protects the final component; ancestor checks detect observed replacements. No claim is made to defeat an adversarial ancestor swap-and-restore between all observations or same-inode concurrent writes. These limits must be stated with evidence, not described as an escape-proof kernel sandbox; no raw-directory discovery or access is added.
Resources: hash and retain text bytes in one descriptor pass; size_bytes is the actual parsed byte length, not an unrelated stat observation. Preserve bounded streaming for comparator-only hashing. No new arbitrary file-size cap, new dependency or subprocess reader. One close attempt per owned descriptor; close failure cannot return success, and cleanup errors must not disclose native payloads.
Table grammar: dimensions include the index column; whitespace means spaces/tabs, not tab-only splitting. Verify declared column count against header and every row, declared row count against consumed data, required registered columns, and numeric parsing; reject extra/unrecognized trailing data instead of discarding it. Required sections: mesh elements/nodes (8/5 cols), att (9), river reaches/types (6/9), geol (8), landcover (7 or8), IC elements/rivers (6/2). Required named values include Node1/2/3, X/Y, GEOL, Down/Type/Length, Width/Manning, KsatH(m_d)/KsatV(m_d)/ThetaS(m3_m3), ROUGH/VEGFRAC and IC state columns.
Optional sections: river geometry From.x/From.y/From.z/To.x/To.y/To.z (6 cols) and IC lakes Index/LakeStage (2 cols) are parsed when present; their own declarations must match. IC's optional third dimension-header value is simulation time in minutes, not a column or datum. Evidence: ccw.sp.riv:112-216; MD_readin.cpp:180-189; MD_update.cpp:235,250-252; heihe.cfg.ic:1; qhh.cfg.ic:6411-6413. Preserve LC INDEX=0 and negative slopes; do not impose index/range/domain rules absent from this parsing contract.
Config grammar: inspect first byte before trimming; skip #, space, LF-empty and NUL-leading lines; accept tab-leading key/value lines. Keys are case-insensitive; retain duplicates and order. Parse numeric values without copying C's uninitialized/stale-value bugs or guessing missing values; malformed values produce controlled errors. Preserve byte-oriented comments as in shud-end.ts; do not require comments to be valid UTF-8 or implement an allowlist/last-wins merge. Strict numeric/data-shape rejection is required by #647 even where the solver silently tolerates malformed input.
Numeric lexical contract (tables and cfg values): consume a complete whitespace-delimited numeric token, accepting signed decimal/scientific forms, C hexadecimal significands with optional binary p exponent, and case-insensitive inf/infinity/nan (including C-style nan payload). Preserve signed zero and return nonfinite numeric values; finiteness/range policy stays with metrics/product consumers. Reject partial tokens such as 93abc, malformed exponents, bad and missing values rather than accepting a numeric prefix or stale value. Config content after the complete value token remains ignored as by sscanf; it is not an additional parameter. Dimension counts remain finite nonnegative safe integers (and the format's required positive column count); optional IC time is parsed as a numeric value, not a count.
Conversion evidence: decimal/scientific forms must use whole-token conversion, never parseFloat prefix acceptance. Hex conversion must preserve double rounding, overflow/underflow and signed zero, including subnormal and long-significand cases; no locale-dependent or external-process parser. Source accepts these numeric forms (strtold/%lf and shud-end.ts:13); full-token rejection fulfills #647's explicit malformed-value refusal without imposing a new scientific finiteness policy.
Dimension lexical boundary follows TabularData.cpp:32's %d rather than data-cell %lf/strtold: each count token is a complete signed decimal integer, then checked for nonnegative safe-integer value and required width. Integral floating/scientific/hex spellings (1.0, 1e0, 0x1) are not count tokens; optional IC time continues to accept the general numeric grammar. Parent's actual libc/built-parser comparison established this distinction before merge; regressions cover row and column declarations.
Compatibility evidence: read eight real ccw files directly from the initialized read-only pinned submodule, rather than maintaining duplicate large fixture copies. Record before/after hashes and use independent digest/length assertions. Synthetic scratch fixtures cover safety and malformed grammar; no test writes to the submodule. Cross-file IC versus mesh/river count mismatch remains a later metrics decision, distinct from malformed declared-versus-actual table shape.
Sequence: tests-only implementation and parent RED; one implementer then extraction/read/parsers/exports; parent focused GREEN, old comparator/build-binary/artifact regressions, actual built records API smoke on ccw and unsafe scratch inputs, strict OpenSpec and full default gate. Public evidence includes exact invocation, complete synthetic inputs, raw-source hashes and results. Revert the atomic slice on failure; retain no old parallel implementation. Shared M5 change remains unarchived.
