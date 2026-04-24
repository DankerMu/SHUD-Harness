# SHUD-Harness 内化式 Agent Runtime 建设与迁移方案（补充完善版）

**版本**：v0.4 补充完善版  
**日期**：2026-04-23  
**定位**：长期技术路线文档 / Runtime 内化迁移方案 / SHUD-Harness 功能设计 PRD + 高层技术 Spec  
**适用对象**：SHUD-Harness 项目负责人、核心开发者、后续 Commander Agent / Worker Agent / Critic Agent / Harness Optimizer 的实现者  
**修订说明**：本版在 v0.3 完善版基础上，将 StackLock / JobSpec / DatasetManifest / CalibrationSpec / BenchmarkPolicy 从“补充概念”升级为“正式一级治理对象”，新增正式 schema、状态机、治理硬规则、目录落点、CLI/API 建议、对象升级条件与 V1/V1.5 实施边界。

---

## 0. 结论先行

SHUD-Harness 的总体方向是正确的：它不应被做成一个外部插件，也不应退化为若干固定工作流脚本的集合，而应被建设为一个**面向 SHUD / rSHUD / AutoSHUD 持续演化的科研建模 Agent Runtime**。

但从“方向正确”到“方案完善”，中间还差几层真正决定可落地性和可持续性的底座。本完善版将方案从“可立项、可汇报”的高层蓝图，推进到“可以按阶段实施、可以控制风险、可以支撑科研证据闭环”的工程设计文档。

本版给出的核心判断如下：

```text
SHUD-Harness
  = Commander Agent 主控
  + Bash-first / Job-aware 执行动作空间
  + Worker / Critic / Harness Optimizer Episode
  + Evidence-grounded Memory
  + Skill Library / Scaffold Promotion
  + SHUD Research Object Model
  + Version Lock / Data Provenance / Output Contract
  + Benchmark / Validation / Human Gate 治理体系
  + Operator-first Web Console
```

最重要的补强点是四条底座：

```text
1. 版本锁：没有 StackLock / EnvLock，就无法区分科学改进与环境漂移。
2. 执行层：没有 JobSpec / Executor，就无法从本地 tiny loop 自然扩展到批量实验。
3. 数据溯源：没有 DatasetManifest / ObservationManifest / PreprocessRecipe，就无法支撑科研证据可信度。
4. 基准治理：没有 BenchmarkPolicy / CalibrationSpec / HoldoutPolicy / OutputContract，就容易把局部指标抖动误判为模型进步。
```

因此，本版的最终结论是：

> **SHUD-Harness 可以按该方向推进，但必须以“版本锁、执行层、数据 provenance、基准治理”作为 V1 的硬底座；否则系统很容易在科研可信度、结果复现性和工程复杂度上失控。**

---

## 1. 本版相对 v0.3 / v0.2 的新增与修订重点

### 1.1 新增的关键对象

本版新增以下核心对象，作为 v0.2 方案的必要补足：

```text
- StackLock
- EnvLock
- DatasetManifest
- ObservationManifest
- PreprocessRecipe
- CalibrationSpec
- HoldoutPolicy
- JobSpec
- ExecutorBackend
- OutputContract
- CompatibilitySuite
- BenchmarkPolicy
- ReleaseGate
```

### 1.2 架构层面的关键修订

1. 原有 “bash-first” 保留，但升级为 **bash-first, job-aware**。  
   也就是说，短任务仍以 bash 为主，长任务和批量任务通过 JobSpec / Executor 提交与监控。

2. 原有 Runtime / Memory / Skill / Evidence 层保留，但新增 **版本锁层**、**数据溯源层**、**输出契约层** 和 **基准治理层**。

3. Web Console 的信息架构从“chat/session 导向”修订为“科研对象导向”：

```text
RCS → Experiment → Run → Evidence → Validation → Change
```

聊天和 episode trace 仍保留，但属于辅助视图，不是主导航。

4. 第一阶段不追求“大而全自演化”，而是按三层闭环推进：

```text
P0：tiny run/evidence loop
P1：cross-repo code change loop
P2：harness self-improvement loop
```

### 1.3 本版优先级调整

原方案中较重的部分做了收敛：

- Memory 分层保留，但 V1 实施上先落地 3 类长期层：  
  `episodic / validated-evidence / skills-procedural`

- Harness Optimizer 保留，但降级为 P2 能力，不抢占 P0/P1 落地资源。

- 大规模 HPC 校准平台不作为第一阶段目标，但必须预留 Executor 抽象。

---

## 2. 建设目标

### 2.1 总目标

建设一个能够长期支持 SHUD 模型开发、实验、验证、诊断、代码演化和科研证据沉淀的 Agent Runtime，使 SHUD 的优化从“人手工组织实验和改代码”逐步演进为：

```text
学者提出问题
  → Commander Agent 建立 Research Change Set
  → Agent 设计实验与诊断路径
  → Worker Agent 在受控 sandbox / executor 中执行模型、写脚手架、改代码
  → Critic Agent 审查证据、指标解释和工程风险
  → Harness 记录 trace、artifact、memory、skill、validation
  → Commander Agent 决定下一轮实验、代码修改、人工审批或归档
  → 系统持续积累可复用技能和科研记忆
```

### 2.2 第一阶段直接目标

第一阶段需要完成以下能力：

```text
1. Commander Agent 能作为主控持续推进 SHUD 研究任务。
2. Worker Agent 能在隔离 workspace 中通过 bash 执行模型运行、数据分析、代码修改和脚手架生成。
3. Critic Agent 能审查实验设计、代码变更、指标解释和验证充分性。
4. Skills 按严格格式组织，可被检索、加载、执行、验证、提升和废弃。
5. Memory 按 proposal 工作流治理，长期层必须有 evidence link。
6. 每次研究任务都能沉淀为 RCS，并形成 Experiment / Run / Evidence / Validation / Change 的闭环。
7. 每个 episode 都有可追踪的 bash 命令、文件修改、artifact、评价结果和 memory proposal。
8. 系统能够稳定跑通至少一条 tiny SHUD case 闭环，以及一条跨 SHUD / rSHUD / AutoSHUD 的小型代码变更闭环。
```

### 2.3 长期目标

长期目标不是简单“自动跑模型”，而是形成 SHUD 的**科研演化操作系统**：

```text
- 能不断吸收历史实验经验；
- 能积累稳定的 SHUD 操作技能；
- 能对模型运行失败进行诊断；
- 能提出并实现跨 SHUD/rSHUD/AutoSHUD 的代码变更；
- 能用 benchmark 和水文证据约束模型改动；
- 能阻止 Agent 把单次指标提升误判为科学改进；
- 能在失败中改进自身 harness、skills、memory 和 context pack。
```

---

## 3. 设计原则

### 3.1 Commander-first

主控应是 Commander Agent，而不是一组固化工作流。科研建模过程中，实验设计、数据诊断、代码修改、验证、反思之间会频繁跳转，不能依赖预先写死的 DAG。

固定的是 agent loop，而不是具体步骤：

```text
Observe
  → Decide
  → Act
  → Observe Result
  → Evaluate
  → Reflect
  → Update Memory / Skills
  → Decide Next
```

### 3.2 Bash-first, Job-aware

第一原则仍是：

```text
给 Agent 一个受控 bash sandbox，而不是一堆过度设计的 typed tools API。
```

但完善版补充为：

```text
短任务：bash-first
长任务 / 批量任务 / 远程任务：job-aware
```

也就是：

- 交互式、局部、短时任务优先直接 bash；
- 编译、批量实验、长时运行、未来 HPC/容器提交任务，通过 JobSpec / Executor 抽象执行；
- Agent 看到的依然是统一动作空间，Harness 在背后选择直接 bash 或 job backend。

### 3.3 Skills as Procedural Memory

Skill 不是普通 prompt，而是 Agent 通过长期实践沉淀出来的程序化能力。它必须有严格格式、明确触发边界、明确输入输出、可选脚本、示例、验证方式和生命周期。

### 3.4 Memory as Evidence-grounded Cognition

Memory 不是聊天记录，也不是 Agent 可以随手写入的偏好文件。SHUD-Harness 的 memory 必须服务科研判断和模型演化。

重要科研结论不得由 Agent 直接写成 verified。必须经过 evidence link、Critic 审查和 Commander / Human Gate 审批。

### 3.5 Evidence before Model Change

任何模型结构、物理过程、默认参数、输入输出契约、benchmark 阈值的变更，必须先有证据包和工程设计说明。

不允许：

```text
- 没有 baseline 的性能声明；
- 没有水量平衡检查的模型改进声明；
- 单一流域指标提升直接泛化为模型改进；
- Agent 直接修改控制方程；
- Agent 直接覆盖 benchmark baseline；
- Agent 直接修改默认参数并提交为正式版本。
```

### 3.6 Version before Conclusion

本版新增一条强约束原则：

> **任何性能、科学结论或回归判断，都必须绑定 StackLock / EnvLock。**

没有版本锁的结果，只能视为“临时观察”，不能进入 validated evidence，更不能进入 benchmark baseline。

### 3.7 Data Provenance before Claim

本版新增另一条强约束原则：

> **没有 DatasetManifest / ObservationManifest / PreprocessRecipe 的结论，不得升级为 validated scientific claim。**

### 3.8 Runtime Ownership

开发可以吸收已有原型经验，但最终系统应由 SHUD-Harness 自身拥有以下核心能力：

```text
- Agent loop
- episode sandbox
- job/executor abstraction
- tool trace
- memory store
- skill registry
- sub-agent runtime
- observability
- scheduler
- supervisor
- Web console
- SHUD domain layer
- evidence layer
- validation layer
- version/provenance layer
```

不把 SHUD-Harness 设计成外部 runtime 的临时插件。

---

## 4. 总体架构

### 4.1 高层结构

```text
Scholar / Researcher
        ↓
Commander Agent
        ↓
Research Constitution + State Briefing + Memory + Skills + Policy
        ↓
Decision
        ├── bash directly
        ├── submit job through Executor
        ├── spawn Worker episode
        ├── ask Critic episode
        ├── trigger Harness Optimizer
        └── request Human Gate
                ↓
Sandbox / Executor Layer
        ↓
SHUD / rSHUD / AutoSHUD / Data / Code / Scaffolds
        ↓
Observations + Traces + Artifacts + Resource Telemetry
        ↓
Evaluators + Validators + CompatibilitySuite
        ↓
Memory Proposals + Skill Proposals + Evidence Updates
        ↓
Commander Next Decision
```

### 4.2 四个平面

为避免后期模块边界不清，整体架构分为四个 plane：

#### A. Control Plane

负责控制、编排与治理：

```text
- Commander runtime
- Episode lifecycle
- Scheduler
- Supervisor
- Human Gate
- Policy engine
```

#### B. Execution Plane

负责真正执行任务：

```text
- bash sandbox
- local executor
- docker executor
- slurm executor（预留）
- k8s executor（预留）
- artifact collector
```

#### C. Research Plane

负责科研对象与证据闭环：

```text
- RCS
- ExperimentSpec
- CalibrationSpec
- RunManifest
- EvidencePacket
- ValidationReport
- ChangeSpec
- OutputContract
```

#### D. Knowledge Plane

负责长期积累与自我改进：

```text
- Skill registry
- Scaffold promotion
- Memory proposal / review
- Benchmark history
- Meta memory
- Harness Optimizer
```

### 4.3 运行时分层

```text
apps/
  server/                 # Runtime API、session、episode、WebSocket、operator console backend
  web/                    # Operator console
  supervisor/             # Runtime 守护进程、heartbeat、restart

packages/
  runtime-core/           # Agent loop、episode、context、tool routing、policy、state
  runtime-tools/          # bash、read、write、edit、spawn、memory、schedule 等通用工具
  runtime-model/          # 模型 provider、router、fallback、model policy
  runtime-memory/         # 通用 memory store、retrieval、index
  runtime-observe/        # logs、metrics、trace、session state、episode state
  runtime-scheduler/      # 定时任务、周期性 benchmark、周期性 consolidation
  runtime-supervisor/     # heartbeat、自恢复、运行守护
  runtime-secrets/        # secrets、脱敏、运行时安全

  harness-domain/         # RCS、ExperimentSpec、CalibrationSpec、EvidencePacket、ChangeSpec
  harness-versioning/     # StackLock、EnvLock、OutputContract、CompatibilitySuite
  harness-skill/          # skill loader、validator、promotion、deprecation
  harness-memory/         # evidence-gated memory、memory proposal、promotion workflow
  harness-eval/           # software/model/scientific evaluators
  harness-artifact/       # artifact manifest、checksum、provenance、run archive
  harness-executor/       # JobSpec、backend adapter、submit/watch/collect/retry
  harness-benchmark/      # baseline、threshold、holdout、trend tracking
  harness-governance/     # risk matrix、human gate、release gate

  shud-domain/            # SHUDStack、Basin、Forcing、Project、RunManifest
  shud-runner/            # SHUD/rSHUD/AutoSHUD bash scaffold templates and adapters
  shud-metrics/           # NSE、KGE、PBIAS、水量平衡、solver health、event metrics
  shud-validation/        # benchmark suites、regression checks、compatibility checks
  shud-provenance/        # dataset / observation / preprocess manifests
```

### 4.4 Runtime 状态目录

建议区分运行时状态和科研资产：

```text
.shud-harness/
  config/
  runtime/
    sessions/
    episodes/
    jobs/
    traces/
    heartbeat.json
  memory/
    working/
    episodic/
    semantic/
    procedural/
    epistemic/
    meta/
  skills/
    installed/
    registry.json
  memory-proposals/
  skill-proposals/
  benchmark-state/
  policy-cache/

shud-workspace/
  repos/
    SHUD/
    rSHUD/
    AutoSHUD/
  data/
    raw/
    processed/
  manifests/
    datasets/
    observations/
    preprocess/
    stacklocks/
    output-contracts/
  rcs/
  experiments/
  runs/
  evidence/
  changes/
  artifacts/
  validation/
  warehouse/
  releases/
```

`.shud-harness/` 面向 runtime，`shud-workspace/` 面向科研资产。前者可包含大量临时状态，后者必须服务长期可追溯性。

---

## 5. SHUD 科研对象模型（完善版）

### 5.1 研究对象总览

完善版的科研对象模型如下：

```text
ResearchChangeSet
  ├── StackLock / EnvLock
  ├── DatasetManifest / ObservationManifest / PreprocessRecipe
  ├── ExperimentSpec
  │     ├── CalibrationSpec
  │     └── HoldoutPolicy
  ├── JobSpec
  ├── RunManifest
  ├── EvidencePacket
  ├── ValidationReport
  ├── ChangeSpec
  ├── OutputContract
  └── ReleaseGate
```

### 5.2 ResearchChangeSet

Research Change Set 是 SHUD-Harness 的核心科研对象，用于承载一个明确研究问题及其相关实验、证据和代码变更。

```yaml
rcs_id: RCS-2026-001
title: Diagnose semi-arid storm peak underestimation
status: active

research_intent:
  question: Why does SHUD underestimate storm peaks in semi-arid basins while preserving total runoff volume?
  domain:
    - infiltration
    - hillslope routing
    - precipitation heterogeneity
    - river routing

hypotheses:
  - id: H1
    statement: Infiltration is too strong during high-intensity events.
  - id: H2
    statement: Hillslope routing is too slow.
  - id: H3
    statement: Precipitation spatial heterogeneity is underrepresented.

linked_stacklock: STACKLOCK-2026-003
linked_datasets:
  - DSM-2026-014
linked_observations:
  - OBS-2026-009
linked_experiments:
  - EXP-2026-004
linked_evidence:
  - EV-2026-004
linked_changes:
  - CHG-2026-003
```

### 5.3 StackLock

StackLock 解决“研究结果是否可复现”以及“性能变化来自代码还是环境”的问题。

```yaml
stacklock_id: STACKLOCK-2026-003
status: locked

repos:
  shud:
    repo_path: shud-workspace/repos/SHUD
    commit: abc123
  rshud:
    repo_path: shud-workspace/repos/rSHUD
    commit: def456
  autoshud:
    repo_path: shud-workspace/repos/AutoSHUD
    commit: ghi789

runtime:
  os_image: ubuntu-22.04
  container_digest: sha256:xxxx
  compiler:
    c: gcc-12.3
    cxx: g++-12.3
  cmake: 3.29
  make: 4.3
  r: 4.4.1
  python: 3.12

dependencies:
  sundials: 6.7.0
  terra: 1.8-10
  sf: 1.0-18
  gdal: 3.8
  proj: 9.3

notes:
  - Required for all benchmark deltas.
```

### 5.4 EnvLock

EnvLock 用于锁定更细粒度的运行环境，例如临时容器配置、环境变量、路径映射、resource limit、挂载策略等。

```yaml
envlock_id: ENVLOCK-2026-011
base_stacklock: STACKLOCK-2026-003

mounts:
  raw_data: read_only
  processed_data: read_only
  episode_scratch: writable

limits:
  cpu: 8
  memory_gb: 32
  wall_minutes: 240

environment_variables:
  OMP_NUM_THREADS: "1"
  TZ: "UTC"

network_policy:
  allow_network: false
```

### 5.5 DatasetManifest

DatasetManifest 解决“输入数据到底是什么版本”的问题。

```yaml
dataset_id: DSM-2026-014
name: Cache Creek DEM 30m
category: terrain
source:
  provider: internal_curated
  original_source: USGS
  acquisition_date: 2025-11-18

spatial:
  crs: EPSG:26910
  resolution: 30m
  extent_bbox: [x1, y1, x2, y2]

files:
  - path: data/raw/cache_creek/dem_30m.tif
    sha256: "..."

license:
  type: internal_research_use

quality:
  missing_ratio: 0.0
  qc_status: passed

lineage:
  parent_dataset: null
```

### 5.6 ObservationManifest

ObservationManifest 解决“观测真值如何管理”的问题，尤其适用于流量站、降水站、事件切片、 rating curve 版本等。

```yaml
observation_id: OBS-2026-009
name: Cache Creek discharge gauge
type: discharge_timeseries

station:
  station_id: USGS-11451100
  coordinates: [lat, lon]

time_range:
  start: 2008-01-01T00:00:00Z
  end: 2008-12-31T23:59:59Z

units:
  discharge: m3/s

quality:
  qc_status: partial
  gap_ratio: 0.013
  rating_curve_version: rc_v5

uncertainty:
  type: operational
  notes:
    - peak flow uncertainty increases during storm crest
```

### 5.7 PreprocessRecipe

PreprocessRecipe 记录从原始数据到模型输入的处理步骤。没有这层，很多“改进”只是预处理变了。

```yaml
preprocess_id: PREP-2026-021
purpose: Build SHUD-ready forcing and terrain layers for Cache Creek storm analysis

inputs:
  - DSM-2026-014
  - DSM-2026-031
  - OBS-2026-009

operations:
  - step: reproject
    params:
      target_crs: EPSG:26910
  - step: clip
    params:
      basin_boundary: basin_cache_creek_v3
  - step: resample
    params:
      resolution: 30m
      method: bilinear
  - step: gap_fill
    params:
      method: nearest_valid
  - step: temporal_slice
    params:
      start: 2008-02-14T00:00:00Z
      end: 2008-02-17T00:00:00Z
  - step: unit_normalize
    params:
      precip: mm_hr
      discharge: m3_s

outputs:
  - path: data/processed/cache_creek/event_2008_02_14/forcing.nc
  - path: data/processed/cache_creek/event_2008_02_14/terrain_bundle/
```

### 5.8 ExperimentSpec

ExperimentSpec 仍是核心对象，但完善版要求显式绑定数据、版本和泛化策略。

```yaml
experiment_id: EXP-2026-004
linked_rcs: RCS-2026-001
stacklock_id: STACKLOCK-2026-003

purpose: Test sensitivity of storm peak error to infiltration, hillslope routing, and precipitation resolution.

datasets:
  - DSM-2026-014
  - DSM-2026-031

observations:
  - OBS-2026-009

preprocess:
  - PREP-2026-021

basins:
  - cache_creek
  - walnut_gulch

events:
  - id: storm_2008_02_14
    start: 2008-02-14T00:00:00
    end: 2008-02-17T00:00:00

treatments:
  - name: baseline
  - name: lower_ksat
    parameters:
      ksat_multiplier: 0.5
  - name: lower_hillslope_roughness
    parameters:
      mannings_n_multiplier: 0.7
  - name: high_resolution_precipitation

metrics:
  - peak_flow_error
  - peak_timing_error
  - event_runoff_coefficient
  - water_balance_residual
  - NSE
  - KGE

decision_rules:
  - Do not claim model improvement if metric delta is within observation uncertainty.
  - Reject infiltration-only explanation if peak error is insensitive to ksat perturbation.

holdout_policy:
  policy_id: HOLD-2026-003
```

### 5.9 CalibrationSpec

这是完善版新增的关键对象，用于明确“参数校准”和“结构诊断”之间的边界。

```yaml
calibration_id: CAL-2026-002
linked_experiment: EXP-2026-004
status: allowed_with_constraints

allowed_parameters:
  - ksat_multiplier
  - mannings_n_multiplier
  - depression_storage_factor

forbidden_parameters:
  - default_release_parameters
  - hidden_debug_tolerances
  - undocumented_physical_switches

search_space:
  ksat_multiplier: [0.25, 2.0]
  mannings_n_multiplier: [0.5, 1.5]
  depression_storage_factor: [0.5, 1.5]

objective_functions:
  primary:
    - peak_flow_error
    - peak_timing_error
  secondary:
    - water_balance_residual
    - NSE

anti_leakage_rules:
  - calibration_set and holdout_set must not overlap
  - event-specific tuning cannot be generalized without holdout validation

acceptance_rules:
  - improvement must persist on holdout events
  - water balance cannot regress beyond threshold
```

### 5.10 HoldoutPolicy

HoldoutPolicy 明确什么情况下允许把“实验观察”升级为“更强结论”。

```yaml
holdout_id: HOLD-2026-003
purpose: Guard against single-basin or single-event overfitting

splits:
  calibration_basins:
    - cache_creek
  holdout_basins:
    - walnut_gulch
  calibration_events:
    - storm_2008_02_14
  holdout_events:
    - storm_2009_08_21

promotion_rules:
  - result may be called promising if calibration improves and no critical regression appears on holdout
  - result may be called validated only if holdout also improves within threshold
```

### 5.11 JobSpec

JobSpec 是本版新增的另一个关键对象，用于把“执行”从临时 bash 行为升级为可管理的作业系统。

```yaml
job_id: JOB-2026-0081
linked_episode: EP-2026-00042
purpose: Run batch event benchmark on two basins

backend: local
mode: batch

command:
  entrypoint: bash
  args:
    - .harness/scaffolds/run_event_benchmark.sh
    - --experiment
    - EXP-2026-004

resources:
  cpu: 8
  memory_gb: 24
  wall_minutes: 180

retry:
  max_attempts: 2
  retry_on:
    - transient_io_error
    - runner_timeout

artifacts_expected:
  - metrics_summary.parquet
  - validation_report.yaml
  - hydrograph_plots/

collection_policy:
  stdout_tail_kb: 64
  stderr_tail_kb: 64
  include_working_patch: true
```

### 5.12 RunManifest

RunManifest 保留，但新增绑定 JobSpec / StackLock / Provenance。

```yaml
run_id: RUN-2026-004-0007
experiment_id: EXP-2026-004
job_id: JOB-2026-0081
stacklock_id: STACKLOCK-2026-003
status: success

inputs:
  preprocess_id: PREP-2026-021
  forcing_id: forcing_cache_creek_2008
  parameter_set: baseline

outputs:
  shud_output_dir: runs/RUN-2026-004-0007/output
  diagnostics: runs/RUN-2026-004-0007/diagnostics
  metrics: runs/RUN-2026-004-0007/metrics

numerical_health:
  cvode_failures: 0
  negative_state_count: 0
  water_balance_residual: 0.0008

resources:
  runtime_seconds: 2512
  memory_peak_mb: 1830
```

### 5.13 EvidencePacket

EvidencePacket 保留，但新增 “claim strength” 与 “provenance completeness”。

```yaml
evidence_id: EV-2026-004
linked_rcs: RCS-2026-001
linked_experiment: EXP-2026-004
status: provisional

main_findings:
  - Peak error is weakly sensitive to tested ksat perturbation.
  - Peak timing improves under reduced hillslope roughness.
  - High-resolution precipitation improves peak magnitude.

supporting_artifacts:
  - metrics_summary.parquet
  - hydrograph_comparison.png
  - event_water_balance.csv

provenance_completeness:
  stacklock: true
  datasets: true
  observations: true
  preprocess: true

claim_strength: limited

limitations:
  - Only two semi-arid basins tested.
  - Precipitation uncertainty not fully quantified.
  - Event diagnostics insufficient to separate hillslope inflow from river attenuation.

recommended_next_actions:
  - Add event-scale diagnostics to SHUD output.
  - Add rSHUD reader for diagnostics.
  - Add AutoSHUD event analysis stage.
```

### 5.14 ChangeSpec

ChangeSpec 保留，但新增 OutputContract 与 CompatibilitySuite 引用。

```yaml
change_id: CHG-2026-003
linked_evidence: EV-2026-004
intent: Add event-scale diagnostics across SHUD stack.

scope:
  shud:
    - write event flux diagnostics
    - preserve existing discharge output
  rshud:
    - read diagnostics files
    - compute event water balance
  autoshud:
    - add optional event_analysis stage

interface_impact:
  input_contract: unchanged
  output_contract: additive
  output_contract_id: OUT-2026-002
  backward_compatible: true

validation_required:
  - build_shud
  - check_rshud
  - run_tiny_event_case
  - old_output_compatibility
  - mass_balance_audit
  - benchmark_before_after

compatibility_suite:
  - COMPAT-2026-004

human_gate:
  required_for:
    - output_contract_acceptance
```

### 5.15 OutputContract

OutputContract 用于显式描述 SHUD 输出被 rSHUD / AutoSHUD 消费的契约。

```yaml
output_contract_id: OUT-2026-002
schema_version: 1.2.0
status: proposed

files:
  - name: discharge.csv
    required: true
  - name: event_flux.csv
    required: false
    since_version: 1.2.0

compatibility:
  additive_only: true
  readers_must_tolerate_missing_optional_files: true

breaking_change_requires:
  - critic_review
  - human_gate
  - compatibility_suite_pass
```

### 5.16 CompatibilitySuite

CompatibilitySuite 用于把“向后兼容”从口头要求变成制度化验证对象。

```yaml
compatibility_suite_id: COMPAT-2026-004
purpose: Ensure new diagnostics remain compatible with legacy output readers

fixtures:
  - old_output_fixture_v1_0
  - output_fixture_v1_1

checks:
  - rshud_can_read_old_output
  - autoshud_pipeline_does_not_break_on_missing_optional_diagnostics
  - new_output_reader_parses_optional_files_correctly
```

### 5.17 ReleaseGate

当后期出现“要不要把某个 change 推入正式分支或正式发布”的场景时，需要明确 ReleaseGate。

```yaml
release_gate_id: RG-2026-001
linked_change: CHG-2026-003
status: pending

required_conditions:
  - validation_report_status == pass
  - compatibility_suite == pass
  - human_gate_approved == true
  - benchmark_regression_within_threshold == true
```

---

## 6. Agent 设计

### 6.1 Commander Agent

Commander Agent 是主控 agent，负责长期维护一个或多个 Research Change Set。

职责：

```text
- 理解学者提出的科学问题；
- 创建和维护 Research Change Set；
- 选择下一步行动：实验、诊断、代码修改、验证、总结、人工审批；
- 检索 memory 和 skill；
- 分派 Worker episode；
- 调用 Critic episode；
- 根据评价结果反思并更新路线；
- 触发 Harness Optimizer 改进 skill、context、prompt 或 scaffold；
- 生成面向学者的阶段性报告。
```

Commander 的输入：

```text
- 用户目标；
- Research Constitution；
- State Briefing；
- memory retrieval；
- skill registry；
- active RCS；
- StackLock / OutputContract / BenchmarkPolicy；
- tool/action policy；
- latest observations；
- pending human gates。
```

Commander 的输出：

```text
- 下一步行动决策；
- Worker episode spec；
- Critic episode spec；
- bash action；
- job submission spec；
- memory proposal；
- skill proposal；
- human gate request；
- final report。
```

### 6.2 Worker Agent

Worker Agent 是短期执行 agent，由 Commander 派生。

典型任务：

```text
- 跑 SHUD tiny case；
- 调试一次失败运行；
- 编写或修改 bash scaffold；
- 实现一个跨仓库诊断输出变更；
- 检查 rSHUD round-trip；
- 运行 benchmark before/after；
- 生成 EvidencePacket 草稿。
```

Worker 的边界：

```text
- 不决定最终科学结论；
- 不直接修改长期 memory；
- 不直接修改 benchmark baseline；
- 不直接越过 human gate；
- 不把临时 scaffold 自动提升为 skill。
```

### 6.3 Critic Agent

Critic Agent 是审查者，负责挑战 Commander 和 Worker。

检查维度：

```text
- 实验设计是否能证伪假设；
- 指标解释是否过度；
- 是否考虑观测不确定性；
- 是否有数据泄漏；
- 是否只在单一流域过拟合；
- 代码修改是否破坏兼容性；
- benchmark 是否覆盖必要案例；
- 结论是否有证据链；
- 是否缺少 StackLock / DatasetManifest / PreprocessRecipe；
- 是否需要补充反例实验；
- 是否需要 human gate。
```

Critic 输出应是结构化审查：

```yaml
critic_result:
  status: pass | needs_revision | blocked
  major_issues:
    - ...
  minor_issues:
    - ...
  required_next_actions:
    - ...
  risk_level: low | medium | high
```

### 6.4 Harness Optimizer Agent

Harness Optimizer 不直接优化 SHUD 模型，而是优化 Agent 如何优化 SHUD。

输入：

```text
- 失败 episode traces；
- 成功 episode traces；
- skill 使用记录；
- memory retrieval 命中记录；
- Critic 审查结果；
- validation failure pattern；
- repeated human intervention pattern。
```

输出：

```text
- 改进某个 skill；
- 增加 scaffold；
- 修改 State Briefing 模板；
- 修改 Research Constitution 的提示表达；
- 增加新的 Critic checklist；
- 改进 observation summary；
- 提出 memory schema 调整；
- 提出新的 benchmark episode。
```

Harness Optimizer 的改动也必须经过验证，不允许直接改变科学阈值、benchmark 接受标准、默认参数或高风险 policy。

---

## 7. Agent Loop 与 Episode 机制

### 7.1 Commander 主循环

```python
while not commander_finished:
    state = build_state_briefing(active_rcs)
    memory = retrieve_relevant_memory(state)
    skills = retrieve_relevant_skills(state)
    policy = load_policy(active_rcs, current_risk)

    decision = commander.decide(
        state=state,
        memory=memory,
        skills=skills,
        policy=policy,
        constitution=research_constitution,
    )

    result = harness.execute(decision)
    evaluation = evaluator.evaluate(result)

    trace_store.append(decision, result, evaluation)
    memory_store.collect_proposals(result, evaluation)
    skill_store.collect_proposals(result, evaluation)

    if evaluation.requires_critic:
        spawn_critic_episode(...)

    if evaluation.requires_human_gate:
        request_human_gate(...)

    commander.reflect(result, evaluation)
```

固定的是循环协议，而不是具体科研路径。

### 7.2 EpisodeSpec

```yaml
episode_id: EP-2026-00042
agent: worker
linked_rcs: RCS-2026-001
objective: Add event-scale diagnostics for storm event analysis.

context:
  active_experiment: EXP-2026-004
  evidence_packet: EV-2026-004
  stacklock: STACKLOCK-2026-003
  relevant_skills:
    - add-shud-output-diagnostics
    - rshud-roundtrip-test
    - benchmark-before-after

workspace:
  root: shud-workspace/episodes/EP-2026-00042
  repos:
    - SHUD
    - rSHUD
    - AutoSHUD
  raw_data_mode: read_only
  scratch_mode: writable

budget:
  max_turns: 80
  max_wall_minutes: 180
  max_patch_files: 40
  max_jobs: 4

policy:
  allowed_actions:
    - bash
    - read
    - edit
    - submit_job
    - spawn_critic
  human_gate_required:
    - change_physical_equation
    - change_default_parameter
    - change_output_contract
    - update_benchmark_baseline

success_criteria:
  - SHUD builds
  - rSHUD check passes
  - tiny event benchmark passes
  - old output compatibility passes
  - validation report generated
```

### 7.3 Episode 目录

```text
episodes/EP-2026-00042/
  context/
    state_briefing.md
    episode_spec.yaml
    relevant_memory.md
    relevant_skills.md
  worktrees/
    SHUD/
    rSHUD/
    AutoSHUD/
  scratch/
  scaffolds/
  traces/
    tool_calls.jsonl
    bash_commands.jsonl
    job_events.jsonl
    observations.jsonl
    file_diffs.jsonl
  artifacts/
  reports/
    worker_final.md
    validation_report.md
  proposals/
    memory_updates/
    skill_updates/
```

---

## 8. Bash Sandbox 与 Executor 体系

### 8.1 原则

Bash 是主要动作空间，但不是裸 shell。

```text
Agent sees bash.
Harness governs bash.
```

Harness 必须提供：

```text
- isolated workspace；
- git worktree；
- read-only raw data；
- writable scratch；
- command timeout；
- resource limit；
- destructive command blocklist；
- human gate for dangerous actions；
- command trace；
- stdout/stderr capture；
- file diff capture；
- artifact registration；
- observation summarization。
```

### 8.2 Bash 工具接口

```yaml
tool: bash
input:
  command: string
  cwd: string
  timeout_seconds: number
  purpose: string

output:
  exit_code: number
  stdout_excerpt: string
  stderr_excerpt: string
  created_files:
    - path: string
  modified_files:
    - path: string
  artifacts:
    - artifact_id: string
  observation_summary: string
  risk_flags:
    - string
```

### 8.3 Job / Executor 抽象

完善版新增统一执行接口：

```text
submit(job_spec) -> job_handle
watch(job_handle) -> status / progress / resource usage
collect(job_handle) -> artifacts / logs / exit info
cancel(job_handle)
retry(job_handle, policy)
```

支持的 backend：

```text
- local
- docker
- slurm（预留）
- k8s（预留）
```

V1 实装建议：

- **必须实现** `local`
- **可选实现** `docker`
- **仅定义接口** `slurm` / `k8s`

### 8.4 命令与作业治理

禁止或需审批的动作类型：

```text
- 删除原始数据；
- 覆盖 benchmark baseline；
- 修改长期 memory canonical 文件；
- 修改发布版本标签；
- 大规模提交 HPC 任务；
- 修改默认参数；
- 修改物理过程实现；
- 修改输入输出契约；
- 更新 OutputContract major version。
```

允许的常规动作：

```text
- 查看文件；
- 生成临时脚手架；
- 跑 R/Python/C++ 测试；
- 编译 SHUD；
- 运行 tiny case；
- 解析日志；
- 生成报告；
- 在 episode worktree 中修改代码；
- 生成 patch bundle。
```

---

## 9. Skill 系统

### 9.1 Skill 定义

Skill 是可复用程序化能力，不是普通 prompt。它应被设计为 Agent 可检索、可加载、可执行、可验证、可修订的能力包。

### 9.2 严格格式

每个 skill 是一个目录，入口文件必须是 `SKILL.md`。`SKILL.md` 的 frontmatter 保持最小化，只放路由必需元数据：

```markdown
---
name: diagnose-shud-run-failure
description: Use when a SHUD run fails, stalls, produces solver anomalies, or emits nonphysical diagnostic signals. Do not use for normal benchmark comparison.
---

# Diagnose SHUD Run Failure

## Purpose
...

## When to use
...

## When not to use
...

## Procedure
...

## Expected outputs
...

## Validation
...
```

额外 metadata 放入独立文件：

```text
skills-src/diagnose-shud-run-failure/
  SKILL.md
  contract.yaml
  scripts/
    parse_solver_log.py
    inspect_forcing_window.R
  references/
    shud_log_patterns.md
  examples/
    cvode_failure_event_case.md
  tests/
    run_skill_smoke_test.sh
  changelog.md
```

### 9.3 Skill Contract

```yaml
skill_id: diagnose-shud-run-failure
version: 0.1.0

inputs:
  required:
    - shud_log
    - run_manifest
  optional:
    - solver_stats
    - forcing_timeseries
    - baseline_run

outputs:
  required:
    - failure_classification.yaml
    - recommended_next_actions.md

success_criteria:
  - failure_class is identified or explicitly marked unknown
  - evidence artifacts are linked
  - next action is testable

risk:
  level: medium
  human_gate_required_for:
    - changing_solver_tolerance
    - changing_default_parameters
    - modifying_physical_process_code
```

### 9.4 首批 Canonical Skills

第一阶段只建设 6 个 canonical skill：

```text
1. run-shud-tiny-case
2. diagnose-shud-run-failure
3. rshud-roundtrip-test
4. add-shud-output-diagnostics
5. benchmark-before-after
6. build-provenance-complete-run
```

其中第 6 个是完善版新增，用于确保 run 结果在进入 evidence 前，完整绑定 StackLock / DatasetManifest / PreprocessRecipe。

### 9.5 Skill 生命周期

```text
candidate
  → tested
  → promoted
  → canonical
  → deprecated
```

#### candidate

来自 Worker 在 episode 中创建的 scaffold。

#### tested

在至少一个 episode 中成功使用，并产生可追踪 artifact。

#### promoted

由 Commander 或 Harness Optimizer 提出，Critic 审查后进入 `skills-src/`。

#### canonical

经过多个固定 benchmark episode 验证，成为 Commander 默认检索技能。

#### deprecated

被更好的技能替代，或者发现容易诱导 Agent 犯错。

---

## 10. Memory 系统

### 10.1 Memory 分层

概念上保留六层：

```text
working memory
episodic memory
semantic memory
procedural memory
epistemic memory
meta memory
```

但 V1 实施上建议收敛为以下三条长期主线：

```text
A. episodic memory：保存 episode 历史、失败模式、修复路径
B. validated evidence memory：保存通过审查的 claim / evidence / counter-evidence
C. procedural memory：保存 skills 与高价值脚手架经验
```

其余 semantic / meta 可先以轻量索引存在，避免治理负担过重。

### 10.2 Memory 写入机制

Agent 不允许直接写入 canonical memory。所有长期 memory 更新都必须走 proposal：

```text
Agent proposes memory update
  → evidence link required
  → Critic review
  → Commander approval
  → optional Human Gate
  → promoted to validated/canonical memory
```

### 10.3 Memory Proposal 示例

```yaml
memory_proposal_id: MP-2026-00031
proposed_by: worker
linked_episode: EP-2026-00042
memory_type: episodic
status: proposed

claim: rSHUD old-output compatibility failed after adding diagnostics reader.

evidence:
  - artifact: validation_report_00042
  - artifact: old_output_test_log_00042

suggested_memory:
  title: Output diagnostics changes must include old-output fixture tests.
  content: When adding new SHUD diagnostics output, run rSHUD reader against old output fixtures before claiming compatibility.
  tags:
    - rshud
    - output-compatibility
    - diagnostics

critic_review:
  status: pending
```

### 10.4 Epistemic Memory

科研判断必须进入 epistemic memory，而不是普通 note。

```yaml
claim_id: CLM-2026-001
statement: Peak underestimation in semi-arid storm events appears more sensitive to hillslope routing than saturated hydraulic conductivity within tested ranges.
status: provisional

supported_by:
  - EXP-2026-004
  - EV-2026-004

weakened_by:
  - EXP-2026-006

uncertainty:
  discharge_observation: considered
  precipitation_spatial_uncertainty: partial
  parameter_equifinality: not_fully_considered

decision:
  action: add_event_diagnostics_before_physics_change
  approved_by: human_researcher
```

### 10.5 Meta Memory

```yaml
meta_memory_id: HM-2026-012
pattern: Engineering episodes repeatedly forget backward compatibility when extending output diagnostics.
observed_in:
  - EP-2026-0011
  - EP-2026-0027
  - EP-2026-0042
recommended_harness_change:
  - Add old-output compatibility checklist to add-shud-output-diagnostics skill.
  - Include old output fixture in default context pack.
  - Add automatic bash scaffold for rSHUD old-output reader test.
status: validated
```

---

## 11. Version / Provenance / Contract 治理

这一章是完善版的新增重点，是整个方案能否真正成立的关键。

### 11.1 StackLock 作为结果进入 Evidence 的门槛

没有 StackLock 的 run，不得进入：

```text
- validated benchmark
- release gate
- scientific claim promotion
- cross-version regression judgment
```

### 11.2 Dataset / Observation / Preprocess 三件套

任何实验都必须能回答三件事：

```text
1. 输入数据是什么？
2. 观测对照是什么？
3. 从原始数据到模型输入做了哪些处理？
```

如果这三件事答不出来，该实验只能算“开发性探索”，不能算“科研证据”。

### 11.3 OutputContract 作为跨仓库协同底座

SHUD 输出一旦被 rSHUD / AutoSHUD 消费，就必须被当作契约治理，而不是“顺手加个文件”。

规定：

```text
- additive change 优先
- breaking change 必须升版本
- reader 必须说明对 optional file 的容忍策略
- compatibility suite 必须固定 old fixtures
```

### 11.4 BenchmarkPolicy

BenchmarkPolicy 用于把“基准”从隐性共识变成可审计制度。

```yaml
benchmark_policy_id: BP-2026-001

tiers:
  smoke:
    purpose: compile + tiny run + schema sanity
  regression:
    purpose: old output compatibility + fixed benchmark deltas
  scientific:
    purpose: cross-basin / cross-event claim support

rules:
  - baseline overwrite requires human gate
  - benchmark delta must bind stacklock
  - benchmark report must include uncertainty-aware interpretation
```

### 11.5 三层 Benchmark

#### Smoke Benchmark

适用于快速回归，最小集合：

```text
- SHUD build
- SHUD tiny case
- rSHUD install/check
- SHUD output → rSHUD basic read
- AutoSHUD stable path smoke（可选）
```

#### Regression Benchmark

适用于工程回归：

```text
- old-output compatibility
- schema / contract compatibility
- fixed-case metrics delta
- solver health delta
- runtime / memory delta
```

#### Scientific Benchmark

适用于科学判断：

```text
- cross-basin robustness
- cross-event robustness
- holdout behavior
- uncertainty-aware conclusion strength
```

### 11.6 校准与结构诊断必须分流

完善版明确规定：

- “参数可调好” 不等于 “结构正确”
- “单一事件最优” 不等于 “可推广”
- “训练集提升” 不等于 “科学进步”

因此 CalibrationSpec 必须和 hypothesis testing 明确分开，HoldoutPolicy 必须显式存在。

---

## 12. Observability 与 Artifact 管理

### 12.1 Trace

每个 episode 必须记录：

```text
- agent decision；
- bash command；
- job submit / watch / collect 事件；
- stdout/stderr excerpt；
- exit code；
- modified files；
- created artifacts；
- observations；
- evaluator result；
- memory proposals；
- skill proposals。
```

### 12.2 ArtifactManifest

```yaml
artifact_id: ART-2026-00093
type: shud_metrics
uri: shud-workspace/runs/RUN-2026-004-0007/metrics/metrics.parquet
sha256: ...
created_by:
  episode: EP-2026-00042
  command_id: CMD-2026-00221

inputs:
  - RUN-2026-004-0007
  - STACKLOCK-2026-003
  - PREP-2026-021

provenance:
  command: python scripts/compute_metrics.py --run RUN-2026-004-0007
  cwd: episodes/EP-2026-00042/workspace
  environment_digest: ...
```

### 12.3 指标仓库

建议把结构化指标写入 Parquet / DuckDB 兼容格式：

```text
warehouse/
  run_index.parquet
  metrics.parquet
  water_balance.parquet
  solver_health.parquet
  event_metrics.parquet
  validation_results.parquet
  benchmark_history.parquet
```

Commander 和 Critic 可以通过 bash 写查询脚本，也可以由 scaffolds 生成分析报告。

---

## 13. Evaluation 体系

### 13.1 三层评价

```text
Software Evaluation
  - build
  - tests
  - static checks
  - package checks
  - old-output compatibility
  - schema / contract compatibility

Model Evaluation
  - NSE
  - KGE
  - RMSE
  - PBIAS
  - peak error
  - event runoff coefficient
  - water balance residual
  - solver failures
  - negative state count
  - runtime / memory

Scientific Evaluation
  - hypothesis support / weakening
  - uncertainty consideration
  - cross-basin robustness
  - holdout robustness
  - overfitting risk
  - alternative explanation
  - claim strength
```

### 13.2 ValidationReport

```yaml
validation_id: VAL-2026-003
linked_change: CHG-2026-003
status: needs_revision

software:
  shud_build: pass
  rshud_check: pass
  old_output_compatibility: fail
  output_contract: pass

model:
  tiny_event_case: pass
  mass_balance_audit: pass
  discharge_regression: pass
  runtime_overhead: warning

scientific:
  claim_strength: limited
  holdout_status: not_run
  missing_checks:
    - runtime overhead threshold confirmation
    - Cache Creek event benchmark

required_next_actions:
  - Add old-output fallback to rSHUD diagnostics reader.
  - Run benchmark-before-after on Cache Creek event case.
  - Run holdout event validation before promoting claim.
```

### 13.3 Release 与 Promote 规则

- `pass`：可进入下一阶段或 release gate；
- `needs_revision`：必须完成列出的 required_next_actions；
- `blocked`：必须先经过 human gate 或重大修复。

---

## 14. Web Console（Operator-first）

Web Console 不是聊天界面，而是 operator console。

### 14.1 信息架构

V1 的主导航建议固定为：

```text
1. RCS
2. Experiments
3. Runs
4. Evidence
5. Validation
6. Changes
7. Skills
8. Memory Review
9. Episode Trace
10. Jobs
```

聊天和命令流是辅助入口，而不是主入口。

### 14.2 第一阶段页面

```text
1. Commander Dashboard
   - active RCS
   - current state briefing
   - pending decisions
   - pending human gates

2. RCS Detail
   - hypotheses
   - linked experiments
   - linked evidence
   - linked changes
   - current claim status

3. Experiment / Run Explorer
   - stacklock
   - datasets / observations / preprocess
   - run status
   - metrics snapshots

4. Validation Dashboard
   - latest validation reports
   - failed checks
   - benchmark deltas
   - holdout status

5. Change Review
   - patch summary
   - output contract impact
   - compatibility suite result
   - release gate status

6. Skill Registry
   - canonical skills
   - candidate scaffolds
   - promotion proposals
   - validation history

7. Memory Review
   - memory proposals
   - critic status
   - promote / reject actions

8. Episode Trace Viewer
   - bash commands
   - stdout/stderr
   - file diffs
   - artifacts
   - observations
   - job events

9. Job Monitor
   - queued / running / finished / failed
   - resource usage
   - retries
```

### 14.3 第二阶段再增加

```text
- benchmark trend dashboard
- claim / evidence graph
- scheduler management
- harness optimizer recommendations
- multi-user review workflow
```

---

## 15. 内化式迁移路线（修订版）

### Phase 0：代码基线冻结与项目归属

目标：建立 SHUD-Harness 独立代码库和工程边界。

任务：

```text
1. 创建 SHUD-Harness runtime 仓库。
2. 导入基础 Agent Runtime 代码。
3. 固定初始 commit，记录来源、许可证和内部改造目标。
4. 建立新的 README、LICENSE、CONTRIBUTING、ARCHITECTURE。
5. 明确项目命名、包命名和目录边界。
6. 删除或隔离与 SHUD 无关的示例、channel、personal assistant 配置。
```

验收：

```text
- 可以本地安装依赖；
- 可以启动 server/web；
- 可以运行基础 agent loop；
- 可以执行 bash；
- 可以记录 trace；
- 项目名称和目录结构已经独立化。
```

### Phase 1：Runtime Core 重命名与所有权内化

目标：把通用 runtime 组件变成 SHUD-Harness 自有模块。

任务：

```text
1. 重命名核心 packages：runtime-core、runtime-tools、runtime-memory、runtime-observe 等。
2. 统一 import path 和 workspace package name。
3. 清理通用 personal assistant 语义。
4. 引入 SHUD-Harness config schema。
5. 建立 runtime state 目录 `.shud-harness/`。
6. 保留 bash、read、write、edit、spawn、observe、memory、scheduler、supervisor 等核心能力。
```

验收：

```text
- install / test / typecheck / lint 全部通过；
- server 能启动；
- Web console 能打开；
- bash tool 能在隔离 workspace 执行；
- sub-agent episode 能创建和结束。
```

### Phase 2：Commander Agent Runtime

目标：让 Commander 成为主控，而不是固定 workflow。

任务：

```text
1. 新增 Commander system prompt。
2. 新增 Research Constitution。
3. 新增 State Briefing builder。
4. 新增 EpisodeSpec。
5. 新增 Worker / Critic / Harness Optimizer agent profiles。
6. 增加 commander decision trace。
7. 增加 request_human_gate action。
```

验收：

```text
- Commander 能读取 state briefing；
- Commander 能通过 bash 执行任务；
- Commander 能 spawn Worker；
- Commander 能请求 Critic；
- Commander 能生成 memory proposal；
- Commander 不会绕过高风险 human gate。
```

### Phase 3：Bash Sandbox 科研化 + Job 基座

目标：把 bash 从通用 shell 变成科研建模 sandbox，并预埋作业系统。

任务：

```text
1. 创建 episode workspace。
2. 支持 repo worktree。
3. 支持 raw data read-only mount。
4. 支持 scratch writable area。
5. 支持 resource limit 和 timeout。
6. 支持 command trace。
7. 支持 file diff trace。
8. 支持 artifact auto-registration。
9. 支持 destructive command policy。
10. 实现 local executor。
11. 定义 docker / slurm / k8s backend interface。
```

验收：

```text
- Worker 可以在 sandbox 中生成 scaffold；
- Worker 可以修改 worktree 但不能修改 raw data；
- 所有 bash 命令被记录；
- 所有新 artifact 被注册；
- 危险命令被拦截或进入 human gate；
- JobSpec 可提交到 local executor 并回收结果。
```

### Phase 4：Version / Provenance / Domain Layer

目标：引入 SHUD 科研对象模型和版本/数据治理底座。

任务：

```text
1. 实现 ResearchChangeSet。
2. 实现 StackLock / EnvLock。
3. 实现 DatasetManifest / ObservationManifest / PreprocessRecipe。
4. 实现 ExperimentSpec / CalibrationSpec / HoldoutPolicy。
5. 实现 RunManifest。
6. 实现 EvidencePacket。
7. 实现 ChangeSpec。
8. 实现 OutputContract / CompatibilitySuite。
9. 实现 ValidationReport。
10. 建立 YAML schema 和 TS type。
11. 增加 CLI / API 读写能力。
```

验收：

```text
- Commander 可以创建 RCS；
- Worker 可以创建 RunManifest；
- Critic 可以读取 EvidencePacket；
- ChangeSpec 能连接 evidence、patch 和 validation；
- 所有对象可 schema validate；
- benchmark delta 能绑定 StackLock；
- scientific evidence 能绑定数据与预处理 provenance。
```

### Phase 5：Skills 正规化

目标：建立严格格式的 SHUD skill library。

任务：

```text
1. 创建 skills-src/。
2. 实现 skill validator。
3. 实现 skill registry。
4. 实现 skill lifecycle 状态。
5. 实现 scaffold-to-skill promotion proposal。
6. 编写首批 6 个 canonical skills。
7. 为每个 skill 添加 smoke test。
```

验收：

```text
- SKILL.md frontmatter 只包含 name/description；
- 非法 skill 无法注册；
- Commander 能检索相关 skill；
- Worker 能使用 skill 中的 scripts；
- Harness Optimizer 能提出 skill 改进；
- Critic 能审查 skill promotion。
```

### Phase 6：Memory Governance

目标：把通用 memory 改造成 evidence-grounded memory。

任务：

```text
1. 实现 memory proposal。
2. 先落地 episodic / validated-evidence / procedural 三条长期主线。
3. 实现 memory review workflow。
4. 实现 evidence link requirement。
5. 实现 Commander / Critic promotion。
6. 禁止 agent 直接写 canonical memory。
```

验收：

```text
- Agent 只能提出 memory proposal；
- Critic 可以审查 proposal；
- Commander 可以 promote/reject；
- validated evidence memory 必须有 evidence link；
- 技能使用经验能进入 procedural / meta memory。
```

### Phase 7：SHUD Tiny Loop

目标：跑通第一个完整闭环。

任务：

```text
1. 准备 tiny SHUD case fixture。
2. Commander 创建 RCS。
3. Worker 使用 run-shud-tiny-case skill 运行模型。
4. Worker 解析输出并生成 RunManifest。
5. Worker 生成 EvidencePacket 草稿。
6. Critic 审查证据。
7. Commander 生成下一步决策。
8. 生成 memory proposal 和 skill improvement proposal。
```

验收：

```text
- 完整 episode trace 存在；
- RunManifest 存在；
- EvidencePacket 存在；
- CriticResult 存在；
- MemoryProposal 存在；
- Commander 能基于结果决定下一步。
```

### Phase 8：跨仓库代码变更闭环

目标：支持 SHUD / rSHUD / AutoSHUD 的代码改造。

任务：

```text
1. 生成 ChangeSpec。
2. 创建 SHUD / rSHUD / AutoSHUD worktree。
3. Worker 修改代码。
4. Worker 运行 build / check / benchmark。
5. 生成 patch bundle。
6. 生成 ValidationReport。
7. 运行 CompatibilitySuite。
8. Critic 审查 patch 和 validation。
9. Commander 决定 accept / revise / reject / human gate。
```

验收：

```text
- Patch bundle 可下载；
- ValidationReport 可读；
- old-output compatibility 被检查；
- benchmark before/after 被记录；
- OutputContract 影响被说明；
- 高风险变更进入 human gate。
```

### Phase 9：Harness Optimizer

目标：让系统开始改进自身。

任务：

```text
1. 读取失败 episode traces。
2. 汇总 repeated failure pattern。
3. 提出 skill / context / scaffold 改进。
4. 在固定 benchmark episode 上验证。
5. 生成 HarnessImprovementProposal。
6. Commander / Critic 审查后合并。
```

验收：

```text
- Harness Optimizer 至少能发现一种重复失败模式；
- 能提出可执行改进；
- 能通过对照 episode 验证改进有效；
- 不能绕过 human gate 修改高风险规则。
```

---

## 16. 第一阶段交付物（修订版）

### 16.1 代码交付物

```text
- SHUD-Harness 独立 runtime 仓库
- runtime-core / runtime-tools / runtime-memory / runtime-observe
- harness-executor / harness-versioning / harness-benchmark
- Commander / Worker / Critic / Harness Optimizer profiles
- bash sandbox
- local executor
- episode trace store
- skill validator
- memory proposal workflow
- SHUD domain schemas
- StackLock / DatasetManifest / OutputContract schemas
- tiny SHUD case fixture
- old-output compatibility fixtures
```

### 16.2 文档交付物

```text
- ARCHITECTURE.md
- RUNTIME.md
- COMMANDER_AGENT.md
- EXECUTOR_SPEC.md
- SKILL_SPEC.md
- MEMORY_SPEC.md
- SHUD_DOMAIN_SPEC.md
- VERSION_PROVENANCE_SPEC.md
- SANDBOX_POLICY.md
- HUMAN_GATE_POLICY.md
- BENCHMARK_POLICY.md
- TINY_LOOP_RUNBOOK.md
```

### 16.3 Demo 交付物

```text
Demo 1: Commander 通过 bash 读取 workspace、创建 RCS、运行 tiny case。
Demo 2: Worker 生成 scaffold，解析 SHUD 输出，形成 RunManifest。
Demo 3: Critic 审查 EvidencePacket 并提出补充验证。
Demo 4: Worker 对 SHUD / rSHUD 做一个小型诊断输出变更，生成 patch bundle。
Demo 5: CompatibilitySuite 证明 old-output 未被破坏。
Demo 6: Harness Optimizer 从失败 trace 提出 skill 改进。
```

---

## 17. 风险与控制

### 17.1 Agent 过度自主风险

风险：Commander 或 Worker 越过科学边界，直接修改模型过程或默认参数。

控制：

```text
- Research Constitution；
- Human Gate；
- bash / job policy；
- high-risk file path guard；
- Critic review；
- validation matrix。
```

### 17.2 Memory 污染风险

风险：Agent 把错误判断写入长期 memory。

控制：

```text
- proposal-only 写入；
- evidence link；
- Critic review；
- Commander / Human promotion；
- memory status lifecycle。
```

### 17.3 Skill 退化风险

风险：技能格式不规范、触发边界模糊，导致模型误用。

控制：

```text
- 严格 SKILL.md 格式；
- frontmatter 最小化；
- contract.yaml；
- smoke tests；
- promotion / deprecation；
- success rate tracking。
```

### 17.4 Bash / Executor 安全风险

风险：bash 权限过大，或 future executor 污染 baseline、破坏仓库、误提交大量任务。

控制：

```text
- read-only raw data；
- worktree isolation；
- destructive command blocklist；
- submit quota；
- human gate；
- command / job trace；
- artifact checksum。
```

### 17.5 科学误判风险

风险：Agent 把一次指标提升解释为模型改进。

控制：

```text
- EvidencePacket；
- uncertainty checklist；
- cross-basin validation；
- holdout policy；
- Critic review；
- claim status: provisional / validated / rejected；
- Human Gate。
```

### 17.6 版本漂移风险

风险：环境变化被误判为代码改进。

控制：

```text
- StackLock / EnvLock；
- benchmark delta bind stacklock；
- baseline overwrite approval；
- reproducibility replay。
```

### 17.7 数据污染与预处理漂移风险

风险：输入数据、观测、预处理规则在无人察觉的情况下变化。

控制：

```text
- DatasetManifest；
- ObservationManifest；
- PreprocessRecipe；
- checksum；
- data lineage；
- preprocess review。
```

---

## 18. 12 周实施计划（修订版）

### 第 1–2 周：Runtime 内化

```text
- 建立独立仓库；
- 重命名 runtime packages；
- 跑通 server / web / bash / sub-agent / trace；
- 建立 `.shud-harness/` runtime state；
- 编写基础架构文档。
```

### 第 3–4 周：Commander 与 Bash / Job 基座

```text
- Commander profile；
- Research Constitution；
- EpisodeSpec；
- Worker / Critic profiles；
- bash sandbox；
- command / file / artifact trace；
- local executor；
- human gate 初版。
```

### 第 5–6 周：Version / Provenance / Domain Layer

```text
- RCS；
- StackLock / EnvLock；
- DatasetManifest / ObservationManifest / PreprocessRecipe；
- ExperimentSpec / CalibrationSpec / HoldoutPolicy；
- RunManifest；
- EvidencePacket；
- ChangeSpec；
- OutputContract / CompatibilitySuite；
- ValidationReport；
- YAML schema / TS type。
```

### 第 7–8 周：Skills 与 Memory

```text
- skill validator；
- skills-src；
- 首批 6 个 skills；
- memory proposal；
- episodic / validated-evidence / procedural 三条长期主线；
- Critic review workflow。
```

### 第 9–10 周：Tiny Loop 与 Evidence Loop

```text
- tiny SHUD case；
- Commander 创建 RCS；
- Worker 运行模型；
- 生成 RunManifest；
- 生成 EvidencePacket；
- Critic 审查；
- Commander 下一步决策。
```

### 第 11–12 周：Code Change Loop 与 Compatibility Loop

```text
- ChangeSpec；
- worktree patch；
- validation report；
- compatibility suite；
- patch bundle；
- holdout-aware benchmark；
- Harness Optimizer 读取失败 trace；
- 提出并验证一条 skill / context 改进。
```

---

## 19. 成功标准

第一阶段成功不是看功能菜单多少，而是看是否跑通以下闭环：

```text
Scholar question
  → Commander creates RCS
  → Worker runs SHUD tiny case through bash
  → Artifact and trace recorded
  → RunManifest generated
  → EvidencePacket generated
  → Critic reviews evidence
  → Commander decides next action
  → Worker modifies code in sandbox
  → ValidationReport generated
  → CompatibilitySuite executed
  → MemoryProposal and SkillProposal generated
  → Human Gate catches high-risk decisions
```

定量标准：

```text
- 100% episode 有 trace；
- 100% bash 命令有 exit code 和 stdout/stderr excerpt；
- 100% job 有 submit / watch / collect 事件；
- 100% artifact 有 manifest；
- 100% benchmark delta 绑定 stacklock；
- 100% 长期 memory 写入走 proposal；
- 100% skill 通过格式校验；
- tiny loop 可重复运行；
- 至少完成 1 个跨 SHUD / rSHUD / AutoSHUD 的小型代码变更闭环；
- 至少完成 1 次 old-output compatibility 检查；
- 至少完成 1 次 holdout-aware benchmark；
- 至少完成 1 次 Harness Optimizer 改进建议并验证。
```

---

## 20. 当前阶段明确不做

```text
- 不把系统做成固定 workflow 平台；
- 不建设十几个常驻 agent；
- 不把外部编码客户端接口作为第一阶段重点；
- 不做跨外部客户端的 skill 同步；
- 不直接自动修改物理方程；
- 不自动发布模型版本；
- 不让 Agent 直接写入 canonical scientific memory；
- 不把 Web Console 做成普通聊天产品；
- 不先做复杂 HPC 大规模校准平台；
- 不在 V1 追求 full autonomous research。
```

---

## 21. 推荐的 V1 / V1.5 / V2 边界

### V1（必须）

```text
- Commander / Worker / Critic
- bash sandbox
- local executor
- RCS / Experiment / Run / Evidence / Validation / Change
- StackLock / DatasetManifest / PreprocessRecipe
- OutputContract / CompatibilitySuite
- 6 个 canonical skills
- memory proposal workflow
- tiny loop + cross-repo small change loop
```

### V1.5（应该）

```text
- docker executor
- benchmark history dashboard
- holdout-aware experiment templates
- richer provenance explorer
- more complete AutoSHUD integration
```

### V2（可以）

```text
- slurm / k8s backend
- stronger harness optimizer
- richer multi-user review workflow
- release gate automation
- larger-scale calibration orchestration
```

---

## 22. 最终定位

SHUD-Harness 的长期价值不是“让 Agent 帮忙跑几个脚本”，而是把 SHUD 模型开发变成一个持续积累的科研智能系统：

```text
它会记得哪些实验做过；
它会记得哪些假设被削弱；
它会记得哪些代码修改导致退化；
它会沉淀可复用的 SHUD 操作技能；
它会把模型运行失败转化为诊断经验；
它会把成功的脚手架提升为正式 skill；
它会把证据、代码、验证和决策连接起来；
它会用版本锁和数据溯源约束结论；
它会在一次次 episode 中优化自己的 harness。
```

一句话定义：

> **SHUD-Harness 是一个以 Commander Agent 为主控、以 bash-first / job-aware 执行为主要动作空间、以严格 skill 和证据记忆为长期能力、以 StackLock / Data Provenance / OutputContract / BenchmarkPolicy 为科研可信度底座、以 Critic / Evaluator / Human Gate 为约束的 SHUD 科研建模 Agent Runtime。**

---


## 23. v0.4 正式对象规范（以本章为准）

本章将 **StackLock / JobSpec / DatasetManifest / CalibrationSpec / BenchmarkPolicy** 从“在架构中出现的对象”升级为“必须落盘、可校验、可审计、可被 CLI / API 直接操作的一级对象”。前文第 5 章保留作为总体对象模型；凡涉及字段边界、状态机、治理硬规则、目录落点与升级条件，**以本章为准**。

### 23.1 StackLock 正式规范

#### 23.1.1 定义与边界

StackLock 用于冻结一次科研运行所依赖的 **代码版本、构建链、运行镜像、关键依赖和契约兼容范围**。它解决的是：

```text
“这次结果到底跑在什么软件堆栈上？”
“性能差异来自代码改动，还是来自环境漂移？”
“这个 benchmark delta 是否可比较？”
```

它**不负责**替代 DatasetManifest，也**不负责**记录临时资源限制；前者由数据对象承担，后者由 EnvLock / JobSpec 承担。

#### 23.1.2 正式最小 schema

```yaml
stacklock_id: STACKLOCK-2026-003
name: shud-stack-cache-creek-v1
status: draft_local | resolved | locked | benchmark_approved | deprecated
created_at: 2026-04-23T10:30:00Z
created_by: commander
fingerprint: sha256:9c2f...

repos:
  shud:
    remote: git@github.com:SHUD-System/SHUD.git
    commit: abc123
    dirty: false
  rshud:
    remote: git@github.com:SHUD-System/rSHUD.git
    commit: def456
    dirty: false
  autoshud:
    remote: git@github.com:SHUD-System/AutoSHUD.git
    commit: ghi789
    dirty: false

build:
  os_image: ubuntu-22.04
  container_digest: sha256:xxxx
  compiler:
    c: gcc-12.3
    cxx: g++-12.3
  cmake: 3.29
  make: 4.3
  build_flags:
    - -O3
    - -DNDEBUG

runtime:
  r: 4.4.1
  python: 3.12
  shell: bash-5.2

dependencies:
  sundials: 6.7.0
  terra: 1.8-10
  sf: 1.0-18
  gdal: 3.8
  proj: 9.3

compatibility:
  output_contract_range: ">=1.2.0,<2.0.0"
  benchmark_policy_range: ">=1.0.0,<2.0.0"

notes:
  - Required for all benchmark deltas and evidence promotion.
```

#### 23.1.3 生命周期

```text
draft_local
  → resolved
  → locked
  → benchmark_approved
  → deprecated
```

含义如下：

- `draft_local`：允许 episode 内部临时生成，允许存在 dirty worktree，仅供开发调试。
- `resolved`：依赖已解析，但尚未通过完整一致性校验。
- `locked`：commit、镜像 digest、关键依赖均已固定，可用于 RunManifest、ValidationReport、BenchmarkReport。
- `benchmark_approved`：已作为基准锁使用，允许被 baseline 和 regression report 引用。
- `deprecated`：历史保留，但不再用于新增实验与 baseline。

#### 23.1.4 治理硬规则

```text
1. 没有 locked 级别 StackLock 的 run，不得进入 evidence。
2. baseline 只允许引用 benchmark_approved 级别 StackLock。
3. 任意 repo 处于 dirty=true 时，不得用于 release gate。
4. 分支名、浮动 tag、latest 镜像标签都不能视为“锁”；必须解析为 commit / digest。
5. BenchmarkReport 必须同时记录 before_stacklock 与 after_stacklock。
6. OutputContract 兼容范围变化时，必须联动 CompatibilitySuite。
```

#### 23.1.5 V1 最小实现要求

```text
- 提供 snapshot / verify / diff 三个原生命令。
- 能从 git、编译器、R/Python 包、容器 digest 自动采集最小字段。
- 能生成稳定 fingerprint。
- 能在 benchmark report 中自动回填 stacklock_id。
```

#### 23.1.6 建议目录与接口

```text
.shud-harness/locks/stacklocks/<stacklock_id>.yaml
```

```text
harness stacklock snapshot
harness stacklock verify <stacklock_id>
harness stacklock diff <before> <after>
```

---

### 23.2 JobSpec 正式规范

#### 23.2.1 定义与边界

JobSpec 用于把“执行”从一次临时 bash 调用升级为 **有输入、有资源、有状态、有回收策略** 的正式作业对象。原则上：

```text
短任务：bash 直接执行
长任务 / 批量任务 / 可重试任务 / 需收集多工件任务：必须走 JobSpec
```

JobSpec 不是替代 bash，而是把 bash 放进一个可治理的 submit / watch / collect / retry 协议里。

#### 23.2.2 正式最小 schema

```yaml
job_id: JOB-2026-0081
name: exp-004-batch-benchmark
job_kind: compile | run | benchmark | calibration | analysis | compatibility
status: draft | submitted | queued | running | collecting | succeeded | failed | cancelled | archived

linked_episode: EP-2026-00042
linked_experiment: EXP-2026-004
linked_stacklock: STACKLOCK-2026-003
linked_envlock: ENVLOCK-2026-011
benchmark_policy_id: BP-2026-001
calibration_spec_id: null

backend:
  type: local | docker | slurm | k8s
  queue: default
  priority: normal

command:
  entrypoint: bash
  args:
    - .harness/scaffolds/run_event_benchmark.sh
    - --experiment
    - EXP-2026-004
  cwd: episodes/EP-2026-00042/worktrees/SHUD

mounts:
  raw_data: read_only
  processed_data: read_only
  episode_scratch: writable

resources:
  cpu: 8
  memory_gb: 24
  wall_minutes: 180

retry_policy:
  max_attempts: 2
  retry_on:
    - transient_io_error
    - runner_timeout

checkpoint_policy:
  enabled: true
  interval_minutes: 30

expected_artifacts:
  - metrics_summary.parquet
  - validation_report.yaml
  - hydrograph_plots/

collection_policy:
  stdout_tail_kb: 64
  stderr_tail_kb: 64
  include_working_patch: true

budget_guard:
  max_jobs_per_episode: 4
  submit_requires_commander: true
```

#### 23.2.3 状态机

```text
draft
  → submitted
  → queued
  → running
  → collecting
  → succeeded | failed | cancelled
  → archived
```

#### 23.2.4 治理硬规则

```text
1. 任何 batch benchmark、calibration、兼容性回归都必须绑定 JobSpec。
2. job_kind=benchmark 时，benchmark_policy_id 为必填。
3. job_kind=calibration 时，calibration_spec_id 与 holdout policy 必须存在。
4. raw data 必须只读挂载；任何可写原始数据作业一律阻断。
5. collect 阶段必须输出 artifact 清单与退出信息，不能只留 stdout。
6. 资源申请不得超过 EpisodeSpec 预算上限。
```

#### 23.2.5 V1 最小实现要求

```text
- 实现 local backend。
- docker backend 可选。
- slurm / k8s 只定义 adapter interface，不要求首版打通。
- 所有 job 事件进入 traces/job_events.jsonl。
- 失败 job 支持 retry_on 规则与最终失败归档。
```

#### 23.2.6 建议目录与接口

```text
.shud-harness/runtime/jobs/<job_id>/
  spec.yaml
  events.jsonl
  stdout.log
  stderr.log
  collect_manifest.yaml
```

```text
harness job submit <job_spec>
harness job watch <job_id>
harness job collect <job_id>
harness job cancel <job_id>
```

---

### 23.3 DatasetManifest 正式规范

#### 23.3.1 定义与边界

DatasetManifest 是 **数据身份、版本、质量、lineage 与可验证性** 的正式载体。它解决的是：

```text
“这次实验到底用的是哪份地形、哪份 forcing、哪份土地利用？”
“文件换了、投影变了、重采样了，系统有没有显式记录？”
“数据变化后，旧 benchmark 还能不能直接沿用？”
```

ObservationManifest 仍然是它的兄弟对象，用于观测真值与不确定性；DatasetManifest 重点覆盖模型输入侧的数据资产。

#### 23.3.2 正式最小 schema

```yaml
dataset_id: DSM-2026-014
name: cache-creek-dem-30m
dataset_class: raw | processed | lookup | forcing | boundary | terrain
status: registered | validated | curated | frozen | retired
version: 1.0.0
fingerprint: sha256:2a93...

source:
  provider: internal_curated
  original_source: USGS
  acquisition_date: 2025-11-18
  license: internal_research_use

storage:
  root_uri: shud-workspace/data/raw/cache_creek/dem_30m/
  immutable: true

spatial:
  crs: EPSG:26910
  resolution: 30m
  extent_bbox: [x1, y1, x2, y2]

temporal:
  start: null
  end: null
  timezone: UTC

units:
  elevation: m

files:
  - path: dem_30m.tif
    sha256: "..."
    size_bytes: 182736452

schema:
  raster_bands:
    - elevation

quality:
  qc_status: passed
  missing_ratio: 0.0

lineage:
  parents: []
  generated_by_preprocess: null

notes:
  - Canonical DEM for Cache Creek smoke/regression cases.
```

#### 23.3.3 生命周期

```text
registered
  → validated
  → curated
  → frozen
  → retired
```

- `registered`：已登记，但还未完成哈希和字段完整性校验。
- `validated`：文件存在、哈希一致、单位/CRS/时间字段齐全。
- `curated`：被项目确认可复用，可被多个 ExperimentSpec 引用。
- `frozen`：被冻结为基准数据，后续不可原地改写。
- `retired`：历史保留，但不再作为默认选择。

#### 23.3.4 治理硬规则

```text
1. frozen 数据集不得原地覆盖；新内容必须生成新版本或新 dataset_id。
2. 任何 derived / processed 数据都必须指向父数据集和 preprocess recipe。
3. 地理数据缺少 CRS / 分辨率，时间序列缺少单位 / timezone，均不得进入 validated。
4. 基准数据集变化后，相关 BenchmarkPolicy 必须重跑并出具新的 baseline 说明。
5. DatasetManifest 缺失时，实验只能算开发性探索，不能升级为 validated evidence。
```

#### 23.3.5 V1 最小实现要求

```text
- 支持 raw / processed / forcing 三类最小分类。
- 支持文件哈希校验、空间/时间字段校验、lineage 父子关系。
- 支持 register / verify / freeze 三个动作。
- 支持在 ExperimentSpec 中强制引用 dataset_id。
```

#### 23.3.6 建议目录与接口

```text
shud-workspace/datasets/manifests/<dataset_id>.yaml
```

```text
harness dataset register <path>
harness dataset verify <dataset_id>
harness dataset freeze <dataset_id>
harness dataset diff <before> <after>
```

---

### 23.4 CalibrationSpec 正式规范

#### 23.4.1 定义与边界

CalibrationSpec 用于明确 **参数校准的允许边界、搜索策略、预算、acceptance rule 与 holdout 约束**。它必须明确与“结构诊断”分流：

```text
CalibrationSpec 解决的是“允许怎么调参数、怎样判定参数搜索是否合规”
而不是“这个模型结构已经被科学证明更正确”
```

因此，CalibrationSpec 是一个 **search policy**，不是 scientific claim。

#### 23.4.2 正式最小 schema

```yaml
calibration_id: CAL-2026-002
name: semi-arid-storm-parameter-search
status: draft | approved | running | analyzed | accepted | rejected | archived

linked_experiment: EXP-2026-004
linked_stacklock: STACKLOCK-2026-003
holdout_policy_id: HOLD-2026-003

mode:
  strategy: grid | random | bayes | evolutionary | manual
  seed: 20260423

optimizer_budget:
  max_trials: 120
  max_wall_minutes: 720
  early_stop_patience: 20

parameter_groups:
  allowed:
    - ksat_multiplier
    - mannings_n_multiplier
    - depression_storage_factor
  forbidden:
    - default_release_parameters
    - undocumented_physical_switches
    - debug_tolerances

search_space:
  ksat_multiplier:
    type: continuous
    bounds: [0.25, 2.0]
    scale: log
  mannings_n_multiplier:
    type: continuous
    bounds: [0.5, 1.5]
    scale: linear
  depression_storage_factor:
    type: continuous
    bounds: [0.5, 1.5]
    scale: linear

constraints:
  - water_balance_residual <= 0.01
  - negative_state_count == 0

objective_functions:
  primary:
    - peak_flow_error
    - peak_timing_error
  secondary:
    - water_balance_residual
    - NSE

anti_leakage_rules:
  - calibration_set and holdout_set must not overlap
  - parameter search cannot use holdout metrics for ranking
  - event-specific tuning cannot be generalized without holdout validation

acceptance_rules:
  - improvement must persist on holdout events
  - water balance cannot regress beyond threshold
  - solver health must remain within policy limits

promotion_rules:
  - accepted calibration result may become evidence candidate
  - accepted calibration result may not directly overwrite release defaults
```

#### 23.4.3 配套结果对象建议

CalibrationSpec 本身不是结果，建议配套一个 `CalibrationRunSummary`：

```yaml
calibration_run_id: CALRUN-2026-017
calibration_id: CAL-2026-002
status: completed

best_trial:
  rank: 1
  parameter_set:
    ksat_multiplier: 0.63
    mannings_n_multiplier: 0.81
    depression_storage_factor: 1.12

calibration_metrics:
  peak_flow_error: 0.14
  peak_timing_error_hours: 1.2

holdout_metrics:
  peak_flow_error: 0.18
  peak_timing_error_hours: 1.7

decision:
  status: accepted_as_candidate_only
  notes:
    - Structural claim not yet promoted.
```

#### 23.4.4 治理硬规则

```text
1. CalibrationSpec 缺失时，不允许跑正式 calibration job。
2. calibration 改善不得自动视为“物理结构更正确”。
3. 没有 holdout policy 的 calibration 结果，不得升级为 validated claim。
4. 默认发布参数的修改必须经过 human gate、scientific benchmark 和 release gate。
5. 所有 calibration 结果必须记录随机种子、搜索预算和失败 trial 数。
```

#### 23.4.5 V1 最小实现要求

```text
- 支持 grid / random 两种最小策略。
- 支持 allowed / forbidden 参数边界。
- 支持 holdout 绑定。
- 支持生成 CalibrationRunSummary。
- 不要求首版实现复杂 Bayesian optimizer，但 schema 必须预留。
```

#### 23.4.6 建议目录与接口

```text
shud-workspace/calibration/specs/<calibration_id>.yaml
shud-workspace/calibration/runs/<calibration_run_id>.yaml
```

```text
harness calibration create <spec>
harness calibration run <calibration_id>
harness calibration analyze <calibration_run_id>
```

---

### 23.5 BenchmarkPolicy 正式规范

#### 23.5.1 定义与边界

BenchmarkPolicy 用于规定 **跑哪些基准、如何比较、解释阈值是什么、何时必须 human gate、何时允许更新 baseline**。它把 benchmark 从“团队口头共识”升级为“可审计制度”。

#### 23.5.2 正式最小 schema

```yaml
benchmark_policy_id: BP-2026-001
name: shud-v1-benchmark-policy
version: 1.0.0
status: draft | active | frozen | superseded

tiers:
  smoke:
    required_for:
      - build_change
      - script_change
      - simple_bugfix
  regression:
    required_for:
      - output_contract_change
      - dependency_change
      - solver_change
      - preprocess_change
  scientific:
    required_for:
      - claim_promotion
      - default_parameter_change
      - release_candidate

cases:
  smoke:
    - shud_build
    - shud_tiny_case
    - rshud_check
    - basic_roundtrip
  regression:
    - old_output_compatibility
    - fixed_case_metrics_delta
    - solver_health_delta
    - runtime_memory_delta
  scientific:
    - cross_basin_holdout
    - cross_event_holdout
    - uncertainty_aware_claim_review

thresholds:
  fixed_case_metrics_delta:
    peak_flow_error:
      max_regression: 0.02
    water_balance_residual:
      max_regression: 0.005
  runtime_memory_delta:
    runtime_relative_regression: 0.10
    memory_relative_regression: 0.15

interpretation:
  uncertainty_aware: true
  require_narrative_for_borderline_cases: true

baseline:
  baseline_status: frozen
  baseline_stacklock: STACKLOCK-2026-003
  baseline_output_contract: OUT-2026-002

human_gate_required_for:
  - baseline_overwrite
  - threshold_relaxation
  - benchmark_case_removal
  - scientific_tier_bypass
```

#### 23.5.3 配套结果对象建议

建议把 benchmark 结果固定为 `BenchmarkReport`：

```yaml
benchmark_report_id: BR-2026-019
benchmark_policy_id: BP-2026-001
before_stacklock: STACKLOCK-2026-003
after_stacklock: STACKLOCK-2026-004
linked_change: CHG-2026-003
status: pass | needs_review | fail

datasets:
  - DSM-2026-014
preprocess:
  - PREP-2026-021
output_contract: OUT-2026-002

tier_results:
  smoke: pass
  regression: needs_review
  scientific: not_run

summary:
  - Old output compatibility passed.
  - Peak-flow regression within tolerance.
  - Runtime increased by 12%, exceeding policy threshold.
```

#### 23.5.4 生命周期

```text
draft
  → active
  → frozen
  → superseded
```

- `active`：默认用于新 validation。
- `frozen`：被冻结为某一时期的正式制度，可用于 release gate。
- `superseded`：被新版本替代，但历史报告仍引用旧 policy。

#### 23.5.5 治理硬规则

```text
1. 所有 BenchmarkReport 必须绑定 benchmark_policy_id、before/after stacklock、dataset/preprocess、output_contract。
2. baseline 只允许在 frozen policy 下维护。
3. 覆盖 baseline、放宽阈值、移除 benchmark case 均需要 human gate。
4. scientific tier 只能在 holdout policy 存在时通过。
5. benchmark 结果必须同时给出数值结论和叙述性解释，不能只给单一 pass/fail。
```

#### 23.5.6 V1 最小实现要求

```text
- smoke / regression 两层必须落地。
- scientific tier 至少落地 schema、报告模板和 holdout 绑定。
- 支持 benchmark diff 与 baseline compare。
- 支持在 ValidationReport 中嵌入 benchmark_report_id。
```

#### 23.5.7 建议目录与接口

```text
shud-workspace/validation/benchmark-policies/<benchmark_policy_id>.yaml
shud-workspace/validation/benchmark-reports/<benchmark_report_id>.yaml
```

```text
harness benchmark run <policy_id>
harness benchmark diff <before_report> <after_report>
harness benchmark promote-baseline <report_id>
```

---

## 24. 对象关系、升级条件与强制绑定矩阵

### 24.1 对象关系主链

```text
Research Change Set
  → ExperimentSpec
    ├── StackLock
    ├── DatasetManifest / ObservationManifest
    ├── PreprocessRecipe
    ├── CalibrationSpec（可选，但必须显式）
    └── HoldoutPolicy
          ↓
        JobSpec
          ↓
        RunManifest
          ↓
        ValidationReport / BenchmarkReport / CompatibilitySuite
          ↓
        EvidencePacket
          ↓
        ChangeSpec
          ↓
        ReleaseGate
```

### 24.2 强制绑定矩阵

| 对象 | 必须引用 | 主要被谁消费 | 缺失后的后果 |
|---|---|---|---|
| StackLock | repos / build / runtime / dependencies | ExperimentSpec、RunManifest、BenchmarkReport | 结果不能进入 evidence / benchmark / release |
| JobSpec | linked_episode / backend / resources / collection_policy | Executor、RunManifest、Trace Viewer | 长任务无法重试、无法审计资源与工件 |
| DatasetManifest | source / files / fingerprint / lineage | ExperimentSpec、PreprocessRecipe、BenchmarkReport | 结果只能算探索性开发，不算科研证据 |
| CalibrationSpec | search_space / objective / holdout / acceptance | Calibration job、CalibrationRunSummary、Critic | 参数搜索缺乏边界，容易把过拟合误判为进步 |
| BenchmarkPolicy | tiers / cases / thresholds / baseline / human gate rules | BenchmarkReport、ValidationReport、ReleaseGate | 基准比较失去制度化约束 |

### 24.3 结果升级条件

```text
开发性运行
  = 有 EpisodeTrace + 基本运行产物

可比较运行
  = 开发性运行
  + StackLock
  + DatasetManifest / PreprocessRecipe
  + RunManifest

evidence candidate
  = 可比较运行
  + ValidationReport
  + Critic review
  + uncertainty note

validated evidence
  = evidence candidate
  + BenchmarkPolicy / BenchmarkReport
  + holdout rule satisfied（如涉及校准或科学声明）
  + Commander/Human approval

release candidate
  = validated evidence
  + ChangeSpec
  + OutputContract / CompatibilitySuite
  + ReleaseGate
```

### 24.4 需要强制阻断的场景

```text
- 无 StackLock 却试图写 benchmark delta。
- 无 DatasetManifest 却试图声称“数据处理改进”。
- 无 CalibrationSpec 却试图跑批量参数搜索。
- 无 BenchmarkPolicy 却试图覆盖 baseline。
- scientific tier 未跑却试图把单一流域结果升级为 validated claim。
```

---

## 25. 目录、CLI / API、控制台与实施边界

### 25.1 建议目录落点

```text
.shud-harness/
  locks/
    stacklocks/
    envlocks/
  runtime/
    jobs/
    sessions/
    episodes/
    traces/

shud-workspace/
  datasets/
    manifests/
  observations/
    manifests/
  preprocess/
    recipes/
  calibration/
    specs/
    runs/
  validation/
    benchmark-policies/
    benchmark-reports/
    compatibility-suites/
  runs/
  evidence/
  changes/
```

### 25.2 CLI / API 最小集合

```text
harness stacklock snapshot / verify / diff
harness job submit / watch / collect / cancel
harness dataset register / verify / freeze / diff
harness calibration create / run / analyze
harness benchmark run / diff / promote-baseline
```

对应 API 建议最小集合：

```text
POST   /api/stacklocks/snapshot
GET    /api/stacklocks/:id
GET    /api/stacklocks/:id/diff/:other

POST   /api/jobs
GET    /api/jobs/:id
POST   /api/jobs/:id/cancel
POST   /api/jobs/:id/collect

POST   /api/datasets/register
POST   /api/datasets/:id/verify
POST   /api/datasets/:id/freeze

POST   /api/calibration/specs
POST   /api/calibration/specs/:id/run
GET    /api/calibration/runs/:id

POST   /api/benchmarks/run
GET    /api/benchmarks/reports/:id
POST   /api/benchmarks/promote-baseline
```

### 25.3 Web Console 需要补的页面与字段

在 v0.3 的基础上，工作台需要新增以下对象页：

```text
1. StackLock Detail
   - repo commits
   - dependency versions
   - fingerprint
   - diff vs another StackLock

2. Job Detail
   - backend
   - queue / resources
   - lifecycle timeline
   - collected artifacts

3. Dataset Detail
   - source / lineage / hash / qc
   - spatial-temporal metadata
   - linked experiments

4. Calibration Detail
   - allowed parameters
   - search space
   - best trial vs holdout
   - promotion status

5. Benchmark Policy / Report
   - tiers / cases / thresholds
   - baseline reference
   - before/after comparison
   - human gate history
```

### 25.4 V1 / V1.5 / V2 实施边界

#### V1 必做

```text
- StackLock snapshot / verify / diff
- local executor + JobSpec lifecycle
- DatasetManifest register / verify / freeze
- CalibrationSpec（grid / random）
- BenchmarkPolicy（smoke / regression）
- BenchmarkReport / ValidationReport 联动
```

#### V1.5 建议做

```text
- docker executor
- scientific tier benchmark 模板
- CalibrationRunSummary 可视化
- baseline 审批流
- StackLock diff 可视化
```

#### V2 再做

```text
- slurm / k8s backend
- Bayesian / evolutionary calibration
- dataset catalog service
- benchmark trend analytics
- release gate 全自动编排
```

---

## 26. v0.4 验收清单（Definition of Done）

满足以下条件，才能认为“补充完善版 v0.4”真正落地，而不是只停留在文档层面：

```text
1. 至少有 1 个 locked 级 StackLock 被 smoke / regression benchmark 引用。
2. 至少有 1 个 JobSpec 经 local executor 成功 submit / watch / collect。
3. 至少有 2 个 DatasetManifest 完成 verify，其中 1 个处于 frozen。
4. 至少有 1 个 CalibrationSpec 绑定 HoldoutPolicy，并产出 CalibrationRunSummary。
5. 至少有 1 个 active BenchmarkPolicy，包含 smoke / regression tiers。
6. 至少有 1 个 BenchmarkReport 同时绑定 before/after stacklock、dataset、preprocess、output_contract。
7. EvidencePacket 的入库逻辑已显式检查 StackLock / DatasetManifest / PreprocessRecipe。
8. ReleaseGate 对 baseline overwrite、threshold relaxation、default parameter change 能触发 human gate。
9. Web Console 至少能浏览 StackLock / JobSpec / DatasetManifest / BenchmarkReport 四类对象。
10. 文档、schema、CLI、trace、目录落点四者保持一致，不出现“文档有对象、系统无落点”的空转设计。
```

作为项目管理层的简化判断，可以用一句话概括：

> **只有当结果被 StackLock 锁住、被 DatasetManifest 说明、由 JobSpec 可审计地执行、在 CalibrationSpec 边界内搜索、并受 BenchmarkPolicy 约束时，SHUD-Harness 才算真正进入“科研运行时”阶段。**



## 附录 A：建议的首批 Benchmark 矩阵

```text
A. Smoke
- SHUD build
- SHUD tiny case
- rSHUD basic load
- SHUD output → rSHUD reader
- event diagnostics optional-file tolerance

B. Regression
- old-output compatibility
- fixed-case hydrograph metrics delta
- water balance residual delta
- solver health delta
- runtime / memory delta

C. Scientific
- semi-arid storm event pair
- one holdout basin
- one holdout event
- claim strength classification
```

---

## 附录 B：建议的 Human Gate 触发条件

```text
- 修改物理过程实现
- 修改默认参数
- 修改 major OutputContract
- 覆盖 benchmark baseline
- 变更 ReleaseGate 规则
- 提升 provisional claim 为 validated claim
- 大规模计算资源提交
```

---

## 附录 C：建议的最小 backlog

```text
1. 建立独立仓库与 runtime skeleton
2. 跑通 server / web / bash / trace
3. 定义 EpisodeSpec / RCS / RunManifest schema
4. 实现 StackLock / DatasetManifest / PreprocessRecipe
5. 实现 local executor
6. 跑通 SHUD tiny case
7. 跑通 SHUD → rSHUD roundtrip
8. 增加 old-output fixture
9. 实现 ValidationReport 与 CompatibilitySuite
10. 完成一条跨仓库小变更闭环
```

---
