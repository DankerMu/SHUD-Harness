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
| report fixture | EvidenceReport/export/language guard | 否 |

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

M2 的 RunJob/RunRecord 不经 `ctx.storage` 域保存；记录落点与索引/锁分工以 [Phased_Plan M2](Phased_Plan.md#2-m2-运行主链) 和 [design D2](../../openspec/changes/m2-run-chain/design.md) 为准。

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
one metrics artifact
one missing figure artifact
one AnalysisPlan progress artifact
```

### 验收

- report 包含 observations；
- report 包含 limitations；
- report 包含 pi_questions；
- missing artifact 被标注，不崩溃；
- forbidden language guard 生效；
- Markdown 报告文件按状态带可见水印或 accepted 标记（Report_Generation_Spec §水印）。

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
