---
status: snapshot
---

# SHUD 代码库现实报告

**日期**: 2026-07-02
**基线**: 3aec657 (2026-04-30, "Fix Print_Ctrl buffer initialization and ownership"; detached HEAD, 无 tag 指向, `git describe` = v1.0-156)
**语言**: C++14, src/ 57 个文件, 9,011 行 (wc -l)

## 1. 构建系统

- `configure` 脚本下载安装 SUNDIALS/CVODE 6.0.0 (configure:39-49)
- `Makefile` 实际编译目标只有两个: `shud` (serial, Makefile:116) 和 `shud_omp` (OpenMP, Makefile:127)；辅助 target: `all/check/help/cvode/clean`。旧文档提到的 `shud_debug` 不存在
- 编译: `g++ -O3 -g -std=c++14` (Makefile:59)
- 链接: serial 为 `-lm -lsundials_cvode -lsundials_nvecserial` (Makefile:87)；OpenMP 追加 `-Xpreprocessor -fopenmp -lomp -lsundials_nvecopenmp` (Makefile:88)
- `SUNDIALS_DIR` 默认 `$(HOME)/sundials` (Makefile:28)

## 2. 源码组织

```
src/
├── main.cpp                    # 入口 (28 行, main.cpp:24 打印 SHUDlogo)
├── classes/                    # 核心数据结构 (12 个类)
│   ├── Element.cpp/.hpp        # 三角网格单元 (继承 Soil_Layer, Geol_Layer, Landcover)
│   ├── River.cpp/.hpp          # 河道段 (几何/水力/Manning)
│   ├── Lake.cpp/.hpp           # 湖泊 (测深/出口/单元连接)
│   ├── Node.cpp/.hpp           # 网格节点 (x, y, zmin, zmax)
│   ├── IO.cpp/.hpp             # I/O 路径管理 (FileIn/FileOut)
│   ├── Model_Control.cpp/.hpp  # 模拟控制参数 (3aec657 修复了 Print_Ctrl 缓冲区)
│   ├── ModelConfigure.cpp/.hpp # 土壤/地质/地表覆盖参数结构
│   ├── TabularData.cpp/.hpp    # 表格数据
│   ├── TimeSeriesData.cpp/.hpp # 时间序列数据
│   ├── CommandIn.cpp/.hpp      # 命令行参数
│   ├── AccTemperature.cpp/.hpp # 积温计算
│   └── FloodAlert.cpp/.hpp     # 洪水预警
├── Equations/                  # 物理方程
│   ├── Equations.cpp/.hpp      # Van Genuchten, Manning, 有效导水率等
│   ├── Flux_RiverElement.cpp/.hpp # 河道-单元交换通量
│   ├── cvode_config.cpp/.hpp   # CVODE 求解器配置
│   ├── functions.cpp/.hpp      # 辅助函数
│   ├── funPlatform.cpp/.hpp    # 平台相关辅助 (跨平台目录/时间)
│   ├── is_sm_et.cpp/.hpp       # 截留/雪/融化/蒸散
│   └── print.cpp/.hpp          # 输出格式化 + SHUDlogo 横幅
├── Model/                      # 求解器主体
│   ├── shud.cpp/.hpp           # 主求解循环 (全局隐式/非耦合两模式, 304 行)
│   ├── f.cpp/.hpp              # 残差函数 (surf/unsat/gw/river/lake, 125 行)
│   └── Macros.hpp              # 状态变量索引宏 (iSF/iUS/iGW/iRIV/iLAKE) + 退出码
└── ModelData/                  # 模型数据管理
    ├── Model_Data.cpp/.hpp     # 中央状态容器 (310 行, 100+ 数组)
    ├── MD_f.cpp                # 主计算循环 (f_loop + f_applyDY)
    ├── MD_f_omp.cpp            # OpenMP 并行版
    ├── MD_f_uncouple.cpp       # 非耦合求解模式 (f_loopET/f_loop1-3/f_applyDYuncoup)
    ├── MD_readin.cpp           # 输入文件读取
    ├── MD_initialize.cpp       # 初始化
    ├── MD_update.cpp           # 状态更新 (含负值钳制)
    ├── MD_CheckInputData.cpp   # 输入数据检查
    ├── MD_ElementFlux.cpp      # 单元通量计算
    ├── MD_RiverFlux.cpp        # 河道通量计算
    ├── MD_ET.cpp               # 蒸散计算
    └── MD_Lake.cpp             # 湖泊计算
```

## 3. 核心算法

**求解模式** (shud.cpp:27 `global_implicit_mode = 1` 默认开):
- **全局隐式** (Global Implicit): 单个耦合 ODE 系统, CVODE 一次性求解所有状态变量
- **非耦合** (Uncoupled, `-g` 关闭全局隐式): 5 个独立 ODE 系统 (地表/非饱和/地下水/河道/湖泊), 显式耦合 (MD_f_uncouple.cpp)

**状态变量** (5 类, 索引宏 Macros.hpp:20-25):
- `uYsf[i]` — 地表积水深度 [m]
- `uYus[i]` — 非饱和带深度 [m]
- `uYgw[i]` — 地下水深度 [m]
- `uYriv[i]` — 河道水位 [m]
- `uYlake[i]` — 湖泊水位 [m]

**残差方程** (MD_f.cpp:51-154 `f_applyDY`):
- 地表 (:65): `DY = 净降水 - 入渗 + 回流 - 地表径流 - 蒸发`
- 非饱和 (:66, 除以 Sy): `DY = 入渗 - 补给 - 蒸发_非饱和 - 蒸腾_非饱和`
- 地下水 (:67, 除以 Sy): `DY = 补给 - 回流 - 壤中流 - 蒸发_地下水 - 蒸腾_地下水`
- 河道 (:124): `DY = (-上游 - 地表交换 - 壤中流交换 - 下游 + 边界) / 长度`
- 湖泊 (:144): `DY = 降水 - 蒸发 + (河流入 - 河流出 + 壤中流 + 地表流) / 面积`

**关键物理方程** (Equations.cpp/.hpp):
- Van Genuchten: 饱和度↔基质势转换
- Manning 方程: `ManningEquation` / `OverlandManning` (Equations.cpp:54)
- 温度递减率: `dTdZ = 0.0065` 即 6.5 K/km (Macros.hpp:50；2023 年 commit 077ff33 曾误为 10 倍, 已修正)
- 有效水力传导率: 调和平均
- 梯形断面: `A = y × (w₀ + y×s)` (River.cpp)

## 4. I/O 文件格式

**输入** (IO.cpp:47-92 `setInFilePath`)。必需 10 个 (缺失即失败):

| 扩展名 | 内容 | 格式 |
|--------|------|------|
| `.sp.mesh` | 三角网格 | ID, Node1-3, Nabr1-3, Zmax |
| `.sp.att` | 单元属性 | ID, Soil, Geol, LC, Forc, MF, BC, SS, iLake |
| `.sp.riv` | 河网 | 三表: River, Parameters, Points |
| `.sp.rivseg` | 河-单元连接 | iRiv, iEle, length, eqDistance |
| `.para.soil` | 土壤参数库 | KsatV, ThetaS, ThetaR, Alpha, Beta... |
| `.para.geol` | 地质参数库 | KsatH, KsatV, Sy... |
| `.para.lc` | 地表覆盖库 | VegFrac, Albedo, Rough, RzD... |
| `.cfg.para` | 模型参数 | 容差/步长/输出间隔/ET模式/模拟期 |
| `.cfg.ic` | 初始条件 | 三表: Element, River, Lake |
| `.tsd.forc` | 气象驱动 | 时间, Prcp, Temp, RH, Wind, Rn, Pressure |

可选 12+ 个: `.sp.lake` `.lake.bathy` `.lake.ic` `.cfg.output` `.cfg.calib` `.tsd.lai` `.tsd.mf` `.tsd.rl` `.tsd.lcm` `.tsd.obs` `.tsd.{e,r,l}bc{1,2}` (IO.cpp:63-91)

**校准因子** (`.cfg.calib`): 38 个, 覆盖 8 类 — GEOL(7) / SOIL(6) / LC(7) / TS(3) / ET(4) / RIV(8) / IC(2) / AQ(1)；键名带 `+` 后缀的为加性因子, 其余为乘性 (实例见 input/ccw/ccw.cfg.calib, 恰 38 行)

**输出** (IO.cpp:126-176): 42 个输出变量 (默认二进制 `.dat`; 扩展名 dat/csv 按输出配置在写出时追加, IO.cpp 注释: dat=binary, csv=ASCII):
- 河道 (5): rivqdown, rivqup, rivqsurf, rivqsub, rivystage
- 单元储量 (5): eleysnow, eleyic, eleysurf, eleyunsat, eleygw
- ET 分量 (3): elevetic, elevettr, elevetev
- 单元通量 (7): elevetp, eleveta, elevprcp, elevnetprcp, elevinfil, elevexfil, elevrech
- 壤中流 (4): eleqsub, eleqsub1-3；地表流 (4): eleqsurf, eleqsurf1-3
- 河-元交换 (2): eleqrsurf, eleqrsub；单元水量平衡 (4): ewbqin, ewbqout, ewbqio, ewbydh
- 湖泊 (8): lakqrivin, lakqrivout, lakqsurf, lakqsub, lakystage, lakatop, lakvevap, lakvprcp

侧产物: `cfg.ic.update` / `cfg.ic.bak` / `cfg.calib.bak` 备份、`flood.csv`、`ovs.csv`、进度文件 `<prj>.time.csv` (列: time_Minutes/Time_Days/Task_perc/CPUTime_s/WallTime_s/Num_fcall, IO.cpp:186-189)

## 5. 示例数据集

| 名称 | 路径 | 用途 |
|------|------|------|
| ccw | `input/ccw/` | Cache Creek 流域 (README 示例) |
| heihe | `input/heihe/` | 黑河流域 |
| qhh | `input/qhh/` | 青海流域 |

## 6. 已知 Bug / 近期改动

- `3aec657` (2026-04-30, 本基线): **BUGFIX** — Print_Ctrl 缓冲区初始化与所有权修复 (Model_Control.cpp/.hpp, ±14 行)；这是相对旧基线 9b55b0c 的唯一新提交
- 历史遗留 (承旧报告): `9b55b0c` 注释掉 4 行关键代码；`8920468` z_surf 计算方式变更；`077ff33` 绝热递减率 10 倍错误 (已修正为 0.0065)；`bc4ac9c` 河道长度 NA 检查
- **基线之外**: 上游在 3aec657 之后还有 125 个 commit 的 CPU 加速系列 (tag `cpu-accel-v1.0` → `v1.0.2`, 截至 2026-07-01)，含 `SHUD_CVODE_RELTOL` 环境变量钩子、`make shud_omp` 默认 Config C、OpenMP 运行文档。**注意: tag `cpu-accel-v1.0.2` 指向 db4ccdb, 不是本基线 3aec657**——若 Harness 需要该加速线, 子模块指针需前移

## 7. 对 Harness 的关键接口

- **编译接口**: `make shud` / `make shud_omp` → 产出 `./shud` 可执行文件
- **运行接口** (CommandIn.cpp:10 usage): `./shud [-0gv] [-p project_file] [-c Calib_file] [-o output] [-n Num_Threads] <project_name>`
  - 全部 flag (getopt `"0fgvc:e:n:o:p:"`, CommandIn.cpp:26): `-0` dummy 模式 (加载输入输出不计算, 输入校验门)、`-f` 频繁 fflush、`-g` 关闭全局隐式、`-v` verbose、`-c` 校准文件、`-e` CMA-ES 目录、`-n` 线程数 (经 `omp_set_num_threads`, shud.cpp:56)、`-o` 输出目录、`-p` 项目配置
  - **无 `--version`**: 运行时版本标识仅有 SHUDlogo 横幅串 "Simulator for Hydrologic Unstructured Domains v2.0 2022" (print.cpp:22, main.cpp:24 调用)——版本追踪必须靠源码 commit
- **退出码** (Macros.hpp:76-82): 0 ERRSUCCESS / 10 ERRNAN / 12 ERRFileIO / 13 ERRDATAIN / 19 ERRCVODE / 20 ERRCONSIS
- **输出接口**: 二进制 `.dat` → rSHUD `read_output()` 解析；进度经 `.time.csv` 轮询
- **配置接口**: `.cfg.para` 控制模拟参数；`.cfg.calib` 38 因子控制校准
- **数值健康信号**: 负状态被静默钳制为 0, 无任何日志 (MD_update.cpp `f_updatei`, 五处: :7 uYsf / :12 uYus / :17 uYgw / :32 uYriv / :53 uYlake)——负值检测只能靠输出分析；stderr 模式: `SUNDIALS_ERROR:` (cvode_config.cpp:11,20)、`MEMORY_ERROR:` (cvode_config.cpp:27)、`Warning: remove sink` (Model_Data.cpp:214)
- **无测试套件**: 仅示例数据集, 无自动化测试

## 8. 与 Domain_CLI_Spec §2.1 的交叉校验

一致项: 退出码表、必需输入 10 文件清单、flag 语义 (`-0/-c/-o/-n`)、`shud.cpp:56`、`.time.csv` 列名 (IO.cpp:186-189)、Makefile 行号引用、logo 串 "v2.0 2022"、负值静默钳制、无 `--version`。

偏差 (以代码为准):
1. spec 头部"SHUD@3aec657 (cpu-accel-v1.0.2)"**不成立**: 该 tag 指向 db4ccdb, 在 3aec657 之后 125 个 commit；3aec657 上无任何 tag
2. 行号微差: getopt 解析在 CommandIn.cpp:26 起 (spec 写 28-29, 那是 `-0` 的 case 分支)；cvode_config 关键行为 11/20/27 (spec 写 11-22)；负值钳制是 f_updatei 内五处而非仅 :7-8
