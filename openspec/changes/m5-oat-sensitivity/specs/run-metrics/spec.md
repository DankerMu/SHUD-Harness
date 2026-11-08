# Spec Delta

## Purpose

定义 SHUD 二进制 `.dat` 输出的读取契约、逐 run 指标（出口峰值、峰现日、窗口总径流量）、水量平衡残差公式、`numerical_health` 四项的来源与诚实声明、阈值判定、`runs/<run_id>/metrics.json` 的形状与确定性序列化、collect 内计算与失败隔离，以及 rSHUD 对照夹具，使每个成功运行的数值诊断都能从保留的 `.dat` 确定性复算，而不依赖 R 运行时或 LLM 判断。

## ADDED Requirements

### Requirement: SHUD binary output read contract
系统 SHALL 以 TS 原生方式读取 SHUD 二进制输出 `<shud_output>/<project>.<var>.dat`，不调用 Rscript 或任何外部进程。文件布局 SHALL 按钉版 SHUD（`SHUD/src/classes/Model_Control.cpp:239-259,408-457`）解释：1024 字节 char 头；随后依次为 double 起始时间、double `NumVar`、`NumVar` 个 double 列索引（第 k 列对应 1 起始的元素或河段 index）；其后每行为 `NumVar + 1` 个 double `[t, v1..vN]`，`t` 为该输出区间的起点（模型时间，分钟），通量值为区间平均、单位 per day，储量值为该行所载的输出值（SHUD 对储量同样按区间内采样求均值，读取方 SHALL NOT 把它表述为区间末瞬时值）。读取 SHALL 校验：文件长度 ≥ 1040 字节；`(长度 − 1024 − 16 − 8·NumVar)` 能被 `8·(NumVar + 1)` 整除；`NumVar` 与每个列索引为有限非负整数。任一不满足 SHALL 以点名该文件与失败原因的受控错误结束该文件读取，SHALL NOT 猜测或截断解析。字节序 SHALL 按小端解释；运行平台非小端时读取 SHALL 直接以受控错误拒绝，SHALL NOT 尝试字节序推断。

打开 SHALL 使用与 verification-cases「Rivqdown comparator」相同的安全读：以 `O_NOFOLLOW` 打开，打开后以 `fstat` 绑定身份并只接受普通文件；路径 SHALL 相对该运行的 `artifacts.shud_output` 目录拼接，规范化后 SHALL NOT 逃逸该目录；符号链接、目录、FIFO 或其它特殊文件 SHALL fail closed。该文件的 sha256 SHALL 在解析所用的同一次读取中对同一批字节计算，SHALL NOT 另行二次读取。值为 NaN 或 ±Inf 时读取 SHALL NOT 抛错：这些值计入 `metrics.json` 的 `nonfinite_count`，依赖它们的指标按「Per-run flow metrics」「Water balance residual」「Numerical health producers」置 `null` 并写明原因。

运行副本 `runs/<run_id>/input/<project>/` 中的文本输入（`.sp.mesh`、`.sp.att`、`.sp.riv`、`.para.geol`、`.cfg.para`、`.cfg.calib`、`.cfg.ic`）SHALL 以同一安全读规则读取（相对副本目录，不逃逸），并同样在同一次读取中计算 sha256。读取 SHALL NOT 写入、截断或改名任何输入或输出文件，SHALL NOT 访问 `data/raw`。

#### Scenario: valid file parsed with digest
- **WHEN** 读取一个 1024 字节头、`NumVar = 2`、列索引 `[1, 2]`、3 行数据的 `.dat`
- **THEN** 结果给出起始时间、列 `[1, 2]`、3 行 `[t, v1, v2]`，sha256 等于该文件全部字节的摘要

#### Scenario: truncated file rejected
- **WHEN** 读取一个长度不满足行对齐（最后一行少 8 字节）或短于 1040 字节的 `.dat`
- **THEN** 读取返回点名该文件与布局错误的受控错误，不返回部分行

#### Scenario: non-integer column count rejected
- **WHEN** `.dat` 的 `NumVar` 为 `2.5`、负数或 NaN，或某个列索引为 `-1`
- **THEN** 读取返回点名该文件的受控错误

#### Scenario: symlinked or escaping output fails closed
- **WHEN** `<shud_output>/ccw.rivqdown.dat` 是指向其它文件的符号链接、是 FIFO，或请求路径经 `..` 解析到 `shud_output` 之外
- **THEN** 读取返回受控错误，不跟随链接、不阻塞，链接与其目标字节不变

#### Scenario: nonfinite values counted not thrown
- **WHEN** `.dat` 某行某列为 NaN
- **THEN** 读取成功返回，`nonfinite_count` 计入该值，依赖该变量的指标为 `null` 且原因点名该变量

#### Scenario: binary metadata and sample nonfinites retain their positions
- **WHEN** 合法布局的 `.dat` 起始日期元数据或数据行的时间/变量值为 NaN 或 ±Inf
- **THEN** 读取器保留这些值在 start_date、t_min 或对应列位置，并逐值累计 nonfinite_count；NumVar 或列索引的非有限值仍按布局错误拒绝，不作为数据计数

#### Scenario: binary platform and structural bounds are explicit
- **WHEN** 平台非小端，或 NumVar 声明的列索引超出实际文件长度
- **THEN** 返回点名文件与受控原因的错误；非小端分支不打开文件，过大的声明不触发按声明大小的未验证分配

#### Scenario: shared text reader preserves source bytes and table structure
- **WHEN** records 的共享文本输入读取器读取钉版 ccw 的 `.sp.mesh`、`.sp.att`、`.sp.riv`、`.para.geol`、`.para.lc`、`.cfg.para`、`.cfg.calib`、`.cfg.ic`
- **THEN** 八类文件解析成功，每个已声明表的行列数与实际一致；sha256 与 size_bytes 来自解析所用的同一次字节读取，源文件字节不变

#### Scenario: optional writer-produced text sections are not truncated
- **WHEN** `.sp.riv` 含第三段几何表，或 `.cfg.ic` 含可选时间头字段或湖泊表
- **THEN** 读取器显式保留这些结构并校验已出现的表，不将其误当成必需表的额外数据；缺少可选结构不导致失败

#### Scenario: config duplicates and byte-leading skip rules are preserved
- **WHEN** `.cfg.calib` 含首字节为 #、空格或 NUL 的行，以及有效的 `GEOL_KSATV` 与 `geol_ksatv` 两行
- **THEN** 前述行被跳过，两个有效键值行按文件顺序返回且按不区分大小写的键识别，读取器不合并重复键

#### Scenario: malformed text and unsafe files fail without partial results
- **WHEN** 文本输入缺登记列、数值不可解析、声明行列数不符，或目标不存在、是符号链接/目录/FIFO、请求路径逃逸基目录
- **THEN** 返回点名文件与受控原因的错误，无部分解析结果、无写入、无 FIFO 阻塞；不存在与不安全或读取失败可区分

#### Scenario: text numeric syntax is complete-token and consumer-neutral
- **WHEN** 文本表格单元或 cfg 值含 `0x1.8p+2`、`nan`、`infinity`，或含 `93abc`、`bad`、缺失值
- **THEN** 前三者分别解析为 6、NaN、Infinity，有限性与范围由消费者判定；后三者返回点名文件与列的受控解析错误，不接受数值前缀或复用上一行值

### Requirement: Per-run flow metrics
出口集合 `O` SHALL 为运行副本 `<project>.sp.riv` 第一张表中 `Down < 0` 的全部河段 index（与 rSHUD `getOutlets` 一致）；`O` 为空 SHALL 视为指标不可用。出口流量序列 SHALL 为 `Q(t) = Σ_{o∈O} rivqdown[o](t)`，单位 m³/d。窗口 SHALL 为 `rivqdown.dat` 的全部输出行。指标 SHALL 为：
- `peak_flow_m3d = max_t Q(t)`；并列时取 `t` 最小的一行。
- `peak_day = t_peak / 1440`，即峰值所在行的区间起点（模型时间，天）。
- `total_runoff_m3 = Σ_t Q(t) · Δ`。

各变量的输出间隔 Δ（天）SHALL 由该 `.dat` 的时间列推导：相邻行 `t` 之差 SHALL 处处相等，Δ 取该差 / 1440；SHALL NOT 读取 `.cfg.para` 的 `DT_*` 键推断 Δ（SHUD 对缺省键有内部默认值，`Model_Control.cpp:14-65`）。行数 < 2 或间隔不等时，依赖该变量的项 SHALL 为 `null`，原因 `interval_undetermined:<name>`（峰值与峰现日不依赖 Δ，仍照常计算）。`rivqdown.dat` 缺失（ENOENT）SHALL 使整份指标为 `unavailable`，原因 `missing_variable:rivqdown`。`Q(t)` 中任一值非有限时，三项指标 SHALL 为 `null`，原因 `nonfinite:rivqdown`。系统 SHALL NOT 计算敏感性指数、弹性系数、排名、观测类指标（NSE、KGE、peak_flow_error）或任何机制解释。

#### Scenario: ccw single outlet
- **WHEN** ccw 副本的 `ccw.sp.riv` 只有河段 1 的 `Down` 为 `-3`
- **THEN** `O = {1}`，`Q(t)` 为 `rivqdown` 第 1 列

#### Scenario: peak tie takes earliest row
- **WHEN** `Q` 在 `t = 1440` 与 `t = 4320` 两行取相同最大值
- **THEN** `peak_day` 为 `1`

#### Scenario: total runoff uses the time-column interval
- **WHEN** `rivqdown.dat` 三行的 `t` 为 `0, 1440, 2880`，`Q` 为 `10, 20, 30`
- **THEN** `total_runoff_m3` 为 `60`

#### Scenario: undetermined interval
- **WHEN** `rivqdown.dat` 只有一行，或三行的 `t` 为 `0, 1440, 4320`
- **THEN** `total_runoff_m3` 为 `null`，原因 `interval_undetermined:rivqdown`，`metrics.json` 的 `status` 仍为 `ok`

#### Scenario: empty outlet set
- **WHEN** 副本 `.sp.riv` 中没有 `Down < 0` 的河段
- **THEN** 该 run 的 `metrics.json` 为 `status: unavailable`，原因点名出口集合为空

### Requirement: Water balance residual
水量平衡残差 SHALL 按以下公式（深度，m；移植 rSHUD 2.5.0 `wb.all` 与 `wb.DS`，`rSHUD/R/WaterBalance.R:9-50,199-218`，另加积雪与冠层截留两项）计算，各量均取自该运行副本与其输出：
- 元素面积 `A_i` 由副本 `<project>.sp.mesh` 的三角形节点坐标计算（同 rSHUD `getArea`），`A = Σ_i A_i`，`w_i = A_i / A`。
- `P = Σ_t Σ_i w_i · elevprcp_i(t) · Δ`；`AET = Σ_t Σ_i w_i · eleveta_i(t) · Δ`；`Qd = Σ_t Q(t) · Δ / A`（`Q` 见「Per-run flow metrics」）。
- `ΔS_surf = Σ_i w_i (eleysurf_i(T) − ic.Surface_i)`。
- `ΔS_us = Σ_i w_i (eleyunsat_i(T) − ic.Unsat_i) · θs_i`；`ΔS_gw = Σ_i w_i (eleygw_i(T) − ic.GW_i) · θs_i`；`θs_i = ThetaS[geol(i)] × GEOL_THETAS`，`geol(i)` 取自副本 `.sp.att`，`ThetaS` 取自副本 `.para.geol`，`GEOL_THETAS` 取自副本 `.cfg.calib`。
- `ΔS_riv = Σ_r (rivystage_r(T) − ic.Stage_r) · Width[type(r)] · Length_r / A`，`type`、`Length` 与河道类型表 `Width` 取自副本 `.sp.riv`。
- `ΔS_snow = Σ_i w_i (snow_i(T) − snow0_i)`，`ΔS_ic = Σ_i w_i (ic_i(T) − ic0_i)`：`snow_i(T)`、`ic_i(T)` 为 `eleysnow`、`eleyic` 的末行值，`snow0_i`、`ic0_i` 为副本 `.cfg.ic` 元素表的 `Snow`、`Canopy` 列；作差前四个值 SHALL 各自按「Storage depth conversion constants」登记的折算换算为以元素面积计的水深（m），SHALL NOT 在残差实现中另写系数。
- `ΔS = ΔS_surf + ΔS_us + ΔS_gw + ΔS_riv + ΔS_snow + ΔS_ic`；`T` 为各储量文件的最后一行。该末行是最后一个输出区间的平均值而非瞬时末态，这一近似与 rSHUD `DeltaS` 的 `x[t2,]` 相同，`metrics.json` 的 `water_balance` SHALL 注明此近似。
- IC SHALL 取自副本 `<project>.cfg.ic`（文本；元素表列 `Index Canopy Snow Surface Unsat GW`，接河道表 `Index Stage`）；元素表或河道表行数与副本网格或河网不等时残差 SHALL 为 `null`，原因 `ic_shape_mismatch`（`.cfg.ic` 不存在或不可安全读取则按「Metrics file shape and determinism」为 `unavailable`）。
- `water_balance_residual = |P − Qd − AET − ΔS| / P`。

该公式是 PI 的科学定义：实现 SHALL NOT 增删、替换或重新加权任何项，任何偏离只能经 PI 决定后改本 spec。`P ≤ 0` 时残差 SHALL 为 `null`，原因 `zero_precipitation`。任一必需变量文件缺失（ENOENT；例如 keliya 不输出储量，或运行副本未开启 `eleyic` 输出）时残差 SHALL 为 `null`，原因 `missing_variable:<var>`（`<var>` 为第一个缺失的变量名，按变量名码点序）；`GEOL_THETAS` 键不在副本 `.cfg.calib` 中时残差 SHALL 为 `null`，原因 `missing_calib:GEOL_THETAS`，SHALL NOT 默认为 1；必需输入含非有限值时残差 SHALL 为 `null`，原因 `nonfinite:<var>`。以上 `null` 只影响残差，不使整份指标变为 `unavailable`。`metrics.json` SHALL 同时写出 `P`、`Qd`、`AET`、六个 ΔS 分量与 `ΔS`（不可算时为 `null`），以及公式来源说明，供 rSHUD 对照与 PI 审阅。`water_balance_residual` 只是数值守恒诊断，SHALL NOT 被表述为水文真实性或模型改进证据。

#### Scenario: residual from closed budget
- **WHEN** 合成夹具中 `P = 0.100`、`Qd = 0.030`、`AET = 0.060`、`ΔS = 0.009`
- **THEN** `water_balance_residual` 在浮点误差内为 `0.01`，`metrics.json` 分项写出这四个量与六个 ΔS 分量

#### Scenario: zero precipitation
- **WHEN** 窗口内 `elevprcp` 全为 0
- **THEN** `water_balance_residual` 为 `null`，原因 `zero_precipitation`，峰值类指标照常计算

#### Scenario: run without eleyic output
- **WHEN** 运行输出目录缺少 `<project>.eleyic.dat`（M5 之前提交的运行）
- **THEN** `water_balance_residual` 为 `null`，原因 `missing_variable:eleyic`，`metrics.json` 的 `status` 仍为 `ok`

#### Scenario: missing GEOL_THETAS is not defaulted
- **WHEN** 副本 `.cfg.calib` 不含 `GEOL_THETAS` 行
- **THEN** `water_balance_residual` 为 `null`，原因 `missing_calib:GEOL_THETAS`

#### Scenario: snow and interception terms included
- **WHEN** 手算夹具中 `eleysnow` 与 `eleyic` 末行均高于 `.cfg.ic` 的 `Snow`、`Canopy` 列
- **THEN** `ΔS_snow` 与 `ΔS_ic` 为正并计入 `ΔS`，残差与按「Storage depth conversion constants」当前登记值手算的值相等；把两项置零的反例夹具得到不同残差

### Requirement: Storage depth conversion constants
core SHALL 导出常量 `STORAGE_DEPTH_CONVERSIONS`，为「Water balance residual」的 `ΔS_snow`、`ΔS_ic` 恰提供四条折算：`snow.output`（`eleysnow` 输出值）、`snow.ic`（副本 `.cfg.ic` 的 `Snow` 列）、`ic.output`（`eleyic` 输出值）、`ic.ic`（副本 `.cfg.ic` 的 `Canopy` 列）。每条 SHALL 为 `{scale, veg_frac_weighted, shud_source_refs}`：`scale` 为有限正数，把该值换算为以元素面积计的水深（m）；`veg_frac_weighted` 为布尔，为真时再乘该元素的植被覆盖率 `VegFrac_i`；`shud_source_refs` 为非空数组，每项为 `SHUD/src/<path>:<正整数行号>`，指向钉版 SHUD 中决定该口径的代码行。元素 i 的折算深度 SHALL 为 `value × scale × (veg_frac_weighted ? VegFrac_i : 1)`。任一条 `veg_frac_weighted` 为真时，常量另 SHALL 含 `veg_frac_source`（副本中的文件、列与所乘 calib 键，及其 `shud_source_refs`）；该文件按「SHUD binary output read contract」的副本文本输入安全读规则读取并计入 `inputs`，缺失或不可读时残差为 `null`，原因 `unreadable_input:<file>`。四条均为假时 SHALL NOT 含 `veg_frac_source`。

各字段取值由 design Open Question O1 对照钉版 SHUD 源码定案；O1 的结论只决定这些字段的值，SHALL NOT 改变本 requirement 的措辞、常量形状或「Water balance residual」的公式结构。该常量为仓库内常量，SHALL NOT 经 profile 覆写，可在残差实现之前独立落地：core SHALL 导出该常量的校验 schema（四条齐全、`scale` 有限且为正、`veg_frac_weighted` 为布尔、每个 `shud_source_refs` 非空且每项匹配上述 file:line 形式），core 测试 SHALL 以该 schema 校验常量。

#### Scenario: four conversions registered with sources
- **WHEN** core 测试以校验 schema 解析 `STORAGE_DEPTH_CONVERSIONS`
- **THEN** 解析成功，恰有 `snow.output`、`snow.ic`、`ic.output`、`ic.ic` 四条，每条 `scale` 为有限正数，`shud_source_refs` 每项形如 `SHUD/src/<path>:<行号>`

#### Scenario: malformed registration rejected
- **WHEN** 以校验 schema 解析一个某条 `shud_source_refs` 为空数组、某项缺行号、`scale` 为 `0`/负数/NaN，或缺少四条之一的登记
- **THEN** 解析失败并点名该条

#### Scenario: residual applies the registered conversion
- **WHEN** 手算夹具按常量当前取值计算 `ΔS_snow` 与 `ΔS_ic`（`veg_frac_weighted` 为真的条目乘夹具中该元素的 `VegFrac_i`）
- **THEN** `metrics.json` 的 `ΔS_snow`、`ΔS_ic` 各自与按 `value × scale × (veg_frac_weighted ? VegFrac_i : 1)` 手算的值相等

### Requirement: Numerical health producers
`numerical_health` 四项 SHALL 按以下来源产生：
- `water_balance_residual`：见「Water balance residual」。
- `cvode_failures`：运行目录 `stderr.log` 中以 `SUNDIALS_ERROR:` 开头的行数（规则同 Domain_CLI_Spec 的 stderr 失败签名），经 shud-run-jobs 既有 stdout/stderr 普通文件读边界读取；文件缺失或不可安全读取时为 `null` 并写明原因。
- `negative_state_count`：`eleysurf`、`eleyunsat`、`eleygw`、`rivystage` 四个输出中所有有限且 `< -1e-10` 的值的个数（容差取自 `SHUD_Output_Variables.md` §11）。钉版 SHUD 会静默把负状态钳为 0（`MD_update.cpp:7-8`），`metrics.json` SHALL 写明该值只是下界；系统 SHALL NOT 以"长零段"等启发式补计。四个文件中任一不存在时整项 SHALL 为 `null`，原因 `missing_variable:<name>`，SHALL NOT 给出其余文件的部分计数；含非有限值时为 `null`，原因 `nonfinite:<var>`。
- `max_solver_dt`：恒为 `null`，原因 `not_observable_in_pinned_shud`（钉版 SHUD 定义了 `PrintFinalStats` 但没有调用点，步长不可观测）。系统 SHALL NOT 以任何估计值填充。

原因字符串只写入 `metrics.json`；RunRecord 的 `numerical_health` 只承载四个值（run-records「RunRecord record」）。

#### Scenario: cvode failures counted from stderr
- **WHEN** `stderr.log` 含两行以 `SUNDIALS_ERROR:` 开头的输出和一行其它文本
- **THEN** `cvode_failures` 为 `2`

#### Scenario: negative states counted as a lower bound
- **WHEN** `eleygw` 中有三个值为 `-1e-6`、一个为 `-1e-12`
- **THEN** `negative_state_count` 为 `3`，`metrics.json` 含"SHUD 静默钳零，该值为下界"的说明

#### Scenario: no partial negative count
- **WHEN** 输出目录有 `eleysurf`、`eleyunsat`、`eleygw`（其中 `eleygw` 含两个 `-1e-6`），但没有 `rivystage.dat`
- **THEN** `negative_state_count` 为 `null`，原因 `missing_variable:rivystage`，不是 `2`；`metrics.json` 的 `status` 仍为 `ok`

#### Scenario: max_solver_dt never estimated
- **WHEN** 对任一成功运行计算 numerical_health
- **THEN** `max_solver_dt` 为 `null`，`metrics.json` 中原因为 `not_observable_in_pinned_shud`

### Requirement: Numerical health verdicts
core SHALL 导出阈值常量 `NUMERICAL_HEALTH_THRESHOLDS`（取自 `SHUD_Output_Variables.md` §13，仓库内常量，SHALL NOT 经 profile 覆写），判定 SHALL 为：`water_balance_residual` ≤ 0.01 为 `pass`，(0.01, 0.05] 为 `warn`，> 0.05 为 `fail`；`cvode_failures` 为 0 为 `pass`，> 0 为 `fail`；`negative_state_count` 为 0 为 `pass`，1..10 为 `warn`，> 10 为 `fail`（按 §13 原样；计数已按「Numerical health producers」排除 `-1e-10` 容差内的值，§13 的 "within tolerance" 即由该计数规则满足）；这三项中值为 `null` 者为 `not_available`。`max_solver_dt` SHALL NOT 参与判定（没有阈值，在钉版 SHUD 中结构性不可观测）：`metrics.json` 的 `verdicts` SHALL 恰含 `water_balance_residual`、`cvode_failures`、`negative_state_count` 三个键，SHALL NOT 出现 `max_solver_dt`。判定结果 SHALL 写入 `metrics.json` 的 `verdicts`。判定只作陈述：SHALL NOT 改变 RunRecord 的 `status` 或 `exit_class`，SHALL NOT 阻断 collect 或任何 closure 谓词；`warn`、`fail`、`not_available` 由报告生成派生确定性 limitation（evidence-reports）。

#### Scenario: residual boundaries
- **WHEN** `water_balance_residual` 分别为 `0.01`、`0.0100001`、`0.05`、`0.0500001`
- **THEN** 判定依次为 `pass`、`warn`、`warn`、`fail`

#### Scenario: negative state count boundaries
- **WHEN** `negative_state_count` 分别为 `0`、`1`、`10`、`11`、`null`
- **THEN** 判定依次为 `pass`、`warn`、`warn`、`fail`、`not_available`，RunRecord 的 `status` 与 `exit_class` 均不变，collect 照常发布

#### Scenario: null value not judged
- **WHEN** `water_balance_residual` 为 `null`（`zero_precipitation`）
- **THEN** 其判定为 `not_available`，RunRecord `status` 不变

#### Scenario: max_solver_dt excluded from verdicts
- **WHEN** 对任一 `status: ok` 的运行写出 `metrics.json`
- **THEN** `verdicts` 只有三个键，不含 `max_solver_dt`

### Requirement: Metrics file shape and determinism
每个计算了指标的运行 SHALL 有 `runs/<run_id>/metrics.json`，为固定键序的 JSON 对象，至少含：`method_version`（core 导出的 metrics 方法版本常量）、`status`（`ok|unavailable`）、`reason`（`status: unavailable` 时为非空字符串，否则为 `null`）、`inputs`（每个读取文件的 `{path, sha256, size_bytes}`，`path` 相对运行目录，按 `path` 码点升序）、`nonfinite_count`、`outlets`（升序河段 index）、`flow`（`peak_flow_m3d`、`peak_day`、`total_runoff_m3` 及各自 `null` 原因）、`water_balance`（`formula_source`、`P`、`Qd`、`AET`、六个 ΔS 分量、`delta_s`、`residual` 及其原因）、`numerical_health`（四项值、各自原因与 `negative_state_count` 的下界说明）、`verdicts`（三项判定，不含 `max_solver_dt`）。

`status` 语义 SHALL 为：`ok` 表示计算完成，单项可以各自为 `null` 并在其原因字段写明原因——变量文件不存在（ENOENT）只使依赖它的项为 `null`，原因 `missing_variable:<name>`，不使整份指标变为 `unavailable`（例如 keliya 不输出储量：`water_balance_residual` 与 `negative_state_count` 为 `null`，峰值类指标照常计算，`status` 仍为 `ok`）。`unavailable` SHALL 只用于计算无法进行的情形：`rivqdown.dat`、副本 `.sp.riv`、`.sp.mesh`、`.cfg.ic` 或 `.cfg.para` 不存在或不可安全读取，出口集合为空，或任一**已存在**的 `.dat` 布局校验失败、为不安全文件或读取发生 IO 错误。副本 `.sp.att`、`.para.geol`、`.cfg.calib` 不存在或不可读时只使残差为 `null`，原因 `unreadable_input:<file>`。`status: unavailable` 时各值 SHALL 为 `null`、`reason` 点名失败原因。数值 SHALL 以 JS 最短往返表示序列化；文件 SHALL NOT 含时间戳、绝对路径、主机信息或密钥材料。同一组输入文件字节 SHALL 产生逐字节相同的 `metrics.json`，使验收脚本可从保留的 `.dat` 独立复算并逐字节比较。

#### Scenario: identical inputs give identical bytes
- **WHEN** 对同一运行目录先后两次计算指标
- **THEN** 两次得到的 `metrics.json` 逐字节相同，`inputs` 按 `path` 升序且每项 sha256 等于对应文件字节的摘要

#### Scenario: unavailable file carries a reason
- **WHEN** `ccw.eleygw.dat` 长度不满足行对齐
- **THEN** `metrics.json` 为 `status: unavailable`，`reason` 点名该文件与布局错误，各指标值为 `null`

#### Scenario: run without storage outputs stays ok
- **WHEN** keliya 运行（`DT_YE_SNOW/SURF/UNSAT/GW` 均为 0，输出目录没有 `eleysurf`、`eleyunsat`、`eleygw` 等储量 `.dat`）被计算指标
- **THEN** `metrics.json` 为 `status: ok`，`peak_flow_m3d`、`peak_day`、`total_runoff_m3` 非 `null`，`water_balance_residual` 与 `negative_state_count` 均为 `null` 且原因为 `missing_variable:<name>`

#### Scenario: unreadable core input makes metrics unavailable
- **WHEN** 运行副本缺少 `<project>.cfg.ic`，或 `<project>.sp.mesh` 为符号链接
- **THEN** `metrics.json` 为 `status: unavailable`，`reason` 点名该文件，各指标值为 `null`

#### Scenario: no host-specific content
- **WHEN** 同一运行目录被复制到另一绝对路径后重算
- **THEN** `metrics.json` 与原文件逐字节相同，不含任何绝对路径

### Requirement: Metrics computed at collect
指标 SHALL 在 shud-run-jobs「Automatic collect」与 `shud_collect` 的同一 collect 尝试内、RunRecord 发布之前计算，调度、幂等与重试计数规则以该 requirement 为准；本 requirement 只定义指标侧的可观测结果，适用于所有任务类型的运行（含不带 `task_id` 的运行）：
- `exit_class` 为 `ok` 的运行：SHALL 原子写 `runs/<run_id>/metrics.json`，RunRecord 的 `artifacts.metrics_summary` SHALL 为 `{path: "metrics.json", sha256}`（sha256 为所写字节的摘要），`numerical_health` 四项取自 `metrics.json`；`status: unavailable` 时四项 SHALL 为 `null`，`metrics_summary` 仍指向该文件。
- 指标不可用或任一 `.dat` 读取失败 SHALL NOT 写 `collect-error.json`、SHALL NOT 计入 collect 尝试次数、SHALL NOT 改变 RunRecord 的 `status` 与 `exit_class`。
- 写 `metrics.json` 本身失败（IO）时，RunRecord 的 `metrics_summary` 与 `numerical_health` 四项 SHALL 为 `null`，collect SHALL 继续发布 RunRecord，并在 collect 回执中给出可见的错误类别（不含路径以外的内容）。
- `exit_class` 不为 `ok` 的运行 SHALL NOT 写 `metrics.json`，`metrics_summary` 与 `numerical_health` 四项为 `null`。
- `run-record.json` 已存在时 SHALL NOT 重算或改写 `metrics.json`；前一次未完成尝试残留的 `metrics.json` SHALL 被下一次尝试以同一确定性内容覆盖。
- 已提交的历史 RunRecord SHALL NOT 回填指标。

#### Scenario: succeeded run gets metrics
- **WHEN** 一个 `exit_class: ok` 的 ccw 运行被 collect
- **THEN** `runs/<run_id>/metrics.json` 存在且 `status: ok`，RunRecord 的 `artifacts.metrics_summary.sha256` 等于该文件字节的摘要，`numerical_health` 的 `water_balance_residual`、`cvode_failures`、`negative_state_count` 非 `null`，`max_solver_dt` 为 `null`

#### Scenario: metric failure does not fail collect
- **WHEN** 一个 `exit_class: ok` 的运行的 `ccw.rivqdown.dat` 被截断后 collect
- **THEN** RunRecord 发布且 `status: succeeded`，`metrics.json` 为 `status: unavailable` 并带原因，`numerical_health` 四项为 `null`，运行目录无 `collect-error.json`

#### Scenario: failed run has no metrics file
- **WHEN** 一个 `exit_class: cvode` 的运行被 collect
- **THEN** 运行目录无 `metrics.json`，RunRecord 的 `metrics_summary` 与 `numerical_health` 四项为 `null`

#### Scenario: collected record is not recomputed
- **WHEN** 已有 `run-record.json` 的运行再次 collect
- **THEN** `metrics.json` 与 `run-record.json` 的字节与修改时间均不变

### Requirement: rSHUD cross-check fixture
records 包 SHALL 带一个合成迷你项目夹具（约 3 个三角形元素、2 个河段、1 个出口，完整的 `.sp.mesh`、`.sp.att`、`.sp.riv`、`.para.geol`、`.cfg.para`、`.cfg.calib`、`.cfg.ic` 与几十行的小 `.dat` 输出，输出间隔均为 1440 分钟，总量几 KB），以及入库的期望值文件 `expected-rshud.json`：它由一次性本机开发脚本（需 Rscript 与 rSHUD 2.5.0，脚本头部记录 R、rSHUD、xts 版本与生成命令）对该夹具调用 `wb.all`/`wb.DS` 的组成项生成，给出 `P`、`Qd`、`AET`、`ΔS_surf`、`ΔS_us`、`ΔS_gw`、`ΔS_riv`。CI 测试 SHALL 只比较 TS 计算结果与该 JSON（相对误差 ≤ 1e-12 或逐项相等），SHALL NOT 需要 Rscript、rSHUD 或任何 R 运行时；该脚本只是开发工具，SHALL NOT 被默认闸或 CI 调用。夹具固定 1440 分钟间隔，因为 rSHUD 按日速率直接求和而不乘 Δ，二者只在日间隔下等价。rSHUD 没有的 `ΔS_snow`、`ΔS_ic` SHALL 由手算夹具覆盖正例与反例；ccw 真实 `.dat` 的对照只在本机执行并写入 PR 证据，不入库。

#### Scenario: shared terms match rSHUD
- **WHEN** CI 对 wb-mini 夹具计算水量平衡
- **THEN** `P`、`Qd`、`AET` 与四个共有 ΔS 分量与 `expected-rshud.json` 在 1e-12 相对误差内一致，测试过程不启动任何 R 进程

#### Scenario: regression in a shared term detected
- **WHEN** 实现把 `ΔS_us` 的 `θs` 因子漏乘 `GEOL_THETAS`，而夹具的 `GEOL_THETAS` 不为 1
- **THEN** 对照测试失败并指出 `ΔS_us`
