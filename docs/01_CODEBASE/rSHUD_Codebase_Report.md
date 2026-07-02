# rSHUD 代码库现实报告

**日期**: 2026-07-02
**基线**: 2b7742e (= tag `v2.5.0`, DESCRIPTION Date 2026-05-05; detached HEAD)
**语言**: R, v2.5.0, R/ 49 文件 14,062 行, NAMESPACE 228 条导出 (226 `export()` + 2 `exportClasses()`)

自旧基线 d162db3 (v2.2.0) 以来跨 v2.3.0 → v2.4.0 → v2.5.0 共 48 提交, 主题: NAMESPACE 同步与旧 API 包装 (#2/#7)、R CMD check 清障与 PET 修复 (#5)、CRS guard (#11)、forcing 读取健壮化与 plot 修复 (#15)、河网几何校验 (#18)、v2.5.0 发布材料 (#4)。

## 1. 包结构

```
rSHUD/
├── R/                 # 49 源文件 (新增 validators.R、io_output.R 现代 I/O、river_processing.R 等)
├── man/               # 232 个 Rd 文档
├── vignettes/         # 5 个 RMarkdown: getting-started, gis-processing,
│                      #   hydrological-analysis, migration-guide, model-building
├── tests/testthat/    # 10 个 test-*.R + helper-data.R (+ tests/ 下 benchmark/ performance/ 目录)
├── data/              # 4 示例数据集 (sh, sac, waerma, shud)
├── src/               # Rcpp: RcppExports.cpp, polygonArea.cpp, triTopology.cpp
├── inst/              # MIGRATION_GUIDE.md
├── docs/release/      # v2.5.0 发布材料 (RELEASE_NOTES, CRAN checklist, cran-comments)
├── openspec/          # issue-18 河网校验的 change fixture
├── prepare_release.R  # 发布前检查脚本
├── DESCRIPTION        # Version 2.5.0, Depends R >= 4.0.0
└── NAMESPACE          # 228 导出声明
```

## 2. 核心能力分组

### A. I/O (输入/输出)
| 函数 | 文件 | 用途 |
|------|------|------|
| `read_mesh()` / `read_river()` / `read_att()` / `read_para()` | io_shud.R | 读 SHUD 输入 |
| `read_output()` | io_output.R:38 | 读 SHUD 二进制输出 (现代 API, 返回 xts) |
| `load_output_data()` | io_output.R:205 | 批量读输出 (现代 API, 带 metadata) |
| `get_default_variables()` | io_output.R:277 | 默认 16 变量集 |
| `read_tsd()` | io_timeseries.R | 读时间序列 (.tsd) |
| `readnc()` | io_netcdf.R | 读 NetCDF |
| `write_mesh()` 等 | io_shud.R | 写 SHUD 输入文件 |
| `readout()` / `loaddata()` | readout.R:15/:101 | **旧名, 仍完全导出且未标 deprecated** |

### B. 网格生成
| 函数 | 文件 | 用途 |
|------|------|------|
| `shud.triangle()` | mesh_generation.R | RTriangle 三角化 |
| `mesh_generation()` | mesh_generation.R | 非结构化三角网格 |
| `meshSinks()` | mesh_generation.R | 网格洼地识别 |

### C. 河网处理 (v2.5.0 新增几何校验 #18)
| 函数 | 文件 | 用途 |
|------|------|------|
| `calc_river_properties()` | river_network.R | 综合河道属性计算 |
| `calc_river_order()` | river_processing.R:40 | Strahler 河流等级 |
| `calc_river_downstream()` | river_processing.R | 下游关系 |
| `calc_river_path()` | river_processing.R:527 | 河流路径追踪 |
| `get_from_to_nodes()` | river_processing.R:345 | 起止节点提取 (无效几何返回 NA) |
| `.stop_invalid_river_geometry()` | river_processing.R:279 | 校验入口: 拒绝 <2 坐标 / 非有限坐标 / 首尾同点的线, 报错格式 `caller: invalid river geometry in N reach(es): segment X (ID Y): reason` |

### D. 水文分析
| 函数 | 文件 | 用途 |
|------|------|------|
| `wb.all()` | WaterBalance.R:9 | 完整水量平衡 |
| `wb.riv()` / `wb.ele()` / `wb.DS()` / `wb.lake()` | WaterBalance.R:65/123/199/228 | 分域水量平衡 |
| `PET_PM()` | PET.R:218 | Penman-Monteith 潜在蒸散 (#5 修复了单位归一与返回值) |
| `PTF()` | Func_PTF.R | 土壤水力参数转换函数 |

### E. 可视化
| 函数 | 文件 | 用途 |
|------|------|------|
| `plot_polygons()` | plot_spatial.R | 空间分布图 |
| `plot_hydrograph()` | plot_timeseries.R | 双面板水文过程线 |
| `plot_tsd()` | plot_timeseries.R | 通用时序图 (#15 修复: 不再关闭调用方图形设备) |
| `fdc()` | Hydro_obs.R | 流量历时曲线 |

### F. 自动建模
| 函数 | 文件 | 用途 |
|------|------|------|
| `shud_auto_build()` | autoBuildModel.R:35 | 完整自动建模流程 (主推, 入口强制 CRS guard) |
| `autoBuildModel()` | interface_main.R:611 | 高层接口 (兼容保留) |

### G. CRS 守卫 (v2.4.0 新增 #11)
| 函数 | 文件 | 用途 |
|------|------|------|
| `check_sf_projected_crs()` | validators.R:187 | sf 对象: 拒绝无 CRS / 经纬度 / 非投影 / 非米单位 |
| `check_raster_projected_crs()` | validators.R:220 | terra 栅格: 同上四项检查 |
| `check_projected_crs_type()` / `check_crs_units_metres()` | validators.R:291/:317 | PROJCRS 关键字 + 单位仅允许 metre/meter |
| `check_model_builder_crs_match()` | validators.R:261 | 拒绝建模输入之间的混合 CRS |

强制点: `shud_auto_build()` 对 domain/dem/rivers/forcing_sites/soil/geology/landcover 全部执行 (interface_main.R:233-253)。

旧空间 API (raster/sp 时代) 的弃用包装集中在 deprecated_wrappers.R 并带 `.Deprecated` 提示 (如 `MeshData2Raster()` → `mesh_to_raster()`)；但旧 I/O 名 `readout`/`loaddata` **不在其中**, 仍是无警告的正式导出。

## 3. 依赖

**Depends**: R (≥ 4.0.0)
**Imports** (DESCRIPTION:28-45): Rcpp, reshape2, ggplot2, gridExtra, grid, fields, xts, hydroGOF, zoo, terra (≥1.7-0), sf (≥1.0-0), RTriangle, proj4, gstat, abind, utils, lubridate, methods
**Suggests** (DESCRIPTION:49-60): testthat, knitr, rmarkdown, deldir, interp, whitebox, ncdf4, raster (legacy), sp (legacy), colorspace, ggpmisc, geos (≥0.2.0)
**Remotes**: shulele/RTriangle/pkg

rgdal/rgeos 已彻底移除；raster/sp 仅存于 Suggests 供兼容测试。

## 4. 测试覆盖

10 个 testthat 文件, 共约 6,180 行 (v2.2.0 → v2.5.0 大幅增长):
test-gis-core (1,189 行), test-river (1,340 行), test-io (912 行), test-mesh (710 行), test-plot (662 行), test-integration (476 行), test-projection (401 行), test-validation (224 行, CRS guard 负例含 feet 单位拒绝), **test-pet (138 行, 新增)**, **test-water-balance (127 行, 新增)**；另有 helper-data.R、testthat.R 入口与 benchmark/、performance/ 目录。

## 5. 对 Harness 的关键接口

- **SHUD 输入生成**: `shud_auto_build()` → 从 GIS 数据生成全套 SHUD 输入文件, 入口即 CRS guard
- **SHUD 输出解析**: `read_output(keyword, path)` → xts 时间序列
  - 二进制格式: 8-byte doubles (io_output.R:70); v2.0+ 有 1024 字节扩展头 = 128 个 double (io_output.R:73-78, 第 129 个 double 为起始时间, 第 130 个为数据列数)
  - `load_output_data(variables=get_default_variables())` 批量读, 默认 16 变量: eley{surf,unsat,gw,snow} + elev{prcp,infil,rech} + elev{etp,eta,etev,ettr,etic} + rivq{down,sub,surf} + rivystage
  - 错误面: 文件缺失/不可读 `stop()` (io_output.R:59,63); 文件不完整 `warning()` (io_output.R:93)
- **环境重建**: `shud.env(prjname, inpath, outpath)` (SHUD_Env.R:14-40) 重建 `.shud` 环境, 供无状态 Rscript 调用
- **水量平衡**: `wb.all(xl, ic=readic(), fun, plot)` 依赖 elevprcp/eleveta/elevetp/rivqdown/eleysurf/eleyunsat/eleygw；**注意 wb.* 系列的默认参数仍经旧名 `loaddata()` 取数** (WaterBalance.R:9,66,124,199,228)
- **网格↔空间**: `mesh_to_sf()`, `mesh_to_raster()` (gis_core.R)
- **参数估计**: `PTF()` 从土壤质地估算水力参数
- **版本探测**: `packageVersion("rSHUD")` 可靠 (DESCRIPTION 维护规范)

## 6. 与 Domain_CLI_Spec §2.2 的交叉校验

一致项: `shud.env` (SHUD_Env.R:14-40)、`load_output_data` (io_output.R:205-264)、`get_default_variables` 16 变量 (io_output.R:277-285)、`wb.all` 行号与依赖变量 (含 eleysurf)、io_output.R:59/63/93 错误语义、`wb.riv`/`wb.ele` 存在性。

偏差 (以代码为准):
1. spec 称 readout/loaddata 为 "deprecated 包装器"——代码中两者**未标记 deprecated**, 且 `wb.*` 默认参数在内部仍调用 `loaddata()`。CLI 若要求"现代 API 面", 调 `wb.*` 时必须显式传入 `xl=`(由 `load_output_data` 构造), 不能依赖其默认值
2. "现代 API 自 v2.5 稳定导出"从宽成立: `read_output`/`load_output_data` 实际自 v2.3.0 (Phase 0, #2) 起已导出, v2.5.0 是当前稳定 tag
