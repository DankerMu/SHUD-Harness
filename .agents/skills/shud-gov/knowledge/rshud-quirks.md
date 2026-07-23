# rSHUD / AutoSHUD 已知问题与接口细节

以下事实从 R 源码提取。每条标注出处。
如果代码已更新导致以下描述不准确，以代码为准并更新本文件。

## read_output() — 二进制输出解析

- 函数签名: `read_output(keyword, file, path, version, format, ascii)` — Source: rSHUD/R/readout.R
- 用 `readBin(fid, what=numeric(), n=1e9, size=8)` 读取 double — Source: rSHUD/R/readout.R
- **两套头格式由 version 决定**:
  - Version > 1.0: header(128 doubles), start_time(double #129), ncol_data(double #130), col_indices(#131..#130+ncol), 然后数据 — Source: rSHUD/R/readout.R
  - Version 1.0: ncol_data(double #1), start_time(double #2), 然后数据（无 128-double 头） — Source: rSHUD/R/readout.R
- 不完整文件: `nrow != nrow_total` 时输出 warning，用截断数据继续 — Source: rSHUD/R/readout.R
- 返回 `xts` 对象，时间列: 分钟 * 60 → 秒, 加到 POSIXct start_date — Source: rSHUD/R/readout.R
- xts cbind 在 ncol=1 时行为不同（返回结构不一致） — Source: rSHUD/R/readout.R line 59-61

## wb.all() — 水量平衡

- 引用 `getOutlets(pr)`，但 `getOutlets()` 在 codebase 中未定义 — Source: rSHUD/R/WaterBalance.R
- 假设: 所有降水/蒸发按面积加权，径流只测出口 — Source: rSHUD/R/WaterBalance.R
- 孔隙度视为常数（按地质类型） — Source: rSHUD/R/WaterBalance.R

## I/O 已知问题

- `read_df()` 硬编码 100 个 block 上限，超出静默截断 — Source: rSHUD/R/io_shud.R line 407
- `readgeol()` / `readatt()` / `readsoil()` 按列号访问，不是列名 — Source: rSHUD/R/Func_Get.R
- 文件存在性检查有，内容结构验证无 — Source: rSHUD/R/io_shud.R
- tab 分隔符硬编码 `sep='\t'` — Source: rSHUD/R/io_shud.R

## 全局状态依赖

- `.shud` 全局环境必须先通过 `shud.env()` 初始化 — Source: rSHUD/R/Interface.R
- 路径和版本信息存在 `.shud` 环境中 — Source: rSHUD/R/Interface.R

## 包冲突

- terra >= 1.7-0 和 sf >= 1.0-0 是现代依赖 — Source: rSHUD/DESCRIPTION
- raster/sp 是 legacy 依赖（Suggests 中），与 terra 冲突 — Source: rSHUD/DESCRIPTION
- GetReady.R 显式 detach terra 来避免冲突 — Source: AutoSHUD/GetReady.R
- rgeos/rgdal 已从 CRAN 移除，安装可能失败 — Verified: 2026-04-26

## 投影硬编码

- `crs.Albers()` 硬编码美国 Albers 投影 — Source: rSHUD/R/ReadProject.R line 98
- 非美国区域使用此函数会产生错误投影 — Verified: 2026-04-26

## 测试覆盖缺口

- test-io.R (139 tests): 无实际 SHUD 二进制输出的解析测试 — Source: rSHUD/tests/testthat/test-io.R
- test-mesh.R (161 tests): 无网格质量指标验证 — Source: rSHUD/tests/testthat/test-mesh.R
- 无水量平衡计算验证测试 — Verified: 2026-04-26
- 无端到端模型构建测试 — Verified: 2026-04-26

## rSHUD 关键函数签名（TS 包装参考）

- `shud.triangle(wb, q=30, a=5, S=NULL, riv=NULL, hole=NULL, pts=NULL)` → list(P, T) — Source: rSHUD/R/mesh_generation.R
- `shud.mesh(tri, dem, AqDepth=10, r.aq=NULL)` → S4 对象 — Source: rSHUD/R/mesh_generation.R
- `shud.att(tri, r.soil, r.geol, r.lc, sp.lake)` → data.frame — Source: rSHUD/R/Func_GIS.R
- `getArea(pm)` → numeric vector (m²) — Source: rSHUD/R/Func_Get.R
- `getElevation(pm)` → numeric vector — Source: rSHUD/R/Func_Get.R

## AutoSHUD Pipeline

- 7 步严格顺序: 0.1(Delineation) → 1(RawData) → 2(DataSubset) → 3(BuildModel) → 4(RunSHUD) → 5(Visualization+WaterBalance) — Source: AutoSHUD/
- 跳过任何步骤 → 后续步骤找不到输入文件 — Verified: 2026-04-26
- 配置文件 `.autoshud.txt`: key-value 对，`#` 注释 — Source: AutoSHUD/ReadProject.R

## AutoSHUD 数据源 codes

- Soil: 0.1(HWSD/本地3GB), 0.2(ISRIC/需联网), 0.3(SSURGO/仅美国) — Source: AutoSHUD/Step2_DataSubset.R
- Landuse: 0.1(GLC), 0.2(NLCD/仅美国) — Source: AutoSHUD/Step2_DataSubset.R
- Forcing: 0.1-0.6(各类 LDAS 变体), 1.1(本地站点), 1.2(多边形覆盖) — Source: AutoSHUD/Step2_DataSubset.R
- 每个 code 调用不同的子脚本，有不同的失败模式 — Verified: 2026-04-26

## AutoSHUD 对 rSHUD 的调用

- `shud.triangle()`, `shud.mesh()`, `sp.mesh2Shape()` — Source: AutoSHUD/Step3_BuidModel.R
- `crs.Albers()`, `days_in_year()`, `getArea()` — Source: AutoSHUD/ReadProject.R
- AutoSHUD 使用 legacy raster/sp，但调用的 rSHUD 函数需要 terra/sf — Source: AutoSHUD/GetReady.R
