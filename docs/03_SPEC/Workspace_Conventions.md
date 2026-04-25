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
  zero/                ← submodule, 只读参考
```

**规则**: Agent 不得直接修改根 submodule。任何需要改代码的任务，必须在 runtime workspace 中通过 `git worktree` 创建工作副本。

### 1.2 Runtime workspace (执行副本)

每个 TaskCard 对应的运行时工作区：

```text
workspace/
  repos/
    SHUD/              ← 从 source submodule clone 或 worktree
    rSHUD/
    AutoSHUD/
    zero/
  stacks/
  data/
  tasks/
  jobs/
  runs/
  artifacts/
  reports/
  sessions/
  warehouse/
  tmp/
```

### 1.3 映射关系

| 层级 | 路径 | 用途 | Agent 写权限 |
|------|------|------|-------------|
| Source | `SHUD/`, `rSHUD/`, `AutoSHUD/`, `zero/` | 只读参考、StackLock 基线 | 禁止 |
| Runtime repos | `workspace/repos/*` | 编译、运行的工作副本 | 受限（Sandbox policy） |
| Task worktree | `workspace/tasks/TASK-*/worktrees/*` | 任务特定代码修改 | 允许 |
| Scratch/tmp | `workspace/tasks/TASK-*/scratch/`, `workspace/tmp/` | 临时文件 | 允许 |
| Artifacts | `workspace/artifacts/`, `workspace/runs/*/` | 运行产出 | 允许 |

### 1.4 与其他规范的关系

- **Sandbox path policy** (`Execution_Jobs_Runs.md` §9.2): 允许路径列表对应上表中"允许"和"受限"行
- **StackLock**: 记录 source submodule 的 commit；若 runtime repos 有本地修改，StackLock 标记 `dirty: true`
- **ChangeRequest patch bundle**: 基于 task worktree 与 source submodule 的 diff 生成
- **Git worktree rollback**: 仅影响 `workspace/tasks/TASK-*/worktrees/`，不触及 source submodule

源码仓库可以来自 submodule、runtime clone 或 worktree，但 StackLock 必须记录实际 commit 和 dirty state。

## 2. Task 目录

```text
tasks/TASK-001/
  task.yaml
  plan.md
  parked_state.yaml
  gates/
  notes.md
  locks/
```

TaskCard 是任务生命周期核心；不要把所有运行输出塞到 task 目录中。

## 3. Run 目录

```text
runs/RUN-001/
  run.yaml
  input/
  output/
  logs/
  metrics.yaml
  artifacts.yaml
```

每个 RunRecord 对应一个 run directory。参数扫描中每个参数集单独 run directory。

## 4. Artifact 目录

```text
artifacts/
  logs/
  figures/
  metrics/
  reports/
  patches/
  toolcalls/
  manifests/
```

### 补充目录

```text
snapshots/          — workspace/session/task 状态快照
locks/              — 幂等锁和任务锁文件
exports/            — 报告导出文件
packages/           — 数据打包（evidence/debug/benchmark）
notifications/      — 通知记录
```

Artifact 文件名建议包含 task/run/report ID：

```text
RUN-001_rivqdown_hydrograph.png
RUN-001_metrics.yaml
TASK-001_patch_bundle.diff
```

## 5. Data 目录

```text
data/
  DATA-001/
    provenance.yaml
    processed/
    checksums.yaml
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

### Report export

```text
artifacts/reports/REPORT-001.md
artifacts/reports/REPORT-001.standalone.html
artifacts/reports/REPORT-001.export_manifest.yaml
```

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

锁文件和幂等记录见 [Idempotency_Concurrency_Locking_Spec.md](Idempotency_Concurrency_Locking_Spec.md)。Workspace snapshot 和 service restart recovery 见 [Workspace_Snapshot_And_Recovery_Spec.md](Workspace_Snapshot_And_Recovery_Spec.md)。

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
- [ ] StackLock 记录四个 submodule 的 commit 和 dirty state。
