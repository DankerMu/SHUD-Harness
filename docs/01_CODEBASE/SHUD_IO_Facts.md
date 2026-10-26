---
status: living
canonical_for: [shud-io-facts]
---

# SHUD 文件格式与运行时事实（审查用）

从 SHUD C++ 源码提取的硬事实，供实现 `shud_run` / `shud_collect`（M2）与水量平衡（M3）的 implementer 和 reviewer 子代理读取；对应 `openspec/project-profile.md` 的 "Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility" 风险包。
每条标注出处；代码与本文矛盾时以代码为准并更新本文。原载 .agents/skills/shud-gov/knowledge/shud-formats.md（历史路径；2026-10-20 降级为文档，skill 已删除）。

重核基线：2026-10-26（UTC），SHUD pin `3aec65755926c478e13ca7d4fea80715e4e90345`；Harness 引用基于 `a8a8133d`。本次核对引用路径、行范围及下列指定的单位、表头、算术、列映射、warning 和串行向量布局，不代表全模型或整篇科学语义已验证；flux/storage tau 与 NaN 传播只修复出处，不重审其语义，审查清单保持原样。rSHUD/AutoSHUD 文档刷新另行跟踪，不在本次重核范围。

路径闸仅检查路径存在，不验证行号或事实正确性。本地文档闸/默认闸须先初始化钉版子模块；现有 checker 在子模块根目录缺失时会跳过该根的路径声明，绿色结果不能替代此先决条件。引用格式为独立反引号路径，行号放在反引号外。

## 时间单位

- 模拟起止时间 `StartTime`/`EndTime` 以**分钟**保存，由 `DayStart`/`DayEnd` 乘以 1440 得到 — Source: `SHUD/src/classes/Model_Control.cpp`:86-91；`SHUD/src/classes/Model_Control.hpp`:119-120
- forcing.csv 第一列是**天**，读入时 `ts[i][0] *= 1440` 转分钟 — Source: `SHUD/src/classes/TimeSeriesData.cpp`:61-69；`SHUD/src/ModelData/MD_readin.cpp`:397-403
- LAI/MF .tsd 文件第一列也是**天**，同样 *= 1440 — Source: `SHUD/src/ModelData/MD_readin.cpp`:473-482；`SHUD/src/classes/TimeSeriesData.cpp`:61-69
- .cfg.para 的 `START`/`END` 是**天**，分别读入 `DayStart`/`DayEnd`，再转换为上述分钟值；不能把该文件的所有时间参数统一当作分钟 — Source: `SHUD/src/classes/Model_Control.cpp`:146-149、86-91、230
- `SCR_INTV` 读入 `screenIntv`，屏幕输出间隔使用**分钟** — Source: `SHUD/src/classes/Model_Control.cpp`:122-123；`SHUD/src/ModelData/Model_Data.cpp`:264-277、288-303
- `LSM_STEP`/`ET_STEP` 读入 `ETStep`（声明注释为分钟）；当前源码没有活动消费者，相关步进代码已注释，不能由此推断实际 ET 步长 — Source: `SHUD/src/classes/Model_Control.cpp`:144-145；`SHUD/src/classes/Model_Control.hpp`:112；`SHUD/src/Model/shud.cpp`:203-213
- .cfg.ic header 第三个数由 writer 写入模拟时间 `t`（分钟；如 5256000.0 / 1440 = **3650 天**）；TabularData reader 只扫描前两个整数，不使用第三个值 — Source: `SHUD/input/ccw/ccw.cfg.ic`:1；`SHUD/src/ModelData/MD_update.cpp`:226-235；`SHUD/src/Model/shud.cpp`:73-88；`SHUD/src/classes/TabularData.cpp`:31-32
- 1440 分钟 = 1 天，是最常见的转换因子 — Source: `SHUD/src/classes/Model_Control.cpp`:89-90

## 输入文件通用解析模式 (TabularData)

- 第一行: `NumRows NumCols`（空格分隔） — Source: `SHUD/src/classes/TabularData.cpp`:31-32
- 第二行: 列名 header（空格/tab 分隔） — Source: `SHUD/src/classes/TabularData.cpp`:41；`SHUD/input/ccw/ccw.sp.att`:2
- 数据行: 空格/tab 分隔，用 `strtold()` 解析（long double 精度） — Source: `SHUD/src/classes/TabularData.cpp`:42-46

## .sp.mesh — 双段结构

- 第一段: 元素表，列序 `ID Node1 Node2 Node3 Nabr1 Nabr2 Nabr3 Zmax` — Source: `SHUD/input/ccw/ccw.sp.mesh`:1-2
- 第二段: 节点表，列序 `ID X Y AqDepth Elevation` — Source: `SHUD/input/ccw/ccw.sp.mesh`:1150-1151
- 两段有各自的 `NumRows NumCols` header — Source: `SHUD/input/ccw/ccw.sp.mesh`:1-2、1150-1151；`SHUD/src/ModelData/MD_readin.cpp`:199、219

## .sp.att — 列序固定，位置访问

- ccw 数据文件列序: `INDEX SOIL GEOL LC FORC MF BC SS ilake` — Source: `SHUD/input/ccw/ccw.sp.att`:2
- C++ 代码按列号访问：`tb.x[i][0]` 为 INDEX（此处忽略），SOIL 从 `tb.x[i][1]` 读取 — Source: `SHUD/src/ModelData/MD_readin.cpp`:252-261
- BC 可为负值（= Dirichlet 边界条件） — Source: `SHUD/src/classes/Element.hpp`:53-56；`SHUD/src/ModelData/MD_readin.cpp`:266-271
- iLake > 0 → 全局设置 `lakeon = 1` — Source: `SHUD/src/ModelData/MD_readin.cpp`:261-264

## .sp.riv — 双段结构

- 第一段: 河段表 `Index Down Type Slope Length BC` — Source: `SHUD/input/ccw/ccw.sp.riv`:1-2
- Down < 1 = 外部出口（如 -3） — Source: `SHUD/input/ccw/ccw.sp.riv`:3；`SHUD/src/ModelData/MD_readin.cpp`:152-154
- 输入文件中 Slope 可为负值（实际数据中有 -0.002705109） — Source: `SHUD/input/ccw/ccw.sp.riv`:9
- 第二段: 河型参数 `Index Depth BankSlope Width Sinuosity Manning Cwr KsatH BedThick` — Source: `SHUD/input/ccw/ccw.sp.riv`:106-107

## .para.soil — 隐式单位转换

- soil 的 `infKsatV` 和 `macKsatV` 读入时除以 1440（m/day → m/min） — Source: `SHUD/src/ModelData/MD_readin.cpp`:288-297
- soil 的 Beta 乘以校准因子后若 < 1.1，先输出 warning，再强制为 1.1 — Source: `SHUD/src/classes/ModelConfigure.cpp`:76-84

## .cfg.calib — 两种参数语义

- 无后缀 = 乘法因子: `GEOL_KSATH 1` → 参数 *= 1 — Source: `SHUD/src/classes/ModelConfigure.cpp`:135-137、97-101
- 带 `+` 后缀 = 加法: `RIV_DPTH+ 0` → 参数 += 0 — Source: `SHUD/src/classes/ModelConfigure.cpp`:211-216；`SHUD/src/classes/River.cpp`:35-38
- 共 35+ 校准参数 — Source: `SHUD/input/ccw/ccw.cfg.calib`:1-38

## .cfg.para — 非标准 key-value

- 按行读取时跳过**首字节**为 `#`、`\n`、`\0`、空格的行 — Source: `SHUD/src/classes/Model_Control.cpp`:109-113
- 首字节为 tab 的行不被跳过，随后 `sscanf(str, "%s %lf", ...)` 接受 key 前的空白（包括 tab 后的空格）；这与首字节为空格的整行被忽略不同 — Source: `SHUD/src/classes/Model_Control.cpp`:110-114
- key 大小写不敏感（`strcasecmp`）；`START`/`END` 读取到以天计的 `DayStart`/`DayEnd` — Source: `SHUD/src/classes/Model_Control.cpp`:116-149
- Harness 提交与 `shud:tiny` 共用 END 更新器：仅替换有效 END 条目的数值，保留 key 大小写、其它字节、注释与行尾；要求覆盖时若没有有效 END 则失败。更新作用于复制后的输入，不改原输入；`input_bytes` 统计 END 改写前实际复制的文件字节 — Source: `packages/dsh-shud-jobs/src/shud-end.ts`:5-21；`packages/dsh-shud-jobs/src/shud-input.ts`:105-126；`packages/dsh-shud-jobs/src/shud-submissions.ts`:168-174；`scripts/runtime/shud-tiny.sh`:17-19

## forcing.csv — 非标准 CSV header

- 第一行: `NumRows NumCols StartDate(YYYYMMDD) EndDate(YYYYMMDD)` — Source: `SHUD/input/ccw/forcing.csv`:1
- 第二行: 列名 `Time_Day APCP TMP SPFH UGRD DSWRF` — Source: `SHUD/input/ccw/forcing.csv`:2
- 循环缓冲区 `MAXQUE=10000`，超出时分块懒加载 — Source: `SHUD/src/Model/Macros.hpp`:36；`SHUD/src/classes/TimeSeriesData.cpp`:33-36、45-88

## 二进制输出格式

- Header: 1024 字节 char header（默认全零，当前调用链未设置变量名或 magic），然后是以 double 写出的起始日期字段、NumVar、column indices。起始日期字段来自 `ForcStartTime`（YYYYMMDD，如 20000101），不是模拟起止时间的分钟值 — Source: `SHUD/src/classes/Model_Control.hpp`:17；`SHUD/src/classes/Model_Control.cpp`:239-259、328-329；`SHUD/src/ModelData/MD_initialize.cpp`:242-258；`SHUD/src/ModelData/MD_readin.cpp`:375-376；`SHUD/input/ccw/ccw.tsd.forc`:1
- 数据: `[Time double][NumVar 个 values double]` 顺序写入 — Source: `SHUD/src/classes/Model_Control.cpp`:408-414
- Native endian，无记录分隔符 — Source: `SHUD/src/classes/Model_Control.cpp`:408-414
- Flux 变量累积后除以 NumUpdate, tau=1440; Storage 变量瞬时, tau=1.0 — Source: `SHUD/src/classes/Model_Control.cpp`:298-302、321-325、360-364、396-400、436-457
- 不检查 NaN，可能写入 NaN 值 — Source: `SHUD/src/classes/Model_Control.cpp`:408-414

## CVODE 集成

- BDF 方法, SPGMR 线性求解器 — Source: `SHUD/src/Equations/cvode_config.cpp`:162-176
- MinStep=1e-6 分钟, MaxNumSteps=1e6 — Source: `SHUD/src/Equations/cvode_config.cpp`:182-185
- 失败时 `exit(ERRCVODE=19)`，无恢复 — Source: `SHUD/src/Equations/cvode_config.cpp`:4-30；`SHUD/src/Equations/functions.cpp`:10-35；`SHUD/src/Model/Macros.hpp`:81

## 状态向量布局

以下描述串行拼接向量；拆分求解路径使用五个独立向量，不应套用这些偏移 — Source: `SHUD/src/ModelData/MD_initialize.cpp`:113-147；`SHUD/src/Model/shud.cpp`:62-67、169-178

- y[0..NumEle-1] = 地表水深 — Source: `SHUD/src/Model/Macros.hpp`:21；`SHUD/src/ModelData/Model_Data.cpp`:73
- y[NumEle..2*NumEle-1] = 非饱和带 — Source: `SHUD/src/Model/Macros.hpp`:22；`SHUD/src/ModelData/Model_Data.cpp`:73
- y[2*NumEle..3*NumEle-1] = 地下水 — Source: `SHUD/src/Model/Macros.hpp`:23；`SHUD/src/ModelData/Model_Data.cpp`:73
- y[3*NumEle..3*NumEle+NumRiv-1] = 河道 — Source: `SHUD/src/Model/Macros.hpp`:24；`SHUD/src/ModelData/Model_Data.cpp`:73
- y[3*NumEle+NumRiv..3*NumEle+NumRiv+NumLake-1] = 湖泊 — Source: `SHUD/src/Model/Macros.hpp`:25；`SHUD/src/ModelData/Model_Data.cpp`:73

## 构建系统

- SUNDIALS 路径硬编码 `$(HOME)/sundials` — Source: `SHUD/Makefile`:28
- OpenMP 路径硬编码 macOS `/usr/local/opt/libomp/` — Source: `SHUD/Makefile`:37-38
- 两个可执行文件: `shud`(serial) 和 `shud_omp`(OpenMP) — Source: `SHUD/Makefile`:43-44、116-132

## 退出码

- 0=成功, 10=NaN, 12=文件IO, 13=数据输入, 19=CVODE失败, 20=一致性检查 — Source: `SHUD/src/Model/Macros.hpp`:77-82；`SHUD/src/Equations/functions.cpp`:10-35

## 审查清单（涉及 SHUD 解析 / 时间 / 参数 / 二进制输出的 diff）

reviewer 只标注需要人工确认的位置，不下结论；无法确定单位的时间值标 `[UNCERTAIN]`。

### 时间单位

- [ ] 对代码中每个涉及时间值的位置，标注该位置实际使用的单位（天/分钟/秒）
- [ ] 验证 forcing CSV 读取是否有 `* 1440`（天 → 分钟）转换
- [ ] 验证 LAI/MF 时序读取是否有同样的 `* 1440` 转换
- [ ] 区分 .cfg.para 的 `START`/`END`（天，转分钟需乘 1440）与其它时间参数，逐字段核对单位，禁止统一假定为分钟
- [ ] 验证 rSHUD read_output() 的时间是否做了 `* 60`（分钟 → 秒）再加到 POSIXct
- [ ] 如果代码向报告 / RunRecord 输出时间，标注最终单位是什么

### 校准参数语义

- [ ] 验证代码是否区分乘法参数和加法参数（+后缀）
- [ ] 检查参数名解析是否处理了尾部 `+` 字符
- [ ] 验证 KsatV / macKsatV 是否除以 1440（m/day → m/min）

### 二进制输出解析

- [ ] 验证是否处理了两种头格式（version > 1.0 的 1024 字节头 vs version 1.0 的简单头）
- [ ] 验证 endian 假设是否与目标平台一致
- [ ] 检查是否有 NaN 检测（SHUD 不做 NaN 检查，输出可能含 NaN）
- [ ] 验证 flux vs storage 变量的平均方式是否不同（tau=1440 vs tau=1）

### 输出变量

- [ ] 如果代码引用 SHUD 输出变量名，验证拼写与 SHUD 源码一致
  （如 `eleysurf`, `eleygw`, `rivqdown` — 不是 `ele_y_surf` 或 `river_q_down`）

### SHUD 输入文件解析（文件级）

- [ ] .mesh 解析: 验证是否处理了双段结构（元素表 + 节点表，各有独立 header）
- [ ] .att 解析: 验证列访问方式（列序固定: INDEX SOIL GEOL LC FORC MF BC SS iLake）
- [ ] .att: 检查是否处理了 BC 负值（= Dirichlet 边界条件）
- [ ] .riv 解析: 验证是否处理了双段（河段 + 河型参数）
- [ ] .riv: 检查是否允许负 slope 值
- [ ] .cfg.para: 验证 key 大小写不敏感，首字节空格行被跳过但 tab 开头行可解析；END 覆盖保留无关字节且只修改副本
- [ ] .cfg.calib: 验证是否区分乘法/加法（+后缀）参数
- [ ] forcing.csv: 验证 header 解析（第一行 4 个值: NumRows NumCols StartDate EndDate）
- [ ] TabularData 通用: 验证是否用空格/tab 分隔（不是逗号）


### 数据安全

- [ ] `<data_root>/raw/` 只读：位于 workspace root 之外，由 Seatbelt 拒写（ADR-0004 治理不变式）；任何解析代码不得在该目录下创建临时文件。
