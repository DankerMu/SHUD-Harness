# AutoSHUD 代码库现实报告

**日期**: 2026-04-24
**分支**: master (V3.x, clean)
**语言**: R 脚本集合 (非 R 包)

## 1. 项目结构

```
AutoSHUD/
├── GetReady.R                    # 环境初始化 + 配置加载
├── Setp0.1_Delineation.R         # 流域划分 (WhiteBox)
├── Step1_RawDataProcessng.R      # 原始数据标准化
├── Step2_DataSubset.R            # 多源数据整合 (条件分支)
├── Step3_BuidModel.R             # 网格生成 + SHUD 输入文件生成 (345 行, 最复杂)
├── Step4_SHUD.R                  # SHUD 编译与运行
├── Step5_ResultVisualization.R   # 结果可视化
├── Step5_WaterBalance.R          # 水量平衡分析
├── All.R                         # 执行 Step1-3
├── Rfunction/                    # 31 个辅助 R 函数
│   ├── ReadProject.R             # 配置解析器 (235 行)
│   ├── CMFD_*.R                  # 中国气象驱动数据处理
│   ├── GLDAS_*.R / FLDAS_*.R     # 全球陆面同化数据
│   ├── getDEM.R                  # DEM 获取 (ASTER GDEM)
│   ├── SoilGeol.R                # 土壤/地质提取
│   └── ...
├── SubScript/                    # 20 个可选子脚本
│   ├── Sub_iSoil_HWSD.R / ISRIC.R / SSURGO.R
│   ├── Sub2.2_Landcover_GLC.R / NLCD.R
│   ├── Sub2.3_Forcing_LDAS.R / NLDAS.R
│   └── Sub3_lake.R
├── Example/                      # 两个示例
│   ├── 9035800/                  # 美国流域 (含 .autoshud.txt)
│   └── Lijiayan/                 # 中国流域
└── Table/                        # 查找表 (USGS_GLC.csv, nlcd.csv)
```

## 2. 工作流水线

```
GetReady.R (配置加载)
    ↓
Step0.1 流域划分 (可选, WhiteBox D8 流向)
    ↓
Step1 原始数据标准化 (边界/DEM/河网/湖泊 → PCS/GCS 重投影)
    ↓
Step2 多源数据整合 (按配置选择土壤/地表/气象源)
    ├→ 土壤: HWSD (0.1) | ISRIC (0.2) | SSURGO (0.3) | 本地 (1.x)
    ├→ 地表覆盖: GLC (0.1) | NLCD (0.2) | 本地 (1.x)
    └→ 气象驱动: CLDAS/FLDAS/GLDAS/NLDAS/CMFD/CMIP6 (0.1-0.6) | 本地 (1.x)
    ↓
Step3 建模 (三角网格 → 属性提取 → SHUD 全套输入文件)
    ↓
Step4 编译运行 (git clone SHUD → make → ./shud)
    ↓
Step5 后处理 (可视化 + 水量平衡)
```

## 3. 配置系统

文件格式: `.autoshud.txt` (空格/制表符分隔的键值对)

关键参数:
- `prjname` — 项目名
- `startyear/endyear` — 模拟期
- `fsp.wbd/fsp.stm/fr.dem` — 空间数据路径
- `Forcing [0-2]` — 气象数据源选择
- `Soil [0-1]` — 土壤数据源选择
- `Landuse [0-1]` — 地表覆盖源选择
- `NumCells` — 目标网格数 (~800)
- `AqDepth` — 含水层深度 (m)
- `MaxArea/MinAngle` — 网格质量控制
- `CRYOSPHERE` — 冰冻圈模块开关

## 4. 依赖

R 包: raster, sp, rgeos, rgdal, **rSHUD**, lattice, ggplot2, hydroTSM, hydroGOF, xts, whitebox, terra
系统: R 3.x+, GDAL, Sundials, C++ 编译器, Git

## 5. 对 Harness 的关键接口

- **与 rSHUD 的关系**: AutoSHUD 重度依赖 rSHUD 的 `shud.triangle()`, `shud.att()`, `shud.river()`, `write.mesh()` 等函数
- **与 SHUD 的关系**: Step4 通过 `git clone` 获取 SHUD 源码, `make shud` 编译, `./shud` 运行
- **配置驱动**: `.autoshud.txt` → `ReadProject.R` → `xfg` 配置对象
- **输出产物**: 完整 SHUD 输入文件集 + 运行结果 + 可视化报告

## 6. 版本状态

- master = V3.x (开发中)
- `v2.0.0` tag = V2.x 稳定版
- `maint/v2.x` = V2.x 维护分支
- V3 主要变化: terra/raster 冲突处理, 参数扩展
