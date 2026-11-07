# Spec Delta

## Purpose

定义 AnalysisPlan（M5 最小 OAT 敏感性分析的不可变参数计划）的品牌 id、字段与 refine、calib 白名单与类别表乘积校验、`analyses/<analysis_plan_id>.json` 工作区持久化，以及 coordinator 工具 `analysis_create` 的校验顺序、一卡一 plan 与 TaskCard `linked_analyses` 回写契约，使批量运行的参数覆盖值只能来自经确定性校验的计划，而不是模型自由传入的数值。

## ADDED Requirements

### Requirement: Analysis plan identifier
`analysis_plan_id` SHALL 为品牌类型 `AnalysisPlanId`，格式 `PLAN-YYYYMMDDTHHMMSS-xxxx`：时间为 UTC、精确到秒，`xxxx` 为 4 位小写十六进制随机数，与其它工作区 id（`TASK-`、`RUN-`、`CHG-`、`VC-`、`BUILD-` 等）使用同一生成与校验规则，随机段与所属 `task_id` 各自独立生成。schema SHALL 拒绝不符合该格式的 id，包括 `docs/03_SPEC/Minimal_Schemas.md` 原文的 `PLAN-NNNN` 形式、大写十六进制与任意其它前缀。

#### Scenario: branded plan id accepted
- **WHEN** 在 UTC 2026-11-08 09:30:00 创建一个 AnalysisPlan
- **THEN** 其 `analysis_plan_id` 形如 `PLAN-20261108T093000-5c1e`

#### Scenario: malformed plan id rejected
- **WHEN** 以 `analysis_plan_id: "PLAN-0001"`、`"PLAN-20261108T093000-5C1E"`（大写十六进制）或 `"TASK-20261108T093000-5c1e"` 解析 AnalysisPlan
- **THEN** schema 解析失败并指出 `analysis_plan_id`

### Requirement: AnalysisPlan record
`AnalysisPlanSchema` SHALL 为 core 导出的严格对象（未知键即拒），恰含：`analysis_plan_id`（`AnalysisPlanId`）、`task_id`（`TaskId`）、`mode`（字面量 `sensitivity`）、`strategy`（字面量 `one_at_a_time`）、`input_dir`（`analysis_create` 时取 realpath 的绝对路径）、`project`（SHUD 项目名，规则同 `shud_run` 的 `project`）、`end_days`（正整数）、`threads`（正整数，必填；绑定该 plan 的每次 `shud_run` 以此线程数执行，见 shud-run-tools「shud_run arguments」）、`parameter_sets`、`parameter_space_rationale`、`input_digests`（必填，见下文）、`created_by`（非空字符串）、`created_at`（ISO 8601 UTC）。`input_digests` SHALL 为严格对象，键为相对 `input_dir` 的 POSIX 相对路径（非绝对、不含 `..`、`.` 或空段），值为该文件内容的 sha256（64 位小写十六进制）；它记录 `analysis_create` 做乘积校验时读到的输入字节，供绑定该 plan 的 `shud_run` 核对运行副本（见 shud-run-jobs「Shud job submission」的「输入摘要核对」）。`parameter_sets` SHALL 为 3–5 项的数组，每项为严格对象 `{parameter_set_id, label, baseline, changes}`：`parameter_set_id` 为 `PSET-1` 至 `PSET-5` 之一，`label` 为非空字符串或 `null`，`baseline` 为布尔值，`changes` 为以 calib 白名单键（见「Calib whitelist and category product check」）为键、倍率为值的对象。`parameter_space_rationale` SHALL 为严格对象 `{proposed_by, basis, confirmed_by}`，`proposed_by` 为字面量 `agent`，`basis` 为非空字符串，`confirmed_by` 为字面量 `null`（M5 没有 plan 确认路径）。

schema SHALL 含以下 refine，任一不成立即解析失败并指出 `parameter_sets`：(1) 恰好一个 pset 的 `baseline` 为 `true`，且其 `changes` 为 `{}`；(2) 每个非 baseline pset 的 `changes` 恰好一个键；(3) `parameter_set_id` 按数组出现顺序依次为 `PSET-1..PSET-n`；(4) 不存在两个 `changes` 完全相同的 pset；(5) 每个倍率为有限数、位于白名单统一倍率区间 [0.5, 2.0] 内且不等于 1.0（与 baseline 相同的扰动没有信息量）；(6) `changes` 的键 SHALL 属于白名单，白名单外的键（含加数 `+` 后缀键、`GEOL_THETAS`、`GEOL_THETAR`、`SOIL_BETA`）一律拒绝。另有一条 refine，不成立即解析失败并指出 `input_digests`：(7) `input_digests` 的键集合 SHALL 恰为 `<project>.cfg.calib` 与 plan 各 pset `changes` 所用键的白名单类别表文件名之并（`GEOL_KSATH`、`GEOL_KSATV` 对应 `<project>.para.geol`，`LC_ROUGH` 对应 `<project>.para.lc`，`RIV_ROUGH` 对应 `<project>.sp.riv`；同一文件只出现一次），不多不少。ParameterSet 的运行状态 SHALL NOT 持久化在 AnalysisPlan 中：pset 与 run 的关联只记录在 RunJob/RunRecord 的 `analysis_plan_id` 与 `parameter_set_id` 上（见 run-records），状态由它们派生。

#### Scenario: acceptance plan parses
- **WHEN** 解析一个 `parameter_sets` 依次为 `PSET-1`（`baseline: true`，`changes: {}`）、`PSET-2`（`{GEOL_KSATH: 0.5}`）、`PSET-3`（`{GEOL_KSATH: 2}`）、`PSET-4`（`{LC_ROUGH: 2}`），`end_days: 90`，`parameter_space_rationale` 为 `{proposed_by: "agent", basis: "单键 OAT", confirmed_by: null}`，`input_digests` 恰含 `ccw.cfg.calib`、`ccw.para.geol`、`ccw.para.lc` 三个键（值均为 64 位小写十六进制）的 AnalysisPlan
- **THEN** 解析成功

#### Scenario: baseline count enforced
- **WHEN** 解析没有 `baseline: true` 的 pset、有两个 `baseline: true` 的 pset，或 baseline pset 的 `changes` 为 `{GEOL_KSATH: 0.5}` 的 AnalysisPlan
- **THEN** 解析失败并指出 `parameter_sets`

#### Scenario: one key per perturbed set
- **WHEN** 解析某个非 baseline pset 的 `changes` 为 `{}` 或 `{GEOL_KSATH: 0.5, LC_ROUGH: 2}` 的 AnalysisPlan
- **THEN** 解析失败并指出 `parameter_sets`

#### Scenario: set count and order enforced
- **WHEN** 解析 `parameter_sets` 为 2 项或 6 项，或 id 顺序为 `PSET-1`、`PSET-3`、`PSET-2`，或含 `PSET-6` 的 AnalysisPlan
- **THEN** 解析失败并指出 `parameter_sets`

#### Scenario: duplicate perturbation rejected
- **WHEN** 解析两个非 baseline pset 的 `changes` 均为 `{GEOL_KSATH: 2}` 的 AnalysisPlan
- **THEN** 解析失败并指出 `parameter_sets`

#### Scenario: multiplier bounds enforced
- **WHEN** 解析某个非 baseline pset 的倍率为 `0.49`、`2.01`、`1`、`NaN` 或 `Infinity` 的 AnalysisPlan
- **THEN** 解析失败并指出 `parameter_sets`

#### Scenario: non-whitelisted key rejected
- **WHEN** 解析某个非 baseline pset 的 `changes` 为 `{GEOL_THETAS: 0.8}`、`{TS_SFCTMP+: 1}` 或 `{geol_ksath: 0.5}`（非白名单拼写）的 AnalysisPlan
- **THEN** 解析失败并指出 `parameter_sets`

#### Scenario: rationale fixed to agent and unconfirmed
- **WHEN** 解析 `parameter_space_rationale.proposed_by: "pi"`、`confirmed_by: "pi"` 或 `basis: ""` 的 AnalysisPlan
- **THEN** 解析失败并指出 `parameter_space_rationale`

#### Scenario: input digest key set enforced
- **WHEN** 解析 `project: "ccw"`、扰动键只有 `GEOL_KSATH` 的 AnalysisPlan，而 `input_digests` 缺少 `ccw.cfg.calib`、多出 `ccw.para.lc`、含键 `../ccw.para.geol` 或 `/abs/ccw.para.geol`，或某个值为大写十六进制或长度不是 64
- **THEN** 解析失败并指出 `input_digests`

#### Scenario: unknown field rejected
- **WHEN** 解析含 `status: "running"` 或 `parameter_sets[0].run_id` 的 AnalysisPlan
- **THEN** 解析失败并指出该未知键

### Requirement: Calib whitelist and category product check
core SHALL 导出 calib 白名单常量（仓库内常量，没有运行时覆写），恰含四个键，每个条目登记其类别表、列、读入变换、SHUD 范围检查区间（或 `null`）与 SHUD 源码出处：`GEOL_KSATH`（`<project>.para.geol` 的 `KsatH(m_d)` 列，读入时除以 1440，SHUD 检查 [0, 1e3]）、`GEOL_KSATV`（`<project>.para.geol` 的 `KsatV(m_d)` 列，读入时除以 1440，[0, 1e3]）、`LC_ROUGH`（`<project>.para.lc` 的 `ROUGH` 列，读入时除以 60，检查 [0, 1]）、`RIV_ROUGH`（`<project>.sp.riv` 河道类型表的 `Manning` 列，SHUD 不做范围检查）。四键的统一倍率区间 SHALL 为 [0.5, 2.0]。白名单外的键 SHALL fail-closed 拒绝，不新增键、不接受加数键。

乘积校验 SHALL 在 `analysis_create` 写入任何文件之前执行，只读：对 plan 中每个扰动键，从 `input_dir` 的 `<project>.cfg.calib` 取该键的 baseline 值 `b`——按 SHUD 的解析规则逐行匹配（首字节为 `#`、空格、换行或 NUL 的行跳过，键大小写不敏感），恰好一个有效行且值为有限数时才成立；0 个或多于 1 个有效行、值不可解析时 SHALL 拒绝并点名该键（SHUD 对未知键会退出，harness 也不新增键）。随后对该键类别表的每一行原值 `x`，按 SHUD 施加顺序计算 `read_transform(x) × b × m`：有 SHUD 范围区间的键，任一行越出区间即拒绝；`RIV_ROUGH` 要求每一行乘积为有限正数。拒绝结果 SHALL 点名键、行 index、乘积值与区间。类别表缺失、不是普通文件、缺少登记列或该列值不可解析时 SHALL 拒绝并指出该文件。乘积校验对 `<project>.cfg.calib` 与每个涉及的类别表各只读取一次（安全读：以 `lstat`/`fstat` 确认为普通文件，符号链接与特殊文件 fail-closed），并 SHALL 在同一次读取中对同一批字节计算 sha256，作为 plan `input_digests` 中该文件的值；SHALL NOT 为计算摘要另行二次读取。

#### Scenario: products within SHUD bounds pass
- **WHEN** 以 `SHUD/input/ccw` 的副本为 `input_dir`，plan 含 `GEOL_KSATH` 倍率 2 与 `LC_ROUGH` 倍率 2（ccw `.cfg.calib` 中两键 baseline 均为 1）
- **THEN** 乘积校验通过：`.para.geol` 每行 `KsatH / 1440 × 1 × 2` 不超过 1e3，`.para.lc` 每行 `ROUGH / 60 × 1 × 2` 不超过 1

#### Scenario: product outside a SHUD range rejected
- **WHEN** `input_dir` 的 `.cfg.calib` 中 `LC_ROUGH` 为 `40`，plan 含 `LC_ROUGH` 倍率 2，使某行 `ROUGH / 60 × 40 × 2` 大于 1
- **THEN** 校验拒绝，错误含 `LC_ROUGH`、越界行的 index、乘积值与区间 [0, 1]，不写 `analyses/` 或卡片

#### Scenario: key absent from cfg.calib rejected
- **WHEN** `input_dir` 的 `.cfg.calib` 没有 `RIV_ROUGH` 的有效行（或该行以 `#` 开头），plan 含 `RIV_ROUGH` 倍率 0.5
- **THEN** 校验拒绝并点名 `RIV_ROUGH`，输入文件字节不变

#### Scenario: duplicated calib key rejected
- **WHEN** `input_dir` 的 `.cfg.calib` 含两行有效的 `GEOL_KSATV`（大小写不同亦然），plan 含 `GEOL_KSATV`
- **THEN** 校验拒绝并点名 `GEOL_KSATV`

#### Scenario: river roughness requires a finite positive product
- **WHEN** 河道类型表某行 `Manning` 为 `0`，plan 含 `RIV_ROUGH` 倍率 2
- **THEN** 校验拒绝并点名 `RIV_ROUGH`、该行 index 与乘积 `0`

### Requirement: AnalysisPlan workspace file
AnalysisPlan SHALL 持久化为会话 cwd 下的 `analyses/<analysis_plan_id>.json`，SHALL NOT 经 `ctx.storage` 或 stateDir 索引；查找 SHALL 只按经 `AnalysisPlanId` 品牌校验的 id 直接定位该文件，读取 SHALL 经 core `AnalysisPlanSchema` 校验，文件缺失、不可解析、校验失败或文件内 id 与请求 id 不一致时 SHALL 返回说明原因的错误，SHALL NOT 改写该文件。路径安全 SHALL 遵循 task-cards「TaskCard workspace file」的工作区文件安全规则，`AnalysisPlanId` 与 `analyses` 目录分别加入该规则的品牌 id 与对象目录集合：id 在任何路径拼接之前经品牌校验；`analyses/` 不存在时以 `mkdir -p` 创建，已存在而不是真实目录（符号链接、普通文件、特殊文件）时 fail-closed；目标文件在读写前 `lstat`，符号链接与特殊文件 fail-closed。首次落盘 SHALL 以排他创建占有 id（同目录临时文件写完后以不覆盖目标的方式发布，目标已存在即 EEXIST）；EEXIST 时 SHALL 重新分配 id 并重试，同一次调用至多重新分配 3 次，仍冲突即返回指出 id 冲突的错误且不写入。AnalysisPlan 创建后不可变：任何工具（含 `analysis_create` 自身的后续调用、`shud_run`、`report_generate`）SHALL NOT 改写、截断、替换或删除已存在的 `analyses/<analysis_plan_id>.json`。

#### Scenario: plan written exclusively and atomically
- **WHEN** `analysis_create` 成功返回 `analysis_plan_id`
- **THEN** 会话 cwd 下存在 `analyses/<analysis_plan_id>.json`，内容通过 `AnalysisPlanSchema` 校验，`analyses/` 不残留临时文件

#### Scenario: id collision reallocates without overwriting
- **WHEN** `analysis_create` 新分配的 id 对应的 `analyses/<analysis_plan_id>.json` 已存在
- **THEN** 工具重新分配 id 后写入新 plan，已有文件的字节与修改时间不变；连续 4 次分配均冲突时返回指出 id 冲突的错误，`analyses/` 与卡片不新增或改写文件

#### Scenario: symlinked analyses directory fails closed
- **WHEN** 会话 cwd 下的 `analyses` 是指向其它目录的符号链接时调用合法的 `analysis_create`
- **THEN** 工具返回指出 `analyses` 的错误，链接目标内不新增文件，卡片字节不变

#### Scenario: malformed plan id never reaches the file system
- **WHEN** 以 `analysis_plan_id: "../tasks/x"` 或 `"PLAN-0001"` 作为 `shud_run` 参数或卡片链接值读取 plan
- **THEN** 返回指出 `analysis_plan_id` 的错误，没有任何以该字符串拼接的路径被 `lstat`、读取或创建

#### Scenario: plan file is never rewritten
- **WHEN** 一个 plan 已被多个 `shud_run` 绑定提交并被 `report_generate` 读取
- **THEN** `analyses/<analysis_plan_id>.json` 的字节与修改时间与创建时相同

### Requirement: analysis_create
`analysis_create` SHALL 为 coordinator 专用的模型工具（角色面见 policy-gate「Role tool surface rule」），参数为严格对象（未知键或错误根类型即拒）：`task_id`（必填，`TaskId`）、`input_dir`（必填，相对路径按会话 cwd 解析）、`project`（可选，缺省为 `input_dir` 解析后目录的末级名，规则同 `shud_run`）、`end_days`（必填，正整数）、`threads`（可选，正整数，省略时写入 plan 的值为 `1`）、`parameter_sets`（必填，数组，元素为严格对象 `{label?, baseline, changes}`，`parameter_set_id` 由工具按数组顺序分配为 `PSET-1..PSET-n`，`label` 缺省为 `null`）、`rationale_basis`（必填，非空字符串）。调用 SHALL 提供有效会话 cwd，缺少 agent、session 或非空 cwd 时 SHALL 在访问文件系统前返回指出工作区缺失的错误，SHALL NOT 回退宿主进程目录。

执行顺序 SHALL 为：(1) 校验参数形状与 `task_id` 品牌，失败即返回指出该参数的错误，不访问文件系统；(2) 在同步读取边界内读取并校验 `tasks/<task_id>/task.json`（task-cards「TaskCard workspace file」），要求文件内 id 与请求一致、`type` 为 `sensitivity`、`status` 为 `planned` 或 `running`、`linked_analyses` 为空；并扫描会话 cwd 下的 `analyses/`（不存在视为空），找出 `task_id` 等于本卡的 plan——扫描只为防重与孤立 plan 修复：每个名为 `<AnalysisPlanId>.json` 的条目 SHALL 为普通文件且其 JSON 中的 `task_id` 可读，否则 SHALL 拒绝并点名该条目，SHALL NOT 跳过；属于本卡的 plan 多于一个时 SHALL 拒绝并点名它们；恰有一个时它是孤立 plan（卡片 `linked_analyses` 为空），SHALL 经 `AnalysisPlanSchema` 校验（失败即拒绝并点名），并在第 (3) 步解析 `input_dir` 的 realpath 后按下文「孤立 plan 修复」处理；(3) 解析 `input_dir` 的 realpath，确认其为目录，且 `<project>.cfg.para`、`<project>.cfg.calib` 与 plan 涉及键的类别表均为普通文件；(4) 执行「Calib whitelist and category product check」；(5) 组装 plan（`proposed_by` 固定为 `agent`，`confirmed_by` 固定为 `null`，`basis` 取 `rationale_basis`，`input_dir` 为第 (3) 步的 realpath，`input_digests` 为第 (4) 步同一次读取计算的摘要，`created_by` 经 policy-gate「Caller role derivation」同一 `readCallerPresetId` 取得当前 preset 投影的非空原值、缺失为 `unknown`），经 `AnalysisPlanSchema` 校验；(6) 按「AnalysisPlan workspace file」排他写入 `analyses/<analysis_plan_id>.json`；(7) 以同步读取—校验—写入边界（读与写之间不 await）重新读取卡片，确认身份、`type`、可运行状态与 `linked_analyses` 仍为空后原子回写：`linked_analyses` 为 `[analysis_plan_id]`、刷新 `updated_at`，`status`、`runtime_phase` 与其它字段不变。第 (1)–(5) 步任一失败 SHALL 返回指出失败检查项的错误，SHALL NOT 写入 `analyses/` 或卡片。第 (6) 步成功而第 (7) 步失败（含卡片在第 (2) 与第 (7) 步之间已离开可运行状态或已有链接）时 SHALL 返回含本次 `analysis_plan_id` 与"plan 已落盘、任务卡回写失败"的错误，已写入的 plan SHALL 保留、SHALL NOT 回滚；此后对该卡再次调用 `analysis_create` 按「孤立 plan 修复」处理，系统不提供其它自动补链路径。

孤立 plan 修复：第 (2) 步找到本卡的孤立 plan 时，若本次参数与它等价——`realpath(input_dir)` 等于其 `input_dir`，`project`（调用值或缺省值）、`end_days`、`threads`（调用值，省略时为 `1`）与 `parameter_space_rationale.basis`（取自 `rationale_basis`）相等，且 `parameter_sets` 按数组顺序逐项的 `baseline` 与 `changes`（键与倍率）相同，且以与第 (4) 步相同的安全读只读计算的当前 `input_digests`（同一文件集合，每个文件读取一次）与孤立 plan 的 `input_digests` 逐项相等——SHALL NOT 新建 plan、SHALL NOT 改写该 plan 文件，跳过第 (4)–(6) 步（摘要计算之外不做乘积校验），只执行第 (7) 步的卡片回写，成功后返回该 plan 的 `analysis_plan_id` 与 pset 列表；回写再次失败时返回含该 id 与"plan 已落盘、任务卡回写失败"的错误。不等价时 SHALL 拒绝并点名该孤立 plan 的 `analysis_plan_id`，不写入 `analyses/` 或卡片。

一张 sensitivity 卡 SHALL 恰好对应一个 plan：卡片 `linked_analyses` 已非空（已链接 plan）时 SHALL 拒绝；`analyses/` 中已有属于本卡的未链接 plan 时只按「孤立 plan 修复」修复链接或拒绝，SHALL NOT 新建第二个 plan；系统不提供 plan 修订或作废。防重扫描是 `analysis_create` 唯一的目录扫描，closure 与报告 SHALL NOT 依赖它（只经卡片链接读取 plan）。成功结果 SHALL 返回 `analysis_plan_id` 以及各 pset 的 `parameter_set_id`、`label`、`baseline` 与 `changes`。`analysis_create` SHALL NOT 调用 LLM，SHALL NOT 发起审批（见 policy-gate「Sensitivity tools do not ask」），SHALL NOT 写入 `input_dir`、`runs/`、`stacks/`、`provenance/` 或 `reports/`。

#### Scenario: create the acceptance plan
- **WHEN** coordinator 对一张 `type: sensitivity`、`status: planned`、`linked_analyses: []` 的卡调用 `analysis_create`，`input_dir` 为工作区 `input/ccw`，`end_days: 90`，`parameter_sets` 为 baseline、`{GEOL_KSATH: 0.5}`、`{GEOL_KSATH: 2}`、`{LC_ROUGH: 2}`，`rationale_basis` 非空
- **THEN** 结果含 `PLAN-…` 格式的 `analysis_plan_id` 与 `PSET-1..PSET-4`；`analyses/<analysis_plan_id>.json` 的 `threads` 为 `1`（调用未传 `threads`）、`input_dir` 为 `input/ccw` 的 realpath、`project` 为 `ccw`、`created_by` 为 `coordinator`、`parameter_space_rationale.confirmed_by` 为 `null`，`input_digests` 恰含 `ccw.cfg.calib`、`ccw.para.geol`、`ccw.para.lc`，各值等于 `input/ccw` 下对应文件的 sha256；卡片 `linked_analyses` 为 `[analysis_plan_id]`、`updated_at` 刷新、`status` 仍为 `planned`；`input/ccw` 下文件字节不变

#### Scenario: non-sensitivity or non-runnable card rejected
- **WHEN** 以 `type: science_assist` 的卡、`status: reporting` 的 sensitivity 卡或不存在的 `task_id` 调用 `analysis_create`
- **THEN** 工具返回指出卡片类型、状态或缺失的错误，`analyses/` 不新增文件，卡片字节不变

#### Scenario: second plan for the same card rejected
- **WHEN** 卡片 `linked_analyses` 已含一个 plan id 时再次调用 `analysis_create`
- **THEN** 工具返回指出该卡已有 plan 的错误，`analyses/` 不新增文件

#### Scenario: same-argument retry repairs the orphan link
- **WHEN** 一次 `analysis_create` 已写入 `analyses/<analysis_plan_id>.json` 而回写卡片失败，工具返回含该 id 与"plan 已落盘、任务卡回写失败"的错误；随后以同一 `task_id` 与等价参数（`input_dir`、`project`、`end_days`、`parameter_sets` 的 baseline/键/倍率及顺序、`rationale_basis` 均相同，`input_dir` 下 `.cfg.calib` 与类别表字节未变）再次调用
- **THEN** 第二次调用成功并返回同一 `analysis_plan_id`；卡片 `linked_analyses` 为 `[analysis_plan_id]`、`updated_at` 刷新；该 plan 文件字节与修改时间不变，`analyses/` 的文件数与第一次调用后相同

#### Scenario: different-argument retry against an orphan rejected
- **WHEN** 同样存在本卡的孤立 plan（`threads: 1`），再次调用时 `parameter_sets` 中某个倍率不同（如 `GEOL_KSATH` 由 2 改为 1.5）、顺序不同，`end_days` 不同，传入 `threads: 2`，或参数全部等价而 `input_dir` 下 `ccw.cfg.calib` 在孤立 plan 写入后被改动（当前摘要与其 `input_digests` 不等）
- **THEN** 工具返回点名该孤立 plan `analysis_plan_id` 的错误，`analyses/` 不新增文件，plan 与卡片字节不变，`linked_analyses` 仍为空

#### Scenario: multiple orphan plans rejected
- **WHEN** `analyses/` 中有两个 `task_id` 等于本卡的 plan，卡片 `linked_analyses` 为空时调用 `analysis_create`
- **THEN** 工具返回点名这两个 plan id 的错误，不写入 `analyses/` 或卡片

#### Scenario: corrupt plan file blocks creation
- **WHEN** `analyses/` 中有一个名为 `<AnalysisPlanId>.json` 但内容不是合法 JSON 的文件，或该名字是符号链接，时调用合法的 `analysis_create`
- **THEN** 工具返回点名该条目的错误，不跳过，不写入新 plan，该条目字节不变

#### Scenario: invalid plan content rejected before any write
- **WHEN** `analysis_create` 的 `parameter_sets` 含两个 baseline、一个双键扰动、倍率 `2.5` 或白名单外键 `SOIL_BETA`
- **THEN** 工具返回指出 `parameter_sets` 的错误，`analyses/` 与卡片不新增或改写，`input_dir` 下文件字节不变

#### Scenario: explicit plan threads recorded
- **WHEN** 以合法参数与 `threads: 2` 调用 `analysis_create`；另一次传入 `threads: 0`、`1.5` 或 `"1"`
- **THEN** 前者写入的 plan `threads` 为 `2`；后者返回指出 `threads` 的错误，不访问文件系统

#### Scenario: plan without threads rejected
- **WHEN** 解析不含 `threads` 键或 `threads: 0` 的 AnalysisPlan
- **THEN** schema 解析失败并指出 `threads`

#### Scenario: model cannot supply plan-owned fields
- **WHEN** 模型调用 `analysis_create` 并传入 `confirmed_by: "pi"`、`proposed_by: "pi"`、`parameter_set_id`、`analysis_plan_id` 或 `input_digests`
- **THEN** 工具返回指出该未知键的错误，不访问文件系统

#### Scenario: missing input files rejected
- **WHEN** `input_dir` 不存在、不是目录，或缺少 `<project>.cfg.calib` 或 plan 涉及键的类别表
- **THEN** 工具返回指出缺失文件的错误，`analyses/` 与卡片不新增或改写

### Requirement: AnalysisPlan generated projection
`AnalysisPlanSchema` 与 calib 白名单常量 SHALL 位于 `packages/dsh-shud-core/src/`（schema 在 `schemas/`，白名单在 `governance/`），SHALL 登记进 schema 生成注册表，经 `pnpm run schema:generate` 投影到 `docs/generated/`；`pnpm run schema:check` SHALL 在投影与 Zod 不一致时失败。AnalysisPlan 是第 10 个导出的核心记录 schema。`docs/03_SPEC/Minimal_Schemas.md` §6 SHALL 与本 spec 一致，并写明处置：id 格式由 `PLAN-NNNN` 改为品牌格式；字段收敛为本 spec 的最小集；ParameterSet 状态不持久化；`parameter_space_rationale.confirmed_by` 在 M5 恒为 `null`。

#### Scenario: projection drift blocks
- **WHEN** 修改 `AnalysisPlanSchema` 字段或白名单倍率区间而不重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出并指出 `docs/generated/` 差异

#### Scenario: projection regenerated
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下出现 AnalysisPlan 的 Markdown 与 JSON Schema 投影，`analysis_plan_id` 的模式拒绝 `PLAN-0001`，`mode` 与 `strategy` 为字面量，`parameter_sets` 的项数为 3–5，`confirmed_by` 只允许 `null`
