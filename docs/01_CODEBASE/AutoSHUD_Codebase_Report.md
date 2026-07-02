# AutoSHUD 代码库现实报告

**日期**: 2026-07-02
**基线**: f421445 (detached at origin/master, tag `v2.5.0` 之后 5 个 commit; README:9 自称 "v2.5.0 release candidate")
**语言**: R 脚本集合 (非 R 包)；无任何运行时版本标识 (无 DESCRIPTION/VERSION, 版本仅 README 硬编码 + git tag)

自旧基线 1cbec6f 以来约 40 提交: Phase 1 空间栈迁移 raster/sp/rgeos/rgdal → terra/sf (#1)、Phase 2 rSHUD API 迁移到 v3 snake_case (#2)、ERA5 CSV forcing 分支 (#8)、Step1/Step3 forcing 健壮化 (#11)、9035800 acceptance 测试 (#13/#15)、CMFD glob 锚定修复 (f421445)。

## 1. 项目结构

```
AutoSHUD/
├── GetReady.R                    # 环境初始化 + 配置加载 + rSHUD API 兼容层 (228 行)
├── Setp0.1_Delineation.R         # 流域划分 (WhiteBox, 可选; 文件名拼写仍是 "Setp")
├── Step1_RawDataProcessng.R      # 原始数据标准化 (113 行)
├── Step2_DataSubset.R            # 多源数据整合入口 (60 行, 分支逻辑已下沉 Rfunction)
├── Step3_BuidModel.R             # 网格生成 + SHUD 输入文件生成 (357 行, 最复杂)
├── Step4_SHUD.R                  # SHUD 构建运行调用器 (21 行, 逻辑在 Step4_SHUDRunner.R)
├── Step5_ResultVisualization.R   # 结果可视化 (30 行)
├── Step5_WaterBalance.R          # 水量平衡分析 (14 行)
├── All.R                         # 仅串联 Step1-3 (共 3 行 source)
├── Rfunction/                    # 36 个辅助 R 函数 (共约 6,100 行)
│   ├── ReadProject.R             # 配置解析器 (296 行, 键表在 :60-151)
│   ├── Step2_ForcingDispatch.R   # 气象源条件分支 (205 行)
│   ├── Step3_ForcingHardening.R  # forcing 数据健壮化 (652 行, #11)
│   ├── Step4_SHUDRunner.R        # SHUD 构建/运行 runner (798 行, 核心)
│   ├── Step5_PostProcessing.R    # 后处理逻辑 (532 行)
│   ├── ERA5_NC2CSV.R             # ERA5 NC→CSV (1,421 行, #8 新增)
│   ├── CMFD_*.R / CMIP6_*.R      # 中国气象驱动 / CMIP6 气候情景
│   ├── GLDAS_*.R / FLDAS_*.R / NLDAS_*.R # 全球/区域陆面同化数据
│   ├── getDEM.R                  # DEM 获取 (ASTER GDEM)
│   └── ...
├── SubScript/                    # 20 个可选子脚本
│   ├── Sub2.1_Soil_ISRIC_SoilGrids.R / Sub2.1_Soil_SSURGO.R / Sub_iSoil_*.R
│   ├── Sub2.2_Landcover_GLC.R / Sub2.2_Landcover_nlcd.R
│   ├── Sub2.3_Forcing_LDAS.R / Sub2.3_Forcing_0.4NLDAS.R
│   └── Sub3_lake.R
├── Example/                      # 示例: 9035800/ (美国) + Lijiayan/ (中国)
│   ├── 9035800.autoshud.txt      # 配置模板 (50 行)
│   ├── 9035800.autoshud.v3test.txt
│   └── ljy.autoshud.txt
├── tests/                        # 6 个 acceptance/hardening 测试 (新增, 见 §7)
├── testdata/9035800/             # 自含测试 fixture (裁剪版 DEM/土壤/地表数据)
├── scripts/                      # make-9035800-step123-fixtures.R + tag-v2-freeze.sh
├── openspec/                     # 4 个特性的 change 设计档
├── docs/                         # 发布/测试文档
└── Table/                        # 查找表 (USGS_GLC.csv, nlcd.csv)
```

## 2. 工作流水线

```
GetReady.R (配置加载 + terra/sf/rSHUD 库加载 + v2.2/v2.5 API 兼容包装层 :97-227)
    ↓
Step0.1 流域划分 (可选, WhiteBox D8 流向; 不在 All.R 中)
    ↓
Step1 原始数据标准化 (边界/DEM/河网/湖泊 → PCS/GCS 重投影; forcing 转换以小时计)
    ↓
Step2 多源数据整合 (按配置选择, dispatch 在 Step2_ForcingDispatch.R:160-202)
    ├→ 土壤: HWSD (0.1) | ISRIC (0.2) | SSURGO (0.3) | 本地 (≥1)
    ├→ 地表覆盖: GLC/USGS (0.1) | NLCD (0.2) | 本地 (≥1)
    └→ 气象: CLDAS (0.1) | FLDAS (0.2) | GLDAS (0.3) | NLDAS (0.4) | CMFD (0.5)
           | CMIP6 (0.6) | ERA5 (0.7, #8 新增) | 本地 (≥1)
    ↓
Step3 建模 (三角网格 → 属性提取 → 全套 SHUD 输入: mesh/riv/rivseg/att/ic/
         para.{lc,soil,geol}/forc/cfg.{para,calib}/lai/rl/mf, 写出在 :312-328)
    ↓
Step4 构建运行 (内置 runner, 见下)
    ↓
Step5 后处理 (Step5_ResultVisualization.R / Step5_WaterBalance.R → autoshud_step5_run)
```

`All.R` 仅串联 Step1-3；Step4/5 独立调用；步骤间纯文件驱动、可独立重跑。

**Step4 内置 SHUD runner** (Step4_SHUD.R → `autoshud_step4_run_case`, Step4_SHUDRunner.R):
- **源码解析链** (Step4_SHUDRunner.R:212-252, 优先级): 显式参数 → `getOption("autoshud.shud_source")` → 环境变量 `AUTOSHUD_SHUD_SOURCE` / `AUTOSHUD_SHUD_SOURCE_DIR` → 配置键 `shud.source` (ReadProject.R:121) → 默认 `../SHUD`；候选目录必须含 `Makefile` 和 `src/`。**无 git clone 回退**——旧版"Step4 通过 git clone 获取 SHUD"已不成立, 依赖本地已 checkout 的 SHUD 源码
- **构建 + 运行 + 超时**: `make shud` 构建后运行; 超时经环境变量 `AUTOSHUD_SHUD_BUILD_TIMEOUT` (默认 600s) / `AUTOSHUD_SHUD_RUN_TIMEOUT` (默认 1800s) / `AUTOSHUD_SHUD_THREADS` (默认 1) (Step4_SHUD.R:13-15)
- **产出校验**: 运行后强制校验 15 个必需输出变量 (`AUTOSHUD_STEP4_REQUIRED_OUTPUTS`, Step4_SHUDRunner.R:6-10): eleysurf, eleyunsat, eleygw, elevprcp, elevetp, elevinfil, elevrech, eleqsurf, elevettr, elevetic, elevetev, rivystage, rivqdown, rivqsub, rivqsurf

## 3. 配置系统

文件格式: `.autoshud.txt` (空格/制表符分隔键值对, 支持 `#` 注释与空行, ReadProject.R:47-52)。键表在 ReadProject.R:60-151, 共 42+ 键:

- **必需**: `prjname`、`startyear`/`endyear`、`dir.out`、`dout.forc`、`fsp.wbd`、`fsp.stm`、`fr.dem`
- **数据源选择** (:60-62): `Soil` (0.1-0.3 | ≥1)、`Landuse` (0.1-0.2 | ≥1)、`Forcing` (0.1-0.7 | ≥1)
- **条件必需**: 按源选择要求 `dir.soil` / `fn.soil`+`fn.geol`+`fa.soil`+`fa.geol` / `fn.landuse`+`tab.landuse` / `dir.ldas` / `dir.era5`
- **ERA5 专属** (:77-90, #8 新增 13 键): `era5.buffer.deg`、`era5.lon.mode`、`era5.file.pattern`、`era5.max.{sites,timesteps,vars,files,bytes,read.bytes}`、`era5.max.discovery.{depth,entries,dirs}`、`era5.time.chunk`
- **可选带默认**: `MaxArea`(1)、`NumCells`(1000)、`AqDepth`(10)、`MinAngle`(31)、`flowpath`(0)、`MAX_SOLVER_STEP`(2)、`CRYOSPHERE`(0)、`STARTDAY`/`ENDDAY`、`tol.wb`、`tol.rivlen`、`RivWidth`/`RivDepth`、`QuickMode`、`DistBuffer`、`local.forcing.max.{bytes,rows,cols}` (#11)、`shud.source`、`fsp.crs`、`fsp.forc`、`fsp.lake`、`fn.pfactor`

## 4. 依赖

R 包 (GetReady.R:82-90): **terra (≥1.7-0), sf (≥1.0-0), rSHUD (≥2.5.0)**, lattice, ggplot2, hydroTSM, hydroGOF, xts；whitebox 仅 Step0.1 用。
**raster/sp/rgeos/rgdal 已全部移除** (Phase 1 迁移完成, 无残留 import)。
系统: R ≥ 4.0, GDAL, SUNDIALS, C++ 编译器；SHUD 源码需本地 checkout (不再依赖 Git 在线 clone)。

GetReady.R:97-227 提供 rSHUD v2.2/v2.5 双 API 兼容包装 (`write_*`/`write.*` 互映射、`mesh_to_sf`、`shud.rivseg`、`shud.att` 的 terra 兼容), Step3 全部写出调用经此层, 对 rSHUD 版本差异免疫。

## 5. 对 Harness 的关键接口

- **与 rSHUD 的关系**: 经 GetReady 兼容层调用 v3 snake_case API (`shud.triangle()`, `write_mesh()`, `write_river()` 等); 要求 rSHUD ≥ 2.5.0
- **与 SHUD 的关系**: Step4 源码解析链的环境变量 `AUTOSHUD_SHUD_SOURCE` 正是 Harness StackLock 注入点; 构建/运行/超时/15 变量校验全部内置 (15 变量 = rSHUD `get_default_variables()` 16 变量去掉 eleysnow/eleveta、加 eleqsurf)
- **配置驱动**: `.autoshud.txt` → `read.prj()` → `xfg` 配置对象
- **输出产物**: 完整 SHUD 输入文件集 + 运行结果 (`output/<prj>.out`) + SHUDtb 图表/摘要
- **可测试性**: tests/ 下 acceptance 套件可直接作为 Harness 的 engineering regression 层 (Domain_CLI_Spec §6 推荐)

## 6. 版本状态

- tags: `1.0`, `v2.0.0`, `v2.5.0`；HEAD = f421445 = v2.5.0 + 5 commits (step4-5 acceptance 对齐 #15 + CMFD glob 修复 #17)
- 远程分支: origin/master (当前), origin/maint/v2.x (维护线)
- README.md + README_cn.md (中文版 #4 新增) 硬编码声明 "v2.5.0 release candidate"
- `scripts/tag-v2-freeze.sh`: 发布自动化 (release marker 校验 / dry-run / GitHub tag+Release)
- openspec/changes/: 4 个特性的 proposal/design/spec/tasks 设计档 (ERA5、step123/step45 acceptance 等)

## 7. 测试与 Fixture (v2.5.0 新增维度)

| 测试 | 覆盖 |
|------|------|
| test-9035800-step123-acceptance.R | Step1-3 端到端 (testdata fixture 驱动) |
| test-9035800-step45-acceptance.R | Step4-5 端到端 (真实 SHUD 构建+运行) |
| test-era5-forcing.R | ERA5 分支 (发现/限额/经度模式/多文件) |
| test-step-forcing-hardening.R | Step1/3 forcing 健壮化 (#11: 单行 forcing、解析限额) |
| test-step4-runner-hardening.R | Step4 源码解析/路径安全/超时 |
| test-step5-postprocessing.R | Step5 后处理与可视化 |

fixture: `testdata/9035800/` 自含最小数据集 (由 `scripts/make-9035800-step123-fixtures.R` 从 Example 数据裁剪生成) + `testdata/9035800/9035800.acceptance.autoshud.txt` 配置。运行方式为 Rscript 直跑 (非 R 包 testthat 结构)。

## 8. 与 Domain_CLI_Spec §2.3/§6 的交叉校验

一致项: 键表规模 (实测 42+ ⊇ spec "39+")、超时默认 600s/1800s、`AUTOSHUD_SHUD_SOURCE` 覆盖机制、All.R 仅串 Step1-3、Forcing=0.5 → CMFD (ForcingDispatch:184)、§6 步骤→脚本映射、`Example/9035800.autoshud.txt` 存在、Step4 必需输出 15 变量。

偏差 (以代码为准):
1. 行号微差: 源码解析链实际在 Step4_SHUDRunner.R:212-252 (spec 写 229-252)
2. spec §2.3 只列了 `AUTOSHUD_SHUD_{BUILD,RUN}_TIMEOUT` 两个注入环境变量, 代码还有 `AUTOSHUD_SHUD_THREADS` (默认 1) 与 `AUTOSHUD_SHUD_SOURCE_DIR` 别名
