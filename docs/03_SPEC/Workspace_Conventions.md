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

**规则**: Agent 不得直接修改根 submodule。代码变更任务必须使用 runtime workspace 内隔离的工作副本，不直接修改 source reference 或主分支；任务独占其检出。M4 具体在 scratch runtime workspace 内以根 SHUD 对象库作来源建立 `repos/SHUD` 独立本地 clone，钉定切片前 commit；不使用 `git worktree add`，避免改写根 submodule 的 git 元数据（design D15(8)，M4 范围裁剪、非放宽 baseline）。M4 以外的隔离副本要求仍有效，不以本轮 clone 例外解除。

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

M4 已交付的布局如下；设计依据为 [m4-mvp-2](../../openspec/changes/archive/2026-11-05-m4-mvp-2/design.md)，实际目录由各领域操作按需创建，不因安装 profile 即全部存在：

```text
workspace/
  repos/SHUD/                       # 独立本地 clone；源码修改面
  changes/<change_id>.json
  patches/<change_id>.patch
  verifications/<vc_id>.json
  builds/<build_id>/
    build-record.json
    shud
    make.stdout.log
    make.stderr.log
```

task worktree、分析 artifacts、warehouse、通知等下文目录属于未激活的后续规划，不由 M3/M4 回放创建。会话与作业索引属于宿主/profile stateDir，不混入领域对象目录。

records 文件层按**物理会话工作区**定位托管根：保留 cwd 中符号链接与 `..` 的实际遍历次序，先直接追加固定根名，以 `lstat` 拒绝根本身的符号链接（含悬空链接）、普通文件或 FIFO 等非目录，再用 native realpath 取得真实目录拼写，最后拼接经校验的品牌 id 与固定后代路径。因此 `cwd-alias → W/child` 时，`cwd-alias/..` 的记录属于 `W`，不会读取或写入词法折叠位置的同名对象。托管后代仍按原有 no-follow 规则检查；build producer 获得物理临时目录，碰撞、dev/ino 所有权复核与仅清理自有临时目录的规则不变。

readonly 查询不创建缺失的 cwd、托管根或对象，也不回退到词法工作区：记录读取保持原来的缺失错误，Markdown 真正缺失返回 `undefined`，报告引用的 runs 根缺失仍为目录错误。普通非 readonly 记录读取保留创建标准托管目录的兼容行为，写入方保留递归创建（包括 cwd 尚不存在）；读取不会创建已发布 build id 目录。非法 kind、品牌 id 或待写对象仍在各自既有文件系统边界前拒绝。这里保证已观察路径类型的拒绝和物理路由，不承诺对恶意跨进程目录替换提供原子快照或新的文件系统锁。

cwd 必须是字符串；非字符串不得隐式回退到进程 cwd，也不得先调用对象的字符串转换。空字符串仍保留旧有相对路径语义，不作为非字符串处理。此检查位于共享托管根边界，不改变 StackLock 配置/仓库元数据采集等调用方原有的校验与观察顺序。

`task_create(code_change)`、`change_create` 与 `shud_build` 共用 source-checkout 边界：在既有受控目录校验内，先对原始 cwd 做 native realpath，再定位并校验固定 `repos/SHUD` 检出与 HEAD，返回同一个物理工作区供后续记录读取、输出目录预检、构建 producer、发布与回滚使用。源码 HEAD、dirty diff 和 patch 必须来自记录实际落盘的工作区，不能把词法同名检出的证据写入物理工作区。品牌/参数校验及已有 TaskCard 的资格检查仍先于 Git；`science_assist` 不进入 source-checkout，也不新增检出存在要求，保留 cwd 尚不存在时的递归创建行为。

原始数据目录 `<data_root>/raw/` **必须位于 workspace root 之外**（ADR-0004 治理不变式：dsh `workspace-write` 沙箱下由 Seatbelt 拒写，`data/raw` 字节保护不依赖字符串扫描）。M3 DataProvenance 记录提交输入副本的文件级 sha256，不在此定义原始数据语义分类。布局以 [Repository Layout §2](../04_IMPLEMENTATION/Repository_Layout.md#2-运行时资产不进代码仓) 为准。

### 1.3 映射关系

| 层级 | 路径 | 用途 | Agent 写权限 |
|------|------|------|-------------|
| Source | `SHUD/`, `rSHUD/`, `AutoSHUD/` | 只读参考、StackLock 基线 | 禁止 |
| Runtime repos | `workspace/repos/SHUD` | M4 修改源码的本地 clone；构建另在 builds 临时树 | coder 受 sandbox 限制 |
| Task worktree | `workspace/tasks/TASK-*/worktrees/*` | 未激活的后续规划，M4 不使用 | M4 模型工具不得写 tasks |
| Scratch/tmp | `workspace/tmp/` | 非证据临时文件 | 受 sandbox 限制 |
| Artifacts / runs | `workspace/artifacts/`, `workspace/runs/*/` | 后续分析 / 已有运行产出 | runs 仅领域工具与受控求解器写 |
| Governance records | `workspace/{tasks,stacks,provenance,reports,changes,patches,verifications,builds}` | 领域事实与投影 | 仅对应领域工具写；模型可只读 |
| Secrets | `workspace/secrets/` | local-token 等敏感文件（0600） | backend 私有 |

### 1.4 与其他规范的关系

- **Sandbox path policy** (`Execution_Jobs_Runs.md` §9.2): 允许路径列表对应上表中"允许"和"受限"行
- **StackLock**: 无 build 取配置三仓库修订；M4 有 build 时 SHUD 来源取 BuildRecord，另两个仓库照常采集。
- **ChangeRequest patch**: M4 对钉定 HEAD 的 `repos/SHUD` 观测已跟踪修改，保存到 `patches/<change_id>.patch`，不用根 submodule 与工作副本间的任意 diff 替代。
- **构建与回滚**: base 仅从钉定 commit 的 archive 构建，不要求 CR/patch；candidate 从同一 archive 加已批 CR 的 patch 构建。两者均在 `builds/.tmp-<build_id>/src/` 内，发布前失败仅清理本次临时构建；不修改 `repos/SHUD` 或根 submodule。

源码与构建来源必须可追溯；M4 不用 worktree，也不声称工作树里的任意文件都是构建输入。

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
  bin/shud                       # M4 仅有 build_id 时：经摘要校验的执行副本
```

这是 M2 已交付布局；可选/完成后文件并非提交时全部存在。active.json、completed.json、lock 与永久 .lock-guard 位于插件 stateDir，不在 run 目录。每个 RunRecord 对应一个运行目录，产物只记路径与元数据，M3 不增加 metrics.yaml 或 artifacts.yaml。

## 4. 领域对象与 Artifact 落点

| 对象 | 工作区路径（M4 行为目标契约） | 所有权 |
|---|---|---|
| TaskCard | `tasks/<task_id>/task.json` | records 文件层，经工具推进状态 |
| StackLock | `stacks/<stack_id>.json` | 提交期确定性采集/复用，不覆盖既有 lock |
| DataProvenance | `provenance/<data_id>.json` | 每次提交从输入副本生成 |
| EvidenceReport | `reports/<report_id>.json` | 规范对象，含 decision_history |
| Markdown 报告 | `reports/<report_id>.md` | 同名 JSON 的确定性投影，状态改变后重渲染 |
| RunJob / RunRecord | `runs/<run_id>/{run-job,run-record}.json` | M2 注册表与收集器 |
| ChangeRequest | `changes/<change_id>.json` | change_create / change_submit |
| Patch | `patches/<change_id>.patch` | change_create 确定性生成，批准/构建/closure 复核摘要 |
| VerificationCase | `verifications/<vc_id>.json` | verification_run |
| BuildRecord 与二进制 | `builds/<build_id>/` | shud_build 整体发布，消费者校验二进制摘要 |

以上领域对象不经 ctx.storage；新对象不另建 stateDir 索引，运行索引仍归 jobs。目录与目标文件拒绝符号链接/特殊文件，按品牌 id 定位并核对文件内 id、schema。records 是文件层而非 Cordis 服务行。M4 新对象首次采用排他创建，碰撞至多重新分配 id 三次，不覆盖既有对象；build 临时目录排他 mkdir 后整体 rename 发布。报告不在 artifacts 下保留第二份。

后续 figures、metrics、repo_context、manifests 与数据打包路径不属于 M4 回放交付；patch 的唯一落点已在上表定义。

Artifact 文件名建议包含 task/run/report ID：

```text
RUN-001_rivqdown_hydrograph.png
RUN-001_metrics.yaml
CHG-20261102T093000-4a1f.patch
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

**M4 治理根写保护：** 相对会话 cwd 固定九根 `tasks stacks provenance reports runs changes patches verifications builds`，不可配置。模型 write/edit/str_replace_editor（非 view）目标命中即 deny `governance-immutable`；bash/pwsh 触及且被既有写 denylist 判为写也 deny，只读触及 next。与角色或 sandbox_permissions 无关，raw 同时命中时优先执行 raw 规则；`repos/` 不在集合中。

这是启发式保护，不是工作区内的沙箱强隔离。绕过 shell denylist 的写法仍可能改写治理记录，`repos/SHUD/.git` 篡改亦不在 M4 威胁模型内。补偿为 ask 前、change_submit 执行时、shud_build 与 closure 的 patch 摘要复核、运行二进制摘要复核，以及回放对 approval_ref 与 session log 的交叉核对；不宣称密码学审批证明。边界见 [design D15(9)/D16](../../openspec/changes/archive/2026-11-05-m4-mvp-2/design.md#d16-治理根写保护critical-path-23)。

## 9.1 Operational UX artifact paths

### Report files

```text
reports/<report_id>.json
reports/<report_id>.md
```

M3/M4 只交付 Markdown 及规范 JSON，不生成 HTML；`export_manifest.yaml` 属于后续导出规划，不是回放必需产物。下面的通知/分析进度等 operational UX 目录仍是后续规划，不代表当前宿主已经生成这些文件。

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
