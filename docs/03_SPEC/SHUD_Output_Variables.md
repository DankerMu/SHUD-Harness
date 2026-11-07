---
status: frozen
---

# SHUD 输出变量注册表

**状态：** P1 设计规范  
**适用范围：** rSHUD 解析、报告图表与指标、水量平衡、numerical health  
**目标：** 为报告图表和指标计算提供稳定变量目录，同时允许 runtime discovery 发现不同 SHUD 版本的输出差异。

## 1. 命名规则

SHUD 输出文件通常遵循：

```text
<ProjectName>.<Identifier>.<format>
```

其中 identifier 可理解为：

```text
<cell><type><variable>
```

常见前缀：

| 前缀 | 含义 |
|---|---|
| `ele` | element / hillslope 单元 |
| `riv` | river 河段 |
| `lak` | lake 湖泊 |

常见类型：

| 类型 | 含义 |
|---|---|
| `y` | state/storage 状态或库容 |
| `v` | areal flux 面通量或类似通量 |
| `q` | volumetric flow 体积流量 |

Harness 内部使用无点号 `variable_id`，例如 `.rivqdown.` 对应 `rivqdown`。

## 2. 注册表 schema

```ts
interface ShudOutputVariable {
  variable_id: string;
  identifier: string;
  domain: "element" | "river" | "lake";
  type: "state" | "areal_flux" | "volumetric_flow" | "area";
  display_name_zh: string;
  display_name_en: string;
  description: string;
  unit: string;
  default_priority: "primary" | "secondary" | "advanced";
  water_balance_role?: "input" | "output" | "storage" | "diagnostic";
  rshud_aliases?: string[];
}
```

## 3. Element 状态变量

| variable_id | Identifier | 中文含义 | 单位 | 优先级 |
|---|---|---|---|---|
| `eleyic` | `.eleyic.` | 冠层截留水量 | m | advanced |
| `eleysnow` | `.eleysnow.` | 雪水当量 | m | secondary |
| `eleysurf` | `.eleysurf.` | 地表积水/地表水深 | m | primary |
| `eleyunsat` | `.eleyunsat.` | 非饱和带水量 | m | primary |
| `eleygw` | `.eleygw.` | 地下水位或地下水储量深度 | m | primary |

## 4. Element 面通量变量

| variable_id | Identifier | 中文含义 | 单位 | 优先级 | 水量平衡角色 |
|---|---|---|---|---|---|
| `elevetp` | `.elevetp.` | 潜在蒸散发 | m3/m2/day | secondary | diagnostic |
| `eleveta` | `.eleveta.` | 实际蒸散发 | m3/m2/day | primary | output |
| `elevetic` | `.elevetic.` | 冠层截留蒸发 | m3/m2/day | advanced | output |
| `elevettr` | `.elevettr.` | 植被蒸腾 | m3/m2/day | advanced | output |
| `elevetev` | `.elevetev.` | 直接蒸发 | m3/m2/day | advanced | output |
| `elevprcp` | `.elevprcp.` | 降水 | m3/m2/day | primary | input |
| `elevnetprcp` | `.elevnetprcp.` | 净降水 | m3/m2/day | secondary | input |
| `elevinfil` | `.elevinfil.` | 入渗 | m3/m2/day | primary | diagnostic |
| `elevexfil` | `.elevexfil.` | 出渗/回归入渗 | m3/m2/day | secondary | diagnostic |
| `elevrech` | `.elevrech.` | 地下水补给 | m3/m2/day | primary | diagnostic |

## 5. Element 体积流量变量

| variable_id | Identifier | 中文含义 | 单位 | 优先级 | 水量平衡角色 |
|---|---|---|---|---|---|
| `eleqsurf` | `.eleqsurf.` | 地表径流/坡面流 | m3/day | primary | output |
| `eleqsub` | `.eleqsub.` | 地下侧向流 | m3/day | primary | output |

## 6. River 变量

| variable_id | Identifier | 中文含义 | 单位 | 优先级 |
|---|---|---|---|---|
| `rivystage` | `.rivystage.` | 河道水位 | m | primary |
| `rivqup` | `.rivqup.` | 向上游方向流量 | m3/day | secondary |
| `rivqdown` | `.rivqdown.` | 向下游方向流量 | m3/day | primary |
| `rivqsurf` | `.rivqsurf.` | 河道与坡面地表交换总量 | m3/day | primary |
| `rivqsurf1` | `.rivqsurf1.` | 地表交换方向 1 | m3/day | advanced |
| `rivqsurf2` | `.rivqsurf2.` | 地表交换方向 2 | m3/day | advanced |
| `rivqsurf3` | `.rivqsurf3.` | 地表交换方向 3 | m3/day | advanced |
| `rivqsub` | `.rivqsub.` | 河道与地下水交换总量 | m3/day | primary |
| `rivqsub1` | `.rivqsub1.` | 地下交换方向 1 | m3/day | advanced |
| `rivqsub2` | `.rivqsub2.` | 地下交换方向 2 | m3/day | advanced |
| `rivqsub3` | `.rivqsub3.` | 地下交换方向 3 | m3/day | advanced |

## 7. Lake 变量

湖泊变量在没有湖泊的项目中可能不存在。缺失时 parser 应返回 `not_available`，不应导致报告生成崩溃。

| variable_id | Identifier | 中文含义 | 单位 | 优先级 |
|---|---|---|---|---|
| `lakystage` | `.lakystage.` | 湖泊水位 | m | secondary |
| `lakarea` | `.lakarea.` | 湖面面积 | m2 | advanced |
| `lakqrivin` | `.lakqrivin.` | 河流入湖流量 | m3/day | secondary |
| `lakqrivout` | `.lakqrivout.` | 湖泊出流到河道 | m3/day | secondary |
| `lakqsurf` | `.lakqsurf.` | 湖泊与地表交换 | m3/day | advanced |
| `lakqsub` | `.lakqsub.` | 湖泊与地下水交换 | m3/day | advanced |

## 8. 前端默认展示

（已删：MVP 零自定义 UI，ADR-0004 K7。章节编号保留，§13 阈值位置不变。）

## 9. Runtime discovery

以下为 M5 之后的通用变量发现规划，不是 M5 metrics 文件形状；M5 只读取 §11–§12 的规定变量，按 run-metrics 契约写 `metrics.json`，不额外生产 available_variables 或 YAML 文件。

```text
scan output directory
→ match filename identifiers
→ validate against registry
→ record available_variables in metrics.yaml
```

示例：

```yaml
available_variables:
  - variable_id: rivqdown
    file: runs/RUN-001/output/ccw.rivqdown.dat
    columns: 103
    timesteps: 30
    format_version: inferred
```

未知变量允许存在，但标记为 `advanced_unknown`，等待后续加入注册表。

## 10. rSHUD alias

不同 rSHUD 版本可能对变量关键词有差异。注册表应支持 aliases：

| variable_id | 常见 alias |
|---|---|
| `eleygw` | `eleygw` |
| `rivqdown` | `rivqdown` |
| `elevprcp` | `eleqprcp`, `elevprcp` |
| `eleveta` | `eleqeta`, `eleveta` |

alias 必须在 rSHUD roundtrip test 中验证。

## 11. Numerical health

M5 的确定性生产者在 collect 内执行，契约见 [Numerical health producers](../../openspec/changes/m5-oat-sensitivity/specs/run-metrics/spec.md#requirement-numerical-health-producers)。RunRecord 只存四项值，原因、下界说明与判定写入 `runs/<run_id>/metrics.json`。

| 字段 | 来源与不可用语义 |
|---|---|
| `water_balance_residual` | §12 的水量平衡残差；不可算时 null，附原因 |
| `cvode_failures` | 安全读取 `stderr.log`，计数以 `SUNDIALS_ERROR:` 开头的行；日志缺失或不可安全读取时 null |
| `negative_state_count` | `eleysurf`、`eleyunsat`、`eleygw`、`rivystage` 四个输出中有限且 `< -1e-10` 的值的个数；任一文件缺失则整项 null，不给部分计数；含非有限值时 null |
| `max_solver_dt` | 恒 null，原因 `not_observable_in_pinned_shud`；钉版 SHUD 的 `PrintFinalStats` 没有调用点，不估计步长 |

**D15(2)：M5 范围裁剪、非放宽 baseline。** max_solver_dt 结构性不可观测，不参与阈值判定，每份报告只附一条固定 limitation。

**D15(3)：M5 范围裁剪、非放宽 baseline。** SHUD 静默钳零，negative_state_count 只是下界；不以长零段或其它启发式补计。计数已排除 `-1e-10` 容差内的负值。

**D15(10)：M5 范围裁剪、非放宽 baseline。** ccw 没有湖泊输入，负状态检查与下节水量平衡只覆盖上述四个状态文件及 rSHUD 共有项、积雪和截留；接入带湖泊流域时须另行扩展。

## 12. 水量平衡最小变量集

本节为 M5 公式的文档落点；机器契约见 [Per-run flow metrics](../../openspec/changes/m5-oat-sensitivity/specs/run-metrics/spec.md#requirement-per-run-flow-metrics) 与 [Water balance residual](../../openspec/changes/m5-oat-sensitivity/specs/run-metrics/spec.md#requirement-water-balance-residual)。公式项由 PI 定义，实现不得自行增删、替换或重新加权。

| 项 | 变量 |
|---|---|
| 输入 | `elevprcp` |
| 输出 | `eleveta`、出口 `rivqdown` |
| 储量 | `eleysurf`、`eleyunsat`、`eleygw`、`rivystage`、`eleysnow`、`eleyic` |

出口集合 `O` 为运行副本 `<project>.sp.riv` 第一张表中 `Down < 0` 的河段 index；为空即指标不可用。ccw 的 `O = {1}`。`Q(t) = Σ_{o∈O} rivqdown[o](t)`，单位 m³/d，窗口为 rivqdown 的全部输出行：

- `peak_flow_m3d = max_t Q(t)`，并列取最早 t。
- `peak_day = t_peak / 1440`，表示峰值行的区间起点（模型时间，天），不是瞬时峰值时刻。
- `total_runoff_m3 = Σ_t Q(t) · Δ`。

每个变量的 Δ（天）由该 `.dat` 时间列的相邻差 / 1440 推导，差必须处处相等，不从 `.cfg.para` 的 `DT_*` 推测。少于两行或间隔不等时，依赖间隔的项为 null；峰值与峰现日不依赖 Δ，仍可计算。Q 任一值非有限时三项均 null。

水量平衡以深度 m 表示，移植 rSHUD 2.5.0 `wb.all` / `wb.DS` 的共有项，并扩展积雪、冠层截留：

- `A_i` 由副本 `.sp.mesh` 三角形节点坐标计算，`A = Σ_i A_i`，`w_i = A_i / A`。
- `P = Σ_t Σ_i w_i · elevprcp_i(t) · Δ`；`AET = Σ_t Σ_i w_i · eleveta_i(t) · Δ`；`Qd = Σ_t Q(t) · Δ / A`。各项使用各自输出的 Δ。
- `ΔS_surf = Σ_i w_i (eleysurf_i(T) − ic.Surface_i)`。
- `ΔS_us = Σ_i w_i (eleyunsat_i(T) − ic.Unsat_i) · θs_i`。
- `ΔS_gw = Σ_i w_i (eleygw_i(T) − ic.GW_i) · θs_i`。
- `θs_i = ThetaS[geol(i)] × GEOL_THETAS`；geol 来自副本 `.sp.att`、ThetaS 来自 `.para.geol`、GEOL_THETAS 来自 `.cfg.calib`，缺键不默认为 1。
- `ΔS_riv = Σ_r (rivystage_r(T) − ic.Stage_r) · Width[type(r)] · Length_r / A`；类型、宽度与长度来自副本 `.sp.riv`。
- `ΔS_snow = Σ_i w_i (snow_i(T) − snow0_i)`；`ΔS_ic = Σ_i w_i (ic_i(T) − ic0_i)`。四个原值分别为 eleysnow、eleyic 末行与 `.cfg.ic` 的 Snow、Canopy 列；作差前均换算为以元素面积计的水深。
- 折算由 core 常量 `STORAGE_DEPTH_CONVERSIONS` 提供四条 `snow.output`、`snow.ic`、`ic.output`、`ic.ic`，每条深度为 `value × scale × (veg_frac_weighted ? VegFrac_i : 1)`。系数及是否乘植被覆盖率待 O1 核实，本节不填猜测值；常量形状与来源要求见 [Storage depth conversion constants](../../openspec/changes/m5-oat-sensitivity/specs/run-metrics/spec.md#requirement-storage-depth-conversion-constants)。
- `ΔS = ΔS_surf + ΔS_us + ΔS_gw + ΔS_riv + ΔS_snow + ΔS_ic`。
- `water_balance_residual = |P − Qd − AET − ΔS| / P`。

IC 取运行副本 `<project>.cfg.ic`：元素表 `Index Canopy Snow Surface Unsat GW`，河道表 `Index Stage`；行数须与网格/河网相符。T 为各储量文件最后一行；**末行为最后一个区间的平均值，而非瞬时末态**，与 rSHUD DeltaS 相同的区间平均近似必须写入 metrics 的 water_balance。文件同时记录 P、Qd、AET、六个储量分量、delta_s、公式来源与输入摘要，供复算与审阅；残差只是数值守恒诊断。

null 原因词表：

| 原因 | 条件 |
|---|---|
| `zero_precipitation` | P ≤ 0 |
| `missing_variable:<name>` | 缺必需变量，多个缺失时按变量名码点序点名第一个 |
| `ic_shape_mismatch` | IC 元素或河道行数不匹配 |
| `missing_calib:GEOL_THETAS` | 副本 calib 缺该键 |
| `interval_undetermined:<name>` | 少于两行或时间间隔不等 |
| `not_observable_in_pinned_shud` | max_solver_dt 在钉版 SHUD 不可观测 |
| `nonfinite:<var>` | 依赖的变量含非有限值 |
| `unreadable_input:<file>` | 残差依赖的非核心输入不可读 |

单项 null 不自动等于整份 unavailable：rivqdown、副本 `.sp.riv`、`.sp.mesh`、`.cfg.ic`、`.cfg.para` 不可读、出口为空，或已存在的 `.dat` 布局/安全读失败，才使整份指标 unavailable；其余边界以 [Metrics file shape and determinism](../../openspec/changes/m5-oat-sensitivity/specs/run-metrics/spec.md#requirement-metrics-file-shape-and-determinism) 为准。

**D15(9)：M5 范围裁剪、非放宽 baseline。** 原 metrics YAML 规划改为确定性 `metrics.json`，basin aggregation 方法与区间平均近似写入其中；固定键序、JS 最短往返数值表示，inputs 按相对路径码点升序，不含时间戳、绝对路径或主机信息。同输入字节应产出相同文件字节。

## 13. 阈值

M5 沿用阈值，core 的 `NUMERICAL_HEALTH_THRESHOLDS` 为仓库内常量，不允许 profile 覆写：

| 指标 | pass | warn | fail |
|---|---|---|---|
| `water_balance_residual` | ≤0.01 | (0.01, 0.05] | >0.05 |
| `cvode_failures` | 0 | 不适用 | >0 |
| `negative_state_count` | 0 | 1..10 | >10 |

前三项值为 null 时判定为 `not_available`；max_solver_dt 不参与判定，verdicts 恰有前三个键。negative 原文的 within tolerance 由 §11 计数时排除容差内值落实，不改变阈值。判定只作陈述，不改变 RunRecord 的 status/exit_class、不阻断 collect 或 closure；warn/fail/not_available 由报告派生 limitation。

## 14. 验收标准

- [ ] 注册表包含上述变量。
- [ ] parser 将缺失可选变量标记为 `not_available`。
- [ ] `rivqdown` 和 `eleygw` 可在 HydrographChart 中选择。
- [ ] rSHUD alias resolution 有 roundtrip 测试。
- [ ] water balance metrics 明确列出使用变量。
- [ ] 未知输出变量不会导致 UI 崩溃。
