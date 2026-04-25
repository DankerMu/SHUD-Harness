# SHUD-Harness 实施规格书 v0.8

**日期**: 2026-04-24 **状态**: 可实施 **团队**: 1 PI + 1 工程师 + 0.5 数据支持

本文件是唯一的实施基准。不依赖任何外部文档即可开始开发。

> **Canonical Source 说明：** 本文件为自包含阅读基准。字段细节以 [Minimal_Schemas.md](03_SPEC/Minimal_Schemas.md) 和 [Support_Schema_Contracts.md](03_SPEC/Support_Schema_Contracts.md) 为权威源。Report export、notification、batch progress、PI decision comments 均为 support schema，不改变 8 个核心对象。

---

## 1. 项目定义

**一句话**: SHUD-Harness 是 PI 主导的科研工程助手——通过 Web 界面（实时对话 + 日志流 + 审批 + 报告阅读）驱动 SHUD/rSHUD/AutoSHUD 的模型运行、诊断、敏感性分析和跨仓库代码变更，产出 Markdown 报告供 PI 决策。

**不是什么**: 不是自治科研平台，不是多 Agent 自主编排系统。

**技术基础**: 基于 Zero agent runtime (TypeScript/Bun) 扩展，复用其 AgentLoop、Session、WebSocket、Tool 架构，在其上构建 SHUD 领域逻辑。

**成功标准**: PI 从"手工跑模型 + 手工对比 + 手工写总结"变成"在浏览器里对话 + 看报告 + 点审批"。衡量时间节省，不衡量自治程度。

---

## 2. 代码栈接口摘要

### SHUD (C++14)
- 构建: `./configure && make shud`
- 运行: `./shud <project>` → 从 `input/<project>/` 读全套输入
- 输出: 二进制 `.dat`，每行 = 时间戳 + N 列值 (8-byte double)
- **Tiny fixture**: `input/ccw/` — 1147 单元, 103 河段, 1827 天。运行 30 天子集即可验证。

### rSHUD (R 2.2.0)
- 读输出: `read_output(keyword, path)` → xts 对象
- 水量平衡: `wb.all()`
- 读输入: `read_mesh()`, `read_river()`, `read_att()`
- 自动建模: `shud_auto_build()`
- **注意**: 新 API 用 snake_case（`read_mesh`），旧 API（`readmesh`）仍存在但不推荐。

### AutoSHUD (R 脚本)
- 入口: `GetReady.R` → `Step1~5_*.R`
- 配置: `.autoshud.txt` 键值对
- 核心依赖: rSHUD 的 `shud.triangle()`, `write.mesh()` 等

### Zero (基础实现，在此扩展)
- 直接复用: AgentLoop + Hook 架构, Session + WebSocket, Tool 注册/调度, bash 工具安全检查, SKILL.md 格式, spawn/wait agent 模式, 命令 trace 结构, Hono + React Web 框架
- 需扩展: Park/Resume 长任务状态机, SHUD 专用工具 (编译/运行/解析), 结构化 RunRecord/EvidenceReport, PI 审批界面, 科研 Closure Classifier
- 需修改: Memory create status (不默认 verified), Role 定义 (Coordinator/Repo Explorer/Worker/Coder/Reviewer)

---

## 3. 角色与治理

### 角色边界

| 角色 | 做什么 | 不做什么 |
|------|--------|----------|
| **PI** | 提问题、定方向、判断证据、批准高风险变更 | 不写代码、不跑模型 |
| **Coordinator** | 解析任务、调度执行、汇总报告、建议下一步 | 不判断科学结论、不自主修改物理代码 |
| **Repo Explorer** | 只读探索仓库、定位入口/调用链/影响面、生成 RepoContextBrief | 不写文件、不提交 RunJob、不做科学判断 |
| **Worker** | 编译、运行、解析日志、写脚本、生成图表、创建 patch | 不决定实验方向、不写长期 memory |
| **Reviewer** | 检查兼容性、输出格式、工程完整性 | 不审查科学假设 |

### 治理规则 (硬编码)

**需要 PI 审批**:
- 修改 SHUD 物理方程 / 默认参数
- 覆盖 benchmark baseline
- 接受 breaking 输出格式变更
- 将 calibration 结果升级为"validated"
- 删除原始数据

**禁止表述**:
- ❌ "模型机制已验证" → ✅ "在 ccw 流域该指标有所改善"
- ❌ "普遍改进" → ✅ "单流域单事件结果，需更多验证"
- ❌ "校准证明了结构" → ✅ "校准结果，需 holdout 验证"

---

## 4. 对象模型 (8 个)

### 4.1 TaskCard — 任务入口

```yaml
task_id: TASK-0001
type: engineering | science_assist | ops
status: created | planned | running | parked | reporting | awaiting_pi | done | cancelled | blocked
runtime_phase: null | running_local | submitted_job | waiting_for_job | collecting
title: "给 SHUD 添加 event flux 诊断输出"
question_or_goal: "在不破坏 rSHUD 旧版读取的前提下，添加 event_flux 可选输出"
created_by: alice
current_owner: alice
stack_id: STACK-0001
data_id: DATA-0001
inference_budget:
  mode: normal          # cheap | normal | deep
  advisory_usd: 1.00   # 建议值，超出时状态栏提醒，不自动中断
  advisory_model_calls: 12
  reviewer_enabled: false
linked_jobs: [JOB-0001, JOB-0002]
linked_reports: [TASK-0001_report.md]
created_at: 2026-04-25T10:00:00Z
updated_at: 2026-04-25T14:30:00Z
```

### 4.2 StackLock — 版本锁

```yaml
stack_id: STACK-0001
repos:
  SHUD: {commit: 9b55b0c, branch: master}
  rSHUD: {commit: d162db3, branch: master}
  AutoSHUD: {commit: 1cbec6f, branch: master}
runtime:
  os: Darwin 24.6.0
  r_version: "4.4.1"
  r_packages_lock: renv.lock   # renv::snapshot() 产出的完整 R 包版本锁
  python_version: "3.12.4"
  sundials_version: "6.0.0"
  gcc_version: "14.1.0"
  gdal_version: "3.9.0"
harness:
  version: "0.8.1"
  prompt_pack: promptpack-0001
  skills_version: skills-0001
fingerprint: sha256:...
created_at: 2026-04-25T10:00:00Z
```

### 4.3 DataProvenance — 数据溯源

```yaml
data_id: DATA-0001
basin: cache_creek
event_window: {start: 2008-01-01, end: 2008-02-28}
sources:
  terrain: {path: data/raw/ccw/dem.tif, sha256: abc...}
  mesh: {path: repos/SHUD/input/ccw/ccw.sp.mesh, sha256: def...}
  forcing: {path: data/raw/ccw/forcing/, sha256: ghi...}
  observations:
    - {variable: discharge, station: USGS-11451100, path: data/raw/ccw/obs_q.csv, sha256: jkl...}
preprocess:
  script: scripts/prep_ccw.R
  params: {interpolation: IDW, resolution: 200m}
  output_sha256: mno...
uncertainty_notes: "降水空间插值可能低估高海拔降水量"
```

### 4.4 RunJob — 执行请求

```yaml
job_id: JOB-0001
task_id: TASK-0001
backend: local_direct | local_job | docker_job
status: created | submitted | running | succeeded | failed | cancelled | timed_out | collected
command: "cd repos/SHUD && make shud && ./shud ccw"
cwd: workspaces/TASK-0001/worktrees/SHUD
resources: {max_wall_minutes: 30, max_memory_mb: 4096}
cost_budget: {max_compute_minutes: 60}
pid: 12345
submitted_at: 2026-04-25T10:05:00Z
finished_at: 2026-04-25T10:12:00Z
```

### 4.5 RunRecord — 执行结果 (可重放核心)

```yaml
run_id: RUN-0001
job_id: JOB-0001
task_id: TASK-0001
stack_id: STACK-0001
data_id: DATA-0001
status: succeeded | failed
command: "cd repos/SHUD && make shud && ./shud ccw"
artifacts:
  stdout: artifacts/RUN-0001/stdout.log
  stderr: artifacts/RUN-0001/stderr.log
  shud_output: runs/RUN-0001/output/
  metrics_summary: artifacts/RUN-0001/metrics.yaml
  plots: [artifacts/RUN-0001/hydrograph.png]
numerical_health:
  water_balance_residual: 0.0008
  cvode_failures: 0
  negative_state_count: 0
  max_solver_dt: 5.2
resources:
  wall_seconds: 420
  peak_memory_mb: 1830
```

### 4.6 AnalysisPlan — 分析/校准/基准统一

```yaml
analysis_id: PLAN-0001
task_id: TASK-0001
mode: sensitivity | calibration | benchmark | comparison
baseline_run: RUN-0001

# sensitivity 模式
parameters:
  ksat_multiplier: [0.5, 1.0, 2.0]
  mannings_n_multiplier: [0.7, 1.0, 1.3]
strategy: one_at_a_time

# calibration 模式 (可选)
calibration:
  allowed_params: [ksat_multiplier, mannings_n_multiplier]
  forbidden_params: [cvode_abstol, cvode_reltol]
  objective: {primary: NSE, secondary: water_balance_residual}
  holdout:
    calibration_events: [storm_2008_02_14]
    holdout_events: [storm_2008_11_20]
    promotion_rule: "holdout NSE ≥ 0.5 才可称 validated; 否则仅 promising"

metrics: [peak_flow_error, peak_timing_error, event_runoff_coefficient, water_balance_residual, NSE, KGE]

rules:
  - "不允许用 hidden debug tolerance 参与 calibration"
  - "calibration_set 与 holdout_set 不得重叠"
  - "单事件最优参数不得直接当默认参数"

outputs: [sensitivity_table, tornado_plot, PI_summary]
```

### 4.7 EvidenceReport — 证据报告

```yaml
report_id: TASK-0001_report.md
task_id: TASK-0001
status: draft | reviewed | awaiting_pi | accepted | revision_requested | rejected | archived
summary: "event_flux 输出已添加, rSHUD 旧版读取兼容, 水量平衡误差 < 0.1%"
observations:
  - "peak_flow_error 对 ksat 不敏感 (range: -2% ~ +3%)"
  - "peak_timing 对 mannings_n 敏感 (range: -45min ~ +30min)"
limitations:
  - "仅在 ccw 流域 2008-02 事件测试"
  - "降水不确定性未量化"
pi_questions:
  - "是否需要在 heihe 流域重复验证?"
  - "是否接受 event_flux 作为可选输出进入主分支?"
llm_cost: {calls: 8, estimated_usd: 0.45}
compute_cost: {wall_minutes: 12, jobs: 2}
```

### 4.8 ChangeRequest — 代码变更

```yaml
change_id: CHG-0001
task_id: TASK-0001
risk: low | medium | high
title: "SHUD 添加 event_flux 可选输出"
files_changed:
  SHUD: [src/ModelData/MD_f.cpp, src/classes/IO.hpp]
  rSHUD: [R/io_output.R]
interface_impact:
  output_change: additive   # additive | breaking
  backward_compatible: true
compat_checks:
  old_output_reader: pass
  tiny_case: pass
  rshud_roundtrip: pass
  water_balance: pass
gates:
  needs_pi_approval: false  # additive + backward_compatible → 不需要
  reason: null
patch_bundle: artifacts/CHG-0001/patch.tar.gz
```

---

## 5. 运行时

### 5.1 目录结构

```
shud-harness/                    # 代码仓库 (TypeScript monorepo, 基于 Zero 扩展)
  packages/
    core/                        # 扩展 Zero 核心 (AgentLoop, Tool, Session)
      src/
        agent/                   # Coordinator/Repo Explorer/Worker/Coder/Reviewer 角色定义
        tools/                   # SHUD 专用工具 (shud-build, shud-run, rshud-parse)
        domain/                  # 领域对象 (TaskCard, RunJob, RunRecord, etc.)
          schemas/               # Zod schemas (前后端共享)
        services/                # 业务逻辑 (task, job, report, sandbox)
    backend/                     # Hono API 服务
      src/
        routes/                  # REST API + WebSocket 端点
          tasks.ts, jobs.ts, reports.ts, analysis.ts, patches.ts, notes.ts
        middleware/               # 认证、sandbox 隔离
    frontend/                    # React 科研工作台
      src/
        pages/                   # Dashboard, Workbench(四栏), ReportFullscreen, CostAdmin
        layouts/                 # WorkbenchLayout (四栏容器)
        components/              # SideNav, AgentActivityFeed, ExperimentDashboard,
                                 # HydrographChart, RuntimeTerminal, ParameterSetTable,
                                 # ResultsOverview, SensitivityHeatmap, NextSuggestedAction
        hooks/                   # useWebSocket, useAgentStream, useHydrograph
  prompts/
    coordinator.md, explorer.md, worker.md, coder.md, reviewer.md
  skills/
    run-shud-tiny-case/SKILL.md
    diagnose-shud-run-failure/SKILL.md
    rshud-roundtrip-test/SKILL.md
    summarize-sensitivity-results/SKILL.md
    build-task-report/SKILL.md
  scripts/                       # 确定性脚本 (非 LLM, R/bash)
    shud/build.sh, run.sh
    rshud/read_output.R, water_balance.R, roundtrip_test.R
    metrics/sensitivity_table.ts, tornado_plot.ts
  templates/
    task_report.md.j2, evidence_report.md.j2
  tests/

shud-workspace/                  # 运行时资产 (不进代码仓)
  config.yaml
  tasks/TASK-*.yaml
  stacklocks/STACK-*.yaml
  data_provenance/DATA-*.yaml
  analysis_plans/PLAN-*.yaml
  jobs/JOB-*.yaml
  runs/RUN-*/
  reports/TASK-*_report.md
  notes/NOTE-*.yaml
  changes/CHG-*.yaml
  artifacts/
  warehouse/shud_harness.duckdb
  repos/SHUD/, repos/rSHUD/, repos/AutoSHUD/
  data/raw/ (只读), data/processed/
  workspaces/TASK-*/
```

### 5.2 Sandbox 规则

**可写**: `workspaces/TASK-*/scratch`, `artifacts/`, `worktrees/`, `reports/`, `runs/`
**只读**: `data/raw/`
**禁写**: benchmark baselines (除非 PI 审批), canonical memory

每条 bash 命令记录:
```yaml
cmd_id: CMD-0042
task_id: TASK-0001
command: "Rscript scripts/rshud/water_balance.R ccw"
cwd: workspaces/TASK-0001
exit_code: 0
wall_seconds: 3.2
stdout_tail: "Water balance residual: 0.0008"
stderr_tail: ""
files_changed: [{path: artifacts/wb_summary.yaml, action: created}]
```

### 5.3 Park/Resume (长任务处理)

SHUD 运行可能几十分钟到几小时。Agent 不应空转等待。

```
Coordinator 构建 RunJob → submit → job.status = submitted
→ task.status = parked → Agent 退出 (不消耗 LLM tokens)
→ job 完成 → WebSocket 推送通知到前端
→ 后端自动 collect → job.status = collected → RunRecord 生成
→ Coordinator 自动恢复, 读取 RunRecord, 生成报告
→ 前端实时展示报告, PI 在浏览器中审阅
```

### 5.4 失败恢复

| 场景 | 处理 |
|------|------|
| 编译失败 | 记录 stderr, 标记 job failed, 报告中列出错误 |
| 运行崩溃 | 收集 partial log, 检查 CVODE 错误, 建议诊断方向 |
| 代码写坏 | `git checkout -- .` 回滚 worktree |
| 临时文件堆积 | Web Dashboard "清理" 按钮 → 后端清理 scratch |
| Agent 死循环 | `max_no_progress_steps: 3` → 自动 block |
| 预算超出建议值 | 状态栏标黄提醒 PI, 不自动中断 |
| Job 孤儿 | 后端定期检查 pid, 超时标记 timed_out, 前端展示告警 |

### 5.5 Memory (两级)

| 类型 | 写入方式 | PI 审核 | 示例 |
|------|----------|---------|------|
| **note** | 直接 draft | 否 | "rSHUD roundtrip 失败因为旧格式缺少 header" |
| **evidence_note** | draft + 等 PI | 是 | "ksat 对洪峰不敏感 (ccw, 2008-02)" |

不搞 4 级审批。不搞 epistemic memory。PI 的判断记录为 `pi_decision` 类型 note:
```yaml
note_id: NOTE-0007
type: pi_decision
task_id: TASK-0002
title: "暂不修改物理方程"
body: "先做完敏感性分析和 holdout 验证再考虑物理修改"
```

### 5.6 Skills (三阶段)

**生命周期**: draft → active → retired。不搞 6 级。

**MVP 5 个 skill**:
1. `run-shud-tiny-case` — 编译+运行 ccw 30天+解析+水量平衡
2. `diagnose-shud-run-failure` — 分类失败 (编译/CVODE/数据/环境)
3. `rshud-roundtrip-test` — 写入+读回+比较
4. `summarize-sensitivity-results` — 参数扫描表+tornado 图
5. `build-task-report` — 从 RunRecord+AnalysisPlan 生成报告

升级 note → skill: 需要 2+ 次出现 + 工程师判断。不靠 LLM 自荐。

检索: MVP 用关键词+标签，不用 embedding（成本不 justify）。

### 5.7 推理预算（软监控）

Budget 是状态栏软监控指标，不是硬限制。做到一半被强制中止比多花代价完成更浪费，由 PI 自行决定是否中止。

```yaml
inference_budget:
  mode: cheap        # 规划+报告, 不启 Reviewer, 用于 ops 任务
  advisory_usd: 0.30
  advisory_model_calls: 6

inference_budget:
  mode: normal       # Coordinator + Worker, 1 次 Reviewer, 用于小工程任务
  advisory_usd: 1.00
  advisory_model_calls: 12
  reviewer_enabled: true   # (只调用一次)

inference_budget:
  mode: deep         # PI 明确要求, 多轮分析, 用于敏感性/跨仓库
  advisory_usd: 5.00
  advisory_model_calls: 30
  reviewer_enabled: true
```

超出 advisory 值 → 状态栏标黄提醒 PI，任务继续执行。PI 可随时手动中止。
Job 等待期间 ≠ LLM 调用, 不计费。

### 5.8 增量 Benchmark

| 变更类型 | 默认运行 |
|----------|----------|
| 文档/报告 | 无 benchmark |
| 脚本/解析器 | parser smoke + tiny read |
| rSHUD reader | old-output fixture + tiny output read |
| SHUD 输出格式 | SHUD tiny + rSHUD roundtrip + 兼容性 |
| 数值核心 | tiny + 固定 regression + PI 选择 batch |
| 预处理 | 仅受影响的流域/事件 |

---

## 6. Coordinator 行为规格

### 6.1 状态机

```
TaskCard.status 流转:
created ──→ planned ──→ running ──→ reporting ──→ awaiting_pi ──→ done
                    │                                        ├──→ planned (PI request_revision; 旧报告 EvidenceReport.status → revision_requested)
                    ├──→ parked ──→ running ──→ reporting     └──→ cancelled
                    └──→ blocked (budget/error/no-progress)

TaskCard.runtime_phase (仅 status=running 时有意义):
null ──→ running_local        (短任务直接执行)
     ──→ submitted_job ──→ waiting_for_job ──→ collecting ──→ null
```

### 6.2 System Prompt (Coordinator)

```markdown
你是 SHUD-Harness 的 Coordinator Agent。你的职责是协调模型运行、代码变更和报告生成。

## 你的能力
- 调用 bash 在 sandbox 中执行命令
- 调度 Worker 执行具体任务 (编译、运行、解析、生成图表)
- 生成 Markdown 报告
- 建议下一步行动

## 你不能做的
- 判断科学结论是否成立 (这是 PI 的事)
- 修改物理方程或默认参数 (需要 PI 审批)
- 覆盖 benchmark baseline
- 在报告中写 "已验证"、"普遍改进"、"机制成立" 等断言
- 忽略状态栏的预算超出提醒（应提醒 PI 注意）

## 每个任务的执行流程
1. **Brief**: 读取 TaskCard, StackLock, DataProvenance, 相关 notes
2. **Plan**: 列出具体步骤 (编译→运行→解析→比较→报告)
3. **Execute**: 逐步执行, 每步记录 trace
   - 短命令 → 直接 bash
   - 长任务 → 提交 RunJob, 设 task.status = parked, 退出
4. **Report**: 从 RunRecord 生成报告, 填充模板, 标注 limitations
5. **Ask PI**: 列出需要 PI 判断的问题, 设 task.status = awaiting_pi

## 硬性约束
- 状态栏实时显示 LLM 调用次数和费用，超出 advisory 值时标黄
- 连续 3 步无进展 → 自动 block
- 每条 bash 命令最多重试 2 次
- 修改的文件必须在 workspaces/TASK-*/ 内
- data/raw/ 只读
```

### 6.3 各阶段的决策逻辑

**Brief 阶段**:
```
读取 TaskCard
├── type == ops → 直接执行, 不跑 benchmark
├── type == engineering → 检查是否有 StackLock 和 DataProvenance
│   ├── 无 → 先创建 (stack lock + data register)
│   └── 有 → 进入 Plan
└── type == science_assist → 检查是否有 AnalysisPlan
    ├── 无 → 先创建 Plan
    └── 有 → 进入 Execute
```

**Plan 阶段**:
```
根据 task.type 选择步骤模板:
├── engineering: compile → run_tiny → modify_code → run_tiny_again → roundtrip → compat → patch → report
├── science_assist: run_baseline → run_parameter_sweep → summarize_metrics → plot → report
└── ops: execute_command → record_result → note
```

**Execute 阶段**:
```
FOR each step in plan:
  IF step.duration_estimate > 5 min:
    submit RunJob(backend=local_job)
    SET task.status = parked
    EXIT (等待 job collect)
  ELSE:
    执行 bash 命令
    检查 exit_code
    IF failed AND retries < 2:
      重试
    ELIF failed:
      SET task.status = blocked
      生成 partial report
      EXIT
  记录 CommandTrace
  更新状态栏 inference_budget 消耗
  IF advisory_exceeded:
    状态栏标黄提醒 PI（不中断执行）
```

**Report 阶段**:
```
收集所有 RunRecord
├── 用确定性脚本生成 metrics summary (不用 LLM)
├── 用确定性脚本生成图表 (不用 LLM)
├── 用模板填充报告框架 (不用 LLM)
└── 用 LLM 生成解释性文字 (标记为 draft)
    ├── observations: 只描述数据, 不做因果推断
    ├── limitations: 必须列出
    └── pi_questions: 必须列出至少 1 个
```

---

## 7. Tiny Fixture 定义

### 选择: ccw (Cache Creek Watershed)

| 属性 | 值 | 原因 |
|------|-----|------|
| 流域 | Cache Creek | README 文档示例, 最小 (1147 单元, 103 河段) |
| 路径 | `repos/SHUD/input/ccw/` | 已存在, 无需额外准备 |
| 全量天数 | 1827 天 (~5年) | 原始配置 |
| Tiny 天数 | **30 天** | 修改 `ccw.cfg.para` 的 END=30 |
| 预期运行时间 | < 2 分钟 | 1147 单元 × 30 天, serial 模式 |

### Tiny 运行步骤 (skill: run-shud-tiny-case)

PI 在 Web 界面点击 "Run Tiny Case" 或在对话中输入指令，后端执行：

```bash
# 1. 锁版本 (POST /api/stacks/lock)
# 后端自动采集 repo commits + runtime versions

# 2. 准备 workspace
cp -r repos/SHUD/input/ccw workspaces/TASK-$TASK/ccw
sed -i 's/^END.*/END 30/' workspaces/TASK-$TASK/ccw/ccw.cfg.para

# 3. 编译
cd repos/SHUD && make shud

# 4. 运行 (前端实时展示 stdout 日志流)
./shud workspaces/TASK-$TASK/ccw/ccw

# 5. 解析
Rscript scripts/rshud/read_output.R --path workspaces/TASK-$TASK/ccw --keywords eleygw,rivqdown

# 6. 水量平衡
Rscript scripts/rshud/water_balance.R --path workspaces/TASK-$TASK/ccw

# 7. 生成 RunRecord → 前端实时展示结果
```

### 验收标准
- SHUD 编译成功
- ccw 30 天运行完成, exit_code=0
- water_balance_residual < 0.01
- cvode_failures = 0
- RunRecord 完整 (stack_id, data_id, artifacts, metrics, numerical_health)

---

## 8. Task Playbook (含决策树)

### Playbook A: 工程任务 — "给 SHUD 添加 event flux 诊断输出"

```
1. [Web] PI 在对话框输入 "添加 event flux 诊断输出" 或点击 "新建任务"
   → POST /api/tasks {type: engineering, title: "Add event flux diagnostics"}

2. [API] POST /api/stacks/lock → 自动采集版本
   └── 失败? → 检查 SUNDIALS/R 环境, 修复后重试

3. run tiny baseline
   ├── 编译失败? → diagnose-shud-run-failure skill → block
   ├── 运行失败? → 检查 CVODE 错误 → block
   └── 成功 → 记录 RUN-BASE

4. 修改代码 (在 worktree 中)
   ├── SHUD: 添加 event_flux 输出 (IO.hpp + MD_f.cpp)
   └── rSHUD: 添加 reader (io_output.R)

5. run tiny after
   ├── 编译失败? → revert worktree, 修复后重试 (max 2)
   └── 成功 → 记录 RUN-AFTER

6. 兼容性检查
   ├── old-output fixture test
   │   ├── 失败? → 修复 reader fallback → 重跑
   │   └── 通过
   ├── rshud roundtrip test
   │   ├── 失败? → 修复格式 → 重跑
   │   └── 通过
   └── water balance diff (BEFORE vs AFTER)
       ├── 差异 > 0.1%? → 报告异常 → 等 PI 判断
       └── 差异 < 0.1% → 继续

7. patch bundle
   └── patch diff + patch bundle → artifacts

8. report build
   └── 生成报告 → task.status = awaiting_pi

9. PI 判断
   ├── 接受 → apply patch to main branch
   ├── 修改 → task.status = planned (旧报告 EvidenceReport.status → revision_requested) → 回到 step 4
   └── 拒绝 → task.status = cancelled
```

### Playbook B: 科研辅助 — "诊断 ccw 暴雨洪峰偏低"

```
1. [Web] PI 在对话中描述问题: "ccw 暴雨洪峰偏低，做敏感性分析"
   → POST /api/tasks {type: science_assist, title: "Peak underestimation sensitivity", budget: deep}

2. [API] POST /api/stacks/lock + POST /api/data/register (ccw, storm_2008_02_14)

3. 创建 AnalysisPlan
   mode: sensitivity
   parameters:
     ksat_multiplier: [0.5, 1.0, 2.0]
     mannings_n_multiplier: [0.7, 1.0, 1.3]
   metrics: [peak_flow_error, peak_timing_error, NSE]

4. run baseline
   ├── 长任务? (ccw 全事件可能 10+ 分钟)
   │   ├── 是 → submit RunJob, park, 等 collect
   │   └── 否 → 直接执行
   └── 成功 → 记录 RUN-BASE

5. run parameter sweep (6 组合 = 6 runs)
   ├── 每组: 修改 ccw.cfg.calib → 运行 → 解析 → 记录 RunRecord
   ├── 全部 local_direct? → 串行跑
   └── 太慢? → 每组提交 local_job, park

6. 汇总
   ├── 确定性脚本: sensitivity_table.py → sensitivity_results.parquet
   ├── 确定性脚本: tornado_plot.py → tornado.png
   └── LLM: 生成 observations (只描述数据, 不做因果推断)

7. report build
   observations:
     - "peak_flow_error 对 ksat_multiplier 不敏感 (range: -2%~+3%)"
     - "peak_timing 对 mannings_n_multiplier 敏感 (range: -45min~+30min)"
   limitations:
     - "仅 ccw 流域 1 个暴雨事件"
     - "降水不确定性未量化"
   pi_questions:
     - "是否需要在 heihe/qhh 重复?"
     - "是否值得先改 hillslope routing 再验证?"

8. task.status = awaiting_pi
   ├── PI: "先做 holdout 验证" → 创建新 TaskCard
   ├── PI: "可以尝试修改 roughness" → 创建 engineering task
   └── PI: "证据不足, 暂缓" → task done
```

### Playbook C: 运维 — "记录一次 rSHUD 兼容性失败经验"

```
1. [Web] Coordinator 自动创建 ops 任务
   → POST /api/tasks {type: ops, title: "Record old-output failure", budget: cheap}
2. 后端执行诊断命令，前端展示日志
3. [API] POST /api/notes {type: note, title: "rSHUD 2.2.0 读旧输出缺少 header fallback", tags: ["rshud","output-compatibility"]}
4. task done → 前端通知 PI
```

---

## 9. 八周实施计划

| 周 | 交付物 | 验收标准 |
|----|--------|----------|
| **W1** | Monorepo + 四栏布局壳 + 基础 API + TaskCard schema | 浏览器打开四栏布局, 可创建 task |
| **W2** | StackLock + DataProvenance + ResearchContext + ExperimentHeader | task 绑定 stack/data, SideNav 展示上下文 |
| **W3** | Sandbox + RunJob + WebSocket + AgentActivityFeed + RuntimeTerminal | Agent 多角色活动流实时展示, 嵌入终端显示日志 |
| **W4** | Tiny SHUD loop + HydrographChart + ResultsOverview | 过程线交互式展示, 指标卡片 (NSE/Peak/WB) |
| **W5** | rSHUD roundtrip + DiffViewer + HydrographComparison | diff 预览 + baseline vs experiment 差异带对比图 |
| **W6** | 敏感性分析 + ParameterSetTable + SensitivityHeatmap | 参数表可排序 + 热力图颜色编码 |
| **W7** | Memory/Skills + CostMonitor + NextSuggestedAction + 审批 | PI 在建议面板选择方案并执行 |
| **W8** | LLM streaming 对话 + 全流程 demo + 失败恢复 | PI 自然语言驱动, 四栏工作台实时联动 |

---

## 10. 验收标准 (9 项)

1. Web 界面能创建 task, 绑定 stack/data, 运行 job, 生成报告
2. 每次运行有完整 RunRecord (stack_id + data_id + artifacts + metrics + numerical_health)
3. ccw tiny benchmark 可重复运行
4. rSHUD roundtrip 可执行
5. 敏感性分析能生成参数表 + 图表
6. patch bundle 可生成 + 可回滚
7. 长任务能 park / collect / resume
8. 每个 task 报告显示 LLM + compute 成本
9. PI 在浏览器中看报告 + 对话 + 点审批就能决定下一步

**不通过条件** (任一项即不合格):
- 结果无法绑定 StackLock
- 数据无法追溯
- calibration 没有 holdout
- benchmark baseline 可被 Agent 自动覆盖
- memory 可被 Agent 直接标记 verified
- 高风险变更可绕过 PI
