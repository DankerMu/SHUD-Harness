# rSHUD 代码库现实报告

**日期**: 2026-04-24
**分支**: master (clean)
**语言**: R, v2.2.0, ~12,267 行, 154 导出函数

## 1. 包结构

```
rSHUD/
├── R/               # 48 源文件
├── man/             # 211+ Rd 文档
├── vignettes/       # 5 个 RMarkdown
├── tests/testthat/  # 10 测试文件
├── data/            # 4 示例数据集 (sh, sac, waerma, shud)
├── src/             # Rcpp 编译代码 (polygonArea.cpp, triTopology.cpp)
├── inst/            # MIGRATION_GUIDE.md
├── DESCRIPTION      # 包元数据
└── NAMESPACE        # 154 导出声明
```

## 2. 核心能力分组

### A. I/O (输入/输出)
| 函数 | 文件 | 用途 |
|------|------|------|
| `read_mesh()` | io_shud.R | 读 .mesh 文件 |
| `read_river()` | io_shud.R | 读 .riv 文件 |
| `read_att()` | io_shud.R | 读 .att 文件 |
| `read_para()` | io_shud.R | 读 .para 配置 |
| `read_output()` | io_output.R | 读 SHUD 二进制输出 (.dat) |
| `read_tsd()` | io_timeseries.R | 读时间序列 (.tsd) |
| `readnc()` | io_netcdf.R | 读 NetCDF |
| `write_mesh()` | io_shud.R | 写 SHUD 输入文件 |

### B. 网格生成
| 函数 | 文件 | 用途 |
|------|------|------|
| `shud.triangle()` | mesh_generation.R | RTriangle 三角化 |
| `mesh_generation()` | mesh_generation.R | 非结构化三角网格 |
| `meshSinks()` | mesh_generation.R | 网格洼地识别 |

### C. 河网处理
| 函数 | 文件 | 用途 |
|------|------|------|
| `calc_river_properties()` | river_network.R | 综合河道属性计算 |
| `calc_river_order()` | river_network.R | Strahler 河流等级 |
| `calc_river_downstream()` | river_network.R | 下游关系 |
| `calc_river_path()` | river_network.R | 河流路径追踪 |

### D. 水文分析
| 函数 | 文件 | 用途 |
|------|------|------|
| `wb.all()` | WaterBalance.R | 完整水量平衡 |
| `PET_PM()` | PET.R | Penman-Monteith 潜在蒸散 |
| `PTF()` | Func_PTF.R | 土壤水力参数转换函数 |

### E. 可视化
| 函数 | 文件 | 用途 |
|------|------|------|
| `plot_polygons()` | plot_spatial.R | 空间分布图 |
| `plot_hydrograph()` | plot_timeseries.R | 双面板水文过程线 |
| `fdc()` | Hydro_obs.R | 流量历时曲线 |

### F. 自动建模
| 函数 | 文件 | 用途 |
|------|------|------|
| `shud_auto_build()` | autoBuildModel.R | 完整自动建模流程 |
| `autoBuildModel()` | interface_main.R | 高层接口 |

## 3. 依赖

**Imports**: terra (≥1.7.0), sf (≥1.0-0), proj4, RTriangle, ggplot2, xts, zoo, lubridate, hydroGOF, gstat, reshape2, Rcpp, abind
**Suggests**: testthat, ncdf4, whitebox, deldir, raster (legacy)

## 4. 测试覆盖

10 个测试文件: test-io, test-mesh, test-river, test-gis-core, test-plot, test-projection, test-integration, test-validation + benchmark/performance 目录

## 5. 对 Harness 的关键接口

- **SHUD 输入生成**: `shud_auto_build()` → 从 GIS 数据生成全套 SHUD 输入文件
- **SHUD 输出解析**: `read_output(keyword, path)` → 返回 xts 时间序列对象
  - 二进制格式: 8-byte doubles, v2.0+ 有扩展头 (1024 bytes)
  - 关键字: `eleygw`, `rivqdown`, `eleqprcp`, `eleqeta` 等
- **水量平衡**: `wb.all()` → 完整水量平衡检查
- **网格↔空间**: `mesh_to_sf()`, `mesh_to_raster()` → GIS 格式转换
- **参数估计**: `PTF()` → 从土壤质地估算水力参数
