---
status: frozen
canonical_for: [workspace-paths]
---

# Workspace 约定

**状态：** P1 设计规范  
**适用范围：** runtime workspace、submodule、runs、artifacts、tasks、reports  
**目标：** 固定目录结构、命名和文件生命周期，使 RunRecord 和 EvidenceReport 可复盘。

## 1. 路径体系 Canonical 规则

本项目存在两层路径体系，用途不同，不可混淆：

### 1.1 源码仓库 (Source reference)

根目录的 git submodule，是只读参考源：

```text
SHUD-Harness/          ← 项目根
  SHUD/                ← submodule, 只读参考
  rSHUD/               ← submodule, 只读参考
  AutoSHUD/            ← submodule, 只读参考
```

**规则**: Agent 不得直接修改根 submodule。任何需要改代码的任务，必须在 runtime workspace 中通过 `git worktree` 创建工作副本。

### 1.2 Runtime workspace (执行副本)

会话 cwd 是工作区根；一个工作区可包含多张 TaskCard。M3 已交付的对象落点如下（设计依据见 [m3-mvp-1](../../openspec/changes/archive/2026-11-01-m3-mvp-1/design.md#d2-工作区文件落点与原子写)，当前布局见 [Repository Layout §2](../04_IMPLEMENTATION/Repository_Layout.md#2-运行时资产不进代码仓)；M2 runs 布局保持不变）：

```text
workspace/
  tasks/<task_id>/task.json
  stacks/<stack_id>.json
  provenance/<data_id>.json
  reports/<report_id>.json
  reports/<report_id>.md
  runs/<run_id>/
```

`repos/`、task worktree、分析 artifacts、warehouse、通知等下文目录是后续能力的预留布局，不由 M3 创建。会话与作业索引属于宿主/profile stateDir，不混入这张领域对象目录表。

原始数据目录 `<data_root>/raw/` **必须位于 workspace root 之外**（ADR-0004 治理不变式：dsh `workspace-write` 沙箱下由 Seatbelt 拒写，`data/raw` 字节保护不依赖字符串扫描）。M3 DataProvenance 记录提交输入副本的文件级 sha256，不在此定义原始数据语义分类。布局以 [Repository Layout §2](../04_IMPLEMENTATION/Repository_Layout.md#2-运行时资产不进代码仓) 为准。

### 1.3 映射关系

| 层级 | 路径 | 用途 | Agent 写权限 |
|------|------|------|-------------|
| Source | `SHUD/`, `rSHUD/`, `AutoSHUD/` | 只读参考、StackLock 基线 | 禁止 |
| Runtime repos | `workspace/repos/*` | 编译、运行的工作副本 | 受限（Sandbox policy） |
| Task worktree | `workspace/tasks/TASK-*/worktrees/*` | 任务特定代码修改 | 允许 |
| Scratch/tmp | `workspace/tasks/TASK-*/scratch/`, `workspace/tmp/` | 临时文件 | 允许 |
| Artifacts | `workspace/artifacts/`, `workspace/runs/*/` | 运行产出 | 允许 |
| Data provenance | `workspace/provenance/` | DATA-*.json 记录 | 允许（只读读取） |
| Secrets | `workspace/secrets/` | local-token 等敏感文件（0600） | backend 私有 |

### 1.4 与其他规范的关系

- **Sandbox path policy** (`Execution_Jobs_Runs.md` §9.2): 允许路径列表对应上表中"允许"和"受限"行
- **StackLock**: 记录 source submodule 的 commit；若 runtime repos 有本地修改，StackLock 标记 `dirty: true`
- **ChangeRequest patch bundle**: 基于 task worktree 与 source submodule 的 diff 生成
- **Git worktree rollback**: 仅影响 `workspace/tasks/TASK-*/worktrees/`，不触及 source submodule

源码仓库可以来自 submodule、runtime clone 或 worktree，但 StackLock 必须记录实际 commit 和 dirty state。

## 2. Task 目录

```text
tasks/<task_id>/
  task.json
```

`task_id` 使用 `TASK-<UTC>-xxxx` 品牌格式，路径拼接前校验。M3 不创建 task.yaml、parked_state.yaml 或 task 内索引/锁。TaskCard 是任务生命周期核心；运行输出留在独立 run 目录。

## 3. Run 目录

```text
runs/<run_id>/
  run-job.json
  run-record.json                 # 终态收集成功后发布
  collect-error.json              # 收集生成失败时记录，成功后保留既有文件
  input/<project>/               # 普通文件/目录的完整输入副本
  output/<project>.out/           # 求解器产物
  stdout.log
  stderr.log
  wrapper.pid
  exit_code                      # 包装进程完成时原子发布
```

这是 M2 已交付布局；可选/完成后文件并非提交时全部存在。active.json、completed.json、lock 与永久 .lock-guard 位于插件 stateDir，不在 run 目录。每个 RunRecord 对应一个运行目录，产物只记路径与元数据，M3 不增加 metrics.yaml 或 artifacts.yaml。

## 4. 领域对象与 Artifact 落点

| 对象 | M3 工作区路径 | 所有权 |
|---|---|---|
| TaskCard | `tasks/<task_id>/task.json` | records 文件层，经工具推进状态 |
| StackLock | `stacks/<stack_id>.json` | 提交期确定性采集/复用，不覆盖既有 lock |
| DataProvenance | `provenance/<data_id>.json` | 每次提交从输入副本生成 |
| EvidenceReport | `reports/<report_id>.json` | 规范对象，含 decision_history |
| Markdown 报告 | `reports/<report_id>.md` | 同名 JSON 的确定性投影，状态改变后重渲染 |
| RunJob / RunRecord | `runs/<run_id>/{run-job,run-record}.json` | M2 注册表与收集器 |

以上对象不经 ctx.storage，不另建 stateDir 对象索引；目录与目标文件拒绝符号链接/特殊文件，读入后校验 schema。records 包是 M3 规划文件层，不是 Cordis 服务行。报告不在 `artifacts/` 下保留第二份。

后续 M4/M5 的 figures、metrics、patches、repo_context、manifests 与数据打包路径由对应契约定义；不据此要求 M3 生成不存在的分析或导出产物。

Artifact 文件名建议包含 task/run/report ID：

```text
RUN-001_rivqdown_hydrograph.png
RUN-001_metrics.yaml
TASK-001_patch_bundle.diff
```

## 5. Data 目录

```text
data/
  raw/
  processed/
  checksums.yaml
```

### DataProvenance 目录

```text
provenance/
  DATA-*.json
```

Raw data 推荐只读引用，不直接复制到 Git。若复制到 workspace，也必须保留 checksum 和来源。

## 6. Warehouse

```text
warehouse/
  metrics.parquet
  runs.parquet
  parameter_sets.parquet
  artifacts.parquet
```

Warehouse 用于查询和 Dashboard，不替代 RunRecord。RunRecord 仍是复盘的源事实。

## 7. 临时文件

`tmp/` 可清理，不可作为报告证据来源。若临时文件需要进入报告，必须转为 artifact。

## 8. Git 策略

建议进入 Git：

- schema；
- prompts；
- skills；
- small fixtures；
- benchmark definitions；
- markdown reports；
- small metrics summaries。

不建议进入 Git：

- 大型 SHUD 输出；
- NetCDF/raster；
- 完整 batch logs；
- secrets；
- large binary artifacts。

## 9. 路径安全

所有用户输入路径必须规范化并检查：

```text
resolve path
→ ensure path under workspace or allowed readonly path
→ reject symlink escape
→ record normalized path
```

## 9.1 Operational UX artifact paths

### Report files

```text
reports/<report_id>.json
reports/<report_id>.md
```

M3 只交付 Markdown 及规范 JSON；不生成 HTML。`export_manifest.yaml` 属于 M4 导出规划，不是 M3 报告必需产物。下面的通知/分析进度等 operational UX 目录仍是后续规划，不代表当前宿主已经生成这些文件。

### Notification records

```text
workspace/notifications/NOTIFY-001.yaml
workspace/notifications/by_task/TASK-001/NOTIFY-001.yaml
```

NotificationRecord 不保存完整邮件正文，只保存 subject、body_preview、recipient、trigger、status、dedupe_key 和 error。

### Analysis progress

```text
artifacts/analysis/PLAN-001/progress.json
artifacts/analysis/PLAN-001/parameter_set_table.json
artifacts/analysis/PLAN-001/heatmap.json
```

### PI decision records

```text
tasks/TASK-001/pi_gates/GATE-001.decision.yaml
tasks/TASK-001/audit/AUDIT-001.yaml
memory/pi_decisions/NOTE-001.yaml
```

### Path safety

Standalone HTML export 不得写出 workspace 根目录。Export 中引用的 artifact path 应使用相对路径或 artifact id，不使用敏感绝对路径。

### 锁与恢复机制

锁文件和幂等记录见 [Idempotency_Concurrency_Locking_Spec.md](Idempotency_Concurrency_Locking_Spec.md)。Workspace snapshot 和 service restart recovery 原见 Workspace_Snapshot_And_Recovery_Spec（已删，见 tag archive/zero-v0.8.3）。

## 10. 清理策略

| 对象 | 清理策略 |
|---|---|
| tmp | 可自动清理 |
| failed run output | 默认保留，便于 debug |
| logs | 保留摘要和完整日志，可按策略归档 |
| reports | 不自动删除 |
| raw data | 不由 Harness 自动删除 |

## 11. 验收标准

- [ ] 每个 RunRecord 有独立 run directory。
- [ ] artifact manifest 可列出报告引用的所有文件。
- [ ] tmp 文件不能被 EvidenceReport 直接引用。
- [ ] workspace 外路径写入被拒绝。
- [ ] StackLock 记录三个 submodule 的 commit 和 dirty state。
