# SHUD 输出变量注册表

**状态：** P1 设计规范  
**适用范围：** rSHUD 解析、HydrographChart、ResultsOverview、水量平衡、numerical health  
**目标：** 为前端和指标计算提供稳定变量目录，同时允许 runtime discovery 发现不同 SHUD 版本的输出差异。

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
  frontend_default: boolean;
  water_balance_role?: "input" | "output" | "storage" | "diagnostic";
  rshud_aliases?: string[];
}
```

## 3. Element 状态变量

| variable_id | Identifier | 中文含义 | 单位 | 优先级 | 默认展示 |
|---|---|---|---|---|---:|
| `eleyic` | `.eleyic.` | 冠层截留水量 | m | advanced | 否 |
| `eleysnow` | `.eleysnow.` | 雪水当量 | m | secondary | 否 |
| `eleysurf` | `.eleysurf.` | 地表积水/地表水深 | m | primary | 是 |
| `eleyunsat` | `.eleyunsat.` | 非饱和带水量 | m | primary | 是 |
| `eleygw` | `.eleygw.` | 地下水位或地下水储量深度 | m | primary | 是 |

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

| variable_id | Identifier | 中文含义 | 单位 | 优先级 | 默认展示 |
|---|---|---|---|---|---:|
| `rivystage` | `.rivystage.` | 河道水位 | m | primary | 是 |
| `rivqup` | `.rivqup.` | 向上游方向流量 | m3/day | secondary | 否 |
| `rivqdown` | `.rivqdown.` | 向下游方向流量 | m3/day | primary | 是 |
| `rivqsurf` | `.rivqsurf.` | 河道与坡面地表交换总量 | m3/day | primary | 否 |
| `rivqsurf1` | `.rivqsurf1.` | 地表交换方向 1 | m3/day | advanced | 否 |
| `rivqsurf2` | `.rivqsurf2.` | 地表交换方向 2 | m3/day | advanced | 否 |
| `rivqsurf3` | `.rivqsurf3.` | 地表交换方向 3 | m3/day | advanced | 否 |
| `rivqsub` | `.rivqsub.` | 河道与地下水交换总量 | m3/day | primary | 否 |
| `rivqsub1` | `.rivqsub1.` | 地下交换方向 1 | m3/day | advanced | 否 |
| `rivqsub2` | `.rivqsub2.` | 地下交换方向 2 | m3/day | advanced | 否 |
| `rivqsub3` | `.rivqsub3.` | 地下交换方向 3 | m3/day | advanced | 否 |

## 7. Lake 变量

湖泊变量在没有湖泊的项目中可能不存在。缺失时 parser 应返回 `not_available`，不应导致 UI 崩溃。

| variable_id | Identifier | 中文含义 | 单位 | 优先级 | 默认展示 |
|---|---|---|---|---|---:|
| `lakystage` | `.lakystage.` | 湖泊水位 | m | secondary | 否 |
| `lakarea` | `.lakarea.` | 湖面面积 | m2 | advanced | 否 |
| `lakqrivin` | `.lakqrivin.` | 河流入湖流量 | m3/day | secondary | 否 |
| `lakqrivout` | `.lakqrivout.` | 湖泊出流到河道 | m3/day | secondary | 否 |
| `lakqsurf` | `.lakqsurf.` | 湖泊与地表交换 | m3/day | advanced | 否 |
| `lakqsub` | `.lakqsub.` | 湖泊与地下水交换 | m3/day | advanced | 否 |

## 8. 前端默认展示

MVP Dashboard 默认显示：

1. `rivqdown`：出口流量；
2. `rivystage`：出口或选定河段水位；
3. `eleygw`：流域均值；
4. `eleysurf`：流域均值；
5. `elevprcp`：流域均值或总量；
6. `eleveta`：流域均值；
7. water balance residual 指标。

## 9. Runtime discovery

每次 run 后扫描输出目录：

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

必要指标：

```yaml
numerical_health:
  water_balance_residual: 0.0008
  cvode_failures: 0
  negative_state_count: 0
  max_solver_dt: 5.2
```

负状态检查变量：

```text
eleysurf, eleyunsat, eleygw, rivystage, lakystage
```

小于浮点容忍阈值的极小负值可单独记录：

```yaml
negative_state_tolerance: -1.0e-10
```

## 12. 水量平衡最小变量集

| 项 | 变量 |
|---|---|
| 输入 | `elevprcp`，可用时加入 `elevnetprcp` |
| 输出 | `eleveta`，出口 `rivqdown`，有湖泊时加入湖泊出流 |
| 储量 | `eleyic`、`eleysnow`、`eleysurf`、`eleyunsat`、`eleygw`、`rivystage`、`lakystage` |
| 诊断 | `elevinfil`、`elevrech`、`eleqsurf`、`eleqsub`、`rivqsurf`、`rivqsub` |

每次 run 的 basin aggregation 方法必须写入 `metrics.yaml`。

## 13. 阈值

MVP 默认：

```yaml
water_balance_residual:
  pass: "<= 0.01"
  warn: "<= 0.05"
  fail: "> 0.05"
cvode_failures:
  pass: 0
  fail: "> 0"
negative_state_count:
  pass: 0
  warn: "<= 10 and within tolerance"
  fail: "otherwise"
```

## 14. 验收标准

- [ ] 注册表包含上述变量。
- [ ] parser 将缺失可选变量标记为 `not_available`。
- [ ] `rivqdown` 和 `eleygw` 可在 HydrographChart 中选择。
- [ ] rSHUD alias resolution 有 roundtrip 测试。
- [ ] water balance metrics 明确列出使用变量。
- [ ] 未知输出变量不会导致 UI 崩溃。
