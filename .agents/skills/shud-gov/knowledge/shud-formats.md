# SHUD 文件格式与运行时行为

以下事实从 SHUD C++ 源码提取。每条标注出处。
如果代码已更新导致以下描述不准确，以代码为准并更新本文件。

## 时间单位

- 所有内部时间表示为**分钟** — Source: SHUD/src/IO/read_func.cpp
- forcing.csv 第一列是**天**，读入时 `ts[i][0] *= 1440` 转分钟 — Source: SHUD/src/IO/read_func.cpp
- LAI/MF .tsd 文件第一列也是**天**，同样 *= 1440 — Source: SHUD/src/IO/read_func.cpp
- .cfg.para 中时间参数已经是分钟（LSM_STEP=60 = 60分钟 = 1小时） — Source: SHUD/src/IO/read_func.cpp
- .cfg.ic header 第三个数是分钟（如 5256000.0 = 3652天） — Source: SHUD/input/ccw/ccw.cfg.ic
- 1440 分钟 = 1 天，是最常见的转换因子 — Verified: 2026-04-26

## 输入文件通用解析模式 (TabularData)

- 第一行: `NumRows NumCols`（空格分隔） — Source: SHUD/src/IO/read_func.cpp
- 第二行: 列名 header（空格/tab 分隔）
- 数据行: 空格/tab 分隔，用 `strtold()` 解析（long double 精度） — Source: SHUD/src/IO/read_func.cpp

## .sp.mesh — 双段结构

- 第一段: 元素表，列序 `ID Node1 Node2 Node3 Nabr1 Nabr2 Nabr3 Zmax` — Source: SHUD/input/ccw/ccw.sp.mesh
- 第二段: 节点表，列序 `ID X Y AquiferDepth Zmax` — Source: SHUD/input/ccw/ccw.sp.mesh
- 两段有各自的 `NumRows NumCols` header — Verified: 2026-04-26

## .sp.att — 列序固定，位置访问

- 列序: `INDEX SOIL GEOL LC FORC MF BC SS iLake` — Source: SHUD/input/ccw/ccw.sp.att
- C++ 代码按列号访问（att[i][0]=SOIL 等） — Source: SHUD/src/IO/read_func.cpp
- BC 可为负值（= Dirichlet 边界条件） — Source: SHUD/src/classes.hpp
- iLake > 0 → 全局设置 `lakeon = 1` — Source: SHUD/src/IO/read_func.cpp

## .sp.riv — 双段结构

- 第一段: 河段表 `Index Down Type Slope Length BC` — Source: SHUD/input/ccw/ccw.sp.riv
- Down < 1 = 外部出口（如 -3） — Source: SHUD/input/ccw/ccw.sp.riv
- Slope 可为负值（实际数据中有 -0.002705109） — Source: SHUD/input/ccw/ccw.sp.riv
- 第二段: 河型参数 `index depth bankslope BottomWidth Sinuosity Rough Cwr KsatH BedThick` — Source: SHUD/input/ccw/ccw.sp.riv

## .para.soil — 隐式单位转换

- KsatV 和 macKsatV 读入后 `/= 1440`（m/day → m/min） — Source: SHUD/src/IO/read_func.cpp
- Beta < 1.1 时被静默强制为 1.1，仅输出 warning — Source: SHUD/src/IO/read_func.cpp

## .cfg.calib — 两种参数语义

- 无后缀 = 乘法因子: `GEOL_KSATH 1` → 参数 *= 1 — Source: SHUD/src/IO/read_func.cpp
- 带 `+` 后缀 = 加法: `RIV_DPTH+ 0` → 参数 += 0 — Source: SHUD/src/IO/read_func.cpp
- 共 35+ 校准参数 — Source: SHUD/input/ccw/ccw.cfg.calib

## .cfg.para — 非标准 key-value

- 跳过行首为 `#`、`\n`、`\0`、空格的行 — Source: SHUD/src/IO/read_func.cpp
- key 大小写不敏感（`strcasecmp`） — Source: SHUD/src/IO/read_func.cpp

## forcing.csv — 非标准 CSV header

- 第一行: `NumRows NumCols StartDate(YYYYMMDD) EndDate(YYYYMMDD)` — Source: SHUD/input/ccw/forcing.csv
- 第二行: 列名 `Time_Day APCP TMP SPFH UGRD DSWRF` — Source: SHUD/input/ccw/forcing.csv
- 循环缓冲区 `MAXQUE=10000`，超出时分块懒加载 — Source: SHUD/src/IO/read_func.cpp

## 二进制输出格式

- Header: 1024 字节 char（变量名），然后 StartTime (double), NumVar (double), column indices (doubles) — Source: SHUD/src/IO/print_func.cpp
- 数据: `[Time double][NumVar 个 values double]` 顺序写入 — Source: SHUD/src/IO/print_func.cpp
- Native endian，无记录分隔符 — Source: SHUD/src/IO/print_func.cpp
- Flux 变量累积后除以 NumUpdate, tau=1440; Storage 变量瞬时, tau=1.0 — Source: SHUD/src/IO/print_func.cpp
- 不检查 NaN，可能写入 NaN 值 — Source: SHUD/src/IO/print_func.cpp

## CVODE 集成

- BDF 方法, SPGMR 线性求解器 — Source: SHUD/src/Equations/cvode_config.cpp
- MinStep=1e-6 分钟, MaxNumSteps=1e6 — Source: SHUD/src/Equations/cvode_config.cpp
- 失败时 `exit(ERRCVODE=19)`，无恢复 — Source: SHUD/src/Equations/cvode_config.cpp

## 状态向量布局

- y[0..NumEle-1] = 地表水深 — Source: SHUD/src/Equations/cvode_config.cpp
- y[NumEle..2*NumEle-1] = 非饱和带 — Source: SHUD/src/Equations/cvode_config.cpp
- y[2*NumEle..3*NumEle-1] = 地下水 — Source: SHUD/src/Equations/cvode_config.cpp
- y[3*NumEle..3*NumEle+NumRiv-1] = 河道 — Source: SHUD/src/Equations/cvode_config.cpp
- y[3*NumEle+NumRiv..end] = 湖泊 — Source: SHUD/src/Equations/cvode_config.cpp

## 构建系统

- SUNDIALS 路径硬编码 `$(HOME)/sundials` — Source: SHUD/Makefile
- OpenMP 路径硬编码 macOS `/usr/local/opt/libomp/` — Source: SHUD/Makefile
- 两个可执行文件: `shud`(serial) 和 `shud_omp`(OpenMP) — Source: SHUD/Makefile

## 退出码

- 0=成功, 10=NaN, 12=文件IO, 13=数据输入, 19=CVODE失败, 20=一致性检查 — Source: SHUD/src/classes.hpp
