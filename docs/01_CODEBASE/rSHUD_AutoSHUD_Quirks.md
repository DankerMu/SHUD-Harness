---
status: living
canonical_for: [rshud-autoshud-quirks]
---

# rSHUD / AutoSHUD 已知问题与接口细节（审查用）

从 R 源码提取的接口事实，供审查未来 R 包装、水量平衡和前处理脚本的 implementer 与 reviewer 使用；对应 `openspec/project-profile.md` 的 "Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility" 风险包。本文不是 M2 `shud_collect` 的实现说明：M2 收集路径不调用 R。
每条标注出处；代码与本文矛盾时以代码为准并更新本文。原载 .agents/skills/shud-gov/knowledge/rshud-quirks.md（历史路径；2026-10-20 降级为文档，skill 已删除）。

重核基线：2026-10-26（UTC），rSHUD pin `2b7742e32ea323a57fd0a947dc2cea67bfd0afd1`，AutoSHUD pin `f421445340f70b8cb160ce58cefb066751628593`。本次仅核对钉版源码中的路径、行范围、签名、分支、调用关系与测试源码的存在及范围；未执行 R 程序、R 测试或模型，不代表科学正确性、区域适用性或端到端运行已验证。

路径闸只检查路径存在，不验证行号、函数签名或事实语义。本地文档闸/默认闸应先初始化钉版子模块；现有 checker 在根目录缺失时会跳过该根的路径声明，绿色结果不能代替此先决条件。CI 也应以实际钉版源码已检出后的路径检查为证据，而非完整历史深度。引用沿用独立反引号路径、行号在反引号外的格式 — Source: `scripts/docs/check_paths.py`:37-51

## read_output() — 二进制输出解析

- 现代函数完整签名：`read_output(keyword = NULL, file = NULL, path = get_output_path(), version = get_model_version(), format = c("modern", "legacy"), ascii = FALSE)`。`format` 经 `match.arg()` 校验后仅记入返回属性，不切换解析器或空间对象类型 — Source: `rSHUD/R/io_output.R`:38-45、66-134
- 不能把它与 legacy `readout(keyword, path = get('outpath', envir = .shud), ASCII = FALSE, ver = get('version', envir = .shud), file = file.path(path, paste0(get('PRJNAME', envir = .shud), '.', keyword, '.dat')))` 混为同一签名；参数名是 `ASCII` / `ver`，不是 `ascii` / `version` — Source: `rSHUD/R/readout.R`:15-18
- 两者均用 `readBin(fid, what = numeric(), n = 1e9, size = 8)` 读取 double — Source: `rSHUD/R/io_output.R`:66-70；Source: `rSHUD/R/readout.R`:20-24
- **两套头格式由 `version`（legacy 为 `ver`）决定，不由 `format` 决定**：
  - `> 1.0`：跳过前 128 个 double 的头区，start_time 为 #129，ncol_data 为 #130，列索引为 #131..#(130+ncol)，之后是数据 — Source: `rSHUD/R/io_output.R`:73-79；Source: `rSHUD/R/readout.R`:25-31
  - `<= 1.0`（不只是等于 1.0）：ncol_data 为 #1，start_time 为 #2，之后是数据，列索引生成 `1:ncol_data`，无 128-double 头区 — Source: `rSHUD/R/io_output.R`:80-86；Source: `rSHUD/R/readout.R`:32-37
- 不完整行的诊断不同：现代函数在 `nrow_data != nrow_total` 时发 `warning()`，legacy 发 `message()`。两者均先用 `round()` 得到行数，再按该行数索引数据并构造矩阵后继续；不能把它描述为总是向下截断到完整行 — Source: `rSHUD/R/io_output.R`:88-97；Source: `rSHUD/R/readout.R`:39-44
- 返回 `xts`，时间列的分钟乘 60 转秒，加到以 `%Y%m%d`、UTC 解析的起始日期上；列名来自列索引 — Source: `rSHUD/R/io_output.R`:114-133；Source: `rSHUD/R/readout.R`:56-64
- 数据列数 `<= 1` 时用 `cbind`，否则用 `rbind` 后交给 `xts::as.xts`。这是针对取列后形状的处理；仅有这两个分支，不能证明 `ncol=1` 的返回契约不一致 — Source: `rSHUD/R/io_output.R`:121-128；Source: `rSHUD/R/readout.R`:58-64

## wb.all() — 水量平衡

- `wb.all()` 调用 `getOutlets(pr)`；该函数已定义，读取 `pr@river[, 'Down']` 并返回 `Down < 0` 的行索引，也已导出 — Source: `rSHUD/R/WaterBalance.R`:19-22；Source: `rSHUD/R/River.R`:206-210；Source: `rSHUD/NAMESPACE`:85
- 现代 `get_river_outlets(rivers)` 接受含 `Down` 或 `downstream` 列的 `sf`，或下游索引 numeric vector，不是对上述 S4 输入的直接同形替换 — Source: `rSHUD/R/river_network.R`:504-525
- `wb.all()` 用单元面积占比加权 P/AET/PET；Q 只取出口列汇总，再除以总面积 — Source: `rSHUD/R/WaterBalance.R`:12-28
- 孔隙度计算实际在 `wb.DS()`：`g$ThetaS.m3_m3.[att$GEOL] * cfg.calib$GEOL_THETAS`，即按单元的地质类别取值再乘校准系数，不是整个模型共用无校准常数 — Source: `rSHUD/R/WaterBalance.R`:199-213

## I/O 已知问题

- `read_df()` 的 `for (i in 1:100)` 最多读取 100 个 block；提前退出按剩余行数判断，达到上限后直接返回，无额外的超限诊断 — Source: `rSHUD/R/io_shud.R`:795-825
- `readatt()` / `readsoil()` / `readgeol()` 是到 `read_att()` / `read_soil()` / `read_geol()` 的弃用包装，不在 Func_Get 中实现 — Source: `rSHUD/R/io_shud.R`:1337-1341、1397-1401、1407-1411
- 这些 reader 取 `read_df()` 的第一个表；底层 `read.table(..., header = TRUE, sep = sep)` 保留表头命名。不能把它们统称为按列号读取属性；真实的位置访问例子是 `getElevation()` 的 `pm@mesh[, 2:4]` / `pm@point[, 5]` — Source: `rSHUD/R/io_shud.R`:94-109、548-563、577-592、808-816；Source: `rSHUD/R/Func_Get.R`:6-12
- 验证因 reader 而异，不能笼统说“只有存在性检查”。独立的 lake block parser 检查头部整数、列名数、声明行数、逐行字段数及必需列，按 `while` 扫描 block；`read_lake_sp()` 使用该 parser，不受 `read_df()` 的 100-block 循环限制 — Source: `rSHUD/R/io_shud.R`:250-353、388-412、428-437
- `read_df(file, text = readLines(file), sep = '\t')` 的 tab 是可覆盖的默认参数，不是不可改变的硬编码分隔符 — Source: `rSHUD/R/io_shud.R`:795-816

## 全局状态依赖

- `.shud <- new.env()` 是包内共享环境，`shud.env()` 写入 PRJNAME、inpath、outpath、anapath、version 和 MASK；不能将其出处写成不存在的 Interface 文件 — Source: `rSHUD/R/ModelClasses.R`:158-160；Source: `rSHUD/R/SHUD_Env.R`:14-36
- legacy `readout()` 和 `shud.filein()` 的默认参数从 `.shud` 取值；使用这些默认值时需先提供相应状态，包装层应显式传参，而非断言全部 rSHUD API 都必须先调用 `shud.env()` — Source: `rSHUD/R/readout.R`:15-18；Source: `rSHUD/R/Project.R`:8-10
- 现代 output getter 在无有效环境值时分别回退到 `getwd()`、版本 `2.0`、项目名 `"model"`；这不等于输入文件已存在或所有 legacy 默认值也有兜底 — Source: `rSHUD/R/io_output.R`:319-349

## 包冲突

- `terra (>= 1.7-0)`、`sf (>= 1.0-0)` 是 Imports — Source: `rSHUD/DESCRIPTION`:28-45
- `raster` / `sp` 在 Suggests 中；依赖声明本身不证明它们与 terra 必然冲突，也不证明外部仓库的安装可用性 — Source: `rSHUD/DESCRIPTION`:49-60
- `GetReady.R` 加载 terra、sf、rSHUD，并按函数边界做兼容转换：例如 `SpatRaster` 到 raster、`sf` 到 Spatial；不是通过 detach terra 实现兼容 — Source: `AutoSHUD/GetReady.R`:82-90、145-163、204-227
- 当前依赖清单不列 rgeos/rgdal。其 CRAN 状态、外部安装失败或成功不属于此次钉版源码核查可证明的事实，不再沿用旧的日期断言 — Source: `rSHUD/DESCRIPTION`:26-60

## 投影硬编码

- 此节保留原审查主题，但 `crs.Albers(spx = NULL, ext = NULL)` **不是美国固定投影**：从输入范围推导参数；未显式给 ext 时，terra/sf 输入需有 CRS，并在必要时转到 EPSG:4326 再提取范围 — Source: `rSHUD/R/GIS_Projection.R`:34-38、57-95
- `x0` / `y0` 为范围中心四舍五入到 1 位，`dx` / `dy` 为跨度四舍五入到 2 位；若 `dx < 1`，`my = 0.25`，否则 `my = round(dy / 4, 2)`；标准纬线是 `y0 ± my`。结果字符串使用 `+proj=aea`、`+lon_0=x0`、WGS84、米单位 — Source: `rSHUD/R/GIS_Projection.R`:98-124
- 源码明确拒绝 legacy raster/sp 对象；范围推导不等于所有地区均已验证适用，也不能反推“非美国必错”。审查时仍须核对输入 CRS、范围及实际项目投影需求 — Source: `rSHUD/R/GIS_Projection.R`:40-95、98-124

## 测试覆盖缺口

- 以下是**测试源码存在及断言范围**，不是执行结果；不保留无法由此次核查证明的“139/161 tests”计数。
- output 测试段检查缺参、不存在文件、默认变量与导出函数；这些断言不是实际 SHUD 二进制输出解析或单列/多列形状的运行证明 — Source: `rSHUD/tests/testthat/test-io.R`:471-504
- mesh 测试示例检查三角形存在、对象类型和 `Area` 等列存在；这些断言本身不是最小角、面积误差等网格质量数值验证 — Source: `rSHUD/tests/testthat/test-mesh.R`:95-155、181-207
- 水量平衡测试已存在，涉及 `wb.DS()`、`wb.riv()`、`wb.all()`、`datafilter.riv()`，有数值断言，但使用 mock reader/面积等；不能写成“无验证测试”，也不能称为真实求解器输出验证 — Source: `rSHUD/tests/testthat/test-water-balance.R`:1-127
- rSHUD integration 源码包含 `auto_build_model()` / `quick_model()` 的输入类型与 smoke 检查，明确容许输入不完整时内部构建失败；AutoSHUD 另有 Step1–3 接受脚本，以及构建、求解器、Step5 接受脚本。脚本存在不证明本次端到端通过 — Source: `rSHUD/tests/testthat/test-integration.R`:128-157、382-418；Source: `AutoSHUD/tests/test-9035800-step123-acceptance.R`:305-338、354；Source: `AutoSHUD/tests/test-9035800-step45-acceptance.R`:306-347
- lake reader 另有 101-block 测试源码，不能把 `read_df()` 的上限推广到全部 I/O — Source: `rSHUD/tests/testthat/test-io.R`:838-856

## rSHUD 关键函数签名（工具包装参考）

- `shud.triangle(wb, dem = NULL, riv = NULL, hole = NULL, pts = NULL, q = 30, ...)` → `RTriangle::triangulate` 的返回对象。`a` / `S` 不是该函数的显式形参，更没有这里声明的 `a=5` / `S=NULL` 默认值；额外参数经 `...` 转发 — Source: `rSHUD/R/mesh_generation.R`:193-194、289-303
- `shud.mesh(tri, dem, AqDepth = 10, r.aq = dem * 0 + AqDepth)` → `SHUD.MESH` S4 对象 — Source: `rSHUD/R/MeshDomain.R`:44-50、141-145；Source: `rSHUD/R/ModelClasses.R`:31-33
- `shud.att(tri, r.soil = NULL, r.geol = NULL, r.lc = NULL, r.forc = NULL, r.mf = NULL, r.BC = NULL, r.SS = NULL, sp.lake = NULL)` → 含 INDEX/SOIL/GEOL/LC/FORC/MF/BC/SS/LAKE 的 data.frame — Source: `rSHUD/R/MeshDomain.R`:197-199、237-248、313-330
- `getArea(pm = read_mesh())` → numeric 面积向量：先调用 `mesh_to_sf()`，sf 分支将 `st_area()` 转为 numeric，terra 分支明确使用 `unit = "m"`；包装层需核对几何 CRS/单位，不能仅凭 numeric 返回值断言任意输入都已验证为 m² — Source: `rSHUD/R/Func_Get.R`:44-64
- `getElevation(pm = read_mesh())` → 各三角形三个节点高程的均值向量，按 mesh/point 的固定列位置计算 — Source: `rSHUD/R/Func_Get.R`:6-12

## AutoSHUD Pipeline

- `All.R` 只按顺序 source Step1_RawDataProcessng、Step2_DataSubset、Step3_BuidModel；不存在这里所称的“7 步严格顺序”总编排 — Source: `AutoSHUD/All.R`:1-3
- Step0.1 是独立 delineation 脚本，不在 All 的调用链中；Step4 及两个 Step5 脚本也是独立入口，不应把这些文件的编号直接当成必跑的严格序列 — Source: `AutoSHUD/Setp0.1_Delineation.R`:21-24、98-101；Source: `AutoSHUD/Step4_SHUD.R`:1-21；Source: `AutoSHUD/Step5_ResultVisualization.R`:10-19；Source: `AutoSHUD/Step5_WaterBalance.R`:1-10
- 下游依赖的是具体产物：Step4 检查必需模型输入存在且非空，Step5 检查必需输出并调用 reader；不能声称只要跳过任何编号步骤就必然缺文件（可能已有产物） — Source: `AutoSHUD/Rfunction/Step4_SHUDRunner.R`:1-4、403-419；Source: `AutoSHUD/Rfunction/Step5_PostProcessing.R`:231-269
- .autoshud.txt 项目配置采用 key-value 表；`read.prj()` 先过滤匹配 `^#` / `^ *$` 的行，再调用 `read.table(text = t2, header = F, row.names = 1)`；查询 key 时转为大写，缺键返回默认值。这里只描述可见预处理，不据此断言内联注释不受支持 — Source: `AutoSHUD/Rfunction/ReadProject.R`:22-55

## AutoSHUD 数据源 codes

- Soil：`0.1` 分派到 HWSD 实现（脚本文件名为 Sub_iSoil_0.2），`0.2` 到 ISRIC，`0.3` 到 US National SSURGO；`>= 1` 到本地 soil/geol 脚本，其余 `< 1` 值只输出 EMPTY option — Source: `AutoSHUD/Step2_DataSubset.R`:17-39
- HWSD 使用本地 hwsd.bil / hwsd.dbf；本地 soil/geol 分支使用配置文件及属性表。不再声称未核实的“本地 3GB”数据量 — Source: `AutoSHUD/SubScript/Sub_iSoil_0.2.R`:41-55；Source: `AutoSHUD/SubScript/Sub_iSoil_1.1.R`:1-12
- ISRIC 分支对本地 `*_250m.tif` 组织路径，调用 gdalwarp 后读取本地栅格；这不是自动联网下载分支，“ISRIC 需联网”不能作为该实现的前提。上游数据获取方式另行核对 — Source: `AutoSHUD/SubScript/Sub2.1_Soil_ISRIC_SoilGrids.R`:1-36
- SSURGO 的属性函数加载 soilDB 并调用 `SDA_query()`；这是需单独检查数据服务访问条件的调用边界，不应与 ISRIC 的本地文件路径混淆 — Source: `AutoSHUD/Rfunction/fun.SSURGO.R`:8-32
- Landuse：`0.1` → GLC，`0.2` → NLCD，`>= 1` 的本地分支目前只有注释；NLCD 使用配置的栅格和 nlcd 属性表。Step3 在 `ilanduse != 0.1` 时进入 NON GLC 分支并 `stop()`，不能把 Step2 分派标签当成全流程支持承诺 — Source: `AutoSHUD/Step2_DataSubset.R`:42-55；Source: `AutoSHUD/SubScript/Sub2.2_Landcover_nlcd.R`:2-23；Source: `AutoSHUD/Step3_BuidModel.R`:289-296
- Forcing：Step2 的 `> 1` 为本地分支、`< 0` 为 dummy 分支，两者没有该段转换动作；枚举分支是 `0.1` CLDAS、`0.2` FLDAS、`0.3` GLDAS、`0.4` NLDAS、`0.5` CMFD、`0.6` CMIP6、`0.7` ERA5。其余值（含 `1`）进入 WRONG LDAS CODE 错误，不应把 `0.1–0.6` 泛称为同一 LDAS 实现 — Source: `AutoSHUD/Rfunction/Step2_ForcingDispatch.R`:153-205
- Step3 自身以 `< 1` / `else` 分支区分 forcing；本地侧读取配置的空间 forcing 文件并调用覆盖与时间窗处理，没有为 `1.1` / `1.2` 分别实现独立分派。Step2 的 `> 1` 与 Step3 的 `>= 1` 边界也不能混写 — Source: `AutoSHUD/Step3_BuidModel.R`:120-153
- 失败行为须按实际分支确认，不是“每个 code 都调用不同子脚本”：本地/dummy 可无动作，CLDAS 分支显式检查转换脚本存在性并在缺失时停止，未知 forcing code 报错 — Source: `AutoSHUD/Rfunction/Step2_ForcingDispatch.R`:153-166、201-205

## AutoSHUD 对 rSHUD 的调用

- Step3 直接调用 `shud.triangle()`、`shud.mesh()`、`mesh_to_sf()` 和 `getArea(pm)`；还调用 `shud.att()`、`shud.rivseg()`、`shud.ic()`、`shud.para()`、`shud.calib()`，写盘后设置 `shud.env()` 并调用无参 `getArea()` / `MeshAtt()` — Source: `AutoSHUD/Step3_BuidModel.R`:66-75、204-211、230-257、341-343
- `sp.mesh2Shape()` 出现在 GetReady 为缺失 `mesh_to_sf` 提供的兼容分支中，不是 Step3 的直接调用；rSHUD 中该函数已弃用，发出 `.Deprecated("mesh_to_sf", ...)` 后委托给 `mesh_to_sf(pm, dbf, crs)` — Source: `AutoSHUD/GetReady.R`:117-124；Source: `rSHUD/R/mesh_generation.R`:447-450
- ReadProject 中 ENDDAY 默认值调用 `rSHUD::days_in_year(years)`；投影经 `autoshud_crs_albers_compat()` 调用 `rSHUD::crs.Albers`，先试 sf、错误时再试 Spatial；若配置的 CRS 文件存在则读取该文件。`getArea()` 的上述调用归属 Step3，不归属 ReadProject — Source: `AutoSHUD/Rfunction/ReadProject.R`:3-20、117、128-142；Source: `AutoSHUD/Step3_BuidModel.R`:75、341-343
- 兼容性须逐函数判断：GetReady 中既有现代 `shud.rivseg` 调用分支，也有 sf/terra 到 legacy 类的转换；rSHUD 的低层 mesh/attribute API 可转回现代类，但 `crs.Albers()` 明确拒绝 legacy 类。不能概括成“AutoSHUD 全用 legacy，而 rSHUD 全只接收现代类” — Source: `AutoSHUD/GetReady.R`:166-227；Source: `rSHUD/R/mesh_generation.R`:201-215；Source: `rSHUD/R/MeshDomain.R`:203-220；Source: `rSHUD/R/GIS_Projection.R`:40-55
- Step5 实际默认使用 legacy `rSHUD::readout` 并传 `ver = 2`，不是现代 `read_output(version = ...)` — Source: `AutoSHUD/Rfunction/Step5_PostProcessing.R`:231-249

## 审查清单（涉及 rSHUD 调用 / AutoSHUD pipeline 的 diff）

reviewer 只标注需要确认的接口假设；无法从代码确认的标 `[UNCERTAIN]` 并要求对照 R 源码。

### rSHUD 接口

- [ ] 如果调用 read_output()，验证 version（决定头格式）与 ascii 参数；若调用 legacy readout()，是否改用其真实 ver / ASCII 参数并区分 warning 与 message？
- [ ] 如果调用 wb.all()，是否核对已定义且导出的 getOutlets() 所需 S4 输入，而非假设函数缺失？若改用 get_river_outlets()，是否适配其 sf/numeric 输入？
- [ ] 如果依赖 read_df()，是否考虑 100-block 上限，并与使用独立 parser 的 lake reader 区分？
- [ ] 是否核对单列/多列 xts 的形状及列名契约，而非仅凭 ncol<=1 的 cbind/rbind 分支就认定返回结构不一致？

### rSHUD 已知问题（包装层不应复制）

- [ ] 是否区分带表头的属性 reader 与 Func_Get 中真实的按位置访问，避免在包装层无依据复制固定列号？
- [ ] 是否核对 crs.Albers() 的输入 CRS、范围推导（含 dx<1 分支）及项目适用性，而非假设美国硬编码或所有区域均适用？
- [ ] 是否显式传入路径/版本并核对剩余 .shud 默认依赖，而非把现代 getter 的兜底误当成所有 API 的保证？

### AutoSHUD Pipeline

- [ ] 如果实现 pipeline 调度，是否按 All.R 的 Step1→2→3、独立 Step0.1/Step4/Step5 入口及实际输入产物检查来安排，而非强制虚构的 7 步序列？
- [ ] 是否覆盖实际分支（soil 0.1/0.2/0.3/>=1；landuse 0.1/0.2/>=1 空分支及 Step3 非 GLC 停止；forcing 0.1–0.7、>1 本地、<0 dummy、非法值），且不将 1.1/1.2 标签当作不同实现？
- [ ] 是否核对 SSURGO/NLCD 对应的数据集及项目区域、本地文件和属性服务条件，并明确 ISRIC 分支消费本地栅格，而非沿用“ISRIC 必须联网”的前提？

