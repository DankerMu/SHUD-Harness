---
status: frozen
---

# Test Fixtures and Command Matrix

**状态：** v0.8.1 测试 fixture 补充  
**目标：** 明确每阶段用哪些 fixture、命令和 expected artifacts，避免测试依赖真实长任务。

> **排期语义（2026-10-20）**：原 W 周阶段标签已删；fixture 何时启用以 [Phased_Plan v2](Phased_Plan.md) 的里程碑 M1–M6 为准（ADR-0004）。

---

## 1. Fixture 层级

| Fixture | 目的 | 是否依赖 SHUD |
|---|---|---|
| schema-only | core/support schema 校验 | 否 |
| dummy-runner | job submit/log/collect/report | 否 |
| dummy-batch | AnalysisPlan/AnalysisProgressPayload（Heatmap 出 MVP；最小 OAT 见 Phased_Plan M5） | 否 |
| old-output fixture | rSHUD backward compatibility | 部分依赖 rSHUD |
| ccw tiny | 真实 SHUD/rSHUD 闭环 | 是 |
| [keliya replay](#7-keliya-known-answer-回放) | M4 N=1 known-answer 工程回放 | 是；本机 block，CI 不运行 |
| report fixture | M3 EvidenceReport 渲染/校验/语言护栏；不含 M4 导出 | 否 |

---

## 2. Dummy runner

### 命令

从仓库根目录执行；先完成 `pnpm install --frozen-lockfile` 与 `pnpm run build`。
M2 没有独立 dummy-runner CLI，使用 CI 完整覆盖率套件中的提交、日志和收集集成测试：

```bash
pnpm exec vitest run packages/dsh-shud-jobs/src/submit-shud.test.ts packages/dsh-shud-jobs/src/file-output.test.ts packages/dsh-shud-jobs/src/collect-shud.test.ts
```

假 SHUD 由 `packages/dsh-shud-jobs/src/test-harness.ts` 的 `installScriptFixture` /
`createHarness` 在临时目录安装，使用 `scripts/fixtures/exec-script.sh` 跳板；各用例自行断言结果并清理临时目录。
本命令覆盖 submit、日志增量回读、collect 幂等性，不证明完整宿主重启或报告生成：
前者另用现有 `pnpm run shud:restart` 本机阻断闸及 #318 PI 验收，后者属于 M3。

### 预期输出

```text
<workspace>/runs/<run_id>/run-job.json      # RunJob 当前状态
<workspace>/runs/<run_id>/stdout.log
<workspace>/runs/<run_id>/stderr.log
<workspace>/runs/<run_id>/run-record.json
# RunJob/RunRecord 位于上述运行目录；active.json、completed.json 与 lock 位于插件 stateDir
```

M2 的 RunJob/RunRecord 不经 `ctx.storage` 域保存；记录落点与索引/锁分工以 [Phased_Plan M2](Phased_Plan.md#2-m2-运行主链) 和 [design D2](../../openspec/changes/archive/2026-10-27-m2-run-chain/design.md) 为准。

### 用例

- RunJob（经 `ctx.jobs` 提交，dsh 重启后对账）；
- 作业日志落文件与回读；
- collect idempotency；
- report generation。

---

## 3. Dummy batch

> **M5 口径（Phased_Plan M5）**：M5 参数集用最小 OAT（3–5 组），产出用普通 artifact
> （analysis_progress.json + batch 汇总表），**不产 parquet / heatmap.json**；下述 3×3 参数设计与 parquet/heatmap
> 定义保留供 M5 之后（首个真实敏感性研究任务）复用。

### 命令

尚未落地，无可执行脚本；需在 M5 及后续真实敏感性任务规划中确定实现入口。
保留的 3×3 设计为 `ksat=0.5,1,2` × `roughness=0.7,1,1.3`，并注入 `PSET-005` 失败，
不是当前可直接运行的命令，也不改变 M5 最小 OAT 的 3–5 组范围。

### 预期输出

```text
<workspace>/runs/<plan_id>/analysis_plan.yaml
<workspace>/runs/<plan_id>/analysis_progress.json
<workspace>/runs/<plan_id>/sensitivity_results.parquet
<workspace>/runs/<plan_id>/heatmap.json
```

### 用例

- AnalysisProgressPayload 计数；
- failed parameter set 保留；
- heatmap aggregation；
- partial report limitations。

---

## 4. ccw tiny

### 预设

- SHUD submodule 已初始化；
- `input/ccw` 可用；
- 独立 `shud:tiny` 默认的 `END=30` 只在 scratch 输入副本更新，不改 root submodule，也不是注册表重启入口的输入承诺；
- 构建是前置条件，不由 fixture 执行；tiny 日志默认随 scratch 清理，`SHUD_TINY_KEEP=1` 可保留。注册表入口的 stdout/stderr/output 由 collect 记入 RunRecord artifacts。

### 当前可执行入口

先提供已构建的可执行 SHUD（默认 `SHUD/shud`，或由 `SHUD_BIN` 指定绝对路径）。
需要构建时，在独立可写的 SHUD 源码副本按其 `configure` / `Makefile` 执行 `./configure` 后
`make shud`，并准备 `~/sundials`；不要修改本仓库只读 submodule。

```bash
pnpm run shud:tiny
```

实际入口为 `scripts/runtime/shud-tiny.sh`：复制 ccw 到 scratch workspace，仅在副本更新 END，
检查 exit 0 与 `.dat` 产出；默认结束后清理 workspace，需保留日志/产物时设置 `SHUD_TINY_KEEP=1`。
它是独立求解器 smoke，不经过作业注册表，不代表下列全部设计产物/验收项已实现。
rSHUD 水量平衡函数见 `rSHUD/R/WaterBalance.R` 的 `wb.all`，依赖已配置的数据与初始条件；
目前没有通用的一键水量平衡 CLI，本入口也不调用该函数。

### 预期输出（按入口）

独立 `pnpm run shud:tiny`：以下位于 scratch；默认运行结束后清理，`SHUD_TINY_KEEP=1` 才保留。

```text
<scratch>/stdout.log
<scratch>/stderr.log
<scratch>/output/ccw.out/*.dat
```

注册表路径 `shud_run` → collect（`project=ccw`；RUN-001 仅为示意 id，不是 tiny 的输出）：

```text
<workspace>/runs/RUN-001/run-job.json
<workspace>/runs/RUN-001/run-record.json
<workspace>/runs/RUN-001/stdout.log
<workspace>/runs/RUN-001/stderr.log
<workspace>/runs/RUN-001/output/ccw.out/*.dat
```

通用注册表布局为 `output/<project>.out/`，记录与 stateDir 索引职责见 [M2](Phased_Plan.md#2-m2-运行主链)。
上述 registry 结果由实际工具/收集路径验证，不能用独立 tiny smoke 的成功代替。

非 M2 的后续设计示意，不是上述两个入口当前承诺的产物：

```text
<workspace>/runs/RUN-001/metrics.yaml        # 后续里程碑示意，非 M2；路径未定
<workspace>/reports/<report_id>.md          # M3 起
```

metrics/figure 的具体里程碑、生产者、格式和落点未在本节确定，见 [Collect 阶段](../03_SPEC/Park_Resume_Design.md#5-collect-阶段)；
图与时序的分类示意见 [Artifact 分类](../03_SPEC/Artifact_Registry_Spec.md#2-artifact-分类)，不将其示例当成已有生产者。

### 验收（按入口）

独立 `shud:tiny`，默认 30 天 END 仅在输入副本更新：

- 30 天运行 exit_code=0；
- scratch 的 `output/ccw.out/` 有 `.dat` 产出；日志保留与清理按上述 KEEP 设置，不要求注册表记录。

注册表路径及后续对象：

- 注册表路径（`shud_run` → collect）：成功运行 exit_code=0、RunRecord.status=succeeded，RunJob/RunRecord 与 stateDir 索引可追溯；独立 `shud:tiny` 不生成这些记录。
- `numerical_health.water_balance_residual` 在 M2 collect 中为 `null`，不作为 M2 通过条件；后续计算的阈值沿用 [既有阈值](../03_SPEC/SHUD_Output_Variables.md#13-阈值)（pass `<=0.01`），本节不确定其计算里程碑或生产者。
- `rivqdown` 序列进入 metrics/figure artifact（后续里程碑，非 M2；具体归属未定）；
- StackLock/DataProvenance 对象接线属于 [M3](Phased_Plan.md#3-m3-mvp-1)；M2 的 `stack_id` / `data_id` 为 null，不能与 RunJob/RunRecord 的已有追溯能力混为一项。

注册表的真实跨重启运行另由 `pnpm run shud:restart` 与 #318 PI 验收覆盖，不把 tiny 的 30 天设置套到这些入口。

---

## 5. Report fixture

### 输入

```text
one succeeded RunRecord
one failed RunRecord
matching TaskCard, StackLock and DataProvenance records with branded ids
no metrics, figure or AnalysisPlan progress artifacts
```

这是 [M3 EvidenceReport 契约](../../openspec/specs/evidence-reports/spec.md) 的确定性 fixture，不要求真实求解器或伪造科学分析。每个引用必须可解析；两份 RunRecord 分别展示成功与失败事实，不能用成功运行掩盖失败。

### 验收

- report 包含 observations、limitations、pi_questions；
- 事实表保留两次运行的状态、退出类别、来源与产物引用；
- metrics/图表未生产的事实写入 limitations，不生成假数值或缺失文件引用；
- 虚构或不可解析的引用明确拒绝，不静默忽略；
- forbidden language guard 生效，四句治理不变式逐字出现；
- Markdown 按七态规则带可见水印或 accepted 标记；规范对象位于 `reports/<report_id>.json`，投影为同名 `.md`。

---

## 6. Failure fixtures

| Fixture | 触发方式 | 预期 |
|---|---|---|
| schema_error | 缺 required field | Zod 校验拒绝 + ErrorRecord(category=schema_error) |
| permission_error | agent 调 PI decision | 策略门 deny（agent 身份不得持 pi 角色）+ ErrorRecord |
| lock_conflict | 两个 collect 同时执行 | 一个成功，一个 ErrorRecord(lock_conflict) 或同 idempotent result |
| timeout | dummy job sleep 超时 | RunJob.timed_out + ErrorRecord |
| parser_error | 删除 required output | ErrorRecord + report limitation |
| secret_leak_attempt | env 中放 fake secret | artifact/log/report 不包含 secret |

---

## 7. keliya known-answer 回放

来源必须显式设置 `SHUD_REPLAY_KELIYA`，指向 basin 的 `input/keliya` 目录；本地已知来源例为仓库根相对路径 `../openMP/SHUD/Basins/keliya/input/keliya`，不是脚本默认值，也不会自动猜测兄弟仓库。准备脚本独立调用时也接受 `--keliya <dir>`，显式参数优先于环境变量。

`scripts/runtime/shud-replay-prepare.sh` 是唯一准备入口；`shud:replay` 自动调用它，勿先准备同一目标再运行完整闸。只在新的显式 scratch workspace 建独立 `repos/SHUD` clone 与 `input/keliya` 副本，已有目标拒绝覆盖。准备期仅改副本两处：

| 文件 | 改写 |
|---|---|
| `keliya.cfg.para` | `NUM_OPENMP` 行改为 `NUM_OPENMP\t1`；原 `START 12053`、`END 12143` 窗口不改 |
| `keliya.tsd.forc` | 第二行改为同一 basin 的 `forcing.trimmed/` 物理绝对路径 |

`input/keliya/PREPARED.json` 记录来源与两项改写前后 SHA256。`forcing.trimmed/` 保持在 workspace 外，不复制进输入副本；必须含表格引用的 32 个普通文件（目录另有两项未引用），目录路径不得含 pinned SHUD 无法解析的 ASCII 空白。回放不传 `end_days`，不把 ccw tiny 的 30 天 END 套用到该窗口。

完整闸从仓库根执行，先经环境变量提供 `DMXAPI_KEY`（不写入文件）、绝对可执行普通文件 `SHUD_BIN`、已存在绝对目录 `SUNDIALS_ROOT` 与上述显式来源；本机须有 SHUD 构建工具链及仓库旁的 `../openMP/docs/p1e/p1e_strict_omp_design.md`：

```sh
pnpm run shud:replay /absolute/path/to/empty-scratch-workspace
```

这是 **block（本机，CI 不运行）**。通过判据唯一正文为 [Replay acceptance criteria](../../openspec/specs/known-answer-replay/spec.md#requirement-replay-acceptance-criteria)，本页不复制清单。退出 1 时保留工作区与 canonical session log，不改称 INCONCLUSIVE；自动 Allow once 不代替 PI 验收，N=1 比较不构成并行正确性、性能或模型改进结论。
