# SHUD 代码库现实报告

**日期**: 2026-04-24
**分支**: master (clean)
**语言**: C++14, ~6,875 行源码

## 1. 构建系统

- `configure` 脚本下载安装 SUNDIALS/CVODE 6.0.0
- `Makefile` 支持三个目标: `shud` (serial), `shud_omp` (OpenMP), `shud_debug`
- 编译: `g++ -std=c++14 -O3`
- 依赖: `-lsundials_cvode -lsundials_nvecserial -lm`; OpenMP 可选

## 2. 源码组织

```
src/
├── main.cpp                    # 入口 (28 行)
├── classes/                    # 核心数据结构
│   ├── Element.cpp/.hpp        # 三角网格单元 (继承 Soil_Layer, Geol_Layer, Landcover)
│   ├── River.cpp/.hpp          # 河道段 (几何/水力/Manning)
│   ├── Lake.cpp/.hpp           # 湖泊 (测深/出口/单元连接)
│   ├── Node.cpp/.hpp           # 网格节点 (x, y, zmin, zmax)
│   ├── IO.cpp/.hpp             # I/O 路径管理 (FileIn/FileOut, ~50 个输出变量)
│   ├── Model_Control.cpp/.hpp  # 模拟控制参数 (容差/步长/输出间隔/ET模式)
│   ├── ModelConfigure.cpp/.hpp # 土壤/地质/地表覆盖参数结构
│   ├── TabularData.cpp/.hpp    # 表格数据
│   ├── TimeSeriesData.cpp/.hpp # 时间序列数据
│   ├── CommandIn.cpp/.hpp      # 命令行参数
│   ├── AccTemperature.cpp/.hpp # 积温计算
│   └── FloodAlert.cpp/.hpp     # 洪水预警
├── Equations/                  # 物理方程
│   ├── Equations.cpp/.hpp      # Van Genuchten, Manning, 温度递减率等
│   ├── Flux_RiverElement.cpp/.hpp # 河道-单元交换通量
│   ├── cvode_config.cpp/.hpp   # CVODE 求解器配置
│   ├── functions.cpp/.hpp      # 辅助函数
│   ├── is_sm_et.cpp/.hpp       # 截留/雪/融化/蒸散
│   └── print.cpp/.hpp          # 输出格式化
├── Model/                      # 求解器主体
│   ├── shud.cpp/.hpp           # 主求解循环 (全局隐式/非耦合两模式, 304 行)
│   ├── f.cpp/.hpp              # 残差函数 (surf/unsat/gw/river/lake, 125 行)
│   └── Macros.hpp              # 状态变量索引宏 (iSF/iUS/iGW/iRIV/iLAKE)
└── ModelData/                  # 模型数据管理
    ├── Model_Data.cpp/.hpp     # 中央状态容器 (339 行, 100+ 数组)
    ├── MD_f.cpp                # 主计算循环 (f_loop + f_applyDY)
    ├── MD_f_omp.cpp            # OpenMP 并行版
    ├── MD_f_uncouple.cpp       # 非耦合求解模式
    ├── MD_readin.cpp           # 输入文件读取
    ├── MD_initialize.cpp       # 初始化
    ├── MD_update.cpp           # 状态更新
    ├── MD_CheckInputData.cpp   # 输入数据检查
    ├── MD_ElementFlux.cpp      # 单元通量计算
    ├── MD_RiverFlux.cpp        # 河道通量计算
    ├── MD_ET.cpp               # 蒸散计算
    └── MD_Lake.cpp             # 湖泊计算
```

## 3. 核心算法

**求解模式**:
- **全局隐式** (Global Implicit): 单个耦合 ODE 系统, CVODE 一次性求解所有状态变量
- **非耦合** (Uncoupled): 5 个独立 ODE 系统 (地表/非饱和/地下水/河道/湖泊), 显式耦合

**状态变量** (5 类):
- `uYsf[i]` — 地表积水深度 [m]
- `uYus[i]` — 非饱和带深度 [m]
- `uYgw[i]` — 地下水深度 [m]
- `uYriv[i]` — 河道水位 [m]
- `uYlake[i]` — 湖泊水位 [m]

**残差方程** (`MD_f.cpp: f_applyDY`):
- 地表: `DY = 净降水 - 入渗 + 回流 - 地表径流 - 蒸发`
- 非饱和: `DY = 入渗 - 补给 - 蒸发_非饱和 - 蒸腾_非饱和`
- 地下水: `DY = 补给 - 回流 - 壤中流 - 蒸发_地下水 - 蒸腾_地下水`
- 河道: `DY = (-上游 - 地表交换 - 壤中流交换 - 下游 + 边界) / 长度`
- 湖泊: `DY = 降水 - 蒸发 + (河流入 - 河流出 + 壤中流 + 地表流) / 面积`

**关键物理方程** (`Equations.hpp`):
- Van Genuchten: 饱和度↔基质势转换
- Manning 方程: 明渠流量
- 温度递减率: 6.5 K/km
- 有效水力传导率: 调和平均
- 梯形断面: `A = y × (w₀ + y×s)`

## 4. I/O 文件格式

**输入** (12+ 文件类型):
| 扩展名 | 内容 | 格式 |
|--------|------|------|
| `.sp.mesh` | 三角网格 | ID, Node1-3, Nabr1-3, Zmax |
| `.sp.riv` | 河网 | 三表: River, Parameters, Points |
| `.sp.att` | 单元属性 | ID, Soil, Geol, LC, Forc, MF, BC, SS, iLake |
| `.sp.rivseg` | 河-单元连接 | iRiv, iEle, length, eqDistance |
| `.para.soil` | 土壤参数库 | KsatV, ThetaS, ThetaR, Alpha, Beta... |
| `.para.geol` | 地质参数库 | KsatH, KsatV, Sy... |
| `.para.lc` | 地表覆盖库 | VegFrac, Albedo, Rough, RzD... |
| `.cfg.para` | 模型参数 | 容差/步长/输出间隔/ET模式/模拟期 |
| `.cfg.ic` | 初始条件 | 三表: Element, River, Lake |
| `.cfg.calib` | 校准因子 | 38+ 乘数因子 |
| `.tsd.forc` | 气象驱动 | 时间, Prcp, Temp, RH, Wind, Rn, Pressure |
| `.tsd.lai` | 叶面积指数 | 时间序列 |

**输出** (~50 变量, 二进制 `.dat`):
- 单元存储: ele_y_surf, ele_y_unsat, ele_y_gw, ele_y_snow, ele_y_ic
- 单元通量: ele_q_ET[3], ele_q_ETP, ele_q_ETA, ele_q_prcp, ele_q_infil, ele_q_rech
- 河道: riv_y_stage, riv_Q_down, riv_Q_up, riv_Q_surf, riv_Q_sub
- 湖泊: lake_y_stage, lake_a_area, lake_Q_rivin/rivout/surf/sub

## 5. 示例数据集

| 名称 | 路径 | 用途 |
|------|------|------|
| ccw | `input/ccw/` | Cache Creek 流域 (README 示例) |
| heihe | `input/heihe/` | 黑河流域 |
| qhh | `input/qhh/` | 青海流域 |

## 6. 已知 Bug / 近期改动

- `9b55b0c`: **BUGFIX** — 注释掉了 4 行关键代码
- `8920468`: **算法修改** — z_surf 计算方式变更
- `077ff33`: **Bug** — 绝热递减率从 0.00065 改为 0.0065 (差 10 倍)
- `bc4ac9c`: 河道长度增加 NA 值检查

## 7. 对 Harness 的关键接口

- **编译接口**: `make shud` → 产出 `./shud` 可执行文件
- **运行接口**: `./shud <project_name>` (从 `input/<project_name>/` 读取输入)
- **输出接口**: 二进制 `.dat` 文件 → rSHUD `read_output()` 解析
- **配置接口**: `.cfg.para` 控制所有模拟参数; `.cfg.calib` 控制校准因子
- **无测试套件**: 仅有示例数据集, 无自动化测试
