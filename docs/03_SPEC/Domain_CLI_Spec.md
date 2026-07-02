# Domain CLI 规范（shud-harness 领域命令面）

**状态**：P0 设计规范（源自三仓库对齐审查，2026-07-02）
**事实基线**：SHUD@3aec657（无 tag，logo 串 "v2.0 2022"；上游加速线 tag cpu-accel-v1.0.2 指向其后 125 commits 的 db4ccdb）· rSHUD v2.5.0（228 导出函数）· AutoSHUD ≈v2.5.0-rc（f421445）
**目标**：把高频科学操作固化为确定性命令，成为 **T2 证据的唯一生产通道**；并为"三仓库持续演化 + 研究成果回流上游"的双向变更提供版本治理。

---

## 1. 定位与原则

1. **T2 唯一生产通道**：报告/warehouse 里的 deterministic 证据（metrics、水量平衡、对比结论）只能由本 CLI 产出。
   agent 在 sandbox 里仍可自由写 R/bash 做探索，但探索产物是 T3——进证据位必须经 CLI 重算
   （与 Context_Trust §2 的信任提升点定义一致）。
2. **参数化，不拼接**：agent 提供的一切取值（项目名、变量名、路径）作为 argv 传入，CLI 内部校验白名单/路径边界；
   LLM 生成的字符串不进入 shell 解释（与 Data_Storage_Provenance 的 SQL 参数化同构）。
3. **机器可读结果**：每条命令产出 result YAML（含 `schema_version`、`cli_version`、输入 digest、上游退出码），
   exit code 遵循 §5 契约。stdout 给人看，result 文件给机器用。
4. **确定性**：同输入同版本 → result 字节级一致（时间戳字段除外，单列不参与 digest）。
   这使 command_digest 幂等 key（Idempotency §4）和失败签名（Control_Kernel §5.1）稳定。
5. **不包探索**：一次性分析、绘图实验不进 CLI。命令面只收录重复出现的证据生产操作——
   每加一条命令都要有对应 fixture 与兼容测试，命令面膨胀=维护负担膨胀。
6. **与 patch 组同入口**：`shud-harness patch diff|bundle|revert`（Sandbox_and_Executor §3 定义）
   与本命令面共享同一可执行文件与 result 契约，本规范不重复其语义。

## 2. 命令面（v0.1，基于三仓库当前事实）

### 2.1 SHUD 求解器组

```text
shud-harness shud build [--omp] [--source <dir>] [--sundials <dir>]
shud-harness shud check <project> [--input <dir>]
shud-harness shud run   <project> [--threads N] [--calib <file>] [--output <dir>] [--timeout <s>]
```

**build**：包装 `make shud` / `make shud_omp`（Makefile:91-136）；SUNDIALS/CVODE v6.0.0 依赖检查
（`SUNDIALS_DIR` 默认 `$HOME/sundials`，Makefile:28）。产出 **build record**：

```yaml
build_record:
  schema_version: 1
  cli_version: 0.1.0
  shud_source_commit: 3aec657          # 关键：SHUD 无 --version，版本靠构建时记录源码 commit
  binary_sha256: sha256:...
  variant: serial | omp
  cvode_version: 6.0.0
  compiler: ...
```

run 前校验"binary sha256 ↔ build record"，杜绝"跑的是哪个版本不知道"。

**check**：输入校验命令，两层：
① 文件集完整性——按 IO.cpp:47-92 的清单校验必需文件
（`.sp.mesh/.sp.att/.sp.riv/.sp.rivseg/.cfg.para/.cfg.ic/.para.lc/.para.soil/.para.geol/.tsd.forc`），
可选文件缺失只记 warn；
② **dummy 运行**——`./shud -0 <project>`（CommandIn.cpp:28-29，加载全部输入输出、不计算），
让求解器自己的 reader 做格式校验，退出码非 0 即输入不自洽。这是"坏输入在提交 4 小时 job 前就死掉"的门。

**run**：包装 `./shud [-c calib] [-o outdir] [-n threads] <project>`（CommandIn.cpp:9-10）；
线程数经 `-n`（内部 `omp_set_num_threads`，shud.cpp:56）；进度解析 `<proj>.time.csv`
（`time_Minutes/Task_perc/CPUTime_s/WallTime_s/Num_fcall`，IO.cpp:186-189）供 job watcher 汇报。

**输入隔离（对抗审查 A07-6）**：SHUD 运行会把 `.cfg.ic.update` / `.bak` 类文件写回输入目录
（上游行为，见 01_CODEBASE/SHUD 报告），二次 run 的输入已被上次运行污染，inputs_digest 幂等破功。
CLI 契约：run 前把项目输入集复制/硬链到 run 工作目录，求解器对副本运行、源输入目录只读；
inputs_digest 对源输入求值，run 侧写产物（含 ic.update）全部留在 run 目录进 artifacts。

**SHUD 退出码 → harness 错误类别映射**（Macros.hpp:76-82，进 result.upstream_exit 并驱动 Error_Handling 分类）：

| SHUD exit | 含义 | harness category |
|---|---|---|
| 0 ERRSUCCESS | 正常 | success |
| 10 ERRNAN | 数值 NaN | `numerical_error` |
| 12 ERRFileIO | 文件 I/O | `workspace_error` |
| 13 ERRDATAIN | 输入数据错误 | `parser_error`（输入侧） |
| 19 ERRCVODE | CVODE 求解失败 | `numerical_error` |
| 20 ERRCONSIS | 一致性检查失败 | `numerical_error` |

stderr 模式（进失败签名）：`SUNDIALS_ERROR:`（cvode_config.cpp:11-22）、`MEMORY_ERROR:`、
`Warning: remove sink`（Model_Data.cpp:214）。
**诚实声明**：负状态被静默钳制为 0（MD_update.cpp:7-8，无日志）——负状态检测**不能**靠日志，
必须靠 `wb`/输出分析，RunRecord.numerical_health 的该项来源标注为 output-derived。

### 2.2 指标与水量平衡组（经 rSHUD v2.5.0 现代 API）

```text
shud-harness metrics <run-dir> --project <prj> [--vars v1,v2,...] [--daily] [--out <yaml>]
shud-harness wb      <run-dir> --project <prj> [--scope all|riv|ele] [--out <yaml>]
shud-harness compare <base-run> <cand-run> [--obs <csv>] [--out <yaml>]
```

**实现契约**：每次调用是无状态 Rscript——先 `shud.env(prjname, inpath, outpath)`（SHUD_Env.R:14-40，
重建 `.shud` 环境），再调**现代 API**：

- metrics：`load_output_data(variables=...)`（io_output.R:205-264）→ 逐变量 xts →（可选 `ts_to_daily`）→
  标准 metrics YAML；默认变量集 = `get_default_variables()` 的 16 个（io_output.R:277-285）；
- wb：`wb.all(xl=..., ic=readic(), fun=xts::apply.daily, plot=FALSE)`（WaterBalance.R:9-45，
  需要 elevprcp/eleveta/elevetp/rivqdown/eleysurf/eleyunsat/eleygw；xl 必须显式传入）→ 残差统计 + 阈值判定；
  `--scope riv|ele` 对应 `wb.riv`/`wb.ele`；
- **numerical_health（对抗审查 A07-2）**：wb 固定加载 5 个状态变量
  eleysurf/eleyunsat/eleygw/rivystage/lakystage（无湖流域跳过 lakystage 并在 result 记录），
  该集合**不受 --vars 影响**——负状态在 SHUD 内被静默钳零（无日志），只能输出侧检测：
  钳零特征（长零段 + 收支残差联合判定，启发式阈值实现期校准）计入 negative_state_count，
  连同 water_balance_residual / cvode_failures（stderr 解析）组成 **RunRecord.numerical_health
  的唯一生产通道**（Execution_Jobs_Runs §8）。--vars 只作用于 metrics 载荷；
- compare：产出 Controlled_Search 的 `BaselineComparisonRef`（same_stack_lock/same_data_id 校验 + metric_delta）；
  给 `--obs` 时经 hydroGOF 计算 NSE/KGE 等 GOF 指标。

**版本门**：CLI 要求 `packageVersion("rSHUD") >= 2.5.0`（现代 API `read_output`/`load_output_data` 自 v2.3.0 导出，
v2.5.0 为当前稳定 tag）；低版本直接拒绝（exit 4），不做静默 legacy 回退。
注意：旧名 `readout`/`loaddata` 在 v2.5.0 仍是**无 deprecated 标记**的正式导出，且 `wb.*` 系列默认参数内部走
`loaddata()`（WaterBalance.R:9,66,124,199,228）——CLI 调 `wb.*` 必须显式传 `xl=`（由 `load_output_data` 构造），
禁止依赖其默认取数路径（见 01_CODEBASE/rSHUD 报告 §6 偏差 1）。
rSHUD 错误映射：`stop()`（文件缺失/不可读，io_output.R:59,63）→ exit 3；
`warning`（文件不完整，io_output.R:93）→ result 中 `warnings[]` + exit 0 但 `complete: false`（不可作 accepted 证据）。

### 2.3 AutoSHUD 流水线组

```text
shud-harness autoshud check <cfg.autoshud.txt>
shud-harness autoshud step  <0.1|1|2|3|4|5> --config <cfg> [--workdir <dir>]
```

**check**：用 `read.prj()` 的键表（ReadProject.R:60-151，39+ 键）校验配置：必需键齐全、
数据源选择与条件键匹配（如 `Forcing=0.5` 则 `dir.ldas` 必须存在且有 CMFD 文件模式命中）、路径存在性。

**step**：逐步执行（实际步骤结构见 §6——**注意上游实际为 Step0.1 + Step1-5，共 5-6 步；
旧文档"7 步"说法以本节为准**）。CLI 注入的环境：

- `AUTOSHUD_SHUD_SOURCE` ← StackLock 锁定的 SHUD 路径（覆盖 Step4 源码解析链，Step4_SHUDRunner.R:212-252；
  别名 `AUTOSHUD_SHUD_SOURCE_DIR`）；
- `AUTOSHUD_SHUD_BUILD_TIMEOUT` / `AUTOSHUD_SHUD_RUN_TIMEOUT` / `AUTOSHUD_SHUD_THREADS`
  ← RunJob 超时与线程配置（默认 600s/1800s/1）。

### 2.4 版本探针

```text
shud-harness version [--out <yaml>]
```

一次产出全栈版本事实（result 直接可贴进 StackLock）：

| 组件 | 探测方式 | 备注 |
|---|---|---|
| CLI 自身 | 内置 semver | |
| SHUD | submodule commit + build record（binary sha256 反查） | 上游无 `--version`（ABSENT），logo 串只有粗粒度 "v2.0 2022" |
| rSHUD | `Rscript -e 'packageVersion("rSHUD")'` + submodule commit | DESCRIPTION 可靠 |
| AutoSHUD | submodule commit | 无任何运行时版本标识（README 硬编码，ABSENT）|
| R / CVODE | `R --version` / build record | |

## 3. Result YAML 通用头

```yaml
result:
  schema_version: 1            # 输出格式版本，独立于 cli_version 演化
  cli_version: 0.1.0
  command: "shud run ccw --threads 4"
  stack:
    shud_commit: 3aec657
    rshud_version: 2.5.0
    autoshud_commit: f421445
  inputs_digest: sha256:...    # 参与 command_digest 的规范化输入摘要
  started_at: ...              # 不参与 digest
  upstream_exit: 0
  status: ok | warn | failed
  warnings: []
  data: { ... }                # 命令特定载荷（metrics 表 / wb 残差 / 校验清单）
```

## 4. Exit code 契约（CLI 自身）

```text
0 成功  · 2 用法错误  · 3 校验失败（check/输入不自洽/wb 超阈）
4 上游工具失败（SHUD/rSHUD/AutoSHUD，原始码在 result.upstream_exit）
5 超时  · 1 其他
```

## 5. 版本治理（CLI 与三仓库的双向演化）

这是本规范的核心动机：三仓库在演化（本次同步即跨 rSHUD v2.2→v2.5、48 提交），
且 SHUD-Harness 的研究成果（ChangeRequest 上行合并）**本身会改变上游接口**。规则：

1. **CLI 有独立 semver**，进三处：每个 result YAML、CommandTrace、`StackLock.harness.cli_version`
   （Minimal_Schemas §2）。RunRecord 由此可追溯"这份 metrics 是哪个 CLI 版本算的"。
2. **兼容矩阵显式声明**：CLI 每个 minor 版本声明支持的上游区间——
   `shud: [3aec657, HEAD-of-tested]`（退出码表 + 输入清单 + 输出命名为契约面）、
   `rshud: >=2.5.0 <3.0`（现代 API 面）、`autoshud: [f421445, ...]`（步骤/配置键/必需输出 15 变量表为契约面）。
   区间外组合 → `version` 命令报 incompatible，run/metrics 拒绝执行（可 `--force` + 显式记录，产物标 dirty）。
   已知事实（对抗审查 A07-4）：上游加速线 cpu-accel-v1.0.2（db4ccdb，领先基线 125 commits，含 RELTOL
   环境钩子与 OpenMP 配置变体）**当前在区间外**——采纳它不是配置动作，必须走第 3 条 bump 流程并
   扩展 fixture（RELTOL 探针进 StackLock.runtime）。矩阵外默认拒绝的第一个真实案例就是它。
3. **submodule bump 流程**（挂接 Dependency_Versioning_Policy）：升级任一仓库 →
   跑 CLI 兼容 fixture 套件（§7）→ 通过则更新兼容矩阵上界；破坏性变更 → 先补 CLI 适配 + bump minor/major，
   同一 PR 内完成，禁止"仓库升了、CLI 装死"。
4. **成果回流治理**：ChangeRequest 上行合并改变上游接口（新输出变量、新 flag、退出码变化）时，
   该 ChangeRequest 的 interface_impact 必须列出 CLI 适配项，工程完整性由 Reviewer validator 检查
   （"改了上游输出格式却没动 CLI fixture" → 打回）。闭环：研究改上游 → 上游 bump → CLI 适配 → 兼容矩阵更新。
   确定性触发（对抗审查 A07-5）：不依赖 interface_impact 自报——submodule bump / 上行合并的 git diff
   触及**契约面路径集**（SHUD：Macros.hpp 退出码、CommandIn.*、`**/IO*`、Model_Control.*、print.hpp；
   rSHUD：io_output.R、WaterBalance.R；AutoSHUD：ReadProject.R 键表）时，CI 强制该 PR 含 fixture
   变更或显式 `cli-impact: none` 声明文件，缺任一即失败。机器触发点 = diff 路径匹配
   （与 semantic_level_floor 同构），Reviewer 只判"适配对不对"、不判"有没有影响"。
5. **result schema_version 独立演化**：CLI 升级不必然破坏下游（warehouse ingest / report 模板按 schema_version 分支）；
   schema 破坏性变更走 minor→major，与 Multiuser_Harness_Versioning 的迁移规则一致。

## 6. AutoSHUD 步骤 → 领域对象映射

上游实际结构（f421445 事实）：`All.R` 仅串联 Step1-3；Step4/5 独立调用；步骤间纯文件驱动、可独立重跑
——这与 RunJob/park/collect 模型天然同构。

| Step | 脚本 | RunJob 类型 | 产物 → 对象 |
|---|---|---|---|
| 0.1（可选） | `Setp0.1_Delineation.R` | data_prep | outlets/wbd/stm shp → DataProvenance（derived 层） |
| 1 | `Step1_RawDataProcessng.R` | data_prep（forcing 转换以小时计，**park**） | `DataPre/{pcs,gcs}` → provenance.preprocess 记录 |
| 2 | `Step2_DataSubset.R` | data_prep | soil/landuse/forcing 子集 → provenance（数据源代码 Soil/Landuse/Forcing 键值一并记录） |
| 3 | `Step3_BuidModel.R` | model_build | `input/<prj>` SHUD 输入文件集 → artifact manifest + provenance 定稿；**后接 `shud check`** |
| 4 | `Step4_SHUD.R` | model_run | `output/<prj>.out` 15 变量 .dat → RunRecord |
| 5 | `Step5_*.R` | postprocess | SHUDtb 图表/摘要 → figure/metrics artifacts |

**MVP 推荐分工**：Step1-3 原样包装（AutoSHUD 的领域逻辑不重写）；**Step4/5 优先走 harness 原生
`shud run` + `metrics`/`wb`**（治理粒度更细：build record、退出码映射、T2 直出），
AutoSHUD Step4/5 保留为兼容通道，其 acceptance 测试（tests/test-9035800-step45-acceptance.R）
纳入 engineering regression benchmark 层。

`*.autoshud.txt` 配置：sha256 记入 DataProvenance；`shud.source` 键由 CLI 强制覆盖为 StackLock 锁定路径，
配置文件里的手写值不生效（防"config 指向别处的 SHUD"）。

## 7. 兼容 fixture 套件（CI 挂接）

| fixture | 覆盖 | 来源 |
|---|---|---|
| ccw tiny `check`+`run`+`metrics`+`wb` | SHUD 退出码/输出命名/rSHUD 读取链 | SHUD/input/ccw（上游自带，heihe/qhh 备选） |
| rSHUD API 探针 | read_output/load_output_data/wb.* 签名存在性与返回结构 | rSHUD tests fixtures |
| AutoSHUD `check` + step 干跑 | 配置键表/步骤入口存在性 | AutoSHUD Example/9035800.autoshud.txt |
| 9035800 step123/step45 acceptance | 端到端流水线（较重，nightly） | AutoSHUD tests/ 原样复用 |

触发：CLI 代码变更（PR）、任一 submodule bump（PR，见 §5.3）、nightly 全量。

## 8. 验收标准

- [ ] `shud check` 对缺文件/坏输入项目返回 exit 3，且 dummy 模式在无求解计算下完成（负例：删 `.sp.mesh` 必失败）。
- [ ] `shud run` 的 6 个 SHUD 退出码全部映射到正确错误类别（表驱动单测）。
- [ ] metrics/wb result 对同一 run 目录两次执行字节级一致（digest 稳定性测试）。
- [ ] lineage guard 拒绝非 CLI 产出的 metrics 作为 deterministic 证据（evidence 需带 cli_version 戳）。
- [ ] rSHUD < 2.5.0 时 metrics/wb 拒绝执行并给出明确升级指引。
- [ ] 任一 submodule bump 的 PR 自动跑兼容 fixture；失败阻塞合并。
- [ ] `version` 输出可直接填充 StackLock；binary 与 build record 不匹配时 run 拒绝执行。
- [ ] ChangeRequest 声明 interface_impact 涉及上游接口时，Reviewer validator 检查 CLI 适配项存在。
- [ ] 激活时机：Phase 3（其交付的 "SHUD build/run wrapper + metrics/hydrograph artifact" 即本 CLI 的
  shud/metrics 组）；autoshud 组随首个真实流域数据准备任务启用。
